/**
 * Pure HTML/text builders for transactional auth emails (no imports, safe to unit test or preview).
 *
 * Email clients block JavaScript, so a real "copy" button is impossible. Instead the code is rendered with
 * `user-select: all` so a single click / tap selects the entire code, ready to copy.
 */

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatExpiry(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export interface AuthEmailTemplateParams {
  portalTitle: string;
  accent: string;
  heading: string;
  intro: string;
  buttonLabel: string;
  actionUrl: string;
  codeLabel: string;
  otpCode: string;
  expiresInMinutes: number;
  footerNote: string;
}

export function renderAuthEmailHtml(p: AuthEmailTemplateParams): string {
  const code = escapeHtml(p.otpCode);
  const url = escapeHtml(p.actionUrl);
  const expiry = escapeHtml(formatExpiry(p.expiresInMinutes));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(p.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Your code is ${code}. It expires in ${expiry}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#0f172a;border-radius:16px;border:1px solid #1e293b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          <tr>
            <td style="padding:32px 32px 8px 32px;">
              <div style="font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:${p.accent};font-weight:700;">${escapeHtml(p.portalTitle)}</div>
              <h1 style="font-size:24px;line-height:1.3;color:#ffffff;margin:12px 0 12px 0;font-weight:700;">${escapeHtml(p.heading)}</h1>
              <p style="font-size:14px;line-height:1.6;color:#cbd5e1;margin:0 0 24px 0;">${p.intro}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 24px 32px;">
              <a href="${url}" style="display:inline-block;background:${p.accent};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 26px;border-radius:10px;">${escapeHtml(p.buttonLabel)}</a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 8px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#020617;border:1px solid #1e293b;border-radius:12px;">
                <tr>
                  <td align="center" style="padding:20px 16px 8px 16px;">
                    <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.1em;">${escapeHtml(p.codeLabel)}</div>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:4px 16px 8px 16px;">
                    <span style="display:inline-block;font-size:34px;line-height:1.2;font-weight:800;letter-spacing:0.3em;padding-left:0.3em;color:#ffffff;font-family:'SF Mono',Menlo,Consolas,'Courier New',monospace;-webkit-user-select:all;-moz-user-select:all;user-select:all;cursor:copy;">${code}</span>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:0 16px 18px 16px;">
                    <div style="font-size:12px;color:${p.accent};font-weight:600;">Click or tap the code to select it, then copy</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 8px 32px;">
              <p style="font-size:12px;line-height:1.6;color:#94a3b8;margin:0;">This link and code expire in <strong style="color:#e2e8f0;">${expiry}</strong>. ${escapeHtml(p.footerNote)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 32px 32px;">
              <p style="font-size:11px;line-height:1.6;color:#64748b;margin:0;">Button not working? Paste this link into your browser:<br><a href="${url}" style="color:${p.accent};word-break:break-all;">${url}</a></p>
            </td>
          </tr>
        </table>
        <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#64748b;margin:16px 0 0 0;">Never share this code with anyone. V-TRY will never ask for it.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildVerificationEmail(params: {
  portalTitle: string;
  accent: string;
  name: string;
  verifyUrl: string;
  otpCode: string;
  expiresInMinutes: number;
}): { html: string; text: string } {
  const html = renderAuthEmailHtml({
    portalTitle: params.portalTitle,
    accent: params.accent,
    heading: 'Verify your email address',
    intro: `Hi ${escapeHtml(params.name || 'there')}, confirm your email to activate your account and sign in securely.`,
    buttonLabel: 'Verify Email Address',
    actionUrl: params.verifyUrl,
    codeLabel: 'Or enter this 6-digit verification code',
    otpCode: params.otpCode,
    expiresInMinutes: params.expiresInMinutes,
    footerNote: 'If you did not create an account, you can safely ignore this email.',
  });
  const text = [
    `${params.portalTitle} - Verify your email`,
    `Hi ${params.name || 'there'},`,
    `Verify your email by opening: ${params.verifyUrl}`,
    `Or enter this 6-digit code: ${params.otpCode}`,
    `Expires in ${formatExpiry(params.expiresInMinutes)}. Never share this code with anyone.`,
  ].join('\n\n');
  return { html, text };
}

export function buildPasswordResetEmail(params: {
  portalTitle: string;
  accent: string;
  name: string;
  resetUrl: string;
  otpCode: string;
  expiresInMinutes: number;
}): { html: string; text: string } {
  const html = renderAuthEmailHtml({
    portalTitle: params.portalTitle,
    accent: params.accent,
    heading: 'Reset your password',
    intro: `Hi ${escapeHtml(params.name || 'there')}, we received a request to reset your password. Use the button or the code below to choose a new one.`,
    buttonLabel: 'Reset Password',
    actionUrl: params.resetUrl,
    codeLabel: '6-digit password reset code',
    otpCode: params.otpCode,
    expiresInMinutes: params.expiresInMinutes,
    footerNote: "If you didn't request a password reset, you can safely ignore this message.",
  });
  const text = [
    `${params.portalTitle} - Password Reset`,
    `Hi ${params.name || 'there'},`,
    `Reset your password by opening: ${params.resetUrl}`,
    `Or enter this 6-digit reset code: ${params.otpCode}`,
    `Expires in ${formatExpiry(params.expiresInMinutes)}. Never share this code with anyone.`,
  ].join('\n\n');
  return { html, text };
}
