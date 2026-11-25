import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../infrastructure/config.js';
import { db } from '../../infrastructure/database.js';
import { createAdminMiddleware, registerScopedPreHandlers } from '../../infrastructure/auth.guard.js';
import { cloudinaryStorage } from '../../infrastructure/cloudinary_storage.js';
import { requirePermission } from '../../modules/rbac/rbac.catalog.js';
import { isMaskedPlaceholder, maskSecret, sanitizeEnvValue, updateEnvFile } from '../../infrastructure/env_manager.js';
import { geminiTryOnEngine } from '../../modules/tryon/gemini.engine.js';
import { tryOnEngine } from '../../modules/tryon/tryon.engine.js';

const adminGuards = createAdminMiddleware();

export async function adminAiEngineRoutes(app: FastifyInstance) {
  registerScopedPreHandlers(app, adminGuards);

  // 1. Read the try-on engine settings (never returns a key in plain text)
  app.get(
    '/api/v1/admin/ai-engine/config',
    { preHandler: requirePermission('ai', 'manage') },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const engine = geminiTryOnEngine.status();
      const active = tryOnEngine.status();
      return reply.send({
        activeProvider: active.provider,
        providerMode: active.mode,
        fallbackProvider: active.fallback,
        fal: {
          configured: Boolean(config.falKey),
          model: config.falModel,
          maskedKey: maskSecret(config.falKey),
        },
        gemini: {
          configured: engine.configured,
          model: config.geminiModel,
          imageModel: engine.imageModel,
          maskedKey: maskSecret(config.geminiApiKey),
        },
        cloudinary: {
          configured: cloudinaryStorage.isConfigured(),
          cloudName: config.cloudinaryCloudName || '',
          maskedApiKey: maskSecret(config.cloudinaryApiKey),
          maskedSecret: maskSecret(config.cloudinaryApiSecret),
          folder: config.cloudinaryFolder || 'virtual-try-on',
        },
        availableProviders: [
          {
            id: 'fal',
            name: 'fal.ai (Gemini 2.5 Flash Image edit)',
            description: 'Sends the person and the garment photo to the fal-hosted Gemini image-edit model. Used first when its key is set.',
            recommended: false,
            status: config.falKey ? 'ready' : 'key_required',
          },
          {
            id: 'gemini',
            name: 'Google Gemini',
            description: 'Looks at the person and the garment, writes a fitting prompt, then creates the try-on picture. It runs inside the backend.',
            recommended: true,
            status: engine.configured ? 'ready' : 'key_required',
          },
        ],
      });
    }
  );

  // 2. Save the settings (applies right away and is written to the .env file)
  app.post(
    '/api/v1/admin/ai-engine/config',
    { preHandler: requirePermission('ai', 'manage') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = (request.body as any) || {};
      const { geminiApiKey, geminiModel, geminiImageModel, falKey, falModel, tryonProvider, cloudinaryCloudName, cloudinaryApiKey, cloudinaryApiSecret, cloudinaryFolder } = body;
      const envUpdates: Record<string, string> = {};

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
      if (typeof geminiImageModel === 'string' && geminiImageModel.trim()) {
        const val = sanitizeEnvValue(geminiImageModel);
        config.geminiImageModel = val;
        process.env.GEMINI_IMAGE_MODEL = val;
        envUpdates.GEMINI_IMAGE_MODEL = val;
      }
      if (typeof falKey === 'string' && falKey.trim() && !isMaskedPlaceholder(falKey)) {
        const val = sanitizeEnvValue(falKey);
        config.falKey = val;
        process.env.FAL_KEY = val;
        envUpdates.FAL_KEY = val;
      }
      if (typeof falModel === 'string' && falModel.trim()) {
        const val = sanitizeEnvValue(falModel);
        config.falModel = val;
        process.env.FAL_MODEL = val;
        envUpdates.FAL_MODEL = val;
      }
      if (typeof tryonProvider === 'string' && ['auto', 'fal', 'gemini'].includes(tryonProvider.trim().toLowerCase())) {
        const val = tryonProvider.trim().toLowerCase() as 'auto' | 'fal' | 'gemini';
        config.tryonProvider = val;
        process.env.TRYON_PROVIDER = val;
        envUpdates.TRYON_PROVIDER = val;
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
          geminiModel: config.geminiModel,
          geminiImageModel: geminiTryOnEngine.imageModel(),
          geminiConfigured: Boolean(config.geminiApiKey),
          falModel: config.falModel,
          falConfigured: Boolean(config.falKey),
          providerMode: config.tryonProvider,
          timestamp: new Date().toISOString(),
        },
      });

      return reply.send({
        success: true,
        message: 'Settings saved. They are in use right away.',
        config: {
          activeProvider: tryOnEngine.status().provider,
          providerMode: config.tryonProvider,
          fal: { configured: Boolean(config.falKey), model: config.falModel, maskedKey: maskSecret(config.falKey) },
          gemini: {
            configured: Boolean(config.geminiApiKey),
            model: config.geminiModel,
            imageModel: geminiTryOnEngine.imageModel(),
            maskedKey: maskSecret(config.geminiApiKey),
          },
        },
      });
    }
  );

  // 3. Check that a key works, straight from the Super Admin screen
  app.post(
    '/api/v1/admin/ai-engine/test-key',
    { preHandler: requirePermission('ai', 'manage') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { provider, apiKey } = (request.body as any) || {};

      if (provider === 'gemini') {
        const candidate = apiKey && !isMaskedPlaceholder(apiKey) ? String(apiKey).trim() : '';
        const keyToTest = candidate || config.geminiApiKey;
        if (!keyToTest) {
          return reply.status(400).send({ success: false, message: 'No Gemini API key provided to test.' });
        }

        try {
          // The key goes in a header, not the URL, so it never appears in logs.
          const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
            headers: { 'x-goog-api-key': keyToTest },
            signal: AbortSignal.timeout(8000),
          });

          if (res.ok) {
            const data: any = await res.json();
            const models: string[] = (data.models || []).map((m: any) => String(m.name).replace('models/', ''));
            const imageModels = models.filter((m) => /image|nano-banana/i.test(m));
            return reply.send({
              success: true,
              provider: 'gemini',
              message: `Your Gemini key works. ${models.length} models are available.`,
              modelsFound: models.length,
              hasImageModel: imageModels.length > 0,
              imageModels: imageModels.slice(0, 6),
              recommendedModel: imageModels.includes(geminiTryOnEngine.imageModel()) ? geminiTryOnEngine.imageModel() : imageModels[0] || null,
            });
          }

          const errText = await res.text();
          return reply.status(400).send({ success: false, provider: 'gemini', message: `Gemini did not accept this key (HTTP ${res.status}). ${errText.slice(0, 200)}` });
        } catch (err: any) {
          return reply.status(500).send({ success: false, provider: 'gemini', message: `Could not reach Gemini: ${err.message}` });
        }
      }

      if (provider === 'cloudinary') {
        const isReady = cloudinaryStorage.isConfigured();
        return reply.send({
          success: isReady,
          provider: 'cloudinary',
          message: isReady
            ? `Cloudinary is ready. Try-on pictures are saved to '${config.cloudinaryFolder}/results'.`
            : 'Cloudinary details are incomplete. Set the cloud name, API key and API secret.',
        });
      }

      return reply.status(400).send({ success: false, message: `Unknown provider '${provider}'. Supported: gemini, cloudinary. (fal.ai keys are checked by a real try-on, because fal has no free key-check call.)` });
    }
  );
}
