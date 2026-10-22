import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../infrastructure/config.js';
import { db } from '../../infrastructure/database.js';
import { authenticateToken, requireRole } from '../../infrastructure/auth.guard.js';
import { cloudinaryStorage } from '../../infrastructure/cloudinary_storage.js';

function maskKey(key?: string): string {
  if (!key || key.length < 8) return '';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export async function adminAiEngineRoutes(app: FastifyInstance) {
  // 1. Fetch AI Engine Configuration & Model Registry Status
  app.get(
    '/api/v1/admin/ai-engine/config',
    { preHandler: [authenticateToken, requireRole('SUPER_ADMIN')] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      // Query local AI service capabilities if reachable
      let aiServiceCapabilities: any = null;
      try {
        const res = await fetch(`${config.aiServiceUrl}/api/v1/models`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          aiServiceCapabilities = await res.json();
        }
      } catch {
        // AI service may be starting or offline
      }

      return reply.send({
        activeProvider: config.vtonProvider || 'gemini',
        gemini: {
          configured: Boolean(config.geminiApiKey),
          model: config.geminiModel || 'gemini-flash-latest',
          maskedKey: maskKey(config.geminiApiKey),
          apiKey: config.geminiApiKey || ''
        },
        fal: {
          configured: Boolean(config.falKey),
          maskedKey: maskKey(config.falKey),
          apiKey: config.falKey || ''
        },
        external: {
          configured: Boolean(config.vtonApiKey),
          maskedKey: maskKey(config.vtonApiKey),
          apiUrl: config.vtonApiUrl || '',
          apiKey: config.vtonApiKey || ''
        },
        cloudinary: {
          configured: cloudinaryStorage.isConfigured(),
          cloudName: config.cloudinaryCloudName || '',
          apiKey: config.cloudinaryApiKey || '',
          maskedSecret: maskKey(config.cloudinaryApiSecret),
          folder: config.cloudinaryFolder || 'virtual-try-on'
        },
        fallbackEnabled: true,
        fallbackChain: ['gemini', 'fal', 'viton_hd'],
        availableProviders: [
          {
            id: 'gemini',
            name: 'Google Gemini Multimodal Vision + Fashion Synthesis',
            description: 'Analyzes model anatomy, fabric drape, and lighting using Gemini 2.5/Flash, then renders fitting.',
            recommended: true,
            status: config.geminiApiKey ? 'ready' : 'key_required'
          },
          {
            id: 'fal',
            name: 'Fal AI FLUX Pro Virtual Try-On (fal-ai/flux-pro/v1/vto)',
            description: 'Hyper-realistic multi-modal cloud inference via fal_client.',
            status: config.falKey ? 'ready' : 'key_required'
          },
          {
            id: 'viton',
            name: 'Local VITON-HD Vision Synthesizer',
            description: 'High-performance CPU/GPU local vision engine. Guaranteed instant zero-cost fallback.',
            status: 'ready'
          },
          {
            id: 'external',
            name: 'Custom / External VTON Cloud API',
            description: 'Forward requests to Fashn.ai, Replicate IDM-VTON, or your custom VTON HTTP endpoint.',
            status: config.vtonApiKey || config.vtonApiUrl ? 'ready' : 'key_required'
          }
        ],
        aiServiceEngineUrl: config.aiServiceUrl,
        aiServiceCapabilities
      });
    }
  );

  // 2. Update AI Engine Configuration (Dynamic Live Reload + .env Sync)
  app.post(
    '/api/v1/admin/ai-engine/config',
    { preHandler: [authenticateToken, requireRole('SUPER_ADMIN')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = (request.body as any) || {};
      const {
        activeProvider,
        geminiApiKey,
        geminiModel,
        falKey,
        vtonApiKey,
        vtonApiUrl,
        cloudinaryCloudName,
        cloudinaryApiKey,
        cloudinaryApiSecret,
        cloudinaryFolder,
        cloudinaryUrl
      } = body;

      // Update in-memory runtime configuration
      if (activeProvider) {
        config.vtonProvider = activeProvider;
        process.env.VTON_PROVIDER = activeProvider;
      }
      if (geminiApiKey !== undefined) {
        config.geminiApiKey = geminiApiKey.trim();
        process.env.GEMINI_API_KEY = geminiApiKey.trim();
      }
      if (geminiModel !== undefined) {
        config.geminiModel = geminiModel.trim();
        process.env.GEMINI_MODEL = geminiModel.trim();
      }
      if (falKey !== undefined) {
        config.falKey = falKey.trim();
        process.env.FAL_KEY = falKey.trim();
      }
      if (vtonApiKey !== undefined) {
        config.vtonApiKey = vtonApiKey.trim();
        process.env.VTON_API_KEY = vtonApiKey.trim();
      }
      if (vtonApiUrl !== undefined) {
        config.vtonApiUrl = vtonApiUrl.trim();
        process.env.VTON_API_URL = vtonApiUrl.trim();
      }
      if (cloudinaryCloudName !== undefined) {
        config.cloudinaryCloudName = cloudinaryCloudName.trim();
        process.env.CLOUDINARY_CLOUD_NAME = cloudinaryCloudName.trim();
      }
      if (cloudinaryApiKey !== undefined) {
        config.cloudinaryApiKey = cloudinaryApiKey.trim();
        process.env.CLOUDINARY_API_KEY = cloudinaryApiKey.trim();
      }
      if (cloudinaryApiSecret !== undefined) {
        config.cloudinaryApiSecret = cloudinaryApiSecret.trim();
        process.env.CLOUDINARY_API_SECRET = cloudinaryApiSecret.trim();
      }
      if (cloudinaryFolder !== undefined) {
        config.cloudinaryFolder = cloudinaryFolder.trim();
        process.env.CLOUDINARY_FOLDER = cloudinaryFolder.trim();
      }
      if (cloudinaryUrl !== undefined) {
        config.cloudinaryUrl = cloudinaryUrl.trim();
        process.env.CLOUDINARY_URL = cloudinaryUrl.trim();
      }

      // Re-initialize Cloudinary storage in runtime
      cloudinaryStorage.reload();

      // Persist updates to backend .env file if it exists
      try {
        const envPath = path.resolve(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
          let envContent = fs.readFileSync(envPath, 'utf-8');
          const updates: Record<string, string> = {
            VTON_PROVIDER: config.vtonProvider,
            GEMINI_API_KEY: config.geminiApiKey,
            GEMINI_MODEL: config.geminiModel,
            FAL_KEY: config.falKey,
            VTON_API_KEY: config.vtonApiKey,
            VTON_API_URL: config.vtonApiUrl,
            CLOUDINARY_CLOUD_NAME: config.cloudinaryCloudName,
            CLOUDINARY_API_KEY: config.cloudinaryApiKey,
            CLOUDINARY_API_SECRET: config.cloudinaryApiSecret,
            CLOUDINARY_FOLDER: config.cloudinaryFolder,
            CLOUDINARY_URL: config.cloudinaryUrl
          };

          for (const [key, val] of Object.entries(updates)) {
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (regex.test(envContent)) {
              envContent = envContent.replace(regex, `${key}=${val}`);
            } else {
              envContent += `\n${key}=${val}`;
            }
          }
          fs.writeFileSync(envPath, envContent, 'utf-8');
        }
      } catch (err: any) {
        console.warn('[Admin] Could not write updates to .env:', err.message);
      }

      // Record Super Admin Audit Log
      db.recordAuditLog({
        action: 'AI_ENGINE_CONFIG_UPDATED',
        performedBy: (request.user as any)?.name || 'Platform Super Admin',
        tenantId: 'platform_system',
        details: {
          activeProvider: config.vtonProvider,
          geminiModel: config.geminiModel,
          geminiConfigured: Boolean(config.geminiApiKey),
          falConfigured: Boolean(config.falKey),
          timestamp: new Date().toISOString()
        }
      });

      return reply.send({
        success: true,
        message: 'AI Engine configuration updated successfully. Changes applied in real time.',
        config: {
          activeProvider: config.vtonProvider,
          gemini: {
            configured: Boolean(config.geminiApiKey),
            model: config.geminiModel,
            maskedKey: maskKey(config.geminiApiKey)
          },
          fal: {
            configured: Boolean(config.falKey),
            maskedKey: maskKey(config.falKey)
          },
          external: {
            configured: Boolean(config.vtonApiKey),
            maskedKey: maskKey(config.vtonApiKey),
            apiUrl: config.vtonApiUrl
          }
        }
      });
    }
  );

  // 3. Test API Key Connectivity Directly from Super Admin Dashboard
  app.post(
    '/api/v1/admin/ai-engine/test-key',
    { preHandler: [authenticateToken, requireRole('SUPER_ADMIN')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { provider, apiKey, model } = (request.body as any) || {};

      if (provider === 'gemini') {
        const keyToTest = apiKey || config.geminiApiKey;
        if (!keyToTest) {
          return reply.status(400).send({ success: false, message: 'No Gemini API key provided to test.' });
        }

        try {
          // Verify with Google Generative Language API
          const testUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${keyToTest}`;
          const res = await fetch(testUrl, { signal: AbortSignal.timeout(8000) });

          if (res.ok) {
            const data: any = await res.json();
            const models = (data.models || []).map((m: any) => m.name.replace('models/', ''));
            const hasFlash = models.some((m: string) => m.includes('flash'));

            return reply.send({
              success: true,
              provider: 'gemini',
              message: `✅ Gemini API Key is valid and operational! Connected to ${models.length} models.`,
              modelsFound: models.length,
              recommendedModel: hasFlash ? 'gemini-flash-latest' : models[0],
              sampleModels: models.slice(0, 6)
            });
          }

          const errText = await res.text();
          return reply.status(400).send({
            success: false,
            provider: 'gemini',
            message: `❌ Gemini API verification failed (HTTP ${res.status}): ${errText}`
          });
        } catch (err: any) {
          return reply.status(500).send({
            success: false,
            provider: 'gemini',
            message: `Network error verifying Gemini key: ${err.message}`
          });
        }
      }

      if (provider === 'fal') {
        const keyToTest = apiKey || config.falKey;
        if (!keyToTest) {
          return reply.status(400).send({ success: false, message: 'No Fal AI key provided to test.' });
        }

        // Basic verification of Fal key structure
        const isValidFormat = keyToTest.length >= 20 && (keyToTest.includes(':') || keyToTest.startsWith('fal_'));
        return reply.send({
          success: isValidFormat,
          provider: 'fal',
          message: isValidFormat
            ? '✅ Fal AI Key format is valid and ready for fal-ai/flux-pro/v1/vto pipelines.'
            : '⚠️ Fal key format does not match expected key_id:key_secret or fal_ token format.'
        });
      }

      if (provider === 'cloudinary') {
        const isReady = cloudinaryStorage.isConfigured();
        return reply.send({
          success: isReady,
          provider: 'cloudinary',
          message: isReady
            ? `✅ Cloudinary storage is active and ready. Try-on results will upload automatically to '${config.cloudinaryFolder}/results'.`
            : `⚠️ Cloudinary credentials incomplete. Please set CLOUDINARY_URL or Cloud Name, API Key, and API Secret in backend/.env.`
        });
      }

      return reply.status(400).send({
        success: false,
        message: `Unknown provider '${provider}'. Supported: gemini, fal, cloudinary.`
      });
    }
  );
}
