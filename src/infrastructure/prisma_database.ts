import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { createPrismaInstance, disconnectPrisma } from './prisma.js';
import {
  Tenant,
  User,
  AuthToken,
  AuthPortal,
  AuthTokenType,
  Product,
  Fabric,
  InventoryLog,
  Subscription,
  Order,
  AuditLog,
  GenerationJob,
  UsageLedgerEntry,
  TenantStatus,
  UserRole,
  TryOnCategory,
  OrderStatus,
  PaymentStatus,
  SubscriptionPlan,
  ProductVariant,
  StorefrontSettings,
  ShippingAddress,
  OrderItem,
} from '../domain/types.js';

export class PrismaDatabase {
  private prisma: PrismaClient | null = null;
  private pool: pg.Pool | null = null;
  private connected: boolean = false;
  private databaseUrl?: string;

  constructor(databaseUrl?: string, customPool?: pg.Pool) {
    this.databaseUrl = databaseUrl;
    if (customPool) {
      const instance = createPrismaInstance({ pool: customPool });
      this.prisma = instance.prisma;
      this.pool = instance.pool;
    }
  }

  public async init(url?: string): Promise<boolean> {
    const connStr = url || this.databaseUrl;
    if (!connStr && !this.prisma) {
      console.warn('[Prisma DB] No DATABASE_URL provided. Skipping Prisma SQL connection.');
      this.connected = false;
      return false;
    }

    try {
      if (!this.prisma && connStr) {
        const instance = createPrismaInstance({ connectionString: connStr });
        this.prisma = instance.prisma;
        this.pool = instance.pool;
      }

      if (!this.prisma) return false;

      // Test connection with a lightweight query
      await this.prisma.$queryRaw`SELECT 1`;
      this.connected = true;
      console.log('[Prisma DB] Successfully connected to PostgreSQL database via Prisma ORM!');

      // Check if seeded
      const tenantCount = await this.prisma.tenant.count();
      if (tenantCount === 0) {
        console.log('[Prisma DB] Database is empty. Seeding initial demo catalog with Prisma...');
        await this.seedInitialData();
      }

      return true;
    } catch (err: any) {
      console.warn('[Prisma DB] Could not connect to SQL database via Prisma:', err.message);
      this.connected = false;
      return false;
    }
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getClient(): PrismaClient | null {
    return this.prisma;
  }

  public async checkHealth(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    if (!this.prisma || !this.connected) {
      return { ok: false, latencyMs: 0, error: 'Prisma ORM connection not active' };
    }
    const start = performance.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true, latencyMs: Number((performance.now() - start).toFixed(1)) };
    } catch (err: any) {
      return { ok: false, latencyMs: Number((performance.now() - start).toFixed(1)), error: err.message };
    }
  }

  public async close(): Promise<void> {
    if (this.prisma) {
      await this.prisma.$disconnect();
    }
    if (this.pool) {
      await this.pool.end();
    }
    this.connected = false;
  }

  // ==========================================
  // Tenants
  // ==========================================
  public async getTenants(): Promise<Tenant[]> {
    if (!this.prisma) return [];
    const rows = await this.prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mapTenant(r));
  }

  public async getTenantById(id: string): Promise<Tenant | undefined> {
    if (!this.prisma) return undefined;
    const row = await this.prisma.tenant.findUnique({ where: { id } });
    return row ? this.mapTenant(row) : undefined;
  }

  public async getTenantBySlug(slug: string): Promise<Tenant | undefined> {
    if (!this.prisma) return undefined;
    const row = await this.prisma.tenant.findUnique({ where: { slug } });
    return row ? this.mapTenant(row) : undefined;
  }

  public async createTenant(tenant: Tenant): Promise<Tenant> {
    if (!this.prisma) throw new Error('Prisma database is not connected');
    const created = await this.prisma.tenant.create({
      data: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        logoUrl: tenant.logoUrl || null,
        bannerUrl: tenant.bannerUrl || null,
        description: tenant.description || null,
        contactEmail: tenant.contactEmail,
        storefrontSettings: (tenant.storefrontSettings as any) || {},
        createdAt: BigInt(tenant.createdAt),
        updatedAt: BigInt(tenant.updatedAt),
      },
    });

    // Also auto-create a starter subscription
    await this.prisma.subscription.upsert({
      where: { tenantId: tenant.id },
      create: {
        id: `sub_${tenant.id}`,
        tenantId: tenant.id,
        plan: 'STARTER',
        productLimit: 50,
        tryOnMonthlyQuota: 500,
        tryOnUsed: 0,
        status: 'ACTIVE',
        updatedAt: BigInt(Date.now()),
      },
      update: {},
    });

    return this.mapTenant(created);
  }

  public async updateTenant(id: string, updates: Partial<Tenant>): Promise<Tenant | undefined> {
    if (!this.prisma) return undefined;
    const data: any = { updatedAt: BigInt(Date.now()) };
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.slug !== undefined) data.slug = updates.slug;
    if (updates.status !== undefined) data.status = updates.status;
    if (updates.logoUrl !== undefined) data.logoUrl = updates.logoUrl;
    if (updates.bannerUrl !== undefined) data.bannerUrl = updates.bannerUrl;
    if (updates.description !== undefined) data.description = updates.description;
    if (updates.contactEmail !== undefined) data.contactEmail = updates.contactEmail;
    if (updates.storefrontSettings !== undefined) data.storefrontSettings = updates.storefrontSettings as any;

    const row = await this.prisma.tenant.update({
      where: { id },
      data,
    });
    return this.mapTenant(row);
  }

  // ==========================================
  // Users
  // ==========================================
  public async getUsers(): Promise<User[]> {
    if (!this.prisma) return [];
    const rows = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mapUser(r));
  }

  public async getUserByEmail(email: string): Promise<User | undefined> {
    if (!this.prisma) return undefined;
    const row = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    return row ? this.mapUser(row) : undefined;
  }

  public async getUserById(id: string): Promise<User | undefined> {
    if (!this.prisma) return undefined;
    const row = await this.prisma.user.findUnique({ where: { id } });
    return row ? this.mapUser(row) : undefined;
  }

  public async createUser(user: User): Promise<User> {
    if (!this.prisma) throw new Error('Prisma database is not connected');
    const created = await this.prisma.user.upsert({
      where: { id: user.id },
      update: {
        tenantId: user.tenantId || null,
        name: user.name,
        email: user.email,
        passwordHash: user.passwordHash,
        role: user.role,
        emailVerified: Boolean(user.emailVerified),
        emailVerifiedAt: user.emailVerifiedAt ? BigInt(user.emailVerifiedAt) : null,
        updatedAt: user.updatedAt ? BigInt(user.updatedAt) : null,
      },
      create: {
        id: user.id,
        tenantId: user.tenantId || null,
        name: user.name,
        email: user.email,
        passwordHash: user.passwordHash,
        role: user.role,
        emailVerified: Boolean(user.emailVerified),
        emailVerifiedAt: user.emailVerifiedAt ? BigInt(user.emailVerifiedAt) : null,
        updatedAt: user.updatedAt ? BigInt(user.updatedAt) : null,
        createdAt: BigInt(user.createdAt),
      },
    });
    return this.mapUser(created);
  }

  public async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    if (!this.prisma) return undefined;
    const data: any = { updatedAt: BigInt(Date.now()) };
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.passwordHash !== undefined) data.passwordHash = updates.passwordHash;
    if (updates.emailVerified !== undefined) data.emailVerified = updates.emailVerified;
    if (updates.emailVerifiedAt !== undefined) data.emailVerifiedAt = BigInt(updates.emailVerifiedAt);
    const result = await this.prisma.user.updateMany({
      where: { id },
      data,
    });
    if (result.count === 0) return undefined;
    return this.getUserById(id);
  }

  public async createAuthToken(token: AuthToken): Promise<AuthToken> {
    if (!this.prisma) throw new Error('Prisma database is not connected');
    const created = await this.prisma.authToken.create({
      data: {
        id: token.id,
        userId: token.userId,
        email: token.email,
        type: token.type,
        tokenHash: token.tokenHash,
        otpCodeHash: token.otpCodeHash || null,
        portal: token.portal,
        expiresAt: BigInt(token.expiresAt),
        usedAt: token.usedAt ? BigInt(token.usedAt) : null,
        createdAt: BigInt(token.createdAt),
      },
    });
    return this.mapAuthToken(created);
  }

  public async invalidateAuthTokens(userId: string, type: AuthTokenType): Promise<void> {
    if (!this.prisma) return;
    await this.prisma.authToken.updateMany({
      where: { userId, type, usedAt: null },
      data: { usedAt: BigInt(Date.now()) },
    });
  }

  public async markAuthTokenUsed(id: string): Promise<void> {
    if (!this.prisma) return;
    await this.prisma.authToken.updateMany({
      where: { id },
      data: { usedAt: BigInt(Date.now()) },
    });
  }

  // ==========================================
  // Products
  // ==========================================
  public async getProducts(): Promise<Product[]> {
    if (!this.prisma) return [];
    const rows = await this.prisma.product.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mapProduct(r));
  }

  public async getProductsByTenant(tenantId: string): Promise<Product[]> {
    if (!this.prisma) return [];
    const rows = await this.prisma.product.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mapProduct(r));
  }

  public async getProductById(id: string, tenantId?: string): Promise<Product | undefined> {
    if (!this.prisma) return undefined;
    const where: any = { id };
    if (tenantId) where.tenantId = tenantId;
    const row = await this.prisma.product.findFirst({ where });
    return row ? this.mapProduct(row) : undefined;
  }

  public async createProduct(product: Product): Promise<Product> {
    if (!this.prisma) throw new Error('Prisma database is not connected');
    const created = await this.prisma.product.create({
      data: {
        id: product.id,
        tenantId: product.tenantId,
        name: product.name,
        slug: product.slug,
        description: product.description || null,
        category: product.category,
        subCategory: product.subCategory || null,
        collection: product.collection || null,
        sku: product.sku,
        price: product.price,
        compareAtPrice: product.compareAtPrice ?? null,
        images: (product.images as any) || [],
        fabricIds: (product.fabricIds as any) || [],
        tags: (product.tags as any) || [],
        brandStorefrontPublished: product.brandStorefrontPublished ?? true,
        marketplacePublished: product.marketplacePublished ?? false,
        isTryOnEligible: product.isTryOnEligible ?? true,
        tryOnCategory: product.tryOnCategory || 'tops',
        specs: (product.specs as any) || {},
        variants: (product.variants as any) || [],
        createdAt: BigInt(product.createdAt),
        updatedAt: BigInt(product.updatedAt),
      },
    });
    return this.mapProduct(created);
  }

  public async updateProduct(id: string, tenantId: string, updates: Partial<Product>): Promise<Product | undefined> {
    if (!this.prisma) return undefined;
    const existing = await this.getProductById(id, tenantId);
    if (!existing) return undefined;

    const data: any = { updatedAt: BigInt(Date.now()) };
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.slug !== undefined) data.slug = updates.slug;
    if (updates.description !== undefined) data.description = updates.description;
    if (updates.category !== undefined) data.category = updates.category;
    if (updates.subCategory !== undefined) data.subCategory = updates.subCategory;
    if (updates.collection !== undefined) data.collection = updates.collection;
    if (updates.sku !== undefined) data.sku = updates.sku;
    if (updates.price !== undefined) data.price = updates.price;
    if (updates.compareAtPrice !== undefined) data.compareAtPrice = updates.compareAtPrice;
    if (updates.images !== undefined) data.images = updates.images as any;
    if (updates.fabricIds !== undefined) data.fabricIds = updates.fabricIds as any;
    if (updates.tags !== undefined) data.tags = updates.tags as any;
    if (updates.brandStorefrontPublished !== undefined) data.brandStorefrontPublished = updates.brandStorefrontPublished;
    if (updates.marketplacePublished !== undefined) data.marketplacePublished = updates.marketplacePublished;
    if (updates.isTryOnEligible !== undefined) data.isTryOnEligible = updates.isTryOnEligible;
    if (updates.tryOnCategory !== undefined) data.tryOnCategory = updates.tryOnCategory;
    if (updates.specs !== undefined) data.specs = updates.specs as any;
    if (updates.variants !== undefined) data.variants = updates.variants as any;

    const updated = await this.prisma.product.update({
      where: { id },
      data,
    });
    return this.mapProduct(updated);
  }

  public async deleteProduct(id: string, tenantId: string): Promise<boolean> {
    if (!this.prisma) return false;
    try {
      await this.prisma.product.deleteMany({
        where: { id, tenantId },
      });
      return true;
    } catch {
      return false;
    }
  }

  // ==========================================
  // Fabrics
  // ==========================================
  public async getFabricsByTenant(tenantId: string): Promise<Fabric[]> {
    if (!this.prisma) return [];
    const rows = await this.prisma.fabric.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mapFabric(r));
  }

  public async getFabricById(id: string, tenantId: string): Promise<Fabric | undefined> {
    if (!this.prisma) return undefined;
    const row = await this.prisma.fabric.findFirst({
      where: { id, tenantId },
    });
    return row ? this.mapFabric(row) : undefined;
  }

  public async createFabric(fabric: Fabric): Promise<Fabric> {
    if (!this.prisma) throw new Error('Prisma database is not connected');
    const created = await this.prisma.fabric.upsert({
      where: { id: fabric.id },
      update: {
        name: fabric.name,
        composition: fabric.composition,
        color: fabric.color,
        pattern: fabric.pattern,
        weightGsm: fabric.weightGsm ?? null,
        stretch: fabric.stretch ?? null,
        transparency: fabric.transparency ?? null,
        thickness: fabric.thickness ?? null,
        careInstructions: fabric.careInstructions ?? null,
        textureUrl: fabric.textureUrl ?? null,
      },
      create: {
        id: fabric.id,
        tenantId: fabric.tenantId,
        name: fabric.name,
        composition: fabric.composition,
        color: fabric.color,
        pattern: fabric.pattern,
        weightGsm: fabric.weightGsm ?? null,
        stretch: fabric.stretch ?? null,
        transparency: fabric.transparency ?? null,
        thickness: fabric.thickness ?? null,
        careInstructions: fabric.careInstructions ?? null,
        textureUrl: fabric.textureUrl ?? null,
        createdAt: BigInt(fabric.createdAt),
      },
    });
    return this.mapFabric(created);
  }

  public async updateFabric(id: string, tenantId: string, updates: Partial<Fabric>): Promise<Fabric | undefined> {
    if (!this.prisma) return undefined;
    const data: any = {};
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.composition !== undefined) data.composition = updates.composition;
    if (updates.color !== undefined) data.color = updates.color;
    if (updates.pattern !== undefined) data.pattern = updates.pattern;
    if (updates.weightGsm !== undefined) data.weightGsm = updates.weightGsm;
    if (updates.stretch !== undefined) data.stretch = updates.stretch;
    if (updates.transparency !== undefined) data.transparency = updates.transparency;
    if (updates.thickness !== undefined) data.thickness = updates.thickness;
    if (updates.careInstructions !== undefined) data.careInstructions = updates.careInstructions;
    if (updates.textureUrl !== undefined) data.textureUrl = updates.textureUrl;
    const res = await this.prisma.fabric.updateMany({
      where: { id, tenantId },
      data,
    });
    if (res.count === 0) return undefined;
    return this.getFabricById(id, tenantId);
  }

  public async deleteFabric(id: string, tenantId: string): Promise<boolean> {
    if (!this.prisma) return false;
    const res = await this.prisma.fabric.deleteMany({
      where: { id, tenantId },
    });
    return res.count > 0;
  }

  public async hydrateAll(): Promise<{
    tenants: Tenant[];
    users: User[];
    authTokens: AuthToken[];
    products: Product[];
    fabrics: Fabric[];
    subscriptions: Subscription[];
    orders: Order[];
    inventoryLogs: InventoryLog[];
    auditLogs: AuditLog[];
    generationJobs: GenerationJob[];
    usageLedger: UsageLedgerEntry[];
  } | null> {
    if (!this.prisma || !this.connected) return null;
    const now = BigInt(Date.now());
    const [
      tenantRows,
      userRows,
      tokenRows,
      productRows,
      fabricRows,
      subRows,
      orderRows,
      invRows,
      auditRows,
      genRows,
      ledgerRows,
    ] = await Promise.all([
      this.prisma.tenant.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.authToken.findMany({
        where: { usedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.product.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.fabric.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.subscription.findMany(),
      this.prisma.order.findMany({ orderBy: { createdAt: 'desc' } }),
      this.prisma.inventoryLog.findMany({ orderBy: { timestamp: 'desc' }, take: 500 }),
      this.prisma.auditLog.findMany({ orderBy: { timestamp: 'desc' }, take: 500 }),
      this.prisma.generationJob.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.usageLedger.findMany({ orderBy: { createdAt: 'asc' } }),
    ]);

    return {
      tenants: tenantRows.map((r) => this.mapTenant(r)),
      users: userRows.map((r) => this.mapUser(r)),
      authTokens: tokenRows.map((r) => this.mapAuthToken(r)),
      products: productRows.map((r) => this.mapProduct(r)),
      fabrics: fabricRows.map((r) => this.mapFabric(r)),
      subscriptions: subRows.map((r) => this.mapSubscription(r)),
      orders: orderRows.map((r) => this.mapOrder(r)),
      inventoryLogs: invRows.map((r) => this.mapInventoryLog(r)),
      auditLogs: auditRows.map((r) => this.mapAuditLog(r)),
      generationJobs: genRows.map((r: any) => ({
        id: r.id,
        tenantId: r.tenantId,
        productId: r.productId,
        category: r.category,
        status: r.status,
        accessTokenHash: r.accessTokenHash,
        idempotencyKey: r.idempotencyKey ?? undefined,
        providerJobId: r.providerJobId ?? undefined,
        errorCode: r.errorCode ?? undefined,
        createdAt: Number(r.createdAt),
        updatedAt: Number(r.updatedAt),
      })),
      usageLedger: ledgerRows.map((r: any) => ({
        id: r.id,
        generationId: r.generationId,
        tenantId: r.tenantId,
        billingPeriod: r.billingPeriod,
        reservedUnits: r.reservedUnits,
        finalUnits: r.finalUnits ?? undefined,
        status: r.status,
        createdAt: Number(r.createdAt),
        updatedAt: Number(r.updatedAt),
      })),
    };
  }

  public async saveGeneration(job: GenerationJob, entry: UsageLedgerEntry, sub: Subscription): Promise<void> {
    if (!this.prisma || !this.connected) return;
    await this.prisma.$transaction([
      this.prisma.generationJob.upsert({
        where: { id: job.id },
        create: {
          id: job.id, tenantId: job.tenantId, productId: job.productId, category: job.category,
          status: job.status, accessTokenHash: job.accessTokenHash, idempotencyKey: job.idempotencyKey ?? null,
          providerJobId: job.providerJobId ?? null, errorCode: job.errorCode ?? null,
          createdAt: BigInt(job.createdAt), updatedAt: BigInt(job.updatedAt),
        },
        update: {
          status: job.status, providerJobId: job.providerJobId ?? null,
          errorCode: job.errorCode ?? null, updatedAt: BigInt(job.updatedAt),
        },
      }),
      this.prisma.usageLedger.upsert({
        where: { generationId: entry.generationId },
        create: {
          id: entry.id, generationId: entry.generationId, tenantId: entry.tenantId,
          billingPeriod: entry.billingPeriod, reservedUnits: entry.reservedUnits,
          finalUnits: entry.finalUnits ?? null, status: entry.status,
          createdAt: BigInt(entry.createdAt), updatedAt: BigInt(entry.updatedAt),
        },
        update: {
          finalUnits: entry.finalUnits ?? null, status: entry.status, updatedAt: BigInt(entry.updatedAt),
        },
      }),
      this.prisma.subscription.updateMany({
        where: { tenantId: sub.tenantId },
        data: { tryOnUsed: sub.tryOnUsed, updatedAt: BigInt(sub.updatedAt) },
      }),
    ]);
  }

  public async getTableCounts(): Promise<Record<string, number> | null> {
    if (!this.prisma || !this.connected) return null;
    const [tenants, users, authTokens, products, fabrics, orders, auditLogs] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.user.count(),
      this.prisma.authToken.count(),
      this.prisma.product.count(),
      this.prisma.fabric.count(),
      this.prisma.order.count(),
      this.prisma.auditLog.count(),
    ]);
    return { tenants, users, authTokens, products, fabrics, orders, auditLogs };
  }

  public async syncCollections(collections: {
    tenants: Tenant[];
    users: User[];
    products: Product[];
    fabrics: Fabric[];
    subscriptions: Subscription[];
    orders: Order[];
    auditLogs: AuditLog[];
  }): Promise<{ synced: Record<string, number> }> {
    if (!this.prisma || !this.connected) {
      throw new Error('PostgreSQL / Supabase connection is not active');
    }

    for (const t of collections.tenants) {
      await this.prisma.tenant.upsert({
        where: { id: t.id },
        update: {
          name: t.name,
          slug: t.slug,
          status: t.status,
          logoUrl: t.logoUrl || null,
          bannerUrl: t.bannerUrl || null,
          description: t.description || null,
          contactEmail: t.contactEmail,
          storefrontSettings: (t.storefrontSettings as any) || {},
          updatedAt: BigInt(t.updatedAt),
        },
        create: {
          id: t.id,
          name: t.name,
          slug: t.slug,
          status: t.status,
          logoUrl: t.logoUrl || null,
          bannerUrl: t.bannerUrl || null,
          description: t.description || null,
          contactEmail: t.contactEmail,
          storefrontSettings: (t.storefrontSettings as any) || {},
          createdAt: BigInt(t.createdAt),
          updatedAt: BigInt(t.updatedAt),
        },
      });
    }

    for (const u of collections.users) {
      await this.prisma.user.upsert({
        where: { id: u.id },
        update: {
          tenantId: u.tenantId || null,
          name: u.name,
          email: u.email,
          passwordHash: u.passwordHash,
          role: u.role,
          emailVerified: Boolean(u.emailVerified),
          emailVerifiedAt: u.emailVerifiedAt ? BigInt(u.emailVerifiedAt) : null,
          updatedAt: u.updatedAt ? BigInt(u.updatedAt) : null,
        },
        create: {
          id: u.id,
          tenantId: u.tenantId || null,
          name: u.name,
          email: u.email,
          passwordHash: u.passwordHash,
          role: u.role,
          emailVerified: Boolean(u.emailVerified),
          emailVerifiedAt: u.emailVerifiedAt ? BigInt(u.emailVerifiedAt) : null,
          updatedAt: u.updatedAt ? BigInt(u.updatedAt) : null,
          createdAt: BigInt(u.createdAt),
        },
      });
    }

    for (const f of collections.fabrics) {
      await this.createFabric(f);
    }

    for (const p of collections.products) {
      await this.prisma.product.upsert({
        where: { id: p.id },
        update: {
          name: p.name,
          slug: p.slug,
          description: p.description || null,
          category: p.category,
          subCategory: p.subCategory || null,
          collection: p.collection || null,
          sku: p.sku,
          price: p.price,
          compareAtPrice: p.compareAtPrice ?? null,
          images: (p.images as any) || [],
          fabricIds: (p.fabricIds as any) || [],
          tags: (p.tags as any) || [],
          brandStorefrontPublished: p.brandStorefrontPublished,
          marketplacePublished: p.marketplacePublished,
          isTryOnEligible: p.isTryOnEligible,
          tryOnCategory: p.tryOnCategory,
          specs: (p.specs as any) || {},
          variants: (p.variants as any) || [],
          updatedAt: BigInt(p.updatedAt),
        },
        create: {
          id: p.id,
          tenantId: p.tenantId,
          name: p.name,
          slug: p.slug,
          description: p.description || null,
          category: p.category,
          subCategory: p.subCategory || null,
          collection: p.collection || null,
          sku: p.sku,
          price: p.price,
          compareAtPrice: p.compareAtPrice ?? null,
          images: (p.images as any) || [],
          fabricIds: (p.fabricIds as any) || [],
          tags: (p.tags as any) || [],
          brandStorefrontPublished: p.brandStorefrontPublished,
          marketplacePublished: p.marketplacePublished,
          isTryOnEligible: p.isTryOnEligible,
          tryOnCategory: p.tryOnCategory,
          specs: (p.specs as any) || {},
          variants: (p.variants as any) || [],
          createdAt: BigInt(p.createdAt),
          updatedAt: BigInt(p.updatedAt),
        },
      });
    }

    for (const s of collections.subscriptions) {
      await this.prisma.subscription.upsert({
        where: { tenantId: s.tenantId },
        update: {
          plan: s.plan,
          productLimit: s.productLimit,
          tryOnMonthlyQuota: s.tryOnMonthlyQuota,
          tryOnUsed: s.tryOnUsed,
          status: s.status,
          updatedAt: BigInt(s.updatedAt),
        },
        create: {
          id: `sub_${s.tenantId}`,
          tenantId: s.tenantId,
          plan: s.plan,
          productLimit: s.productLimit,
          tryOnMonthlyQuota: s.tryOnMonthlyQuota,
          tryOnUsed: s.tryOnUsed,
          status: s.status,
          updatedAt: BigInt(s.updatedAt),
        },
      });
    }

    for (const o of collections.orders) {
      await this.prisma.order.upsert({
        where: { id: o.id },
        update: {
          status: o.status,
          paymentStatus: o.paymentStatus,
          updatedAt: BigInt(o.updatedAt),
        },
        create: {
          id: o.id,
          tenantId: o.tenantId,
          customerId: o.customerId || null,
          customerEmail: o.customerEmail,
          status: o.status,
          totalAmount: o.totalAmount,
          subtotal: o.subtotal,
          shippingFee: o.shippingFee || 0,
          shippingAddress: (o.shippingAddress as any) || {},
          items: (o.items as any) || [],
          paymentStatus: o.paymentStatus || 'PENDING',
          createdAt: BigInt(o.createdAt),
          updatedAt: BigInt(o.updatedAt),
        },
      });
    }

    for (const a of collections.auditLogs.slice(0, 100)) {
      await this.prisma.auditLog.upsert({
        where: { id: a.id },
        update: {},
        create: {
          id: a.id,
          tenantId: a.tenantId || null,
          actorId: a.actorId,
          actorRole: a.actorRole,
          action: a.action,
          entity: a.entity,
          entityId: a.entityId || null,
          details: (a.details as any) || {},
          timestamp: BigInt(a.timestamp),
        },
      });
    }

    return {
      synced: {
        tenants: collections.tenants.length,
        users: collections.users.length,
        fabrics: collections.fabrics.length,
        products: collections.products.length,
        subscriptions: collections.subscriptions.length,
        orders: collections.orders.length,
      },
    };
  }

  // ==========================================
  // Subscriptions
  // ==========================================
  public async getSubscription(tenantId: string): Promise<Subscription | undefined> {
    if (!this.prisma) return undefined;
    const row = await this.prisma.subscription.findUnique({
      where: { tenantId },
    });
    return row ? this.mapSubscription(row) : undefined;
  }

  public async updateSubscription(tenantId: string, sub: Subscription): Promise<void> {
    if (!this.prisma) return;
    await this.prisma.subscription.updateMany({
      where: { tenantId },
      data: {
        plan: sub.plan,
        productLimit: sub.productLimit,
        tryOnMonthlyQuota: sub.tryOnMonthlyQuota,
        status: sub.status,
        updatedAt: BigInt(sub.updatedAt),
      },
    });
  }

  public async recordTryOnUsage(tenantId: string): Promise<void> {
    if (!this.prisma) return;
    try {
      await this.prisma.subscription.update({
        where: { tenantId },
        data: {
          tryOnUsed: { increment: 1 },
          updatedAt: BigInt(Date.now()),
        },
      });
    } catch (err: any) {
      console.warn('[Prisma DB] Error incrementing tryOnUsed:', err.message);
    }
  }

  // ==========================================
  // Orders
  // ==========================================
  public async getOrdersByTenant(tenantId: string): Promise<Order[]> {
    if (!this.prisma) return [];
    const rows = await this.prisma.order.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mapOrder(r));
  }

  public async getOrderById(id: string, tenantId?: string): Promise<Order | undefined> {
    if (!this.prisma) return undefined;
    const where: any = { id };
    if (tenantId) where.tenantId = tenantId;
    const row = await this.prisma.order.findFirst({ where });
    return row ? this.mapOrder(row) : undefined;
  }

  public async createOrder(order: Order): Promise<Order> {
    if (!this.prisma) throw new Error('Prisma database is not connected');
    const created = await this.prisma.order.create({
      data: {
        id: order.id,
        tenantId: order.tenantId,
        customerId: order.customerId || null,
        customerEmail: order.customerEmail,
        status: order.status,
        totalAmount: order.totalAmount,
        subtotal: order.subtotal,
        shippingFee: order.shippingFee || 0,
        shippingAddress: (order.shippingAddress as any) || {},
        items: (order.items as any) || [],
        paymentStatus: order.paymentStatus || 'PENDING',
        createdAt: BigInt(order.createdAt),
        updatedAt: BigInt(order.updatedAt),
      },
    });
    return this.mapOrder(created);
  }

  public async updateOrderStatus(id: string, tenantId: string, status: OrderStatus): Promise<Order | undefined> {
    if (!this.prisma) return undefined;
    try {
      const res = await this.prisma.order.updateMany({
        where: { id, tenantId },
        data: {
          status,
          updatedAt: BigInt(Date.now()),
        },
      });
      if (res.count === 0) return undefined;
      return this.getOrderById(id, tenantId);
    } catch {
      return undefined;
    }
  }

  // ==========================================
  // Inventory Logs
  // ==========================================
  public async recordInventoryLog(log: Omit<InventoryLog, 'id' | 'timestamp'>): Promise<InventoryLog> {
    if (!this.prisma) throw new Error('Prisma database is not connected');
    const now = Date.now();
    const created = await this.prisma.inventoryLog.create({
      data: {
        id: `inv_${now}_${Math.random().toString(36).substring(2, 6)}`,
        tenantId: log.tenantId,
        productId: log.productId,
        variantSku: log.variantSku,
        change: log.change,
        newStock: log.newStock,
        reason: log.reason,
        timestamp: BigInt(now),
      },
    });
    return this.mapInventoryLog(created);
  }

  public async getInventoryLogs(tenantId: string, productId?: string): Promise<InventoryLog[]> {
    if (!this.prisma) return [];
    const where: any = { tenantId };
    if (productId) where.productId = productId;
    const rows = await this.prisma.inventoryLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
    });
    return rows.map((r) => this.mapInventoryLog(r));
  }

  // ==========================================
  // Audit Logs
  // ==========================================
  public async recordAuditLog(log: Omit<AuditLog, 'id' | 'timestamp'>): Promise<AuditLog> {
    if (!this.prisma) throw new Error('Prisma database is not connected');
    const now = Date.now();
    const created = await this.prisma.auditLog.create({
      data: {
        id: `audit_${now}_${Math.random().toString(36).substring(2, 6)}`,
        tenantId: log.tenantId || null,
        actorId: log.actorId,
        actorRole: log.actorRole,
        action: log.action,
        entity: log.entity,
        entityId: log.entityId || null,
        details: (log.details as any) || {},
        timestamp: BigInt(now),
      },
    });
    return this.mapAuditLog(created);
  }

  public async getAuditLogs(tenantId?: string): Promise<AuditLog[]> {
    if (!this.prisma) return [];
    const where: any = tenantId ? { tenantId } : {};
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: 500,
    });
    return rows.map((r) => this.mapAuditLog(r));
  }

  // ==========================================
  // Demo Seed
  // ==========================================
  public async seedInitialData(): Promise<void> {
    if (!this.prisma) return;
    const now = Date.now();

    await this.prisma.tenant.upsert({
      where: { id: 'tenant_aura' },
      update: {},
      create: {
        id: 'tenant_aura',
        name: 'Aura Atelier',
        slug: 'aura-atelier',
        status: 'ACTIVE',
        logoUrl: 'https://images.unsplash.com/photo-1549298916-b41d501d3772?w=200',
        bannerUrl: 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=1200',
        description: 'Contemporary minimalist luxury silhouettes.',
        contactEmail: 'contact@auraatelier.com',
        storefrontSettings: { primaryColor: '#0f172a', accentColor: '#38bdf8' } as any,
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
      },
    });

    await this.prisma.tenant.upsert({
      where: { id: 'tenant_vogue' },
      update: {},
      create: {
        id: 'tenant_vogue',
        name: 'Vogue Nova',
        slug: 'vogue-nova',
        status: 'ACTIVE',
        logoUrl: 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=200',
        bannerUrl: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1200',
        description: 'Bold streetwear and tailored statement wear.',
        contactEmail: 'hello@voguenova.com',
        storefrontSettings: { primaryColor: '#18181b', accentColor: '#f43f5e' } as any,
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
      },
    });

    await this.prisma.subscription.upsert({
      where: { tenantId: 'tenant_aura' },
      update: {},
      create: {
        id: 'sub_aura',
        tenantId: 'tenant_aura',
        plan: 'PRO',
        productLimit: 150,
        tryOnMonthlyQuota: 1000,
        tryOnUsed: 124,
        status: 'ACTIVE',
        updatedAt: BigInt(now),
      },
    });

    await this.prisma.subscription.upsert({
      where: { tenantId: 'tenant_vogue' },
      update: {},
      create: {
        id: 'sub_vogue',
        tenantId: 'tenant_vogue',
        plan: 'ENTERPRISE',
        productLimit: 500,
        tryOnMonthlyQuota: 5000,
        tryOnUsed: 312,
        status: 'ACTIVE',
        updatedAt: BigInt(now),
      },
    });

    console.log('[Prisma DB] Initial seed data successfully populated with Prisma.');
  }

  // ==========================================
  // Entity Mappers
  // ==========================================
  private mapTenant(row: any): Tenant {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status as TenantStatus,
      logoUrl: row.logoUrl || undefined,
      bannerUrl: row.bannerUrl || undefined,
      description: row.description || undefined,
      contactEmail: row.contactEmail,
      storefrontSettings: (row.storefrontSettings as StorefrontSettings) || undefined,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  private mapUser(row: any): User {
    return {
      id: row.id,
      tenantId: row.tenantId || undefined,
      name: row.name,
      email: row.email,
      passwordHash: row.passwordHash,
      role: row.role as UserRole,
      emailVerified: Boolean(row.emailVerified),
      emailVerifiedAt: row.emailVerifiedAt ? Number(row.emailVerifiedAt) : undefined,
      updatedAt: row.updatedAt ? Number(row.updatedAt) : undefined,
      createdAt: Number(row.createdAt),
    };
  }

  private mapAuthToken(row: any): AuthToken {
    return {
      id: row.id,
      userId: row.userId,
      email: row.email,
      type: row.type as AuthTokenType,
      tokenHash: row.tokenHash,
      otpCodeHash: row.otpCodeHash || undefined,
      portal: (row.portal || 'marketplace') as AuthPortal,
      expiresAt: Number(row.expiresAt),
      usedAt: row.usedAt ? Number(row.usedAt) : undefined,
      createdAt: Number(row.createdAt),
    };
  }

  private mapProduct(row: any): Product {
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      slug: row.slug,
      description: row.description || '',
      category: row.category,
      subCategory: row.subCategory || undefined,
      collection: row.collection || undefined,
      sku: row.sku,
      price: Number(row.price),
      compareAtPrice: row.compareAtPrice ? Number(row.compareAtPrice) : undefined,
      images: Array.isArray(row.images) ? (row.images as string[]) : [],
      fabricIds: Array.isArray(row.fabricIds) ? (row.fabricIds as string[]) : [],
      tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
      brandStorefrontPublished: Boolean(row.brandStorefrontPublished),
      marketplacePublished: Boolean(row.marketplacePublished),
      isTryOnEligible: Boolean(row.isTryOnEligible),
      tryOnCategory: row.tryOnCategory as TryOnCategory,
      specs: (row.specs as Record<string, string>) || undefined,
      variants: Array.isArray(row.variants) ? (row.variants as ProductVariant[]) : [],
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  private mapFabric(row: any): Fabric {
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      composition: row.composition,
      color: row.color,
      pattern: row.pattern,
      weightGsm: row.weightGsm ?? undefined,
      stretch: (row.stretch as any) ?? undefined,
      transparency: (row.transparency as any) ?? undefined,
      thickness: (row.thickness as any) ?? undefined,
      careInstructions: row.careInstructions ?? undefined,
      textureUrl: row.textureUrl ?? undefined,
      createdAt: Number(row.createdAt),
    };
  }

  private mapSubscription(row: any): Subscription {
    return {
      tenantId: row.tenantId,
      plan: row.plan as SubscriptionPlan,
      productLimit: row.productLimit,
      tryOnMonthlyQuota: row.tryOnMonthlyQuota,
      tryOnUsed: row.tryOnUsed,
      status: row.status as any,
      updatedAt: Number(row.updatedAt),
    };
  }

  private mapOrder(row: any): Order {
    return {
      id: row.id,
      tenantId: row.tenantId,
      customerId: row.customerId || undefined,
      customerEmail: row.customerEmail,
      shippingAddress: row.shippingAddress as ShippingAddress,
      items: (row.items as OrderItem[]) || [],
      subtotal: Number(row.subtotal),
      shippingFee: Number(row.shippingFee),
      totalAmount: Number(row.totalAmount),
      status: row.status as OrderStatus,
      paymentStatus: row.paymentStatus as PaymentStatus,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  private mapInventoryLog(row: any): InventoryLog {
    return {
      id: row.id,
      tenantId: row.tenantId,
      productId: row.productId,
      variantSku: row.variantSku,
      change: row.change,
      newStock: row.newStock,
      reason: row.reason,
      timestamp: Number(row.timestamp),
    };
  }

  private mapAuditLog(row: any): AuditLog {
    return {
      id: row.id,
      tenantId: row.tenantId || undefined,
      actorId: row.actorId,
      actorRole: row.actorRole as UserRole,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId || undefined,
      details: (row.details as Record<string, any>) || undefined,
      timestamp: Number(row.timestamp),
    };
  }
}
