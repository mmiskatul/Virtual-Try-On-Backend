# Virtual Try-On Unified Backend (Fastify 5)

Enterprise high-performance multi-tenant backend consolidating Brand API, Marketplace API, and Super Admin API into a single unified Fastify 5 architecture.

---

## 🏛 Architecture Overview

```
                      ┌───────────────────────────────────────────────┐
                      │             Virtual Try-On Platform           │
                      └──────────────────────┬────────────────────────┘
                                             │
      ┌──────────────────────────────────────┼──────────────────────────────────────┐
      │                                      │                                      │
┌─────▼───────────────┐            ┌─────────▼─────────────┐            ┌───────────▼───────────┐
│   Brand Dashboard   │            │ Marketplace Frontend  │            │ Super Admin Dashboard │
│   Port: 3001        │            │ Port: 3000            │            │ Port: 3002            │
└─────┬───────────────┘            └─────────┬─────────────┘            └───────────┬───────────┘
      │                                      │                                      │
      │ :4001                                │ :4002                                │ :4003
      ▼                                      ▼                                      ▼
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│                                unified `backend` (Fastify 5)                              │
│                                                                                           │
│  • Brand Routes (Auth, Products, Fabrics, Inventory, Orders, Storefront, Uploads)         │
│  • Marketplace Routes (Catalog, Single-Seller Checkout, Orders, Try-On Dispatch)          │
│  • Super Admin Routes (Admin Auth, Tenant Governance, Platform Analytics, Audit Logs)     │
│  • System Routes (/health, /live, /ready, /metrics)                                       │
│  • Unified Gateway (Port 4000)                                                            │
│                                                                                           │
│  💾 Database: Neon Serverless PostgreSQL / In-Memory ACID Resilient Fallback              │
│  ☁️ Cloudinary Storage: Dynamic image CDN for products & try-on assets                    │
└─────────────────────────────────────────────┬─────────────────────────────────────────────┘
                                              │ :8000
                                              ▼
                               ┌─────────────────────────────┐
                               │    `ai-service` (FastAPI)   │
                               │  VITON-HD Dense Pose + UNet │
                               └─────────────────────────────┘
```

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Configure Environment (`.env`)
Copy `.env.example` to `.env`:
```bash
# Server Ports
HOST=0.0.0.0
PORT=4000
BRAND_API_PORT=4001
MARKETPLACE_API_PORT=4002
SUPER_ADMIN_API_PORT=4003

# Security & Tokens
JWT_SECRET=vton_unified_jwt_secret_production_ready_2026
PASSWORD_SALT=vton_production_salt_secure_2026
INTERNAL_SERVICE_KEY=vton_internal_service_key_enterprise

# AI Service Engine (FastAPI)
AI_SERVICE_URL=http://localhost:8000

# Database Configuration (Neon Serverless PostgreSQL or local Postgres)
# Leave blank to run on automatic in-memory ACID store with disk snapshotting
DATABASE_URL=

# Cloudinary Image Storage
CLOUDINARY_URL=
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
CLOUDINARY_FOLDER=virtual-try-on
```

### 3. Run Development Server
```bash
npm run dev
```
Starts Fastify 5 listening simultaneously on:
- `http://localhost:4001` -> Brand API
- `http://localhost:4002` -> Marketplace API
- `http://localhost:4003` -> Super Admin API
- `http://localhost:4000` -> Unified Gateway

### 4. Run Test Suite
```bash
npm test
```
Runs the 30-case integration test suite across all domains with 100% pass guarantee.

### 5. Build for Production
```bash
npm run build
npm start
```
