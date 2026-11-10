import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../infrastructure/config.js';
import { db } from '../../infrastructure/database.js';
import { authenticateToken, requireRole } from '../../infrastructure/auth.guard.js';
import { cloudinaryStorage } from '../../infrastructure/cloudinary_storage.js';
import { isMaskedPlaceholder, maskSecret, sanitizeEnvValue, updateEnvFile } from '../../infrastructure/env_manager.js';

export async function adminAiEngineRoutes(app: FastifyInstance) {
  // 1. Fetch AI Engine Configuration & Model Registry Status (Never leak plaintext API keys)
  app.get(
    '/api/v1/admin/ai-engine/config',
    { preHandler: [authenticateToken, requireRole('SUPER_ADMIN')] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
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
          model: config.geminiModel || 'gemini-3.6-flash',
          maskedKey: maskSecret(config.geminiApiKey),
        },
        fal: {
          configured: Boolean(config.falKey),
          maskedKey: maskSecret(config.falKey),
        },
        cloudinary: {
          configured: cloudinaryStorage.isConfigured(),
          cloudName: config.cloudinaryCloudName || '',
          maskedApiKey: maskSecret(config.cloudinaryApiKey),
          maskedSecret: maskSecret(config.cloudinaryApiSecret),
          folder: config.cloudinaryFolder || 'virtual-try-on',
        },
        fallbackEnabled: true,
        fallbackChain: ['gemini', 'fal', 'viton_hd'],
        availableProviders: [
          {
            id: 'gemini',
            name: 'Google Gemini Multimodal Vision + Fashion Synthesis',
            description: 'Analyzes model anatomy, fabric drape, and lighting using Gemini 2.5/Flash, then renders fitting.',
            recommended: true,
            status: config.geminiApiKey ? 'ready' : 'key_required',
          },
          {
            id: 'fal',
            name: 'Fal AI FLUX Pro Virtual Try-On (fal-ai/flux-pro/v1/vto)',
            description: 'Hyper-realistic multi-modal cloud inference via fal_client.',
            status: config.falKey ? 'ready' : 'key_required',
          },
          {
            id: 'viton',
            name: 'Local VITON-HD Vision Synthesizer',
            description: 'High-performance CPU/GPU local vision engine. Guaranteed instant zero-cost fallback.',
            status: 'ready',
          },
        ],
        aiServiceEngineUrl: config.aiServiceUrl,
        aiServiceCapabilities,
      });
    }
  );

  // 2. Update AI Engine Configuration (Dynamic Live Reload + Safe .env Sync)
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
        cloudinaryCloudName,
        cloudinaryApiKey,
        cloudinaryApiSecret,
        cloudinaryFolder,
      } = body;

      const envUpdates: Record<string, string> = {};

      if (typeof activeProvider === 'string' && activeProvider.trim()) {
        const val = sanitizeEnvValue(activeProvider);
        config.vtonProvider = val;
      }
      if (typeof geminiApiKey === 'string' && geminiApiKey.trim() && !isMaskedPlaceholder(geminiApiKey)) {
        const val = sanitizeEnvValue(geminiApiKey);
        config.geminiApiKey = val;
        process.env.GEMINI_API_KEY = val;
        envUpdates.GEMINI_API_KEY = val;
      }
      if (typeof geminiModel === 'string' && geminiModel.trim()) {
        const val = sanitizeEnvValue(geminiModel);
        config.geminiModel = val;
        process.env.GEMINI_MODEL = val;
        envUpdates.GEMINI_MODEL = val;
      }
      if (typeof falKey === 'string' && falKey.trim() && !isMaskedPlaceholder(falKey)) {
        const val = sanitizeEnvValue(falKey);
        config.falKey = val;
        process.env.FAL_KEY = val;
        envUpdates.FAL_KEY = val;
      }
      if (cloudinaryCloudName !== undefined && typeof cloudinaryCloudName === 'string') {
        const val = sanitizeEnvValue(cloudinaryCloudName);
        config.cloudinaryCloudName = val;
        process.env.CLOUDINARY_CLOUD_NAME = val;
        envUpdates.CLOUDINARY_CLOUD_NAME = val;
      }
      if (typeof cloudinaryApiKey === 'string' && cloudinaryApiKey.trim() && !isMaskedPlaceholder(cloudinaryApiKey)) {
        const val = sanitizeEnvValue(cloudinaryApiKey);
        config.cloudinaryApiKey = val;
        process.env.CLOUDINARY_API_KEY = val;
        envUpdates.CLOUDINARY_API_KEY = val;
      }
      if (typeof cloudinaryApiSecret === 'string' && cloudinaryApiSecret.trim() && !isMaskedPlaceholder(cloudinaryApiSecret)) {
        const val = sanitizeEnvValue(cloudinaryApiSecret);
        config.cloudinaryApiSecret = val;
        process.env.CLOUDINARY_API_SECRET = val;
        envUpdates.CLOUDINARY_API_SECRET = val;
      }
      if (cloudinaryFolder !== undefined && typeof cloudinaryFolder === 'string') {
        const val = sanitizeEnvValue(cloudinaryFolder);
        config.cloudinaryFolder = val;
        process.env.CLOUDINARY_FOLDER = val;
        envUpdates.CLOUDINARY_FOLDER = val;
      }

      cloudinaryStorage.reload();
      updateEnvFile(envUpdates);

      db.recordAuditLog({
        actorId: request.authUser!.id,
        actorRole: request.authUser!.role,
        action: 'AI_ENGINE_CONFIG_UPDATED',
        entity: 'AiEngine',
        details: {
          activeProvider: config.vtonProvider,
          geminiModel: config.geminiModel,
          geminiConfigured: Boolean(config.geminiApiKey),
          falConfigured: Boolean(config.falKey),
          timestamp: new Date().toISOString(),
        },
      });

      return reply.send({
        success: true,
        message: 'AI Engine configuration updated successfully. Changes applied in real time.',
        config: {
          activeProvider: config.vtonProvider,
          gemini: {
            configured: Boolean(config.geminiApiKey),
            model: config.geminiModel,
            maskedKey: maskSecret(config.geminiApiKey),
          },
          fal: {
            configured: Boolean(config.falKey),
            maskedKey: maskSecret(config.falKey),
          },
        },
      });
    }
  );

  // 3. Test API Key Connectivity Directly from Super Admin Dashboard
  app.post(
    '/api/v1/admin/ai-engine/test-key',
    { preHandler: [authenticateToken, requireRole('SUPER_ADMIN')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { provider, apiKey } = (request.body as any) || {};

      if (provider === 'gemini') {
        const candidate = apiKey && !isMaskedPlaceholder(apiKey) ? String(apiKey).trim() : '';
        const keyToTest = candidate || config.geminiApiKey;
        if (!keyToTest) {
          return reply.status(400).send({ success: false, message: 'No Gemini API key provided to test.' });
        }

        try {
          // Pass API key via header instead of URL query string so it never appears in logs
          const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
            headers: { 'x-goog-api-key': keyToTest },
            signal: AbortSignal.timeout(8000),
          });

          if (res.ok) {
            const data: any = await res.json();
            const models = (data.models || []).map((m: any) => m.name.replace('models/', ''));
            const recommendedModel = models.includes('gemini-3.6-flash')
              ? 'gemini-3.6-flash'
              : (models.find((m: string) => m.includes('flash') && !m.includes('latest')) || models[0]);

            return reply.send({
              success: true,
              provider: 'gemini',
              message: `✅ Gemini API Key is valid and operational! Connected to ${models.length} models.`,
              modelsFound: models.length,
              recommendedModel,
              sampleModels: models.slice(0, 6),
            });
          }

          const errText = await res.text();
          return reply.status(400).send({
            success: false,
            provider: 'gemini',
            message: `❌ Gemini API verification failed (HTTP ${res.status}): ${errText}`,
          });
        } catch (err: any) {
          return reply.status(500).send({
            success: false,
            provider: 'gemini',
            message: `Network error verifying Gemini key: ${err.message}`,
          });
        }
      }

      if (provider === 'fal') {
        const candidate = apiKey && !isMaskedPlaceholder(apiKey) ? String(apiKey).trim() : '';
        const keyToTest = candidate || config.falKey;
        if (!keyToTest) {
          return reply.status(400).send({ success: false, message: 'No Fal AI key provided to test.' });
        }

        const isValidFormat = keyToTest.length >= 20 && (keyToTest.includes(':') || keyToTest.startsWith('fal_'));
        return reply.send({
          success: isValidFormat,
          provider: 'fal',
          message: isValidFormat
            ? '✅ Fal AI Key format is valid and ready for fal-ai/flux-pro/v1/vto pipelines.'
            : '⚠️ Fal key format does not match expected key_id:key_secret or fal_ token format.',
        });
      }

      if (provider === 'cloudinary') {
        const isReady = cloudinaryStorage.isConfigured();
        return reply.send({
          success: isReady,
          provider: 'cloudinary',
          message: isReady
            ? `✅ Cloudinary storage is active and ready. Try-on results will upload automatically to '${config.cloudinaryFolder}/results'.`
            : `⚠️ Cloudinary credentials incomplete. Please set Cloud Name, API Key, and API Secret in backend/.env.`,
        });
      }

      return reply.status(400).send({
        success: false,
        message: `Unknown provider '${provider}'. Supported: gemini, fal, cloudinary.`,
      });
    }
  );
}
