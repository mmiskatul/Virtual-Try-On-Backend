import { v2 as cloudinary } from 'cloudinary';
import { config } from './config.js';

export interface CloudinaryUploadOptions {
  folder?: string;
  publicId?: string;
  tags?: string[];
}

export class CloudinaryStorage {
  private configured: boolean = false;

  constructor() {
    this.init();
  }

  private init() {
    if (config.cloudinaryUrl) {
      cloudinary.config({ cloudinary_url: config.cloudinaryUrl });
      this.configured = true;
      console.log('[Cloudinary] Configured via CLOUDINARY_URL.');
    } else if (config.cloudinaryCloudName && config.cloudinaryApiKey && config.cloudinaryApiSecret) {
      cloudinary.config({
        cloud_name: config.cloudinaryCloudName,
        api_key: config.cloudinaryApiKey,
        api_secret: config.cloudinaryApiSecret,
        secure: true
      });
      this.configured = true;
      console.log(`[Cloudinary] Configured for cloud '${config.cloudinaryCloudName}'.`);
    } else {
      console.log('[Cloudinary] Not configured in .env. Falling back to data URI & memory mode.');
      this.configured = false;
    }
  }

  public reload(newConfig?: { cloudinaryUrl?: string; cloudName?: string; apiKey?: string; apiSecret?: string }): boolean {
    if (newConfig) {
      if (newConfig.cloudinaryUrl) config.cloudinaryUrl = newConfig.cloudinaryUrl;
      if (newConfig.cloudName) config.cloudinaryCloudName = newConfig.cloudName;
      if (newConfig.apiKey) config.cloudinaryApiKey = newConfig.apiKey;
      if (newConfig.apiSecret) config.cloudinaryApiSecret = newConfig.apiSecret;
    }
    this.init();
    return this.configured;
  }

  public isConfigured(): boolean {
    return this.configured;
  }

  public async uploadBuffer(buffer: Buffer, options: CloudinaryUploadOptions = {}): Promise<string | null> {
    if (!this.configured) return null;
    return new Promise((resolve) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: options.folder || config.cloudinaryFolder,
          public_id: options.publicId,
          tags: options.tags || ['virtual-try-on'],
          resource_type: 'image'
        },
        (error, result) => {
          if (error || !result) {
            console.error('[Cloudinary] Upload failed:', error);
            resolve(null);
          } else {
            resolve(result.secure_url);
          }
        }
      );
      uploadStream.end(buffer);
    });
  }

  public async uploadBase64(base64Data: string, options: CloudinaryUploadOptions = {}): Promise<string | null> {
    if (!this.configured) return null;
    try {
      const result = await cloudinary.uploader.upload(base64Data, {
        folder: options.folder || config.cloudinaryFolder,
        public_id: options.publicId,
        tags: options.tags || ['virtual-try-on'],
        resource_type: 'image'
      });
      return result.secure_url;
    } catch (err) {
      console.error('[Cloudinary] Base64 upload failed:', err);
      return null;
    }
  }

  public async uploadRemoteUrl(remoteUrl: string, options: CloudinaryUploadOptions = {}): Promise<string | null> {
    if (!this.configured) return null;
    try {
      const result = await cloudinary.uploader.upload(remoteUrl, {
        folder: options.folder || `${config.cloudinaryFolder}/results`,
        public_id: options.publicId,
        tags: options.tags || ['virtual-try-on', 'results'],
        resource_type: 'image'
      });
      return result.secure_url;
    } catch (err) {
      console.error('[Cloudinary] Remote URL upload failed:', err);
      return null;
    }
  }
}

export const cloudinaryStorage = new CloudinaryStorage();
