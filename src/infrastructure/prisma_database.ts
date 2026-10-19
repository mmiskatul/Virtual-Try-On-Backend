import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { createPrismaInstance, disconnectPrisma } from './prisma.js';
import {
  Tenant,
  User,
  Product,
  Fabric,
  InventoryLog,
  Subscription,
  Order,
  AuditLog,
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
    const created = await this.prisma.user.create({
      data: {
        id: user.id,
        tenantId: user.tenantId || null,
        name: user.name,
        email: user.email,
        passwordHash: user.passwordHash,
        role: user.role,
        createdAt: BigInt(user.createdAt),
      },
    });
    return this.mapUser(created);
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
    const created = await this.prisma.fabric.create({
      data: {
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
      const updated = await this.prisma.order.update({
        where: { id },
        data: {
          status,
          updatedAt: BigInt(Date.now()),
        },
      });
      return this.mapOrder(updated);
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
