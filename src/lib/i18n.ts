import type { ErrorCode } from './errors';

export type Locale = 'he' | 'en';
export type Direction = 'rtl' | 'ltr';

export const directionFor = (locale: Locale): Direction => (locale === 'he' ? 'rtl' : 'ltr');

const MESSAGES: Record<ErrorCode, { en: string; he: string }> = {
  bad_request: { en: 'The request is invalid.', he: 'הבקשה אינה תקינה.' },
  validation_error: { en: 'Some fields are invalid.', he: 'חלק מהשדות אינם תקינים.' },
  unauthenticated: { en: 'Please sign in.', he: 'יש להתחבר.' },
  forbidden: { en: 'You do not have permission to perform this action.', he: 'אין לך הרשאה לבצע פעולה זו.' },
  csrf_failed: { en: 'Security check failed. Refresh and try again.', he: 'בדיקת האבטחה נכשלה. רעננו ונסו שוב.' },
  not_found: { en: 'Not found.', he: 'לא נמצא.' },
  conflict: { en: 'The request conflicts with the current state.', he: 'הבקשה מתנגשת במצב הנוכחי.' },
  idempotency_conflict: {
    en: 'This idempotency key was already used with a different request.',
    he: 'מפתח האידמפוטנטיות כבר שימש לבקשה אחרת.',
  },
  rate_limited: { en: 'Too many requests. Please try again later.', he: 'יותר מדי בקשות. נסו שוב מאוחר יותר.' },
  quota_exceeded: { en: 'Your usage quota for this period has been reached.', he: 'מכסת השימוש לתקופה זו נוצלה.' },
  entitlement_required: { en: 'Your plan does not include this feature.', he: 'המסלול שלך אינו כולל תכונה זו.' },
  input_too_long: { en: 'The text is too long for your plan.', he: 'הטקסט ארוך מדי עבור המסלול שלך.' },
  empty_input: { en: 'Please enter some text.', he: 'יש להזין טקסט.' },
  feature_disabled: { en: 'This feature is currently unavailable.', he: 'תכונה זו אינה זמינה כרגע.' },
  account_inactive: { en: 'This account is not active.', he: 'החשבון אינו פעיל.' },
  organization_suspended: { en: 'This organization is suspended.', he: 'הארגון מושעה.' },
  reauthentication_required: {
    en: 'Please confirm your password to continue.',
    he: 'יש לאשר את הסיסמה כדי להמשיך.',
  },
  invalid_credentials: { en: 'Incorrect email or password.', he: 'אימייל או סיסמה שגויים.' },
  invalid_token: { en: 'This link is invalid or has expired.', he: 'הקישור אינו תקף או שפג תוקפו.' },
  email_not_verified: { en: 'Please verify your email address first.', he: 'יש לאמת את כתובת האימייל תחילה.' },
  registration_closed: { en: 'Registration is currently closed.', he: 'ההרשמה סגורה כרגע.' },
  payload_too_large: { en: 'The upload is too large.', he: 'הקובץ גדול מדי.' },
  unsupported_media_type: { en: 'This file type is not allowed.', he: 'סוג הקובץ אינו מורשה.' },
  invalid_signature: { en: 'Invalid signature.', he: 'חתימה לא תקינה.' },
  provider_not_configured: {
    en: 'This service has not been configured yet.',
    he: 'השירות טרם הוגדר.',
  },
  provider_error: { en: 'An upstream service failed. Please try again.', he: 'שירות חיצוני נכשל. נסו שוב.' },
  queue_unavailable: { en: 'Processing is temporarily unavailable.', he: 'העיבוד אינו זמין זמנית.' },
  job_not_ready: { en: 'The job has not finished yet.', he: 'העבודה טרם הסתיימה.' },
  job_not_cancellable: { en: 'The job can no longer be cancelled.', he: 'לא ניתן עוד לבטל את העבודה.' },
  service_unavailable: { en: 'Service temporarily unavailable.', he: 'השירות אינו זמין זמנית.' },
  internal_error: { en: 'Something went wrong.', he: 'אירעה שגיאה.' },
};

export function errorMessage(code: ErrorCode, locale: Locale): string {
  return MESSAGES[code][locale];
}

/** Picks a supported locale from an Accept-Language header (defaults to Hebrew). */
export function localeFromHeader(header: string | undefined | null): Locale {
  if (!header) return 'he';
  const first = header.split(',')[0]?.trim().toLowerCase() ?? '';
  if (first.startsWith('en')) return 'en';
  if (first.startsWith('he') || first.startsWith('iw')) return 'he';
  return header.toLowerCase().includes('he') ? 'he' : 'en';
}
