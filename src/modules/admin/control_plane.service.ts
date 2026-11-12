import crypto from 'node:crypto';
import { db } from '../../infrastructure/database.js';
import { getGlobalPrisma } from '../../infrastructure/prisma.js';
import { logger } from '../../infrastructure/logger.js';
import { rabbitMqBus } from '../../infrastructure/rabbitmq.js';
import { redisAdapter } from '../../infrastructure/redis.js';
import { storageAdapter } from '../../infrastructure/storage.adapter.js';
import { recordAudit } from '../audit/audit.service.js';
import { revokeAllUserSessions } from '../auth/jwt.verifier.js';
import { billingCreditService } from '../billing/billing.service.js';
import { catalogRepository } from '../catalog/catalog.repository.js';

export interface CmsContentDto {
  id: string;
  slug: string;
  type: string;
  title: string;
  summary?: string;
  body?: unknown;
  status: 'DRAFT' | 'PUBLISHED';
  sortOrder: number;
  updatedAt: string;
}

export interface FeatureFlagDto {
  key: string;
  name: string;
  description: string;
  owner: string;
  globalEnabled: boolean;
  rolloutPct: number;
  overrides: Record<string, boolean>;
}

export interface SupportTicketDto {
  id: string;
  tenantId?: string;
  requesterName: string;
  requesterEmail: string;
  subject: string;
  category: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  assignedAgent?: string;
  relatedJobId?: string;
  messages: Array<{ id: string; sender: string; senderRole: string; body: string; internal: boolean; createdAt: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface RefundRecordDto {
  id: string;
  orderId: string;
  tenantId: string;
  amount: number;
  currency: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'PROCESSED';
  createdAt: string;
}

export interface WebhookEndpointDto {
  id: string;
  tenantId?: string;
  url: string;
  events: string[];
  active: boolean;
  lastResponseCode?: number;
  createdAt: string;
}

export interface DataGovernanceDto {
  id: string;
  tenantId: string;
  type: 'EXPORT' | 'DELETE';
  requester: string;
  status: 'PENDING_REVIEW' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED';
  retentionDeadline: string;
  createdAt: string;
}

export interface AiModelDto {
  id: string;
  providerId: string;
  name: string;
  version: string;
  category: string;
  resolution: string;
  requiredEntitlement: string;
  estCostUsd: number;
  active: boolean;
  isDefault: boolean;
}

const memoryUserStatus = new Map<string, 'ACTIVE' | 'SUSPENDED'>();
const memoryAiModels: AiModelDto[] = [
  {
    id: 'model_gemini_vton',
    providerId: 'gemini',
    name: 'Gemini Virtual Try-On Compose',
    version: 'v3.6',
    category: 'all',
    resolution: '1024x1536',
    requiredEntitlement: 'STARTER',
    estCostUsd: 0.035,
    active: true,
    isDefault: true,
  },
  {
    id: 'model_fal_catvton',
    providerId: 'fal',
    name: 'Fal CatVTON High Fidelity',
    version: 'v2.1',
    category: 'tops',
    resolution: '1024x1536',
    requiredEntitlement: 'PRO',
    estCostUsd: 0.055,
    active: true,
    isDefault: false,
  },
  {
    id: 'model_local_blend',
    providerId: 'local',
    name: 'Local Deterministic Preview Engine',
    version: 'v1.0',
    category: 'all',
    resolution: '768x1024',
    requiredEntitlement: 'STARTER',
    estCostUsd: 0.002,
    active: true,
    isDefault: false,
  },
];

let aiRoutingPolicy = {
  primaryProvider: 'gemini',
  fallbackProvider: 'fal',
  localPreviewFallback: true,
  maxConcurrencyPerTenant: 5,
  autoRetryOnTransientError: true,
};

const memoryCmsPages = new Map<string, CmsContentDto>([
  [
    'hero-banner',
    {
      id: crypto.randomUUID(),
      slug: 'hero-banner',
      type: 'BANNER',
      title: 'Try Before You Buy Across Luxury Independent Studios',
      summary: 'AI-powered virtual fitting room live on verified designer storefronts.',
      status: 'PUBLISHED',
      sortOrder: 1,
      updatedAt: new Date().toISOString(),
    },
  ],
]);

const memoryFeatureFlags = new Map<string, FeatureFlagDto>([
  [
    'async_rabbitmq_tryon',
    {
      key: 'async_rabbitmq_tryon',
      name: 'Async RabbitMQ VTON Pipeline',
      description: 'Routes try-on jobs through durable outbox + RabbitMQ workers with SSE progress.',
      owner: 'platform-ai',
      globalEnabled: true,
      rolloutPct: 100,
      overrides: {},
    },
  ],
  [
    'multi_garment_layering',
    {
      key: 'multi_garment_layering',
      name: 'Multi-Garment Outfit Layering',
      description: 'Enables stacking outerwear over tops in single fitting room session.',
      owner: 'ml-research',
      globalEnabled: false,
      rolloutPct: 25,
      overrides: { tenant_aura: true },
    },
  ],
]);

const memoryTickets = new Map<string, SupportTicketDto>();
const memoryRefunds = new Map<string, RefundRecordDto>();
const memoryWebhooks = new Map<string, WebhookEndpointDto>();
const memoryGovernance = new Map<string, DataGovernanceDto>();
let platformSettings: Record<string, unknown> = {
  platformName: 'VTON Studio Enterprise',
  maintenanceMode: false,
  maxUploadMb: 10,
  requireModerationBeforeMarketplace: false,
  defaultRetentionDays: 30,
};

export class AdminControlPlaneService {
  public async listUsers() {
    const users = db.getUsers();
    const prisma = getGlobalPrisma();
    const profileMap = new Map<string, string>();
    if (prisma) {
      try {
        const profiles = await prisma.userProfile.findMany({ select: { userId: true, status: true } });
        for (const p of profiles) profileMap.set(p.userId, p.status);
      } catch {
        // ignore
      }
    }

    return users.map((u: any) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      tenantId: u.tenantId || null,
      emailVerified: Boolean(u.emailVerified),
      status: memoryUserStatus.get(u.id) || (profileMap.get(u.id) as 'ACTIVE' | 'SUSPENDED') || 'ACTIVE',
      createdAt: new Date(u.createdAt).toISOString(),
    }));
  }

