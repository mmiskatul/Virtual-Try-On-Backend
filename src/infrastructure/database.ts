import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  Tenant, User, Product, Fabric, InventoryLog,
  Subscription, Order, AuditLog
} from '../domain/types.js';
import { config } from './config.js';
import { NeonSqlDatabase } from './neon_database.js';

export interface DatabaseCollections {
  tenants: Tenant[];
  users: User[];
  products: Product[];
  fabrics: Fabric[];
  inventoryLogs: InventoryLog[];
  subscriptions: Subscription[];
  orders: Order[];
  auditLogs: AuditLog[];
}

export class Database {
  private data: DatabaseCollections = {
    tenants: [],
    users: [],
    products: [],
    fabrics: [],
    inventoryLogs: [],
    subscriptions: [],
    orders: [],
    auditLogs: []
  };

  private snapshotPath: string;
  private neonSql: NeonSqlDatabase | null = null;
  private transactionLock: Promise<void> = Promise.resolve();

  constructor(customSnapshotPath?: string) {
    this.snapshotPath = customSnapshotPath || path.resolve(process.cwd(), '.data', 'db_snapshot.json');
    this.init();
    if (config.databaseUrl) {
      this.initNeonSql(config.databaseUrl);
    }
  }

  private async initNeonSql(url: string): Promise<void> {
    try {
      this.neonSql = new NeonSqlDatabase(url);
      const connected = await this.neonSql.init();
      if (connected) {
        console.log('[Database] Active persistence: Neon PostgreSQL Serverless SQL database.');
      }
    } catch (err: any) {
      console.warn('[Database] Neon SQL init failed, running on resilient memory snapshot:', err.message);
    }
  }

  public isNeonSqlActive(): boolean {
    return this.neonSql !== null && this.neonSql.isConnected();
  }

  public getNeonSql(): NeonSqlDatabase | null {
    return this.neonSql;
  }

  private init() {
    try {
      const dir = path.dirname(this.snapshotPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(this.snapshotPath)) {
        const raw = fs.readFileSync(this.snapshotPath, 'utf-8');
        this.data = JSON.parse(raw);
        if (!this.data.auditLogs) this.data.auditLogs = [];
      } else {
        this.seedDemoData();
        this.save();
      }
    } catch (err) {
      console.warn('[Database] Snapshot init error, resetting to seed data:', err);
      this.seedDemoData();
    }
  }

  public save() {
    try {
      fs.writeFileSync(this.snapshotPath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Database] Failed to save snapshot:', err);
    }
  }

  public reset() {
    this.seedDemoData();
    this.save();
  }

  public hashPassword(password: string): string {
    return crypto.createHash('sha256').update(password + config.passwordSalt).digest('hex');
  }

  public async runTransaction<T>(action: () => Promise<T> | T): Promise<T> {
    const previousLock = this.transactionLock;
    let releaseLock: () => void;
    this.transactionLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    await previousLock;
    try {
      const result = await action();
      this.save();
      return result;
    } finally {
      releaseLock!();
    }
  }

