import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  Tenant, User, AuthToken, AuthTokenType, Product, Fabric, InventoryLog,
  Subscription, Order, AuditLog, GenerationJob, UsageLedgerEntry, GenerationStatus
} from '../domain/types.js';
import { config } from './config.js';
import { NeonSqlDatabase } from './neon_database.js';
import { PrismaDatabase } from './prisma_database.js';

export interface DatabaseCollections {
  tenants: Tenant[];
  users: User[];
  authTokens: AuthToken[];
  products: Product[];
  fabrics: Fabric[];
  inventoryLogs: InventoryLog[];
  subscriptions: Subscription[];
  orders: Order[];
  auditLogs: AuditLog[];
  generationJobs: GenerationJob[];
  usageLedger: UsageLedgerEntry[];
}

export class Database {
  private data: DatabaseCollections = {
    tenants: [],
    users: [],
    authTokens: [],
    products: [],
    fabrics: [],
    inventoryLogs: [],
    subscriptions: [],
    orders: [],
    auditLogs: [],
    generationJobs: [],
    usageLedger: []
  };

  private snapshotPath: string;
  private neonSql: NeonSqlDatabase | null = null;
  private prismaDb: PrismaDatabase | null = null;
  private transactionLock: Promise<void> = Promise.resolve();
  private prismaSyncQueue: Promise<void> = Promise.resolve();
  private skipAsyncHydration: boolean = false;
  private otpFailedAttempts = new Map<string, { count: number; resetAt: number }>();

  constructor(customSnapshotPath?: string) {
    this.snapshotPath = customSnapshotPath || path.resolve(process.cwd(), '.data', 'db_snapshot.json');
    this.init();
    if (config.databaseUrl) {
      void this.initConnections(config.databaseUrl);
    }
  }

  private async initConnections(url: string): Promise<void> {
    // Ensure SQL schema tables exist before Prisma counts/hydrates rows on fresh databases
    await this.initNeonSql(url);
    await this.initPrisma(url);
  }

  public getDatabaseProviderLabel(): string {
    const url = (config.databaseUrl || '').toLowerCase();
    if (!url) return 'In-Memory + Local Snapshot';
    if (url.includes('supabase.co') || url.includes('supabase.com') || url.includes('pooler.supabase.com')) {
      return 'Supabase PostgreSQL';
    }
    if (url.includes('neon.tech')) {
      return 'Neon PostgreSQL';
    }
    return 'PostgreSQL';
  }

  private async initPrisma(url: string): Promise<void> {
    try {
      this.prismaDb = new PrismaDatabase(url);
      const connected = await this.prismaDb.init();
      if (connected) {
        console.log(`[Database] Active persistence: Prisma ORM (${this.getDatabaseProviderLabel()}).`);
        if (!this.skipAsyncHydration) {
          await this.hydrateOrSeedDatabase();
        }
      }
    } catch (err: any) {
      console.warn('[Database] Prisma ORM init failed, running on resilient memory snapshot:', err.message);
    }
  }

  private async hydrateOrSeedDatabase(): Promise<void> {
    if (!this.prismaDb || !this.prismaDb.isConnected()) return;
    try {
      const hydrated = await this.prismaDb.hydrateAll();
      if (!hydrated) return;

      // If remote DB has tenants AND users, hydrate memory from it; otherwise sync initial seed data
      if (hydrated.tenants.length > 0 && hydrated.users.length > 0) {
        this.data = {
          tenants: hydrated.tenants,
          users: hydrated.users,
          authTokens: hydrated.authTokens,
          products: hydrated.products.length > 0 ? hydrated.products : this.data.products,
          fabrics: hydrated.fabrics.length > 0 ? hydrated.fabrics : this.data.fabrics,
          subscriptions: hydrated.subscriptions.length > 0 ? hydrated.subscriptions : this.data.subscriptions,
          orders: hydrated.orders,
          inventoryLogs: hydrated.inventoryLogs,
          auditLogs: hydrated.auditLogs,
          generationJobs: hydrated.generationJobs,
          usageLedger: hydrated.usageLedger,
        };
        this.applySeedPasswordsFromEnv();
        this.save();
        console.log(
          `[Database] Hydrated ${hydrated.tenants.length} tenants, ${hydrated.users.length} users, ${hydrated.products.length} products from ${this.getDatabaseProviderLabel()}.`
        );
      } else {
        await this.prismaDb.syncCollections(this.data);
        if (hydrated.tenants.length > 0) {
          // Existing DB had tenants/orders created prior to user seeding; re-hydrate merged records
          const rehydrated = await this.prismaDb.hydrateAll();
          if (rehydrated) {
            this.data.tenants = rehydrated.tenants;
            this.data.orders = rehydrated.orders;
            this.save();
          }
        }
        console.log(`[Database] Synchronized initial seed data into ${this.getDatabaseProviderLabel()}.`);
      }
    } catch (err: any) {
      console.warn('[Database] Hydration warning:', err?.message || err);
    }
  }

