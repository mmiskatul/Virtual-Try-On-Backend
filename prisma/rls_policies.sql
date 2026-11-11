-- PostgreSQL Row Level Security (RLS) Baseline Policy Script (Phase 1 / Security Architecture)
-- NOTE: Fastify server-side repositories connect via privileged PostgreSQL role and enforce explicit
-- `where: { tenantId }` / `userId` isolation on every query. RLS protects direct Supabase PostgREST /
-- SQL user-scoped sessions using `app.current_user_id` and `app.current_tenant_id` GUC variables.

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Public marketplace can only read explicitly published products from ACTIVE tenants
DROP POLICY IF EXISTS products_public_marketplace_read ON products;
CREATE POLICY products_public_marketplace_read ON products
  FOR SELECT
  USING (
    marketplace_published = true
    AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = products.tenant_id AND t.status = 'ACTIVE')
  );

-- Authenticated tenant scope policy for tenant-owned tables
DROP POLICY IF EXISTS products_tenant_isolation ON products;
CREATE POLICY products_tenant_isolation ON products
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true));

DROP POLICY IF EXISTS orders_tenant_isolation ON orders;
CREATE POLICY orders_tenant_isolation ON orders
  FOR ALL
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)
    OR customer_id = current_setting('app.current_user_id', true)
  );

DROP POLICY IF EXISTS jobs_tenant_or_owner_isolation ON generation_jobs;
CREATE POLICY jobs_tenant_or_owner_isolation ON generation_jobs
  FOR ALL
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)
    OR user_id = current_setting('app.current_user_id', true)
  );

DROP POLICY IF EXISTS customer_uploads_owner_only ON customer_uploads;
CREATE POLICY customer_uploads_owner_only ON customer_uploads
  FOR ALL
  USING (user_profile_id::text = current_setting('app.current_user_id', true));

-- Audit logs: append-only insert allowed; reads restricted to platform super admin GUC context
DROP POLICY IF EXISTS audit_logs_super_admin_read ON audit_logs;
CREATE POLICY audit_logs_super_admin_read ON audit_logs
  FOR SELECT
  USING (current_setting('app.current_role', true) = 'SUPER_ADMIN');

