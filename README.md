# Virtual Try-On Unified Enterprise Backend (Fastify 5 + Prisma)

Enterprise multi-tenant SaaS backend powering **Marketplace (`:3000`)**, **Brand Dashboard (`:3001`)**, and **Super Admin Control Plane (`:3002`)**, paired with the Python **AI Inference Service (`:8000`)**, RabbitMQ (`:5672`), Redis (`:6379`), PostgreSQL/Supabase, and Private Signed Object Storage.

---

## Architecture Overview

- **Unified Fastify 5 API (`src/server.ts`) & Background Worker (`src/worker.ts`)**:
  - Single-port multi-domain modular monolith (`PORT=4000`) with OpenAPI 3.1 docs at `/docs/json` & `/docs`.
  - Structured Pino JSON logging + `X-Correlation-Id` end-to-end request tracing.
  - Transactional Outbox (`outbox_events`) + idempotent event consumer (`processed_events`) for `tryon.generation.*`.
- **PostgreSQL + Prisma 7 + RLS (`prisma/schema.prisma`, `prisma/rls_policies.sql`)**:
  - 45+ normalized relational models covering identity/sessions, RBAC (`roles`, `permissions`, `role_permissions`, `user_role_assignments`), tenant membership & audited `ViewAsSession`, catalog/variants/moderation, `Cart`/`Order`/`PaymentRecord`/`RefundRecord`, `Plan`/`PlanEntitlement`/`InvoiceRecord`, atomic `AiCreditAccount` + `AiCreditLedger` (`FOR UPDATE`), `SupportTicket`, `CmsContent`, `FeatureFlag`, `WebhookEndpoint`, and `DataGovernanceRequest`.
- **Identity, Dual JWT & Enterprise RBAC (`src/modules/auth/`, `src/modules/rbac/`, `src/modules/tenants/`)**:
  - Dual verification: Fastify HS256 JWT + optional Supabase Auth JWT (`SUPABASE_JWT_SECRET` HS256 / `SUPABASE_URL` JWKS).
  - Real-time `UserSession` tracking and immediate revocation on suspend/logout.
  - 10 Platform Admin roles, 7 Brand roles + `STORE_MANAGER` alias + `CUSTOMER` role.
  - Strict `tenantScopeGuard` rejecting forged `tenantId` parameters and blocking mutations on `READ_ONLY` Super Admin `View-As` sessions.
- **Async Virtual Try-On Pipeline (`src/modules/tryon/`, `src/routes/tryon/`)**:
  - Signed PUT upload intents (`POST /api/v1/try-on/upload-url`), idempotent async jobs (`POST /api/v1/try-on/jobs`), owner/tenant-scoped status + signed 300s download URLs (`GET /api/v1/try-on/jobs/:id`), live SSE streams (`GET /api/v1/try-on/jobs/:id/events`), queued cancellation (`POST /api/v1/try-on/jobs/:id/cancel`), and authenticated history (`GET /api/v1/try-on/jobs`).
- **Plans, Billing & Atomic Credits (`src/modules/billing/`)**:
  - `SELECT ... FOR UPDATE` row-locked reservations, promo-first credit priority, idempotent `CONSUME` / `RELEASE` ledger settlement, plan upgrades, and invoice generation.
- **Super Admin Control Plane & Commerce Engagement (`src/modules/admin/`, `src/modules/commerce/`)**:
  - Unified `/api/v1/admin/control-plane/snapshot`, moderation approvals/rejections, CMS pages, feature flags, webhooks, support tickets, multi-seller cart/reviews/favorites, and GDPR `/api/v1/account/export` & deletion governance.

---

## Quick Start & Commands

```bash
cd backend
npm install

# Validate Prisma schema & push to PostgreSQL
npx prisma validate
npx prisma generate
npm run prisma:push

# Build TypeScript + run Vitest enterprise suite (Phases 1-7)
npm run build
npm run test:unit

# Start API server (:4000) and RabbitMQ/Outbox background worker
npm run dev
npm run worker
```

---

## Root Infrastructure (`docker-compose.yml`)

From the repository root:

```bash
docker compose up -d rabbitmq redis
```