  public async reloadDatabase(newDatabaseUrl: string): Promise<{
    connected: boolean;
    provider: string;
    latencyMs?: number;
    counts?: Record<string, number> | null;
    error?: string;
  }> {
    this.skipAsyncHydration = false;
    if (this.prismaDb) {
      await this.prismaDb.close().catch(() => {});
      this.prismaDb = null;
    }
    if (this.neonSql) {
      await this.neonSql.close().catch(() => {});
      this.neonSql = null;
    }

    if (!newDatabaseUrl) {
      return { connected: false, provider: 'In-Memory + Local Snapshot' };
    }

    // Ensure SQL tables and columns exist first
    this.neonSql = new NeonSqlDatabase(newDatabaseUrl);
    const sqlOk = await this.neonSql.init();

    this.prismaDb = new PrismaDatabase(newDatabaseUrl);
    const prismaOk = await this.prismaDb.init();

    if (!sqlOk && !prismaOk) {
      return {
        connected: false,
        provider: this.getDatabaseProviderLabel(),
        error: 'Failed to connect to the database URL provided. Check credentials, host, and SSL settings.',
      };
    }

    if (prismaOk) {
      await this.hydrateOrSeedDatabase();
      const health = await this.prismaDb.checkHealth();
      const counts = await this.prismaDb.getTableCounts();
      return {
        connected: health.ok,
        provider: this.getDatabaseProviderLabel(),
        latencyMs: health.latencyMs,
        counts,
        error: health.error,
      };
    }

    const sqlHealth = await this.neonSql.checkHealth();
    return {
      connected: sqlHealth.ok,
      provider: this.getDatabaseProviderLabel(),
      latencyMs: sqlHealth.latencyMs,
      error: sqlHealth.error,
    };
  }

  public async syncSnapshotToDatabase(): Promise<{ synced: Record<string, number> }> {
    if (!this.prismaDb || !this.prismaDb.isConnected()) {
      throw new Error('PostgreSQL / Supabase connection is not active.');
    }
    return this.prismaDb.syncCollections(this.data);
  }

  public isPrismaActive(): boolean {
    return this.prismaDb !== null && this.prismaDb.isConnected();
  }

  public getPrisma(): PrismaDatabase | null {
    return this.prismaDb;
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
    return this.isPrismaActive() || (this.neonSql !== null && this.neonSql.isConnected());
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
        if (!this.data.authTokens) this.data.authTokens = [];
        if (!this.data.generationJobs) this.data.generationJobs = [];
        if (!this.data.usageLedger) this.data.usageLedger = [];

        // Migrate legacy snapshot users that predate emailVerified tracking
        let migrated = false;
        for (const u of this.data.users) {
          if (u.emailVerified === undefined) {
            u.emailVerified = true;
            u.emailVerifiedAt = u.createdAt || Date.now();
            migrated = true;
          }
        }
        if (migrated) this.save();
        this.applySeedPasswordsFromEnv();
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
    this.skipAsyncHydration = true;
    this.otpFailedAttempts.clear();
    this.seedDemoData();
    this.data.generationJobs = [];
    this.data.usageLedger = [];
    this.save();
  }

