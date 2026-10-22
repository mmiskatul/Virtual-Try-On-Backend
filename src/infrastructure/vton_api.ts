import { config } from './config.js';

export interface VtonJobStatus {
  jobId: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  resultUrl?: string;
  error?: string;
  provider: string;
  createdAt: number;
}

export class ExternalVtonService {
  private jobs: Map<string, VtonJobStatus> = new Map();

  public isConfigured(): boolean {
    return Boolean(config.falKey || config.vtonApiKey || config.vtonApiUrl);
  }

  public detectProvider(): 'fal' | 'fashn' | 'replicate' | 'segmind' | 'custom' | 'local' {
    if (!this.isConfigured()) return 'local';
    const provider = (config.vtonProvider || 'auto').toLowerCase();
    if (['fal', 'fashn', 'replicate', 'segmind', 'custom'].includes(provider)) {
      return provider as any;
    }

    const key = config.falKey || config.vtonApiKey || '';
    const url = config.vtonApiUrl || '';

    if (config.falKey || key.startsWith('fal_') || (key.includes(':') && !key.includes('/')) || url.includes('fal.ai') || url.includes('fal.run')) return 'fal';
    if (key.startsWith('fa_') || key.startsWith('fashn_') || url.includes('fashn.ai')) return 'fashn';
    if (key.startsWith('r8_') || url.includes('replicate.com')) return 'replicate';
    if (url.includes('segmind.com')) return 'segmind';
    if (url) return 'custom';
    return config.falKey ? 'fal' : 'fashn';
  }

