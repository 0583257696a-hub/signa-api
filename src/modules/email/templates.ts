import type { Locale } from '../../lib/i18n';

export type TemplateId =
  | 'email_verification'
  | 'password_reset'
  | 'org_invitation'
  | 'subscription_status'
  | 'security_notice';

export interface TemplateVars {
  name?: string;
  link?: string;
  organizationName?: string;
  status?: string;
  event?: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type Copy = { subject: string; lines: (v: TemplateVars) => string[]; cta?: string };

const COPY: Record<TemplateId, Record<Locale, Copy>> = {
  email_verification: {
    en: { subject: 'Verify your email for Signa', lines: (v) => [`Hi ${v.name ?? ''},`, 'Please confirm your email address. The link expires in 24 hours.'], cta: 'Verify email' },
    he: { subject: 'אימות כתובת האימייל שלך ב-Signa', lines: (v) => [`שלום ${v.name ?? ''},`, 'נא לאשר את כתובת האימייל שלך. הקישור תקף ל-24 שעות.'], cta: 'אימות אימייל' },
  },
  password_reset: {
    en: { subject: 'Reset your Signa password', lines: () => ['We received a request to reset your password. The link expires in 1 hour.', 'If you did not request this, you can ignore this email.'], cta: 'Reset password' },
    he: { subject: 'איפוס הסיסמה שלך ב-Signa', lines: () => ['קיבלנו בקשה לאיפוס הסיסמה. הקישור תקף לשעה אחת.', 'אם לא ביקשת זאת, אפשר להתעלם מהודעה זו.'], cta: 'איפוס סיסמה' },
  },
  org_invitation: {
    en: { subject: 'You have been invited to an organization on Signa', lines: (v) => [`You have been invited to join ${v.organizationName ?? ''} on Signa. The invitation expires in 7 days.`], cta: 'Accept invitation' },
    he: { subject: 'הוזמנת להצטרף לארגון ב-Signa', lines: (v) => [`הוזמנת להצטרף לארגון ${v.organizationName ?? ''} ב-Signa. ההזמנה תקפה ל-7 ימים.`], cta: 'קבלת ההזמנה' },
  },
  subscription_status: {
    en: { subject: 'Your Signa subscription was updated', lines: (v) => [`Your subscription status is now: ${v.status ?? ''}.`] },
    he: { subject: 'המינוי שלך ב-Signa עודכן', lines: (v) => [`סטטוס המינוי שלך כעת: ${v.status ?? ''}.`] },
  },
  security_notice: {
    en: { subject: 'Security notice for your Signa account', lines: (v) => [`A security-relevant change was made to your account: ${v.event ?? ''}.`, 'If this was not you, reset your password immediately.'] },
    he: { subject: 'הודעת אבטחה לחשבון Signa שלך', lines: (v) => [`בוצע שינוי הקשור לאבטחת החשבון שלך: ${v.event ?? ''}.`, 'אם לא ביצעת זאת, יש לאפס את הסיסמה מיד.'] },
  },
};

/** Renders a bilingual template. All variables are HTML-escaped; Hebrew is rendered RTL. */
export function renderTemplate(id: TemplateId, locale: Locale, vars: TemplateVars): { subject: string; html: string; text: string } {
  const copy = COPY[id][locale];
  const dir = locale === 'he' ? 'rtl' : 'ltr';
  const lines = copy.lines(vars);
  const safeLines = copy.lines(Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, escapeHtml(String(v ?? ''))])));
  const button =
    copy.cta && vars.link
      ? `<p><a href="${escapeHtml(vars.link)}" style="background:#5b5bd6;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${escapeHtml(copy.cta)}</a></p>`
      : '';
  const html = `<!doctype html><html lang="${locale}" dir="${dir}"><body style="font-family:system-ui,sans-serif;direction:${dir};text-align:${dir === 'rtl' ? 'right' : 'left'}">${safeLines
    .map((l) => `<p>${l}</p>`)
    .join('')}${button}</body></html>`;
  const text = [...lines, ...(copy.cta && vars.link ? [`${copy.cta}: ${vars.link}`] : [])].join('\n\n');
  return { subject: copy.subject, html, text };
}