  private seedPasswordCache: string | null = null;

  /**
   * Only the platform super admin is seeded. Its password comes from SEED_ADMIN_PASSWORD (.env);
   * if unset, a random one is generated and printed once. Shops and customers register themselves.
   */
  private seedAdminPassword(): string {
    const fromEnv = process.env.SEED_ADMIN_PASSWORD;
    if (fromEnv && fromEnv.length >= 8) return fromEnv;
    if (this.seedPasswordCache) return this.seedPasswordCache;
    this.seedPasswordCache = crypto.randomBytes(12).toString('base64url');
    console.warn(`[Seed] SEED_ADMIN_PASSWORD not set. Generated one-time super admin password: ${this.seedPasswordCache}  (set SEED_ADMIN_PASSWORD in .env to choose your own)`);
    return this.seedPasswordCache;
  }

  /** .env is the source of truth for the super admin password: existing admin account is synced at startup. */
  private applySeedPasswordsFromEnv(): void {
    if (process.env.NODE_ENV === 'test') return; // tests must never rewrite real database users
    const user = this.data.users.find(u => u.id === 'user_admin');
    if (!user) return;
    const updates: Partial<User> = {};

    const email = (process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
    if (email && email !== user.email && !this.data.users.some(u => u.id !== user.id && u.email === email)) {
      updates.email = email;
    }
    const wanted = process.env.SEED_ADMIN_PASSWORD;
    if (wanted && wanted.length >= 8 && !this.verifyPassword(wanted, user.passwordHash)) {
      updates.passwordHash = this.hashPassword(wanted);
    }
    if (Object.keys(updates).length === 0) return;

    Object.assign(user, updates, { updatedAt: Date.now() });
    this.enqueuePrismaSync(async (prisma) => {
      await prisma.updateUser(user.id, updates);
    });
    this.save();
  }

  public hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return `scrypt$${salt}$${derived}`;
  }

  public verifyPassword(password: string, storedHash: string): boolean {
    if (!storedHash) return false;
    try {
      if (storedHash.startsWith('scrypt$')) {
        const parts = storedHash.split('$');
        if (parts.length !== 3) return false;
        const [, salt, expectedHex] = parts;
        const derivedBuf = crypto.scryptSync(password, salt, 64);
        const expectedBuf = Buffer.from(expectedHex, 'hex');
        if (derivedBuf.length !== expectedBuf.length) return false;
        return crypto.timingSafeEqual(derivedBuf, expectedBuf);
      }

      return false;
    } catch {
      return false;
    }
  }

  public hashToken(rawValue: string): string {
    return crypto.createHash('sha256').update(rawValue).digest('hex');
  }

  private enqueuePrismaSync(task: (prisma: PrismaDatabase) => Promise<void>): void {
    if (this.skipAsyncHydration) return;
    this.prismaSyncQueue = this.prismaSyncQueue
      .then(async () => {
        if (this.prismaDb && this.prismaDb.isConnected()) {
          await task(this.prismaDb);
        }
      })
      .catch((err: any) => {
        console.warn('[Database] Prisma background sync skipped:', err?.message || err);
      });
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
      email: (process.env.SEED_ADMIN_EMAIL || 'admin@vton-platform.io').trim().toLowerCase(),
      passwordHash: this.hashPassword(this.seedAdminPassword()),
      role: 'SUPER_ADMIN',
      emailVerified: true,
      emailVerifiedAt: now,
      createdAt: now
    };