  public seedDemoData() {
    const now = Date.now();

    // 1. Seed Tenants
    const tenant1: Tenant = {
      id: 'tenant_aura',
      name: 'Aura Atelier',
      slug: 'aura-atelier',
      status: 'ACTIVE',
      logoUrl: 'https://images.unsplash.com/photo-1549298916-b41d501d3772?w=200&auto=format&fit=crop&q=80',
      bannerUrl: 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=1200&auto=format&fit=crop&q=80',
      description: 'Contemporary minimalist high-fashion silhouettes and organic luxury linens.',
      contactEmail: 'contact@auraatelier.com',
      storefrontSettings: {
        primaryColor: '#0f172a',
        accentColor: '#38bdf8',
        announcement: 'Free worldwide express shipping on orders over $150',
        aboutText: 'Crafted for those who value quiet luxury and sustainable elegance.'
      },
      createdAt: now,
      updatedAt: now
    };

    const tenant2: Tenant = {
      id: 'tenant_vogue',
      name: 'Vogue Nova',
      slug: 'vogue-nova',
      status: 'ACTIVE',
      logoUrl: 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=200&auto=format&fit=crop&q=80',
      bannerUrl: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1200&auto=format&fit=crop&q=80',
      description: 'Bold streetwear, tailored blazers, and urban statement aesthetics.',
      contactEmail: 'hello@voguenova.com',
      storefrontSettings: {
        primaryColor: '#18181b',
        accentColor: '#f43f5e',
        announcement: 'New Autumn/Winter Drop Available Now',
        aboutText: 'Empowering urban statement wear made with recycled technical fabrics.'
      },
      createdAt: now,
      updatedAt: now
    };

    this.data.tenants = [tenant1, tenant2];

    // 2. Seed Users
    const superAdmin: User = {
      id: 'user_admin',
      name: 'Platform Super Admin',
      email: 'admin@vton-platform.io',
      passwordHash: this.hashPassword('Admin@123456'),
      role: 'SUPER_ADMIN',
      createdAt: now
    };

    const brandOwner1: User = {
      id: 'user_aura_owner',
      tenantId: 'tenant_aura',
      name: 'Elena Rostova',
      email: 'elena@auraatelier.com',
      passwordHash: this.hashPassword('Aura@123456'),
      role: 'BRAND_OWNER',
      createdAt: now
    };

    const brandOwner2: User = {
      id: 'user_vogue_owner',
      tenantId: 'tenant_vogue',
      name: 'Marcus Sterling',
      email: 'marcus@voguenova.com',
      passwordHash: this.hashPassword('Vogue@123456'),
      role: 'BRAND_OWNER',
      createdAt: now
    };

    const customerUser: User = {
      id: 'user_customer_demo',
      name: 'Sophia Chen',
      email: 'sophia@example.com',
      passwordHash: this.hashPassword('Customer@123456'),
      role: 'CUSTOMER',
      createdAt: now
    };

    this.data.users = [superAdmin, brandOwner1, brandOwner2, customerUser];

    // 3. Seed Fabrics
    const fabric1: Fabric = {
      id: 'fab_silk_crepe',
      tenantId: 'tenant_aura',
      name: 'Mulberry Silk Crepe',
      composition: '100% Organic Silk',
      color: 'Champagne Ivory',
      pattern: 'Solid Matte',
      weightGsm: 120,
      stretch: 'LOW',
      transparency: 'OPAQUE',
      thickness: 'LIGHT',
      careInstructions: 'Dry clean only or cold gentle hand wash with pH-neutral detergent.',
      createdAt: now
    };

    const fabric2: Fabric = {
      id: 'fab_tech_twill',
      tenantId: 'tenant_vogue',
      name: 'Recycled Technical Twill',
      composition: '88% Recycled Poly, 12% Elastane',
      color: 'Midnight Obsidian',
      pattern: 'Micro-weave',
      weightGsm: 260,
      stretch: 'HIGH',
      transparency: 'OPAQUE',
      thickness: 'MEDIUM',
      careInstructions: 'Machine wash cold inside out, hang to dry.',
      createdAt: now
    };

    this.data.fabrics = [fabric1, fabric2];

    // 4. Seed Products
    const product1: Product = {
      id: 'prod_aura_dress_01',
      tenantId: 'tenant_aura',
      name: 'Astral Silk Bias Slip Dress',
      slug: 'astral-silk-bias-slip-dress',
      description: 'Floor-grazing evening slip crafted from 19mm mulberry silk crepe with subtle cowled neckline.',
      category: 'Dresses',
      subCategory: 'Evening',
      collection: 'Nocturne 2026',
      sku: 'AUR-DRS-001',
      price: 285.0,
      compareAtPrice: 340.0,
      images: [
        'https://images.unsplash.com/photo-1515372039744-b8f02a3ae446?w=800&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1539109136881-3be0616acf4b?w=800&auto=format&fit=crop&q=80'
      ],
      fabricIds: ['fab_silk_crepe'],
      tags: ['silk', 'slip', 'minimalist', 'evening', 'dress'],
      brandStorefrontPublished: true,
      marketplacePublished: true,
      isTryOnEligible: true,
      tryOnCategory: 'dresses',
      specs: { Length: 'Maxi (135cm)', Fit: 'Bias Cut Slim Fit' },
      variants: [
        { id: 'v_aura_1', sku: 'AUR-DRS-001-S', size: 'S', color: 'Champagne Ivory', stockQuantity: 14, available: true },
        { id: 'v_aura_2', sku: 'AUR-DRS-001-M', size: 'M', color: 'Champagne Ivory', stockQuantity: 22, available: true },
        { id: 'v_aura_3', sku: 'AUR-DRS-001-L', size: 'L', color: 'Champagne Ivory', stockQuantity: 8, available: true }
      ],
      createdAt: now,
      updatedAt: now
    };

    const product2: Product = {
      id: 'prod_vogue_jacket_01',
      tenantId: 'tenant_vogue',
      name: 'Cyber-Tailored Oversized Blazer',
      slug: 'cyber-tailored-oversized-blazer',
      description: 'Structural power shoulder blazer tailored with technical weatherproof twill.',
      category: 'Outerwear',
      subCategory: 'Blazers',
      collection: 'Neo-Tokyo Autumn',
      sku: 'VOG-BLZ-092',
      price: 320.0,
      compareAtPrice: 380.0,
      images: [
        'https://images.unsplash.com/photo-1584273143981-41c073dfe8f8?w=800&auto=format&fit=crop&q=80'
      ],
      fabricIds: ['fab_tech_twill'],
      tags: ['blazer', 'streetwear', 'tailored', 'oversized'],
      brandStorefrontPublished: true,
      marketplacePublished: true,
      isTryOnEligible: true,
      tryOnCategory: 'outerwear',
      specs: { Closure: 'Double-breasted magnetic snap' },
      variants: [
        { id: 'v_vog_1', sku: 'VOG-BLZ-092-M', size: 'M', color: 'Midnight Obsidian', stockQuantity: 18, available: true },
        { id: 'v_vog_2', sku: 'VOG-BLZ-092-L', size: 'L', color: 'Midnight Obsidian', stockQuantity: 12, available: true }
      ],
      createdAt: now,
      updatedAt: now
    };

    const product3: Product = {
      id: 'prod_aura_top_02',
      tenantId: 'tenant_aura',
      name: 'Sculpted Linen Cross-Halter Top',
      slug: 'sculpted-linen-cross-halter-top',
      description: 'Hand-pleated halter bodice with architectural front crossover.',
      category: 'Tops',
      subCategory: 'Tops & Blouses',
      collection: 'Summer Solstice',
      sku: 'AUR-TOP-044',
      price: 135.0,
      images: [
        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&auto=format&fit=crop&q=80'
      ],
      fabricIds: ['fab_silk_crepe'],
      tags: ['linen', 'halter', 'summer'],
      brandStorefrontPublished: true,
      marketplacePublished: false, // Brand-only catalog
      isTryOnEligible: true,
      tryOnCategory: 'tops',
      variants: [
        { id: 'v_aura_top_1', sku: 'AUR-TOP-044-S', size: 'S', color: 'Ecru Sand', stockQuantity: 15, available: true }
      ],
      createdAt: now,
      updatedAt: now
    };

    this.data.products = [product1, product2, product3];

    // 5. Seed Subscriptions
    this.data.subscriptions = [
      { tenantId: 'tenant_aura', plan: 'PRO', productLimit: 150, tryOnMonthlyQuota: 1000, tryOnUsed: 124, status: 'ACTIVE', updatedAt: now },
      { tenantId: 'tenant_vogue', plan: 'ENTERPRISE', productLimit: 500, tryOnMonthlyQuota: 5000, tryOnUsed: 312, status: 'ACTIVE', updatedAt: now }
    ];

    // 6. Seed Sample Order
    this.data.orders = [
      {
        id: 'ord_demo_1001',
        tenantId: 'tenant_aura',
        customerId: 'user_customer_demo',
        customerEmail: 'sophia@example.com',
        shippingAddress: {
          fullName: 'Sophia Chen',
          street: '742 Evergreen Terrace',
          city: 'San Francisco',
          state: 'CA',
          zipCode: '94107',
          country: 'US'
        },
        items: [
          {
            productId: 'prod_aura_dress_01',
            variantSku: 'AUR-DRS-001-M',
            productName: 'Astral Silk Bias Slip Dress',
            size: 'M',
            color: 'Champagne Ivory',
            quantity: 1,
            unitPrice: 285.0,
            lineTotal: 285.0,
            imageUrl: 'https://images.unsplash.com/photo-1515372039744-b8f02a3ae446?w=800'
          }
        ],
        subtotal: 285.0,
        shippingFee: 0,
        totalAmount: 285.0,
        status: 'PROCESSING',
        paymentStatus: 'PAID',
        createdAt: now - 86400000,
        updatedAt: now - 86400000
      }
    ];

    // 7. Seed Audit Logs
    this.data.auditLogs = [
      {
        id: 'audit_01',
        actorId: 'user_admin',
        actorRole: 'SUPER_ADMIN',
        action: 'TENANT_ONBOARDED',
        entity: 'Tenant',
        entityId: 'tenant_aura',
        details: { name: 'Aura Atelier', plan: 'PRO' },
        timestamp: now - 172800000
      },
      {
        id: 'audit_02',
        actorId: 'user_admin',
        actorRole: 'SUPER_ADMIN',
        action: 'TENANT_ONBOARDED',
        entity: 'Tenant',
        entityId: 'tenant_vogue',
        details: { name: 'Vogue Nova', plan: 'ENTERPRISE' },
        timestamp: now - 86400000
      }
    ];
  }

