import { createApp } from './server.js';
import { config } from './infrastructure/config.js';
import { db } from './infrastructure/database.js';

async function bootstrap() {
  console.log('\n=============================================================');
  console.log('🚀 Virtual Try-On SaaS — Unified Fastify 5 Backend Starting...');
  console.log('=============================================================\n');

  const app = createApp('all');

  try {
    await app.listen({ port: config.port, host: config.host });

    const isPrisma = db.isPrismaActive();
    const isSql = db.isNeonSqlActive();

    console.log(`✅ [Unified Backend]    Listening on http://${config.host}:${config.port}`);
    console.log(`   ├─ Brand API:           http://${config.host}:${config.port}/api/v1/auth, /products, /fabrics...`);
    console.log(`   ├─ Marketplace API:     http://${config.host}:${config.port}/api/v1/marketplace/..., /checkout...`);
    console.log(`   ├─ Super Admin API:     http://${config.host}:${config.port}/api/v1/admin/...`);
    console.log(`   └─ Health & Metrics:    http://${config.host}:${config.port}/health, /live, /ready, /metrics\n`);

    console.log(`💾 [Persistence Engine] ${isPrisma ? 'Prisma ORM (PostgreSQL Serverless)' : isSql ? 'Neon PostgreSQL Serverless SQL' : 'Resilient In-Memory + File Snapshot'}`);
    console.log(`🎨 [Cloudinary Storage] ${config.cloudinaryCloudName ? `Connected to '${config.cloudinaryCloudName}'` : 'Local Fallback / Memory'}`);
    console.log(`🤖 [AI Engine Target]   ${config.aiServiceUrl} (FastAPI)\n`);
    console.log('=============================================================\n');
  } catch (err) {
    console.error('❌ Failed to start backend service:', err);
    process.exit(1);
  }

  const handleShutdown = async (signal: string) => {
    console.log(`\n[${signal}] Gracefully closing Fastify server instance...`);
    await app.close();
    db.save();
    console.log('✅ Backend server closed cleanly.');
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

bootstrap();