    this.data.users = [superAdmin]; // shops and customers register their own accounts
    this.data.authTokens = [];

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
    this.enqueuePrismaSync(async (prisma) => {
      await prisma.createTenant(tenant);
    });
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
    if (!this.skipAsyncHydration) {
      this.enqueuePrismaSync(async (prisma) => {
        await prisma.updateTenant(id, updates);
      });
    }
    return this.data.tenants[idx];
  }

  public deleteTenant(id: string): void {
    this.data.tenants = this.data.tenants.filter(t => t.id !== id);
    this.data.subscriptions = this.data.subscriptions.filter(s => s.tenantId !== id);
    this.save();
    this.enqueuePrismaSync(async (prisma) => {
      await prisma.deleteTenant(id);
    });
  }

  // --- Users ---
  public getUsers(): User[] {
    return this.data.users;
  }

  public getUserByEmail(email: string): User | undefined {
    const clean = email.trim().toLowerCase();
    return this.data.users.find(u => u.email.toLowerCase() === clean);
  }

  public getUserById(id: string): User | undefined {
    return this.data.users.find(u => u.id === id);
  }

  public createUser(user: User): User {
    const normalized: User = {
      ...user,
      email: user.email.trim().toLowerCase(),
      emailVerified: user.emailVerified ?? false
    };
    this.data.users.push(normalized);
    this.save();
    this.enqueuePrismaSync(async (prisma) => {
      await prisma.createUser(normalized);
    });
    return normalized;
  }

  public updateUser(id: string, updates: Partial<User>): User | undefined {
    const idx = this.data.users.findIndex(u => u.id === id);
    if (idx === -1) return undefined;
    this.data.users[idx] = {
      ...this.data.users[idx],
      ...updates,
      updatedAt: Date.now()
    };
    this.save();
    this.enqueuePrismaSync(async (prisma) => {
      await prisma.updateUser(id, updates);
    });
    return this.data.users[idx];
  }

  public deleteUser(id: string): void {
    this.data.users = this.data.users.filter(u => u.id !== id);
    this.data.authTokens = this.data.authTokens.filter(t => t.userId !== id);
    this.save();
    this.enqueuePrismaSync(async (prisma) => {
      await prisma.deleteUser(id);
    });
  }

  // --- Auth Tokens (Email Verification & Password Reset) ---
  public createAuthToken(token: AuthToken): AuthToken {
    this.data.authTokens.push(token);
    if (this.data.authTokens.length > 2000) {
      const now = Date.now();
      this.data.authTokens = this.data.authTokens.filter(t => !t.usedAt && t.expiresAt > now);
    }
    this.save();
    this.enqueuePrismaSync(async (prisma) => {
      await prisma.createAuthToken(token);
    });
    return token;
  }

  public invalidateAuthTokens(userId: string, type: AuthTokenType): void {
    const now = Date.now();
    let changed = false;
    for (const token of this.data.authTokens) {
      if (token.userId === userId && token.type === type && !token.usedAt) {
        token.usedAt = now;
        changed = true;
      }
    }
    if (changed) {
      this.save();
      this.enqueuePrismaSync(async (prisma) => {
        await prisma.invalidateAuthTokens(userId, type);
      });
    }
  }

  public findAuthTokenByRawToken(rawToken: string, type: AuthTokenType): AuthToken | undefined {
    const tokenHash = this.hashToken(rawToken.trim());
    const now = Date.now();
    return this.data.authTokens.find(
      t => t.type === type && t.tokenHash === tokenHash && !t.usedAt && t.expiresAt > now
    );
  }

  public findAuthTokenByOtp(email: string, otpCode: string, type: AuthTokenType): AuthToken | undefined {
    const cleanEmail = email.trim().toLowerCase();
    const otpCodeHash = this.hashToken(otpCode.trim());
    const now = Date.now();
    return this.data.authTokens.find(
      t =>
        t.type === type &&
        t.email.toLowerCase() === cleanEmail &&
        t.otpCodeHash === otpCodeHash &&
        !t.usedAt &&
        t.expiresAt > now
    );
  }

  public getLatestAuthToken(userId: string, type: AuthTokenType): AuthToken | undefined {
    return this.data.authTokens
      .filter(t => t.userId === userId && t.type === type)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  public countRecentAuthTokens(userId: string, type: AuthTokenType, windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.data.authTokens.filter(t => t.userId === userId && t.type === type && t.createdAt >= cutoff).length;
  }

  public markAuthTokenUsed(id: string): void {
    const token = this.data.authTokens.find(t => t.id === id);
    if (token && !token.usedAt) {
      token.usedAt = Date.now();
      this.save();
      this.enqueuePrismaSync(async (prisma) => {
        await prisma.markAuthTokenUsed(id);
      });
    }
  }

  public recordOtpFailure(email: string, type: AuthTokenType): { locked: boolean; attempts: number } {
    const key = `${email.trim().toLowerCase()}:${type}`;
    const now = Date.now();
    const existing = this.otpFailedAttempts.get(key);
    if (!existing || existing.resetAt <= now) {
      this.otpFailedAttempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
      return { locked: false, attempts: 1 };
    }
    existing.count += 1;
    if (existing.count >= 5) {
      const user = this.getUserByEmail(email);
      if (user) this.invalidateAuthTokens(user.id, type);
      return { locked: true, attempts: existing.count };
    }
    return { locked: false, attempts: existing.count };
  }

  public clearOtpFailures(email: string, type: AuthTokenType): void {
    this.otpFailedAttempts.delete(`${email.trim().toLowerCase()}:${type}`);
  }

  public isOtpLocked(email: string, type: AuthTokenType): boolean {
    const key = `${email.trim().toLowerCase()}:${type}`;
    const entry = this.otpFailedAttempts.get(key);
    if (!entry) return false;
    if (entry.resetAt <= Date.now()) {
      this.otpFailedAttempts.delete(key);
      return false;
    }
    return entry.count >= 5;
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
    if (!this.skipAsyncHydration) {
      this.enqueuePrismaSync(async (prisma) => {
        await prisma.createProduct(product);
      });
    }
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
    if (!this.skipAsyncHydration) {
      this.enqueuePrismaSync(async (prisma) => {
        await prisma.updateProduct(id, tenantId, updates);
      });
    }
    return this.data.products[idx];
  }

  public deleteProduct(id: string, tenantId: string): boolean {
    const initialLen = this.data.products.length;
    this.data.products = this.data.products.filter(p => !(p.id === id && p.tenantId === tenantId));
    const deleted = this.data.products.length < initialLen;
    if (deleted) {
      this.save();
      if (!this.skipAsyncHydration) {
        this.enqueuePrismaSync(async (prisma) => {
          await prisma.deleteProduct(id, tenantId);
        });
      }
    }
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
    if (!this.skipAsyncHydration) {
      this.enqueuePrismaSync(async (prisma) => {
        await prisma.createFabric(fabric);
      });
    }
    return fabric;
  }

  public updateFabric(id: string, tenantId: string, updates: Partial<Fabric>): Fabric | undefined {
    const idx = this.data.fabrics.findIndex(f => f.id === id && f.tenantId === tenantId);
    if (idx === -1) return undefined;
    this.data.fabrics[idx] = { ...this.data.fabrics[idx], ...updates };
    this.save();
    if (!this.skipAsyncHydration) {
      this.enqueuePrismaSync(async (prisma) => {
        await prisma.updateFabric(id, tenantId, updates);
      });
    }
    return this.data.fabrics[idx];
  }

  public deleteFabric(id: string, tenantId: string): boolean {
    const initialLen = this.data.fabrics.length;
    this.data.fabrics = this.data.fabrics.filter(f => !(f.id === id && f.tenantId === tenantId));
    const deleted = this.data.fabrics.length < initialLen;
    if (deleted) {
      this.save();
      if (!this.skipAsyncHydration) {
        this.enqueuePrismaSync(async (prisma) => {
          await prisma.deleteFabric(id, tenantId);
        });
      }
    }
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
    if (!this.skipAsyncHydration) {
      this.enqueuePrismaSync(async (prisma) => {
        await prisma.updateProduct(productId, tenantId, { variants: product.variants });
        await prisma.recordInventoryLog({
          tenantId,
          productId,
          variantSku,
          change,
          newStock: nextStock,
          reason
        });
      });
    }

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
    if (!this.skipAsyncHydration) {
      this.enqueuePrismaSync(async (prisma) => {
        await prisma.createOrder(order);
      });
    }
    return order;
  }

  public updateOrderStatus(id: string, tenantId: string, status: Order['status']): Order | undefined {
    const order = this.data.orders.find(o => o.id === id && o.tenantId === tenantId);
    if (!order) return undefined;
    order.status = status;
    order.updatedAt = Date.now();
    this.save();
    if (!this.skipAsyncHydration) {
      this.enqueuePrismaSync(async (prisma) => {
        await prisma.updateOrderStatus(id, tenantId, status);
      });
    }
    return order;
  }

  // --- Subscriptions ---
  public getSubscription(tenantId: string): Subscription | undefined {
    return this.data.subscriptions.find(s => s.tenantId === tenantId);
  }

  public updateSubscription(
    tenantId: string,
    updates: Partial<Pick<Subscription, 'plan' | 'productLimit' | 'tryOnMonthlyQuota' | 'status'>>
  ): Subscription | undefined {
    const sub = this.data.subscriptions.find(s => s.tenantId === tenantId);
    if (!sub) return undefined;
    Object.assign(sub, updates, { updatedAt: Date.now() });
    this.save();
    this.enqueuePrismaSync(async (prisma) => {
      await prisma.updateSubscription(tenantId, sub);
    });
    return sub;
  }

  public getAllGenerations(): GenerationJob[] {
    return this.data.generationJobs;
  }

  public getAllUsageLedger(): UsageLedgerEntry[] {
    return this.data.usageLedger;
  }

  public recordTryOnUsage(tenantId: string): void {
    const sub = this.data.subscriptions.find(s => s.tenantId === tenantId);
    if (sub) {
      sub.tryOnUsed += 1;
      sub.updatedAt = Date.now();
      this.save();
      if (!this.skipAsyncHydration) {
        this.enqueuePrismaSync(async (prisma) => {
          await prisma.recordTryOnUsage(tenantId);
        });
      }
    }
  }

  // --- Generation jobs & usage ledger (quota reservation) ---
  private billingPeriod(ts = Date.now()): string {
    return new Date(ts).toISOString().slice(0, 7);
  }

  /**
   * Atomically checks quota and creates a generation job + ledger entry.
   * Fully synchronous: on Node's single thread two concurrent requests can never both
   * pass the quota check (no await between check and write).
   * tenantId MUST come from a server-side lookup (product -> tenant), never from the client.
   */
  public reserveGeneration(params: {
    tenantId: string;
    productId: string;
    category: string;
    idempotencyKey?: string;
  }):
    | { ok: true; job: GenerationJob; accessToken?: string; duplicate: boolean }
    | { ok: false; error: 'QUOTA_EXHAUSTED' | 'NO_SUBSCRIPTION' | 'SUBSCRIPTION_INACTIVE' } {
    const { tenantId, productId, category, idempotencyKey } = params;

    if (idempotencyKey) {
      const existing = this.data.generationJobs.find(
        j => j.tenantId === tenantId && j.idempotencyKey === idempotencyKey
      );
      if (existing) return { ok: true, job: existing, duplicate: true };
    }

    const sub = this.data.subscriptions.find(s => s.tenantId === tenantId);
    if (!sub) return { ok: false, error: 'NO_SUBSCRIPTION' };
    if (sub.status !== 'ACTIVE') return { ok: false, error: 'SUBSCRIPTION_INACTIVE' };
    if (sub.tryOnUsed >= sub.tryOnMonthlyQuota) return { ok: false, error: 'QUOTA_EXHAUSTED' };

    const now = Date.now();
    const generationId = `gen_${now}_${crypto.randomBytes(5).toString('hex')}`;
    const accessToken = crypto.randomBytes(24).toString('hex');
    const job: GenerationJob = {
      id: generationId,
      tenantId,
      productId,
      category,
      status: 'QUEUED',
      accessTokenHash: this.hashToken(accessToken),
      idempotencyKey,
      createdAt: now,
      updatedAt: now
    };
    const entry: UsageLedgerEntry = {
      id: `led_${generationId}`,
      generationId,
      tenantId,
      billingPeriod: this.billingPeriod(now),
      reservedUnits: 1,
      status: 'RESERVED',
      createdAt: now,
      updatedAt: now
    };
    sub.tryOnUsed += 1;
    sub.updatedAt = now;
    this.data.generationJobs.push(job);
    this.data.usageLedger.push(entry);
    this.save();
    this.syncGeneration(job, entry, sub);
    return { ok: true, job, accessToken, duplicate: false };
  }

  private syncGeneration(job: GenerationJob, entry: UsageLedgerEntry, sub: Subscription): void {
    this.enqueuePrismaSync(async (prisma) => {
      await prisma.saveGeneration(job, entry, sub);
    });
  }

  public attachProviderJob(generationId: string, providerJobId: string): void {
    const job = this.data.generationJobs.find(j => j.id === generationId);
    const entry = this.data.usageLedger.find(l => l.generationId === generationId);
    const sub = job && this.data.subscriptions.find(s => s.tenantId === job.tenantId);
    if (!job || !entry || !sub) return;
    job.providerJobId = providerJobId;
    if (job.status === 'QUEUED') job.status = 'PROCESSING';
    job.updatedAt = Date.now();
    this.save();
    this.syncGeneration(job, entry, sub);
  }

  /**
   * Moves a job to a terminal state exactly once. Success consumes the reserved unit;
   * failure releases it back to the shop. Repeated calls (duplicate polls/deliveries) are no-ops.
   */
  public finalizeGeneration(
    generationId: string,
    outcome: Extract<GenerationStatus, 'COMPLETED' | 'FAILED'>,
    errorCode?: string
  ): void {
    const job = this.data.generationJobs.find(j => j.id === generationId);
    const entry = this.data.usageLedger.find(l => l.generationId === generationId);
    const sub = job && this.data.subscriptions.find(s => s.tenantId === job.tenantId);
    if (!job || !entry || !sub) return;
    if (entry.status !== 'RESERVED') return; // already finalized -> idempotent

    const now = Date.now();
    job.status = outcome;
    job.errorCode = outcome === 'FAILED' ? (errorCode || 'GENERATION_FAILED') : undefined;
    job.updatedAt = now;
    entry.updatedAt = now;
    if (outcome === 'COMPLETED') {
      entry.status = 'CONSUMED';
      entry.finalUnits = 1;
    } else {
      entry.status = 'RELEASED';
      entry.finalUnits = 0;
      sub.tryOnUsed = Math.max(0, sub.tryOnUsed - 1);
      sub.updatedAt = now;
    }
    this.save();
    this.syncGeneration(job, entry, sub);
  }

  /** Returns the job only if the caller holds the access token issued to the originating session. */
  public getGenerationForSession(jobId: string, accessToken: string | undefined): GenerationJob | undefined {
    if (!accessToken) return undefined;
    const job = this.data.generationJobs.find(j => j.providerJobId === jobId || j.id === jobId);
    if (!job) return undefined;
    const given = Buffer.from(this.hashToken(accessToken));
    const stored = Buffer.from(job.accessTokenHash);
    if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) return undefined;
    return job;
  }

  public getGenerationsByTenant(tenantId: string): GenerationJob[] {
    return this.data.generationJobs.filter(j => j.tenantId === tenantId);
  }

  public getUsageLedger(tenantId: string): UsageLedgerEntry[] {
    return this.data.usageLedger.filter(l => l.tenantId === tenantId);
  }

  // --- Audit Logs ---
  public recordAuditLog(log: Omit<AuditLog, 'id' | 'timestamp'>): AuditLog {
    const record: AuditLog = {
      ...log,
      id: `audit_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      timestamp: Date.now()
    };
    this.data.auditLogs.unshift(record);
    if (this.data.auditLogs.length > 500) {
      this.data.auditLogs.pop();
    }
    this.save();
    if (!this.skipAsyncHydration) {
      this.enqueuePrismaSync(async (prisma) => {
        await prisma.recordAuditLog(log);
      });
    }
    return record;
  }

  public getAuditLogs(tenantId?: string): AuditLog[] {
    return this.data.auditLogs.filter(a => tenantId ? a.tenantId === tenantId : true);
  }
}

export const db = new Database();