  public async submitTryOn(payload: {
    personImage: string;
    garmentImage: string;
    category?: string;
    prompt?: string;
  }): Promise<{ jobId: string; status: string; queuePosition?: number; resultUrl?: string }> {
    const provider = this.detectProvider();
    const jobId = `vton_ext_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const category = (payload.category || 'tops').toLowerCase();

    // 0. Fal AI Provider (handled via Python ai-service with fal-client)
    if (provider === 'fal') {
      const endpoint = `${config.aiServiceUrl}/api/v1/try-on/jobs`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personImage: payload.personImage,
          garmentImage: payload.garmentImage,
          category,
          model_name: 'fal',
          prompt: payload.prompt
        })
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Fal AI dispatch error (${res.status}): ${errText}`);
      }
      const data: any = await res.json();
      return {
        jobId: data.job_id || data.jobId || jobId,
        status: data.status || 'QUEUED',
        resultUrl: data.resultUrl || data.output_url
      };
    }

    // 1. Fashn.ai Provider
    if (provider === 'fashn') {
      const endpoint = config.vtonApiUrl || 'https://api.fashn.ai/v1/run';
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.vtonApiKey}`
          },
          body: JSON.stringify({
            model_image: payload.personImage,
            garment_image: payload.garmentImage,
            category: category === 'dresses' ? 'dresses' : category === 'bottoms' ? 'bottoms' : 'tops',
            mode: 'balanced',
            nsfw_filter: true
          })
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Fashn.ai error (${res.status}): ${errText}`);
        }

        const data: any = await res.json();
        const externalId = data.id || jobId;

        this.jobs.set(externalId, {
          jobId: externalId,
          status: data.status === 'completed' ? 'COMPLETED' : 'PROCESSING',
          resultUrl: Array.isArray(data.output) ? data.output[0] : data.output,
          provider: 'fashn.ai',
          createdAt: Date.now()
        });

        return {
          jobId: externalId,
          status: data.status === 'completed' ? 'COMPLETED' : 'PROCESSING',
          resultUrl: Array.isArray(data.output) ? data.output[0] : data.output
        };
      } catch (err: any) {
        console.error('[VTON External API] Fashn.ai dispatch error:', err.message);
        throw err;
      }
    }

    // 2. Replicate IDM-VTON Provider
    if (provider === 'replicate') {
      const endpoint = config.vtonApiUrl || 'https://api.replicate.com/v1/predictions';
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Token ${config.vtonApiKey}`
          },
          body: JSON.stringify({
            version: 'c871bb9b046607b680449ecbae55fd8c6d945e0a1948644bf2361b3d05e800f0',
            input: {
              human_img: payload.personImage,
              garm_img: payload.garmentImage,
              garment_des: category
            }
          })
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Replicate error (${res.status}): ${errText}`);
        }

        const data: any = await res.json();
        const externalId = data.id || jobId;

        this.jobs.set(externalId, {
          jobId: externalId,
          status: data.status === 'succeeded' ? 'COMPLETED' : 'PROCESSING',
          resultUrl: Array.isArray(data.output) ? data.output[0] : data.output,
          provider: 'replicate',
          createdAt: Date.now()
        });

        return {
          jobId: externalId,
          status: data.status === 'succeeded' ? 'COMPLETED' : 'PROCESSING',
          resultUrl: Array.isArray(data.output) ? data.output[0] : data.output
        };
      } catch (err: any) {
        console.error('[VTON External API] Replicate dispatch error:', err.message);
        throw err;
      }
    }

    // 3. Custom / Generic VTON API Provider
    if (provider === 'custom') {
      const endpoint = config.vtonApiUrl;
      if (!endpoint) throw new Error('VTON_API_URL must be specified for custom VTON API provider');

      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (config.vtonApiKey) {
          headers['Authorization'] = `Bearer ${config.vtonApiKey}`;
          headers['x-api-key'] = config.vtonApiKey;
        }

        const res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            personImage: payload.personImage,
            garmentImage: payload.garmentImage,
            model_image: payload.personImage,
            garment_image: payload.garmentImage,
            category
          })
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Custom VTON API error (${res.status}): ${errText}`);
        }

        const data: any = await res.json();
        const externalId = data.jobId || data.id || jobId;
        const resultUrl = data.resultUrl || data.outputUrl || (Array.isArray(data.output) ? data.output[0] : data.output);

        this.jobs.set(externalId, {
          jobId: externalId,
          status: resultUrl ? 'COMPLETED' : (data.status || 'PROCESSING'),
          resultUrl,
          provider: 'custom',
          createdAt: Date.now()
        });

        return {
          jobId: externalId,
          status: resultUrl ? 'COMPLETED' : (data.status || 'PROCESSING'),
          resultUrl
        };
      } catch (err: any) {
        console.error('[VTON External API] Custom API dispatch error:', err.message);
        throw err;
      }
    }

    throw new Error(`Unsupported VTON provider '${provider}'.`);
  }

  public async getStatus(jobId: string): Promise<VtonJobStatus | undefined> {
    const cached = this.jobs.get(jobId);
    if (!cached) return undefined;
    if (cached.status === 'COMPLETED' && cached.resultUrl) {
      return cached;
    }

    const provider = this.detectProvider();

    // Poll Fashn.ai
    if (provider === 'fashn' && config.vtonApiKey) {
      try {
        const res = await fetch(`https://api.fashn.ai/v1/status/${jobId}`, {
          headers: { 'Authorization': `Bearer ${config.vtonApiKey}` }
        });
        if (res.ok) {
          const data: any = await res.json();
          if (data.status === 'completed') {
            cached.status = 'COMPLETED';
            cached.resultUrl = Array.isArray(data.output) ? data.output[0] : data.output;
          } else if (data.status === 'failed') {
            cached.status = 'FAILED';
            cached.error = data.error?.message || 'Processing failed';
          }
          this.jobs.set(jobId, cached);
        }
      } catch (e) {
        // Return existing cache on network glitch
      }
    }

    // Poll Replicate
    if (provider === 'replicate' && config.vtonApiKey) {
      try {
        const res = await fetch(`https://api.replicate.com/v1/predictions/${jobId}`, {
          headers: { 'Authorization': `Token ${config.vtonApiKey}` }
        });
        if (res.ok) {
          const data: any = await res.json();
          if (data.status === 'succeeded') {
            cached.status = 'COMPLETED';
            cached.resultUrl = Array.isArray(data.output) ? data.output[0] : data.output;
          } else if (data.status === 'failed') {
            cached.status = 'FAILED';
            cached.error = data.error || 'Prediction failed';
          }
          this.jobs.set(jobId, cached);
        }
      } catch (e) {
        // Return existing cache
      }
    }

    return cached;
  }
}

export const externalVtonService = new ExternalVtonService();
