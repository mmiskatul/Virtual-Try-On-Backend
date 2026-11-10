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
    return Boolean(config.falKey);
  }

  public detectProvider(): 'fal' | 'local' {
    if (!this.isConfigured()) return 'local';
    return 'fal';
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

    throw new Error('Fal AI key (FAL_KEY) is not configured.');
  }

  public async getStatus(jobId: string): Promise<VtonJobStatus | undefined> {
    return this.jobs.get(jobId);
  }
}

export const externalVtonService = new ExternalVtonService();
