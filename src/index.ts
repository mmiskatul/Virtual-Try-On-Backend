import { createApp } from './server.js';
import { config } from './infrastructure/config.js';
import { db } from './infrastructure/database.js';

async function bootstrap() {
  console.log('\n=============================================================');
  console.log('🚀 Virtual Try-On SaaS — Unified Fastify 5 Backend Starting...');
  console.log('=============================================================\n');

  const brandApp = createApp('brand');
  const marketplaceApp = createApp('marketplace');
  const adminApp = createApp('admin');
  const unifiedApp = createApp('all');

  try {
    await Promise.all([
      brandApp.listen({ port: config.brandApiPort, host: config.host }),
      marketplaceApp.listen({ port: config.marketplaceApiPort, host: config.host }),
      adminApp.listen({ port: config.superAdminApiPort, host: config.host }),
      unifiedApp.listen({ port: config.port, host: config.host })
    ]);

    const isSql = db.isNeonSqlActive();

    console.log(`✅ [Brand API]          Listening on http://${config.host}:${config.brandApiPort}`);
    console.log(`   └─ Linked to Brand Dashboard: http://localhost:3001\n`);

    console.log(`✅ [Marketplace API]    Listening on http://${config.host}:${config.marketplaceApiPort}`);
    console.log(`   └─ Linked to Marketplace Frontend: http://localhost:3000\n`);

    console.log(`✅ [Super Admin API]    Listening on http://${config.host}:${config.superAdminApiPort}`);
    console.log(`   └─ Linked to Super Admin Dashboard: http://localhost:3002\n`);

    console.log(`✅ [Unified Gateway]    Listening on http://${config.host}:${config.port}`);
    console.log(`   └─ All microservice routes consolidated on single port\n`);

    console.log(`💾 [Persistence Engine] ${isSql ? 'Neon PostgreSQL Serverless SQL' : 'Resilient In-Memory + File Snapshot'}`);
    console.log(`🎨 [Cloudinary Storage] ${config.cloudinaryCloudName ? `Connected to '${config.cloudinaryCloudName}'` : 'Local Fallback / Memory'}`);
    console.log(`🤖 [AI Engine Target]   ${config.aiServiceUrl} (FastAPI)\n`);
    console.log('=============================================================\n');
  } catch (err) {
    console.error('❌ Failed to start backend services:', err);
    process.exit(1);
  }

  const handleShutdown = async (signal: string) => {
    console.log(`\n[${signal}] Gracefully closing all Fastify server instances...`);
    await Promise.allSettled([
      brandApp.close(),
      marketplaceApp.close(),
      adminApp.close(),
      unifiedApp.close()
    ]);
    db.save();
    console.log('✅ All backend servers closed cleanly.');
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

bootstrap();
