import nodemailer, { Transporter } from 'nodemailer';
import { config } from './config.js';
import { AuthPortal } from '../domain/types.js';

export interface EmailSendResult {
  delivered: boolean;
  provider: 'resend' | 'smtp' | 'dev-preview';
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

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getPortalMeta(portal: AuthPortal): { title: string; accent: string; baseUrl: string } {
  switch (portal) {
    case 'brand':
      return {
        title: 'V-TRY Brand Merchant Portal',
        accent: '#0ea5e9',
        baseUrl: config.brandDashboardUrl.replace(/\/$/, ''),
      };
    case 'admin':
      return {
        title: 'V-TRY Platform Governance',
        accent: '#f59e0b',
        baseUrl: config.superAdminUrl.replace(/\/$/, ''),
      };
    case 'marketplace':
    default:
      return {
        title: 'V-TRY Fashion Marketplace',
        accent: '#9333ea',
        baseUrl: config.marketplaceUrl.replace(/\/$/, ''),
      };
  }
}

export interface SmtpOverrideOptions {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
}

class EmailService {
  private smtpTransporter: Transporter | null = null;

  public hasRealTransport(): boolean {
    return Boolean(config.smtpHost);
  }

  public getActiveTransport(): 'smtp' | 'dev-preview' {
    if (config.smtpHost) return 'smtp';
    return 'dev-preview';
  }

  public reloadTransport(): void {
    if (this.smtpTransporter) {
      try {
        this.smtpTransporter.close();
      } catch {
        // Ignore transporter close errors
      }
      this.smtpTransporter = null;
    }
  }

  public isDevPreviewAllowed(): boolean {
    return process.env.NODE_ENV !== 'production' && !this.hasRealTransport();
  }

  public getPortalBaseUrl(portal: AuthPortal): string {
    return getPortalMeta(portal).baseUrl;
  }

  private createSmtpTransporter(override?: SmtpOverrideOptions): Transporter | null {
    const host = (override?.host ?? config.smtpHost).trim();
    if (!host) return null;

    const port = Number(override?.port ?? config.smtpPort ?? 587);
    const secure = override?.secure !== undefined ? Boolean(override.secure) : port === 465 || config.smtpSecure;
    const user = (override?.user ?? config.smtpUser).trim();
    const pass = override?.pass !== undefined && override.pass !== '' ? override.pass : config.smtpPass;

    return nodemailer.createTransport({
      host,
      port,
      secure,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      auth: user
        ? {
            user,
            pass,
          }
        : undefined,
    });
  }

  private getSmtpTransporter(): Transporter | null {
    if (!config.smtpHost) return null;
    if (!this.smtpTransporter) {
      this.smtpTransporter = this.createSmtpTransporter();
    }
    return this.smtpTransporter;
  }

  public async verifySmtpConnection(override?: SmtpOverrideOptions): Promise<{
    success: boolean;
    message: string;
    latencyMs: number;
  }> {
    const transporter = override?.host ? this.createSmtpTransporter(override) : this.getSmtpTransporter();
    if (!transporter) {
      return {
        success: false,
        latencyMs: 0,
        message: 'SMTP host is not configured.',
      };
    }

    const start = performance.now();
    try {
      await transporter.verify();
      const latencyMs = Number((performance.now() - start).toFixed(1));
      if (override?.host) transporter.close();
      return {
        success: true,
        latencyMs,
        message: `SMTP connection verified successfully (${latencyMs}ms). Ready to deliver verification and reset emails.`,
      };
    } catch (err: any) {
      const latencyMs = Number((performance.now() - start).toFixed(1));
      if (override?.host) transporter.close();
      return {
        success: false,
        latencyMs,
        message: `SMTP handshake failed: ${err?.message || 'Connection error'}`,
      };
    }
  }

  public async sendTestEmail(to: string, override?: SmtpOverrideOptions): Promise<{
    success: boolean;
    provider: 'smtp' | 'resend' | 'dev-preview';
    messageId?: string;
    message: string;
  }> {
    const transporter = override?.host ? this.createSmtpTransporter(override) : this.getSmtpTransporter();
    const fromAddr = (override?.from ?? config.emailFrom).trim() || 'V-TRY Studio <noreply@v-try.fashion>';

    if (transporter) {
      try {
        const info = await transporter.sendMail({
          from: fromAddr,
          to,
          subject: 'V-TRY Platform — SMTP Email Delivery Test',
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; background: #0f172a; color: #e2e8f0; border-radius: 16px; padding: 28px; border: 1px solid #1e293b;">
              <div style="font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: #f59e0b; font-weight: 700; margin-bottom: 10px;">V-TRY Platform Infrastructure</div>
              <h2 style="color: #ffffff; margin: 0 0 10px;">SMTP Test Successful</h2>
              <p style="font-size: 13px; color: #94a3b8; line-height: 1.6; margin: 0;">
                Your SMTP mail transport is configured and working properly for account verification and password recovery emails.
              </p>
            </div>
          `,
          text: 'V-TRY Platform SMTP Test Successful — Your email delivery pipeline is working properly.',
        });
        if (override?.host) transporter.close();
        return {
          success: true,
          provider: 'smtp',
          messageId: info.messageId,
          message: `Test email sent via SMTP to ${to} (Message ID: ${info.messageId}).`,
        };
      } catch (err: any) {
        if (override?.host) transporter.close();
        return {
          success: false,
          provider: 'smtp',
          message: `Failed to send test email via SMTP: ${err?.message || 'Unknown error'}`,
        };
      }
    }

    return {
      success: false,
      provider: 'dev-preview',
      message: 'No SMTP host configured. Enter SMTP details to test live email delivery.',
    };
  }

  private async dispatch(payload: BaseMailPayload): Promise<EmailSendResult> {
    // 1. Nodemailer SMTP (when SMTP_HOST is configured)
    const transporter = this.getSmtpTransporter();
    if (transporter) {
      try {
        await transporter.sendMail({
          from: config.emailFrom,
          to: payload.to,
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
        });
        return { delivered: true, provider: 'smtp' };
      } catch (err: any) {
        console.warn('[EmailService] SMTP dispatch error:', err?.message || err);
      }
    }

    // 2. Development Preview Fallback
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
  }): Promise<EmailSendResult> {
    const meta = getPortalMeta(params.portal);
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
  }): Promise<EmailSendResult> {
    const meta = getPortalMeta(params.portal);
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
