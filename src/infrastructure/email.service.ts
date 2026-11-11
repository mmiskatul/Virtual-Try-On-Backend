import { Resend } from 'resend';
import { config } from './config.js';
import { AuthPortal } from '../domain/types.js';

export interface EmailSendResult {
  delivered: boolean;
  error?: string;
  provider: 'resend' | 'dev-preview';
  messageId?: string;
  preview?: {
    actionUrl?: string;
    otpCode?: string;
    expiresInMinutes?: number;
  };
}

interface BaseMailPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
  preview?: {
    actionUrl?: string;
    otpCode?: string;
    expiresInMinutes?: number;
  };
}

export interface ResendOverrideOptions {
  apiKey?: string;
  from?: string;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isTrustedPortalOrigin(urlStr: string): string | undefined {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (host === 'localhost' || host === '127.0.0.1')
    ) {
      return parsed.origin;
    }
    if (
      parsed.protocol === 'https:' &&
      (host.endsWith('.vercel.app') || host === 'vton-platform.io' || host.endsWith('.vton-platform.io'))
    ) {
      return parsed.origin;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function getPortalMeta(portal: AuthPortal, requestOrigin?: string): { title: string; accent: string; baseUrl: string } {
  const safeOrigin = requestOrigin ? isTrustedPortalOrigin(requestOrigin) : undefined;
  switch (portal) {
    case 'brand':
      return {
        title: 'V-TRY Brand Merchant Portal',
        accent: '#0ea5e9',
        baseUrl: safeOrigin || config.brandDashboardUrl.replace(/\/$/, ''),
      };
    case 'admin':
      return {
        title: 'V-TRY Platform Governance',
        accent: '#f59e0b',
        baseUrl: safeOrigin || config.superAdminUrl.replace(/\/$/, ''),
      };
    case 'marketplace':
    default:
      return {
        title: 'V-TRY Fashion Marketplace',
        accent: '#9333ea',
        baseUrl: safeOrigin || config.marketplaceUrl.replace(/\/$/, ''),
      };
  }
}

class EmailService {
  private resendClient: Resend | null = null;
  private cachedKey = '';

  public hasRealTransport(): boolean {
    return Boolean(config.resendApiKey) && process.env.NODE_ENV !== 'test';
  }

  public getActiveTransport(): 'resend' | 'dev-preview' {
    return this.hasRealTransport() ? 'resend' : 'dev-preview';
  }

  public reloadTransport(): void {
    this.resendClient = null;
    this.cachedKey = '';
  }

  public isDevPreviewAllowed(): boolean {
    return process.env.NODE_ENV !== 'production' && !this.hasRealTransport();
  }

  public getPortalBaseUrl(portal: AuthPortal): string {
    return getPortalMeta(portal).baseUrl;
  }

  private getClient(apiKeyOverride?: string): Resend | null {
    const key = (apiKeyOverride ?? config.resendApiKey).trim();
    if (!key) return null;
    if (apiKeyOverride) return new Resend(key);
    if (!this.resendClient || this.cachedKey !== key) {
      this.resendClient = new Resend(key);
      this.cachedKey = key;
    }
    return this.resendClient;
  }

  public async verifyResendConnection(override?: ResendOverrideOptions): Promise<{
    success: boolean;
    message: string;
    latencyMs: number;
  }> {
    const client = this.getClient(override?.apiKey);
    if (!client) {
      return {
        success: false,
        latencyMs: 0,
        message: 'RESEND_API_KEY is not configured.',
      };
    }

    const start = performance.now();
    try {
      const { error } = await client.domains.list();
      const latencyMs = Number((performance.now() - start).toFixed(1));
      if (error) {
        return {
          success: false,
          latencyMs,
          message: `Resend API verification failed: ${error.message}`,
        };
      }
      return {
        success: true,
        latencyMs,
        message: `Resend API key verified (${latencyMs}ms). Ready to send verification and reset emails.`,
      };
    } catch (err: any) {
      const latencyMs = Number((performance.now() - start).toFixed(1));
      return {
        success: false,
        latencyMs,
        message: `Resend API check failed: ${err?.message || 'Network error'}`,
      };
    }
  }

  public async sendTestEmail(
    to: string,
    override?: ResendOverrideOptions
  ): Promise<{
    success: boolean;
    provider: 'resend' | 'dev-preview';
    messageId?: string;
    message: string;
  }> {
    const client = this.getClient(override?.apiKey);
    const fromAddr = (override?.from ?? config.resendFrom).trim() || 'V-TRY Studio <onboarding@resend.dev>';

    if (!client) {
      return {
        success: false,
        provider: 'dev-preview',
        message: 'RESEND_API_KEY is not configured. Add your Resend API key to test live email delivery.',
      };
    }

    try {
      const { data, error } = await client.emails.send({
        from: fromAddr,
        to: [to],
        subject: 'V-TRY Platform — Resend Email Delivery Test',
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; background: #0f172a; color: #e2e8f0; border-radius: 16px; padding: 28px; border: 1px solid #1e293b;">
            <div style="font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: #f59e0b; font-weight: 700; margin-bottom: 10px;">V-TRY Platform Infrastructure</div>
            <h2 style="color: #ffffff; margin: 0 0 10px;">Resend Test Successful</h2>
            <p style="font-size: 13px; color: #94a3b8; line-height: 1.6; margin: 0;">
              Your Resend transactional email pipeline is configured and ready for verification codes and password recovery.
            </p>
          </div>
        `,
        text: 'V-TRY Platform Resend Test Successful — Your transactional email pipeline is working properly.',
      });

      if (error) {
        return {
          success: false,
          provider: 'resend',
          message: `Resend API error: ${error.message}`,
        };
      }

      return {
        success: true,
        provider: 'resend',
        messageId: data?.id,
        message: `Test email sent via Resend to ${to} (ID: ${data?.id || 'sent'}).`,
      };
    } catch (err: any) {
      return {
        success: false,
        provider: 'resend',
        message: `Failed to send test email via Resend: ${err?.message || 'Unknown error'}`,
      };
    }
  }

  private async dispatch(payload: BaseMailPayload): Promise<EmailSendResult> {
    if (this.hasRealTransport()) {
      const client = this.getClient();
      if (client) {
        try {
          const { data, error } = await client.emails.send({
            from: config.resendFrom,
            to: [payload.to],
            subject: payload.subject,
            html: payload.html,
            text: payload.text,
          });
          if (error) {
            console.error('[EmailService] Resend dispatch error:', error.message);
            return { delivered: false, provider: 'resend', error: error.message };
          }
          return { delivered: true, provider: 'resend', messageId: data?.id };
        } catch (err: any) {
          const msg = err?.message || String(err);
          console.error('[EmailService] Resend dispatch exception:', msg);
          return { delivered: false, provider: 'resend', error: msg };
        }
      }
    }

    // Development Preview Fallback (when RESEND_API_KEY is unset or NODE_ENV === 'test')
    console.log('\n================ [EmailService - Dev Preview] ================');
    console.log(`To:      ${payload.to}`);
    console.log(`Subject: ${payload.subject}`);
    if (payload.preview?.actionUrl) console.log(`Link:    ${payload.preview.actionUrl}`);
    if (payload.preview?.otpCode) console.log(`OTP:     ${payload.preview.otpCode}`);
    console.log('==============================================================\n');

    return {
      delivered: true,
      provider: 'dev-preview',
      preview: this.isDevPreviewAllowed() ? payload.preview : undefined,
    };
  }

  public async sendVerificationEmail(params: {
    to: string;
    name: string;
    portal: AuthPortal;
    rawToken: string;
    otpCode: string;
    expiresInMinutes: number;
    requestOrigin?: string;
  }): Promise<EmailSendResult> {
    const meta = getPortalMeta(params.portal, params.requestOrigin);
    const verifyUrl = `${meta.baseUrl}/verify-email?token=${encodeURIComponent(params.rawToken)}&email=${encodeURIComponent(params.to)}`;
    const safeName = escapeHtml(params.name || 'there');

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; background: #0f172a; color: #e2e8f0; border-radius: 16px; padding: 32px; border: 1px solid #1e293b;">
        <div style="font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: ${meta.accent}; font-weight: 700; margin-bottom: 12px;">
          ${escapeHtml(meta.title)}
        </div>
        <h1 style="font-size: 22px; color: #ffffff; margin: 0 0 12px;">Verify your email address</h1>
        <p style="font-size: 14px; line-height: 1.6; color: #94a3b8; margin: 0 0 24px;">
          Hi ${safeName}, please verify your email address to activate your account and sign in securely.
        </p>
        <a href="${verifyUrl}" style="display: inline-block; background: ${meta.accent}; color: #ffffff; text-decoration: none; font-weight: 700; font-size: 14px; padding: 12px 24px; border-radius: 10px; margin-bottom: 24px;">
          Verify Email Address
        </a>
        <div style="background: #020617; border: 1px solid #1e293b; border-radius: 12px; padding: 16px; margin-bottom: 20px;">
          <div style="font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px;">Or enter your 6-digit verification code</div>
          <div style="font-size: 26px; font-weight: 800; letter-spacing: 0.25em; color: #ffffff; font-family: monospace;">${params.otpCode}</div>
        </div>
        <p style="font-size: 12px; color: #64748b; margin: 0;">
          This verification link and code expire in ${params.expiresInMinutes} minutes. If you did not create an account, you can safely ignore this email.
        </p>
      </div>
    `;

    const text = [
      `${meta.title} - Verify your email`,
      `Hi ${params.name || 'there'},`,
      `Verify your email by opening: ${verifyUrl}`,
      `Or enter this 6-digit code: ${params.otpCode}`,
      `Expires in ${params.expiresInMinutes} minutes.`,
    ].join('\n\n');

    return this.dispatch({
      to: params.to,
      subject: `Verify your email for ${meta.title}`,
      html,
      text,
      preview: {
        actionUrl: verifyUrl,
        otpCode: params.otpCode,
        expiresInMinutes: params.expiresInMinutes,
      },
    });
  }

  public async sendPasswordResetEmail(params: {
    to: string;
    name: string;
    portal: AuthPortal;
    rawToken: string;
    otpCode: string;
    expiresInMinutes: number;
    requestOrigin?: string;
  }): Promise<EmailSendResult> {
    const meta = getPortalMeta(params.portal, params.requestOrigin);
    const resetUrl = `${meta.baseUrl}/reset-password?token=${encodeURIComponent(params.rawToken)}&email=${encodeURIComponent(params.to)}`;
    const safeName = escapeHtml(params.name || 'there');

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; background: #0f172a; color: #e2e8f0; border-radius: 16px; padding: 32px; border: 1px solid #1e293b;">
        <div style="font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: ${meta.accent}; font-weight: 700; margin-bottom: 12px;">
          ${escapeHtml(meta.title)}
        </div>
        <h1 style="font-size: 22px; color: #ffffff; margin: 0 0 12px;">Reset your password</h1>
        <p style="font-size: 14px; line-height: 1.6; color: #94a3b8; margin: 0 0 24px;">
          Hi ${safeName}, we received a request to reset the password for your account. Click the button below or use the reset code to choose a new password.
        </p>
        <a href="${resetUrl}" style="display: inline-block; background: ${meta.accent}; color: #ffffff; text-decoration: none; font-weight: 700; font-size: 14px; padding: 12px 24px; border-radius: 10px; margin-bottom: 24px;">
          Reset Password
        </a>
        <div style="background: #020617; border: 1px solid #1e293b; border-radius: 12px; padding: 16px; margin-bottom: 20px;">
          <div style="font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px;">6-digit password reset code</div>
          <div style="font-size: 26px; font-weight: 800; letter-spacing: 0.25em; color: #ffffff; font-family: monospace;">${params.otpCode}</div>
        </div>
        <p style="font-size: 12px; color: #64748b; margin: 0;">
          This reset link and code expire in ${params.expiresInMinutes} minutes. If you didn't request a password reset, you can safely ignore this message.
        </p>
      </div>
    `;

    const text = [
      `${meta.title} - Password Reset`,
      `Hi ${params.name || 'there'},`,
      `Reset your password by opening: ${resetUrl}`,
      `Or enter this 6-digit reset code: ${params.otpCode}`,
      `Expires in ${params.expiresInMinutes} minutes.`,
    ].join('\n\n');

    return this.dispatch({
      to: params.to,
      subject: `Reset your password for ${meta.title}`,
      html,
      text,
      preview: {
        actionUrl: resetUrl,
        otpCode: params.otpCode,
        expiresInMinutes: params.expiresInMinutes,
      },
    });
  }

  public async sendPasswordChangedNotice(params: {
    to: string;
    name: string;
    portal: AuthPortal;
  }): Promise<EmailSendResult> {
    const meta = getPortalMeta(params.portal);
    const safeName = escapeHtml(params.name || 'there');

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; background: #0f172a; color: #e2e8f0; border-radius: 16px; padding: 32px; border: 1px solid #1e293b;">
        <div style="font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: ${meta.accent}; font-weight: 700; margin-bottom: 12px;">
          ${escapeHtml(meta.title)}
        </div>
        <h1 style="font-size: 20px; color: #ffffff; margin: 0 0 12px;">Your password was updated</h1>
        <p style="font-size: 14px; line-height: 1.6; color: #94a3b8; margin: 0;">
          Hi ${safeName}, this is a confirmation that your password for ${escapeHtml(meta.title)} was successfully changed. If you did not make this change, contact support immediately.
        </p>
      </div>
    `;

    const text = `Hi ${params.name || 'there'}, your password for ${meta.title} was successfully updated.`;

    return this.dispatch({
      to: params.to,
      subject: `Password updated for ${meta.title}`,
      html,
      text,
    });
  }
}

export const emailService = new EmailService();