  public async setUserStatus(input: {
    userId: string;
    status: 'ACTIVE' | 'SUSPENDED';
    actorId: string;
    actorRole: string;
    reason?: string;
    correlationId?: string;
  }) {
    const user = db.getUserById(input.userId);
    if (!user) return null;

    memoryUserStatus.set(input.userId, input.status);
    if (input.status === 'SUSPENDED') {
      await revokeAllUserSessions(input.userId);
    }

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        await prisma.userProfile.upsert({
          where: { userId: input.userId },
          update: { status: input.status },
          create: { userId: input.userId, displayName: user.name, status: input.status },
        });
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'admin.user_status_prisma_warning');
      }
    }

    await recordAudit({
      actorId: input.actorId,
      actorRole: input.actorRole,
      tenantId: user.tenantId,
      action: input.status === 'SUSPENDED' ? 'ADMIN_USER_SUSPENDED' : 'ADMIN_USER_REACTIVATED',
      entity: 'User',
      entityId: input.userId,
      reason: input.reason,
      correlationId: input.correlationId,
    });

    return { id: user.id, email: user.email, status: input.status };
  }

  public async createTenantAsAdmin(input: {
    name: string;
    slug: string;
    contactEmail: string;
    planSlug: 'STARTER' | 'PRO' | 'ENTERPRISE';
    actorId: string;
    actorRole: string;
    correlationId?: string;
  }) {
    const cleanSlug = input.slug.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-');
    if (db.getTenantBySlug(cleanSlug)) {
      return { ok: false as const, error: 'ConflictError', message: `Tenant slug '${cleanSlug}' already exists.` };
    }
    const now = Date.now();
    const tenantId = `tenant_${cleanSlug}_${Math.random().toString(36).slice(2, 6)}`;
    const tenant = db.createTenant({
      id: tenantId,
      name: input.name.trim(),
      slug: cleanSlug,
      status: 'ACTIVE',
      contactEmail: input.contactEmail.trim().toLowerCase(),
      createdAt: now,
      updatedAt: now,
    });

    const planRes = await billingCreditService.changeTenantPlan({
      tenantId: tenant.id,
      planSlug: input.planSlug,
      actorId: input.actorId,
      actorRole: input.actorRole,
      correlationId: input.correlationId,
    });

    return { ok: true as const, tenant, ...planRes };
  }

  public getAiModelsAndRouting() {
    return { models: memoryAiModels, routing: aiRoutingPolicy };
  }

  public async updateAiModel(
    modelId: string,
    patch: { active?: boolean; isDefault?: boolean },
    actorId: string,
    actorRole: string,
    correlationId?: string
  ) {
    const target = memoryAiModels.find((m) => m.id === modelId);
    if (!target) return null;
    if (typeof patch.active === 'boolean') target.active = patch.active;
    if (patch.isDefault === true) {
      for (const m of memoryAiModels) m.isDefault = m.id === modelId;
    }

    await recordAudit({
      actorId,
      actorRole,
      action: 'ADMIN_AI_MODEL_UPDATED',
      entity: 'AiModelRecord',
      entityId: modelId,
      correlationId,
      details: patch,
    });
    return target;
  }

  public async updateAiRouting(
    patch: Partial<typeof aiRoutingPolicy>,
    actorId: string,
    actorRole: string,
    correlationId?: string
  ) {
    aiRoutingPolicy = { ...aiRoutingPolicy, ...patch };
    await recordAudit({
      actorId,
      actorRole,
      action: 'ADMIN_AI_ROUTING_UPDATED',
      entity: 'SystemSetting',
      entityId: 'ai_routing',
      correlationId,
      details: patch,
    });
    return aiRoutingPolicy;
  }

  public async listModerationQueue() {
    const tenants = new Map(db.getTenants().map((t) => [t.id, t]));
    const products = db.getProducts();
    return Promise.all(
      products.map(async (p) => {
        const pub = await catalogRepository.getPublicationMeta(p.id, p.tenantId);
        return {
          productId: p.id,
          productName: p.name,
          sku: p.sku,
          category: p.category,
          price: p.price,
          image: p.images?.[0],
          tenantId: p.tenantId,
          brandName: tenants.get(p.tenantId)?.name || 'Unknown Brand',
          marketplacePublished: p.marketplacePublished,
          brandStorefrontPublished: p.brandStorefrontPublished,
          moderationStatus: pub.moderationStatus,
          moderationNote: pub.moderationNote,
          featured: pub.featured,
          sponsored: pub.sponsored,
        };
      })
    );
  }

  public listCmsPages() {
    return Array.from(memoryCmsPages.values());
  }

  public async saveCmsPage(input: Omit<CmsContentDto, 'id' | 'updatedAt'> & { id?: string }, actorId: string, actorRole: string) {
    const existing = memoryCmsPages.get(input.slug);
    const page: CmsContentDto = {
      id: input.id || existing?.id || crypto.randomUUID(),
      slug: input.slug,
      type: input.type,
      title: input.title,
      summary: input.summary,
      body: input.body,
      status: input.status,
      sortOrder: input.sortOrder,
      updatedAt: new Date().toISOString(),
    };
    memoryCmsPages.set(page.slug, page);

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        await prisma.cmsContent.upsert({
          where: { slug: page.slug },
          update: {
            type: page.type,
            title: page.title,
            summary: page.summary ?? null,
            body: (page.body as any) ?? undefined,
            status: page.status,
            sortOrder: page.sortOrder,
          },
          create: {
            id: page.id,
            slug: page.slug,
            type: page.type,
            title: page.title,
            summary: page.summary ?? null,
            body: (page.body as any) ?? undefined,
            status: page.status,
            sortOrder: page.sortOrder,
          },
        });
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'admin.cms_prisma_warning');
      }
    }

    await recordAudit({
      actorId,
      actorRole,
      action: 'ADMIN_CMS_SAVED',
      entity: 'CmsContent',
      entityId: page.slug,
    });
    return page;
  }

  public listFeatureFlags() {
    return Array.from(memoryFeatureFlags.values());
  }

  public async updateFeatureFlag(
    key: string,
    patch: { globalEnabled?: boolean; rolloutPct?: number; tenantOverride?: { tenantId: string; enabled: boolean } },
    actorId: string,
    actorRole: string
  ) {
    const flag = memoryFeatureFlags.get(key);
    if (!flag) return null;
    if (typeof patch.globalEnabled === 'boolean') flag.globalEnabled = patch.globalEnabled;
    if (typeof patch.rolloutPct === 'number') flag.rolloutPct = patch.rolloutPct;
    if (patch.tenantOverride) {
      flag.overrides[patch.tenantOverride.tenantId] = patch.tenantOverride.enabled;
    }

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        await prisma.featureFlag.upsert({
          where: { key: flag.key },
          update: { globalEnabled: flag.globalEnabled, rolloutPct: flag.rolloutPct },
          create: {
            key: flag.key,
            name: flag.name,
            description: flag.description,
            owner: flag.owner,
            globalEnabled: flag.globalEnabled,
            rolloutPct: flag.rolloutPct,
          },
        });
        if (patch.tenantOverride && db.getTenantById(patch.tenantOverride.tenantId)) {
          await prisma.tenantFeatureOverride.upsert({
            where: { tenantId_featureKey: { tenantId: patch.tenantOverride.tenantId, featureKey: flag.key } },
            update: { enabled: patch.tenantOverride.enabled },
            create: {
              tenantId: patch.tenantOverride.tenantId,
              featureKey: flag.key,
              enabled: patch.tenantOverride.enabled,
            },
          });
        }
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'admin.flag_prisma_warning');
      }
    }

    await recordAudit({
      actorId,
      actorRole,
      action: 'ADMIN_FEATURE_FLAG_UPDATED',
      entity: 'FeatureFlag',
      entityId: key,
      details: patch,
    });
    return flag;
  }

  public listSupportTickets() {
    return Array.from(memoryTickets.values());
  }

  public async createSupportTicket(input: {
    tenantId?: string;
    requesterName: string;
    requesterEmail: string;
    subject: string;
    category: string;
    priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    message: string;
  }) {
    const now = new Date().toISOString();
    const ticket: SupportTicketDto = {
      id: `tkt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      tenantId: input.tenantId,
      requesterName: input.requesterName,
      requesterEmail: input.requesterEmail,
      subject: input.subject,
      category: input.category,
      priority: input.priority || 'MEDIUM',
      status: 'OPEN',
      messages: [
        {
          id: crypto.randomUUID(),
          sender: input.requesterName,
          senderRole: 'REQUESTER',
          body: input.message,
          internal: false,
          createdAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    memoryTickets.set(ticket.id, ticket);

    const prisma = getGlobalPrisma();
    if (prisma) {
      try {
        await prisma.supportTicket.create({
          data: {
            id: ticket.id,
            tenantId: ticket.tenantId ?? null,
            requesterName: ticket.requesterName,
            requesterEmail: ticket.requesterEmail,
            subject: ticket.subject,
            category: ticket.category,
            priority: ticket.priority,
            status: ticket.status,
            messages: {
              create: {
                sender: ticket.requesterName,
                senderRole: 'REQUESTER',
                body: input.message,
                internal: false,
              },
            },
          },
        });
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'support.create_ticket_prisma_warning');
      }
    }
    return ticket;
  }

  public async replyOrUpdateTicket(
    ticketId: string,
    patch: { status?: SupportTicketDto['status']; assignedAgent?: string; message?: string; internal?: boolean },
    actorName: string,
    actorRole: string
  ) {
    const t = memoryTickets.get(ticketId);
    if (!t) return null;
    if (patch.status) t.status = patch.status;
    if (patch.assignedAgent !== undefined) t.assignedAgent = patch.assignedAgent;
    if (patch.message) {
      t.messages.push({
        id: crypto.randomUUID(),
        sender: actorName,
        senderRole: actorRole,
        body: patch.message,
        internal: Boolean(patch.internal),
        createdAt: new Date().toISOString(),
      });
    }
    t.updatedAt = new Date().toISOString();
    return t;
  }

  public listRefunds() {
    return Array.from(memoryRefunds.values());
  }

  public async createRefund(
    input: { orderId: string; tenantId: string; amount: number; reason: string },
    actorId: string,
    actorRole: string
  ) {
    const ref: RefundRecordDto = {
      id: crypto.randomUUID(),
      orderId: input.orderId,
      tenantId: input.tenantId,
      amount: input.amount,
      currency: 'BDT',
      reason: input.reason,
      status: 'PROCESSED',
      createdAt: new Date().toISOString(),
    };
    memoryRefunds.set(ref.id, ref);
    await recordAudit({
      actorId,
      actorRole,
      tenantId: input.tenantId,
      action: 'FINANCE_REFUND_PROCESSED',
      entity: 'RefundRecord',
      entityId: ref.id,
      reason: input.reason,
      details: { orderId: input.orderId, amount: input.amount },
    });
    return ref;
  }

  public listWebhooks() {
    return Array.from(memoryWebhooks.values());
  }

  public async addWebhook(input: { url: string; events: string[]; tenantId?: string }, actorId: string, actorRole: string) {
    const hook: WebhookEndpointDto = {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      url: input.url,
      events: input.events,
      active: true,
      lastResponseCode: 200,
      createdAt: new Date().toISOString(),
    };
    memoryWebhooks.set(hook.id, hook);
    await recordAudit({
      actorId,
      actorRole,
      tenantId: input.tenantId,
      action: 'ADMIN_WEBHOOK_REGISTERED',
      entity: 'WebhookEndpoint',
      entityId: hook.id,
      details: { url: input.url, events: input.events },
    });
    return hook;
  }

  public listGovernanceRequests() {
    return Array.from(memoryGovernance.values());
  }

  public async createGovernanceRequest(input: { tenantId: string; type: 'EXPORT' | 'DELETE'; requester: string }) {
    const req: DataGovernanceDto = {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      type: input.type,
      requester: input.requester,
      status: 'PENDING_REVIEW',
      retentionDeadline: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    memoryGovernance.set(req.id, req);
    return req;
  }

  public async updateGovernanceRequest(
    id: string,
    status: DataGovernanceDto['status'],
    actorId: string,
    actorRole: string
  ) {
    const row = memoryGovernance.get(id);
    if (!row) return null;
    row.status = status;
    await recordAudit({
      actorId,
      actorRole,
      tenantId: row.tenantId,
      action: `GOVERNANCE_REQUEST_${status}`,
      entity: 'DataGovernanceRequest',
      entityId: id,
    });
    return row;
  }

  public getSettings() {
    return platformSettings;
  }

  public async updateSettings(patch: Record<string, unknown>, actorId: string, actorRole: string) {
    platformSettings = { ...platformSettings, ...patch };
    await recordAudit({
      actorId,
      actorRole,
      action: 'ADMIN_PLATFORM_SETTINGS_UPDATED',
      entity: 'SystemSetting',
      entityId: 'global',
      details: patch,
    });
    return platformSettings;
  }

  public async getFullSnapshot() {
    const [users, plans, moderationProducts, redisHealth, storageHealth] = await Promise.all([
      this.listUsers(),
      billingCreditService.listPlans(true),
      this.listModerationQueue(),
      redisAdapter.health(),
      storageAdapter.health(),
    ]);

    return {
      users,
      plans,
      subscriptions: db.getTenants().map((t) => ({
        tenantId: t.id,
        tenantName: t.name,
        subscription: db.getSubscription(t.id),
      })),
      orders: db.getOrders(),
      refunds: this.listRefunds(),
      invoices: billingCreditService.getInvoices(),
      creditLedger: billingCreditService.getLedger().slice(0, 100),
      aiModels: memoryAiModels,
      aiRouting: aiRoutingPolicy,
      moderationProducts,
      cmsPages: this.listCmsPages(),
      tickets: this.listSupportTickets(),
      featureFlags: this.listFeatureFlags(),
      webhooks: this.listWebhooks(),
      governanceRequests: this.listGovernanceRequests(),
      settings: platformSettings,
      infrastructureHealth: {
        redis: redisHealth,
        rabbitmq: { connected: rabbitMqBus.isConnected() },
        storage: storageHealth,
      },
    };
  }
}

export const adminControlPlaneService = new AdminControlPlaneService();