  // --- Tenants ---
  public getTenants(): Tenant[] {
    return this.data.tenants;
  }

  public getTenantById(id: string): Tenant | undefined {
    return this.data.tenants.find(t => t.id === id);
  }

  public getTenantBySlug(slug: string): Tenant | undefined {
    return this.data.tenants.find(t => t.slug === slug);
  }

  public createTenant(tenant: Tenant): Tenant {
    this.data.tenants.push(tenant);
    this.data.subscriptions.push({
      tenantId: tenant.id,
      plan: 'STARTER',
      productLimit: 50,
      tryOnMonthlyQuota: 500,
      tryOnUsed: 0,
      status: 'ACTIVE',
      updatedAt: Date.now()
    });
    this.save();
    return tenant;
  }

  public updateTenant(id: string, updates: Partial<Tenant>): Tenant | undefined {
    const idx = this.data.tenants.findIndex(t => t.id === id);
    if (idx === -1) return undefined;
    this.data.tenants[idx] = {
      ...this.data.tenants[idx],
      ...updates,
      updatedAt: Date.now()
    };
    this.save();
    return this.data.tenants[idx];
  }

  // --- Users ---
  public getUsers(): User[] {
    return this.data.users;
  }

  public getUserByEmail(email: string): User | undefined {
    return this.data.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  }

