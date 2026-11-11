/**
 * SQL Schema Definition for PostgreSQL / Neon Database (neon.tech)
 * Automatically executes during bootstrap if tables do not exist.
 */

export const POSTGRES_SCHEMA_SQL = `
-- 1. Tenants Table
CREATE TABLE IF NOT EXISTS tenants (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  logo_url TEXT,
  banner_url TEXT,
  description TEXT,
  contact_email VARCHAR(255) NOT NULL,
  storefront_settings JSONB,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

-- 2. Users Table
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(64) NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  email_verified_at BIGINT,
  updated_at BIGINT,
  created_at BIGINT NOT NULL
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at BIGINT;
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 3. Products Table
CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(128) NOT NULL,
  sub_category VARCHAR(128),
  collection VARCHAR(128),
  sku VARCHAR(128) NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  compare_at_price DOUBLE PRECISION,
  images JSONB NOT NULL DEFAULT '[]'::jsonb,
  fabric_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  brand_storefront_published BOOLEAN NOT NULL DEFAULT true,
  marketplace_published BOOLEAN NOT NULL DEFAULT false,
  is_try_on_eligible BOOLEAN NOT NULL DEFAULT true,
  try_on_category VARCHAR(64) NOT NULL DEFAULT 'tops',
  specs JSONB,
  variants JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_tenant_id ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_marketplace ON products(marketplace_published);

-- 4. Fabrics Table
CREATE TABLE IF NOT EXISTS fabrics (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  composition VARCHAR(255) NOT NULL,
  color VARCHAR(128) NOT NULL,
  pattern VARCHAR(128) NOT NULL,
  weight_gsm INT NOT NULL,
  stretch VARCHAR(32) NOT NULL,
  transparency VARCHAR(32) NOT NULL,
  thickness VARCHAR(32) NOT NULL,
  care_instructions TEXT,
  texture_url TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fabrics_tenant_id ON fabrics(tenant_id);

-- 5. Subscriptions Table
CREATE TABLE IF NOT EXISTS subscriptions (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) UNIQUE NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan VARCHAR(64) NOT NULL DEFAULT 'STARTER',
  product_limit INT NOT NULL DEFAULT 50,
  try_on_monthly_quota INT NOT NULL DEFAULT 500,
  try_on_used INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  updated_at BIGINT NOT NULL
);

-- 6. Orders Table
CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id VARCHAR(64),
  customer_email VARCHAR(255) NOT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'PENDING',
  total_amount DOUBLE PRECISION NOT NULL,
  subtotal DOUBLE PRECISION NOT NULL,
  shipping_fee DOUBLE PRECISION NOT NULL DEFAULT 0,
  shipping_address JSONB,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  payment_status VARCHAR(64) NOT NULL DEFAULT 'PENDING',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_tenant_id ON orders(tenant_id);

-- 7. Inventory Logs Table
CREATE TABLE IF NOT EXISTS inventory_logs (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  product_id VARCHAR(64) NOT NULL,
  variant_sku VARCHAR(128) NOT NULL,
  change INT NOT NULL,
  new_stock INT NOT NULL,
  reason TEXT NOT NULL,
  timestamp BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inventory_logs_tenant ON inventory_logs(tenant_id);

-- 8. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64),
  actor_id VARCHAR(255) NOT NULL,
  actor_role VARCHAR(64) NOT NULL,
  action VARCHAR(128) NOT NULL,
  entity VARCHAR(128) NOT NULL,
  entity_id VARCHAR(255),
  details JSONB,
  timestamp BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);

-- 9. Auth Tokens Table (Email Verification & Password Reset)
CREATE TABLE IF NOT EXISTS auth_tokens (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  type VARCHAR(32) NOT NULL,
  token_hash VARCHAR(128) NOT NULL,
  otp_code_hash VARCHAR(128),
  portal VARCHAR(32) NOT NULL DEFAULT 'marketplace',
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_id ON auth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_email ON auth_tokens(email);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens(token_hash);

-- 10. Generation Jobs Table
CREATE TABLE IF NOT EXISTS generation_jobs (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL,
  category VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
  access_token_hash VARCHAR(128) NOT NULL,
  idempotency_key VARCHAR(128),
  provider_job_id VARCHAR(128),
  error_code VARCHAR(64),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_tenant ON generation_jobs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_provider ON generation_jobs(provider_job_id);

-- 11. Usage Ledger Table (unique generation_id = no double charging)
CREATE TABLE IF NOT EXISTS usage_ledger (
  id VARCHAR(64) PRIMARY KEY,
  generation_id VARCHAR(64) NOT NULL UNIQUE,
  tenant_id VARCHAR(64) NOT NULL,
  billing_period VARCHAR(16) NOT NULL,
  reserved_units INT NOT NULL,
  final_units INT,
  status VARCHAR(32) NOT NULL DEFAULT 'RESERVED',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_tenant_period ON usage_ledger(tenant_id, billing_period);
`;
