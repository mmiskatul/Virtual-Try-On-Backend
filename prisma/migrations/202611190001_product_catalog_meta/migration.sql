-- Stores the extra product fields (short summary, cost price, low-stock alert, warehouse, catalog status,
-- try-on switches, AI reference image) as one JSON document. Safe to run on existing data.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "catalog_meta" JSONB;