  public getUserById(id: string): User | undefined {
    return this.data.users.find(u => u.id === id);
  }

  public createUser(user: User): User {
    this.data.users.push(user);
    this.save();
    return user;
  }

  // --- Products ---
  public getProducts(): Product[] {
    return this.data.products;
  }

  public getProductsByTenant(tenantId: string): Product[] {
    return this.data.products.filter(p => p.tenantId === tenantId);
  }

  public getProductById(id: string, tenantId?: string): Product | undefined {
    return this.data.products.find(p => p.id === id && (tenantId ? p.tenantId === tenantId : true));
  }

  public createProduct(product: Product): Product {
    this.data.products.push(product);
    this.save();
    return product;
  }

  public updateProduct(id: string, tenantId: string, updates: Partial<Product>): Product | undefined {
    const idx = this.data.products.findIndex(p => p.id === id && p.tenantId === tenantId);
    if (idx === -1) return undefined;
    this.data.products[idx] = {
      ...this.data.products[idx],
      ...updates,
      updatedAt: Date.now()
    };
    this.save();
    return this.data.products[idx];
  }

  public deleteProduct(id: string, tenantId: string): boolean {
    const initialLen = this.data.products.length;
    this.data.products = this.data.products.filter(p => !(p.id === id && p.tenantId === tenantId));
    const deleted = this.data.products.length < initialLen;
    if (deleted) this.save();
    return deleted;
  }

  public getMarketplaceProducts(): (Product & { brandName: string; brandSlug: string })[] {
    const activeTenants = new Map(this.data.tenants.filter(t => t.status === 'ACTIVE').map(t => [t.id, t]));
    return this.data.products
      .filter(p => p.marketplacePublished && activeTenants.has(p.tenantId))
      .map(p => {
        const tenant = activeTenants.get(p.tenantId)!;
        return {
          ...p,
          brandName: tenant.name,
          brandSlug: tenant.slug
        };
      });
  }

  public getStorefrontProducts(tenantId: string): Product[] {
    return this.data.products.filter(p => p.tenantId === tenantId && p.brandStorefrontPublished);
  }

  // --- Fabrics ---
  public getFabricsByTenant(tenantId: string): Fabric[] {
    return this.data.fabrics.filter(f => f.tenantId === tenantId);
  }

