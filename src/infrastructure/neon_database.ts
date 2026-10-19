import pg from 'pg';
import { POSTGRES_SCHEMA_SQL } from './sql_schema.js';
import { Tenant, User, Product, Fabric, InventoryLog, Subscription, Order, AuditLog } from '../domain/types.js';

const { Pool } = pg;

export class NeonSqlDatabase {
  private pool: pg.Pool | null = null;
  private connected: boolean = false;
  private databaseUrl: string;

  constructor(databaseUrl: string) {
    this.databaseUrl = databaseUrl;
  }

  public async init(): Promise<boolean> {
    try {
      this.pool = new Pool({
        connectionString: this.databaseUrl,
        ssl: { rejectUnauthorized: false }, // Required for Neon serverless PostgreSQL
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      const client = await this.pool.connect();
      try {
        console.log('[Neon DB] Successfully connected to Neon PostgreSQL SQL database!');
        await client.query(POSTGRES_SCHEMA_SQL);
        console.log('[Neon DB] Verified SQL schema & tables in Neon DB.');
        this.connected = true;

        const countRes = await client.query('SELECT count(*) FROM tenants');
        if (Number(countRes.rows[0].count) === 0) {
          console.log('[Neon DB] Database is empty. Seeding initial tenants & demo catalog to Neon SQL...');
          await this.seedNeonDatabase(client);
        }
        return true;
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.warn('[Neon DB] Could not connect to SQL database:', err.message);
      this.connected = false;
      return false;
    }
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async checkHealth(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    if (!this.pool || !this.connected) {
      return { ok: false, latencyMs: 0, error: 'Neon SQL connection not active' };
    }
    const start = performance.now();
    try {
      await this.pool.query('SELECT 1');
      return { ok: true, latencyMs: Number((performance.now() - start).toFixed(1)) };
    } catch (err: any) {
      return { ok: false, latencyMs: Number((performance.now() - start).toFixed(1)), error: err.message };
    }
  }

  // --- Tenants ---
  public async getTenants(): Promise<Tenant[]> {
    if (!this.pool) return [];
    const res = await this.pool.query('SELECT * FROM tenants ORDER BY created_at DESC');
    return res.rows.map(this.mapTenant);
  }

  public async getTenantById(id: string): Promise<Tenant | undefined> {
    if (!this.pool) return undefined;
    const res = await this.pool.query('SELECT * FROM tenants WHERE id = $1', [id]);
    return res.rows[0] ? this.mapTenant(res.rows[0]) : undefined;
  }

  public async getTenantBySlug(slug: string): Promise<Tenant | undefined> {
    if (!this.pool) return undefined;
    const res = await this.pool.query('SELECT * FROM tenants WHERE slug = $1', [slug]);
    return res.rows[0] ? this.mapTenant(res.rows[0]) : undefined;
  }

  public async createTenant(tenant: Tenant): Promise<Tenant> {
    if (!this.pool) throw new Error('Database not connected');
    const q = `
      INSERT INTO tenants (id, name, slug, status, logo_url, banner_url, description, contact_email, storefront_settings, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;
    const values = [
      tenant.id, tenant.name, tenant.slug, tenant.status, tenant.logoUrl || null, tenant.bannerUrl || null,
      tenant.description || null, tenant.contactEmail, JSON.stringify(tenant.storefrontSettings || {}),
      tenant.createdAt, tenant.updatedAt
    ];
    const res = await this.pool.query(q, values);
    return this.mapTenant(res.rows[0]);
  }

  public async updateTenant(id: string, updates: Partial<Tenant>): Promise<Tenant | undefined> {
    if (!this.pool) return undefined;
    const current = await this.getTenantById(id);
    if (!current) return undefined;
    const merged = { ...current, ...updates, updatedAt: Date.now() };
    const q = `
      UPDATE tenants SET name = $2, slug = $3, status = $4, logo_url = $5, banner_url = $6,
        description = $7, contact_email = $8, storefront_settings = $9, updated_at = $10
      WHERE id = $1
      RETURNING *
    `;
    const values = [
      id, merged.name, merged.slug, merged.status, merged.logoUrl || null, merged.bannerUrl || null,
      merged.description || null, merged.contactEmail, JSON.stringify(merged.storefrontSettings || {}),
      merged.updatedAt
    ];
    const res = await this.pool.query(q, values);
    return res.rows[0] ? this.mapTenant(res.rows[0]) : undefined;
  }

  // --- Users ---
  public async getUsers(): Promise<User[]> {
    if (!this.pool) return [];
    const res = await this.pool.query('SELECT * FROM users');
    return res.rows.map(this.mapUser);
  }

  public async getUserByEmail(email: string): Promise<User | undefined> {
    if (!this.pool) return undefined;
    const res = await this.pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    return res.rows[0] ? this.mapUser(res.rows[0]) : undefined;
  }

  public async createUser(user: User): Promise<User> {
    if (!this.pool) throw new Error('Database not connected');
    const q = `
      INSERT INTO users (id, tenant_id, name, email, password_hash, role, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;
    const values = [user.id, user.tenantId || null, user.name, user.email, user.passwordHash, user.role, user.createdAt];
    const res = await this.pool.query(q, values);
    return this.mapUser(res.rows[0]);
  }

  // --- Products ---
  public async getProductsByTenant(tenantId: string): Promise<Product[]> {
    if (!this.pool) return [];
    const res = await this.pool.query('SELECT * FROM products WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId]);
    return res.rows.map(this.mapProduct);
  }

  public async getProductById(id: string, tenantId?: string): Promise<Product | undefined> {
    if (!this.pool) return undefined;
    const q = tenantId
      ? 'SELECT * FROM products WHERE id = $1 AND tenant_id = $2'
      : 'SELECT * FROM products WHERE id = $1';
    const params = tenantId ? [id, tenantId] : [id];
    const res = await this.pool.query(q, params);
    return res.rows[0] ? this.mapProduct(res.rows[0]) : undefined;
  }

  public async createProduct(product: Product): Promise<Product> {
    if (!this.pool) throw new Error('Database not connected');
    const q = `
      INSERT INTO products (
        id, tenant_id, name, slug, description, category, sub_category, collection, sku,
        price, compare_at_price, images, fabric_ids, tags, brand_storefront_published,
        marketplace_published, is_try_on_eligible, try_on_category, specs, variants,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
      RETURNING *
    `;
    const values = [
      product.id, product.tenantId, product.name, product.slug, product.description || null,
      product.category, product.subCategory || null, product.collection || null, product.sku,
      product.price, product.compareAtPrice || null, JSON.stringify(product.images || []),
      JSON.stringify(product.fabricIds || []), JSON.stringify(product.tags || []),
      product.brandStorefrontPublished, product.marketplacePublished, product.isTryOnEligible,
      product.tryOnCategory, JSON.stringify(product.specs || {}), JSON.stringify(product.variants || []),
      product.createdAt, product.updatedAt
    ];
    const res = await this.pool.query(q, values);
    return this.mapProduct(res.rows[0]);
  }

  public async updateProduct(id: string, tenantId: string, updates: Partial<Product>): Promise<Product | undefined> {
    if (!this.pool) return undefined;
    const current = await this.getProductById(id, tenantId);
    if (!current) return undefined;
    const merged = { ...current, ...updates, updatedAt: Date.now() };
    const q = `
      UPDATE products SET name = $3, slug = $4, description = $5, category = $6, sub_category = $7,
        collection = $8, sku = $9, price = $10, compare_at_price = $11, images = $12, fabric_ids = $13,
        tags = $14, brand_storefront_published = $15, marketplace_published = $16, is_try_on_eligible = $17,
        try_on_category = $18, specs = $19, variants = $20, updated_at = $21
      WHERE id = $1 AND tenant_id = $2
      RETURNING *
    `;
    const values = [
      id, tenantId, merged.name, merged.slug, merged.description || null, merged.category,
      merged.subCategory || null, merged.collection || null, merged.sku, merged.price,
      merged.compareAtPrice || null, JSON.stringify(merged.images || []), JSON.stringify(merged.fabricIds || []),
      JSON.stringify(merged.tags || []), merged.brandStorefrontPublished, merged.marketplacePublished,
      merged.isTryOnEligible, merged.tryOnCategory, JSON.stringify(merged.specs || {}),
      JSON.stringify(merged.variants || []), merged.updatedAt
    ];
    const res = await this.pool.query(q, values);
    return res.rows[0] ? this.mapProduct(res.rows[0]) : undefined;
  }

  public async deleteProduct(id: string, tenantId: string): Promise<boolean> {
    if (!this.pool) return false;
    const res = await this.pool.query('DELETE FROM products WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return (res.rowCount || 0) > 0;
  }

  // --- Seed Initial Data into Neon ---
  private async seedNeonDatabase(client: pg.PoolClient): Promise<void> {
    const now = Date.now();
    await client.query(`
      INSERT INTO tenants (id, name, slug, status, logo_url, banner_url, description, contact_email, storefront_settings, created_at, updated_at)
      VALUES
        ('tenant_aura', 'Aura Atelier', 'aura-atelier', 'ACTIVE', 'https://images.unsplash.com/photo-1549298916-b41d501d3772?w=200', 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=1200', 'Contemporary minimalist luxury silhouettes.', 'contact@auraatelier.com', '{"primaryColor":"#0f172a"}'::jsonb, ${now}, ${now}),
        ('tenant_vogue', 'Vogue Nova', 'vogue-nova', 'ACTIVE', 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=200', 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1200', 'Bold streetwear and tailored statement wear.', 'hello@voguenova.com', '{"primaryColor":"#18181b"}'::jsonb, ${now}, ${now})
      ON CONFLICT (id) DO NOTHING;
    `);

    await client.query(`
      INSERT INTO subscriptions (id, tenant_id, plan, product_limit, try_on_monthly_quota, try_on_used, status, updated_at)
      VALUES
        ('sub_aura', 'tenant_aura', 'PRO', 150, 1000, 124, 'ACTIVE', ${now}),
        ('sub_vogue', 'tenant_vogue', 'ENTERPRISE', 500, 5000, 312, 'ACTIVE', ${now})
      ON CONFLICT (tenant_id) DO NOTHING;
    `);
    console.log('[Neon DB] Initial seed data successfully populated in Neon PostgreSQL.');
  }

  private mapTenant(row: any): Tenant {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      logoUrl: row.logo_url,
      bannerUrl: row.banner_url,
      description: row.description,
      contactEmail: row.contact_email,
      storefrontSettings: typeof row.storefront_settings === 'string' ? JSON.parse(row.storefront_settings) : row.storefront_settings,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  private mapUser(row: any): User {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      email: row.email,
      passwordHash: row.password_hash,
      role: row.role,
      createdAt: Number(row.created_at)
    };
  }

  private mapProduct(row: any): Product {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      category: row.category,
      subCategory: row.sub_category,
      collection: row.collection,
      sku: row.sku,
      price: Number(row.price),
      compareAtPrice: row.compare_at_price ? Number(row.compare_at_price) : undefined,
      images: typeof row.images === 'string' ? JSON.parse(row.images) : (row.images || []),
      fabricIds: typeof row.fabric_ids === 'string' ? JSON.parse(row.fabric_ids) : (row.fabric_ids || []),
      tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : (row.tags || []),
      brandStorefrontPublished: Boolean(row.brand_storefront_published),
      marketplacePublished: Boolean(row.marketplace_published),
      isTryOnEligible: Boolean(row.is_try_on_eligible),
      tryOnCategory: row.try_on_category,
      specs: typeof row.specs === 'string' ? JSON.parse(row.specs) : (row.specs || {}),
      variants: typeof row.variants === 'string' ? JSON.parse(row.variants) : (row.variants || []),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }
}