  public getFabricById(id: string, tenantId: string): Fabric | undefined {
    return this.data.fabrics.find(f => f.id === id && f.tenantId === tenantId);
  }

  public createFabric(fabric: Fabric): Fabric {
    this.data.fabrics.push(fabric);
    this.save();
    return fabric;
  }

  public updateFabric(id: string, tenantId: string, updates: Partial<Fabric>): Fabric | undefined {
    const idx = this.data.fabrics.findIndex(f => f.id === id && f.tenantId === tenantId);
    if (idx === -1) return undefined;
    this.data.fabrics[idx] = { ...this.data.fabrics[idx], ...updates };
    this.save();
    return this.data.fabrics[idx];
  }

  public deleteFabric(id: string, tenantId: string): boolean {
    const initialLen = this.data.fabrics.length;
    this.data.fabrics = this.data.fabrics.filter(f => !(f.id === id && f.tenantId === tenantId));
    const deleted = this.data.fabrics.length < initialLen;
    if (deleted) this.save();
    return deleted;
  }

  // --- Inventory ---
  public adjustInventory(
    tenantId: string,
    productId: string,
    variantSku: string,
    change: number,
    reason: string
  ): { success: boolean; newStock?: number; error?: string } {
    const product = this.data.products.find(p => p.id === productId && p.tenantId === tenantId);
    if (!product) return { success: false, error: 'Product not found in this tenant catalog' };

    const variant = product.variants.find(v => v.sku === variantSku);
    if (!variant) return { success: false, error: `Variant SKU '${variantSku}' not found on product` };

    const nextStock = variant.stockQuantity + change;
    if (nextStock < 0) {
      return {
        success: false,
        error: `Insufficient stock for SKU '${variantSku}'. Current: ${variant.stockQuantity}, requested change: ${change}`
      };
    }

    variant.stockQuantity = nextStock;
    variant.available = nextStock > 0;
    product.updatedAt = Date.now();

    const log: InventoryLog = {
      id: `inv_log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      tenantId,
      productId,
      variantSku,
      change,
      newStock: nextStock,
      reason,
      timestamp: Date.now()
    };
    this.data.inventoryLogs.push(log);
    this.save();

    return { success: true, newStock: nextStock };
  }

  public getInventoryLogs(tenantId: string, productId?: string): InventoryLog[] {
    return this.data.inventoryLogs
      .filter(l => l.tenantId === tenantId && (productId ? l.productId === productId : true))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  // --- Orders ---
  public getOrders(): Order[] {
    return this.data.orders;
  }

  public getOrdersByTenant(tenantId: string): Order[] {
    return this.data.orders.filter(o => o.tenantId === tenantId).sort((a, b) => b.createdAt - a.createdAt);
  }

  public getOrderById(id: string, tenantId?: string): Order | undefined {
    return this.data.orders.find(o => o.id === id && (tenantId ? o.tenantId === tenantId : true));
  }

  public createOrder(order: Order): Order {
    this.data.orders.push(order);
    this.save();
    return order;
  }

  public updateOrderStatus(id: string, tenantId: string, status: Order['status']): Order | undefined {
    const order = this.data.orders.find(o => o.id === id && o.tenantId === tenantId);
    if (!order) return undefined;
    order.status = status;
    order.updatedAt = Date.now();
    this.save();
    return order;
  }

  // --- Subscriptions ---
  public getSubscription(tenantId: string): Subscription | undefined {
    return this.data.subscriptions.find(s => s.tenantId === tenantId);
  }

  public recordTryOnUsage(tenantId: string): void {
    const sub = this.data.subscriptions.find(s => s.tenantId === tenantId);
    if (sub) {
      sub.tryOnUsed += 1;
      sub.updatedAt = Date.now();
      this.save();
    }
  }

  // --- Audit Logs ---
  public recordAuditLog(log: Omit<AuditLog, 'id' | 'timestamp'>): AuditLog {
    const record: AuditLog = {
      ...log,
      id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now()
    };
    this.data.auditLogs.unshift(record);
    if (this.data.auditLogs.length > 500) {
      this.data.auditLogs.pop();
    }
    this.save();
    return record;
  }

  public getAuditLogs(tenantId?: string): AuditLog[] {
    return this.data.auditLogs.filter(a => tenantId ? a.tenantId === tenantId : true);
  }
}

export const db = new Database();
