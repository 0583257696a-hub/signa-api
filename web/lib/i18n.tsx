'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Locale = 'he' | 'en';

const en = {
  appName: 'Signa',
  nav: { translate: 'Translate', history: 'Translation History', historyShort: 'History', dictionary: 'Dictionary', usage: 'Usage & Plan', settings: 'Settings', help: 'Help & Support', admin: 'Admin' },
  common: {
    clear: 'Clear', save: 'Save', cancel: 'Cancel', retry: 'Retry', loading: 'Loading…', edit: 'Edit', delete: 'Delete',
    signOut: 'Sign out', personal: 'Personal', back: 'Back', next: 'Next', close: 'Close', search: 'Search',
    errorGeneric: 'Something went wrong. Please try again.', plan: 'plan', of: 'of',
  },
  plans: { free: 'Free', pro: 'Pro', business: 'Business', upgrade: 'Upgrade to Pro', seePlans: 'See plans' },
  translate: {
    title: 'Translate your message',
    subtitle: 'Turn written words into visual communication.',
    emojiTitle: 'Translate into emojis',
    emojiSubtitle: 'Express your message visually and share it anywhere.',
    tabSign: 'Sign Language',
    tabEmoji: 'Emoji Translation',
    tabEmojiShort: 'Emoji',
    prompt: 'What would you like to say?',
    inputLang: 'Input',
    hebrew: 'עברית',
    tryExample: 'Try an example',
    examples: ['תודה רבה, נתראה מחר', 'איפה תחנת האוטובוס הקרובה?'],
    button: 'Translate message',
    privacy: 'Your text is processed for this translation only and isn’t saved. History is off.',
    privacyHistoryOn: 'Your text is processed for this translation only. You can save a result to your history.',
  },
  sign: {
    panelTitle: 'Israeli Sign Language',
    whatMeans: 'What does this mean?',
    renderPlaceholder: '3D avatar · render placeholder',
    segmentOf: 'Segment {n} of {total}',
    illustrative: 'Illustrative segmentation — not a validated ISL gloss',
    upNext: 'Up next', playing: 'Playing', played: 'Played', notAvailable: 'No reviewed sign',
    status: { verified: 'Verified translation', partially_verified: 'Partially verified', experimental: 'Experimental translation', unsupported: 'Unsupported', failed: 'Failed' },
    statusShort: { verified: 'Verified', partially_verified: 'Partially verified', experimental: 'Experimental', unsupported: 'Unsupported', failed: 'Failed' },
    explain: {
      verified: 'Shown only when every segment was reviewed by ISL experts against an approved test set.',
      partially_verified: 'Some parts are covered by reviewed signs; others are fingerspelled or missing.',
      experimental: 'Produced by an experimental engine and not proven linguistically correct. Segments follow Hebrew word order and are not ISL grammar.',
      unsupported: 'This message cannot currently be translated with sufficient confidence.',
      failed: 'The translation could not be completed.',
    },
    loading: 'Preparing the signing sequence…',
    covered: 'Covered by reviewed signs',
    fingerspelled: 'Fingerspelled — no reviewed sign yet',
    missing: 'Not covered — no reviewed sign',
    playAnyway: 'Play anyway',
    unsupportedTitle: 'This message cannot currently be translated with sufficient confidence.',
    unsupportedBody: 'Try shorter sentences or everyday phrases. You can still turn it into emojis.',
    editMessage: 'Edit message',
    tryEmojis: 'Try emojis',
    serviceErrorTitle: 'We couldn’t reach the translation service.',
    serviceErrorBody: 'Check your connection and try again. Your text wasn’t stored.',
    limitTitle: 'You’ve used all {limit} translations this month.',
    limitBody: 'Your quota resets on {date}. Upgrade for a higher monthly limit.',
    empty: 'Type a message and press “Translate message” to see it signed.',
    lexicalCoverage: 'Dictionary coverage',
    coverageNote: 'Share of the text covered by reviewed dictionary signs — not a measure of accuracy.',
    cancel: 'Cancel',
    controls: { prev: 'Previous segment', play: 'Play', pause: 'Pause', next: 'Next segment', replay: 'Replay', loop: 'Loop', captions: 'Captions', fullscreen: 'Fullscreen' },
  },
  emoji: {
    style: 'Style',
    styles: { minimal: 'Minimal', standard: 'Standard', expressive: 'Expressive' },
    result: 'Result',
    emojisOnly: 'Emojis only',
    textEmojis: 'Text + Emojis',
    preview: 'Preview',
    copy: 'Copy result',
    copyWhatsapp: 'Copy for WhatsApp',
    regenerate: 'Regenerate',
    copied: 'Copied — ready to paste in WhatsApp',
    copiedPlain: 'Copied',
    note: 'Signa creates text you copy and paste yourself. It never reads or sends your messages.',
    noMatch: 'No matching emojis were found for this text. Try different words.',
    planOnly: 'Available on Pro and Business',
    saveToHistory: 'Save to history',
    saved: 'Saved to history',
    idle: 'Type a message, pick a style and press “Translate message”.',
  },
  history: {
    title: 'Translation History',
    subtitle: 'Only translations you choose to save appear here.',
    clear: 'Clear history',
    search: 'Search saved translations',
    allTypes: 'All types',
    emptyTitle: 'Your translations are not saved automatically.',
    emptyBody: 'By default, Signa forgets your text as soon as a translation is done. If you turn on saved history, translations you save are stored in your account until you delete them. You can clear them at any time.',
    turnOn: 'Turn on saved history',
    howData: 'How we handle data',
    availability: 'Available on Pro and Business plans',
    noItems: 'No saved translations yet. Use “Save to history” on a result.',
    confirmClear: 'Delete all saved translations? This cannot be undone.',
    consent: 'I understand that translations I choose to save are stored in my account until I delete them.',
  },
  dictionary: {
    title: 'Dictionary', subtitle: 'Signs reviewed by ISL experts and published with a confirmed licence.',
    search: 'Search by meaning or gloss', empty: 'No published signs yet. Entries appear here after expert review and licence confirmation.',
    gloss: 'Gloss', meaning: 'Meaning', code: 'Sign ID',
  },
  usage: {
    title: 'Usage & Plan', thisMonth: 'Translations this month', resets: 'Resets on {date}', unlimited: 'No monthly limit',
    emoji: 'Emoji', sign: 'Sign language', plansTitle: 'Simple plans for every kind of conversation',
    plansSubtitle: 'Start free. Upgrade when you need more translations or a workspace for your team.',
    tba: 'Pricing to be announced', priceTba: '[Price TBA]', getStarted: 'Get started', current: 'Current plan',
    waitlist: 'Join the waitlist', onWaitlist: 'You’re on the waitlist', contactSales: 'Contact sales', popular: 'Popular', planned: 'Planned',
    footnote: 'Sign-language translation covers supported phrases only and shows its verification status on every result. Features marked Planned are not yet available.',
    tagline: { free: 'For trying Signa', pro: 'For everyday communication', business: 'For organizations and public services' },
    features: {
      free: [['ok', 'Limited emoji translations'], ['ok', 'Limited supported sign-language translations'], ['ok', 'Standard player controls'], ['no', 'No saved history']],
      pro: [['ok', 'Higher translation quotas'], ['ok', 'Advanced player preferences'], ['ok', 'Optional saved history'], ['planned', 'Productivity features']],
      business: [['ok', 'Organization accounts'], ['ok', 'Member management'], ['ok', 'Centralized usage limits'], ['planned', 'Organization reporting'], ['planned', 'API access']],
    } as Record<string, [string, string][]>,
  },
  settings: {
    title: 'Settings & privacy', langSection: 'Language & translation', interfaceLang: 'Interface language', defaultMode: 'Default translation mode',
    speed: 'Preferred playback speed', a11y: 'Accessibility', reduceMotion: 'Reduce motion', reduceMotionHint: 'Interface without transition animations. The avatar keeps signing.',
    highContrast: 'High contrast', largeText: 'Large text', captions: 'Captions', privacy: 'Privacy', saveHistory: 'Save translation history',
    saveHistoryHint: 'Off by default. Your text isn’t kept after translating.', deleteHistory: 'Delete saved history', dataPolicy: 'How we handle data',
    privacyPolicy: 'Privacy policy', deleteAccount: 'Delete account', deleteAccountHint: 'A final action that erases all account data.',
    confirmDelete: 'Type DELETE and your password to permanently delete your account.', password: 'Password', saved: 'Saved',
    account: 'Account', name: 'Name', exportData: 'Download my data', sessions: 'Signed-in devices', signOutOthers: 'Sign out other devices',
  },
  help: {
    title: 'Help & Support',
    items: [
      ['What does “Experimental” mean?', 'Sign-language output marked Experimental was produced by an engine that has not been validated by ISL experts. It follows Hebrew word order and is not ISL grammar. Only results marked Verified passed expert review.'],
      ['Is my text saved?', 'No. Text is processed for the translation only and deleted right after. Saved history is optional (Pro/Business) and only stores items you choose to save.'],
      ['Why is part of my sentence missing?', 'Signa only shows signs that were reviewed by ISL experts and have a licensed animation. Missing parts are marked instead of being guessed.'],
      ['When does my quota reset?', 'Monthly quotas reset on the first day of each month (UTC).'],
    ] as [string, string][],
  },
  auth: {
    login: 'Sign in', register: 'Create account', email: 'Email', password: 'Password', name: 'Full name',
    forgot: 'Forgot password?', noAccount: 'No account yet?', haveAccount: 'Already have an account?',
    loginTitle: 'Welcome back', registerTitle: 'Create your Signa account', passwordHint: 'At least 10 characters',
    registered: 'Account created. Please check your email to verify it, then sign in.',
    forgotTitle: 'Reset your password', forgotSent: 'If an account exists for this email, we sent a reset link.', sendLink: 'Send reset link',
    resetTitle: 'Choose a new password', newPassword: 'New password', resetDone: 'Password updated. You can sign in now.',
    verifyTitle: 'Verifying your email…', verified: 'Your email is verified.', invalidLink: 'This link is invalid or has expired.',
    continue: 'Continue',
  },
  admin: { title: 'Admin overview', users: 'Registered users', subs: 'Active subscriptions', failures: 'Translation failures', latency: 'Sign engine latency', perDay: 'Translation requests per day', coverage: 'Dictionary coverage', notAvailable: 'n/a', last30: 'Last 30 days', concepts: 'concepts', renderable: 'renderable' },
};

type Dict = typeof en;

const he: Dict = {
  appName: 'Signa',
  nav: { translate: 'תרגום', history: 'היסטוריית תרגומים', historyShort: 'היסטוריה', dictionary: 'מילון', usage: 'שימוש ותוכנית', settings: 'הגדרות', help: 'עזרה ותמיכה', admin: 'ניהול' },
  common: {
    clear: 'ניקוי', save: 'שמירה', cancel: 'ביטול', retry: 'ניסיון חוזר', loading: 'טוען…', edit: 'עריכה', delete: 'מחיקה',
    signOut: 'התנתקות', personal: 'אישי', back: 'חזרה', next: 'הבא', close: 'סגירה', search: 'חיפוש',
    errorGeneric: 'משהו השתבש. נסו שוב.', plan: 'תוכנית', of: 'מתוך',
  },
  plans: { free: 'חינמי', pro: 'מקצועי', business: 'עסקי', upgrade: 'שדרוג למקצועי', seePlans: 'לצפייה בתוכניות' },
  translate: {
    title: 'תרגמו את ההודעה שלכם',
    subtitle: 'הפכו מילים כתובות לתקשורת חזותית.',
    emojiTitle: 'תרגום לאימוג׳ים',
    emojiSubtitle: 'הביעו את ההודעה שלכם באופן חזותי ושתפו בכל מקום.',
    tabSign: 'שפת סימנים',
    tabEmoji: 'תרגום לאימוג׳ים',
    tabEmojiShort: 'אימוג׳י',
    prompt: 'מה תרצו לומר?',
    inputLang: 'שפת קלט',
    hebrew: 'עברית',
    tryExample: 'נסו דוגמה',
    examples: ['תודה רבה, נתראה מחר', 'איפה תחנת האוטובוס הקרובה?'],
    button: 'תרגום ההודעה',
    privacy: 'הטקסט שלכם מעובד לתרגום הזה בלבד ואינו נשמר. ההיסטוריה כבויה.',
    privacyHistoryOn: 'הטקסט מעובד לתרגום הזה בלבד. אפשר לשמור תוצאה בהיסטוריה.',
  },
  sign: {
    panelTitle: 'שפת הסימנים הישראלית',
    whatMeans: 'מה זה אומר?',
    renderPlaceholder: 'אווטאר תלת־ממדי · תצוגה זמנית',
    segmentOf: 'מקטע {n} מתוך {total}',
    illustrative: 'חלוקה להמחשה — לא גלוס מאומת של שס״י',
    upNext: 'הבא בתור', playing: 'מוצג כעת', played: 'הוצג', notAvailable: 'אין סימן שנבדק',
    status: { verified: 'תרגום מאומת', partially_verified: 'מאומת חלקית', experimental: 'תרגום ניסיוני', unsupported: 'לא נתמך', failed: 'נכשל' },
    statusShort: { verified: 'מאומת', partially_verified: 'מאומת חלקית', experimental: 'ניסיוני', unsupported: 'לא נתמך', failed: 'נכשל' },
    explain: {
      verified: 'מוצג רק כשכל מקטע נבדק על ידי מומחי שס״י מול מערך בדיקות מאושר.',
      partially_verified: 'חלקים מסוימים מכוסים בסימנים שנבדקו; אחרים מאוייתים באצבעות או חסרים.',
      experimental: 'הופק על ידי מנוע ניסיוני ולא הוכח כנכון לשונית. המקטעים בסדר המילים העברי ואינם דקדוק שס״י.',
      unsupported: 'לא ניתן כרגע לתרגם את ההודעה ברמת ביטחון מספקת.',
      failed: 'לא ניתן היה להשלים את התרגום.',
    },
    loading: 'מכינים את רצף הסימנים…',
    covered: 'מכוסה בסימנים שנבדקו',
    fingerspelled: 'מאוית באצבעות — אין עדיין סימן שנבדק',
    missing: 'לא מכוסה — אין סימן שנבדק',
    playAnyway: 'הצגה בכל זאת',
    unsupportedTitle: 'לא ניתן כרגע לתרגם את ההודעה ברמת ביטחון מספקת.',
    unsupportedBody: 'נסו משפטים קצרים או ביטויים יומיומיים. עדיין אפשר להפוך את ההודעה לאימוג׳ים.',
    editMessage: 'עריכת ההודעה',
    tryEmojis: 'נסו אימוג׳ים',
    serviceErrorTitle: 'לא הצלחנו להתחבר לשירות התרגום.',
    serviceErrorBody: 'בדקו את החיבור ונסו שוב. הטקסט שלכם לא נשמר.',
    limitTitle: 'ניצלתם את כל {limit} התרגומים החודש.',
    limitBody: 'המכסה מתאפסת ב־{date}. שדרגו למכסה חודשית גבוהה יותר.',
    empty: 'הקלידו הודעה ולחצו „תרגום ההודעה” כדי לראות אותה בשפת הסימנים.',
    lexicalCoverage: 'כיסוי מילוני',
    coverageNote: 'החלק מהטקסט שמכוסה בסימנים שנבדקו במילון — לא מדד לדיוק.',
    cancel: 'ביטול',
    controls: { prev: 'המקטע הקודם', play: 'הפעלה', pause: 'השהיה', next: 'המקטע הבא', replay: 'הפעלה מחדש', loop: 'חזרה', captions: 'כתוביות', fullscreen: 'מסך מלא' },
  },
  emoji: {
    style: 'סגנון',
    styles: { minimal: 'מינימלי', standard: 'רגיל', expressive: 'אקספרסיבי' },
    result: 'תוצאה',
    emojisOnly: 'אימוג׳ים בלבד',
    textEmojis: 'טקסט + אימוג׳ים',
    preview: 'תצוגה מקדימה',
    copy: 'העתקת התוצאה',
    copyWhatsapp: 'העתקה לוואטסאפ',
    regenerate: 'יצירה מחדש',
    copied: 'הועתק — מוכן להדבקה בוואטסאפ',
    copiedPlain: 'הועתק',
    note: 'Signa יוצרת טקסט שאתם מעתיקים ומדביקים בעצמכם. היא אף פעם לא קוראת או שולחת את ההודעות שלכם.',
    noMatch: 'לא נמצאו אימוג׳ים מתאימים לטקסט הזה. נסו מילים אחרות.',
    planOnly: 'זמין בתוכניות מקצועי ועסקי',
    saveToHistory: 'שמירה בהיסטוריה',
    saved: 'נשמר בהיסטוריה',
    idle: 'הקלידו הודעה, בחרו סגנון ולחצו „תרגום ההודעה”.',
  },
  history: {
    title: 'היסטוריית תרגומים',
    subtitle: 'רק תרגומים שבחרתם לשמור מופיעים כאן.',
    clear: 'מחיקת ההיסטוריה',
    search: 'חיפוש בתרגומים שמורים',
    allTypes: 'כל הסוגים',
    emptyTitle: 'התרגומים שלכם אינם נשמרים אוטומטית.',
    emptyBody: 'כברירת מחדל, Signa שוכחת את הטקסט שלכם מיד כשהתרגום מסתיים. אם תפעילו שמירת היסטוריה, תרגומים שתבחרו לשמור יישמרו בחשבון שלכם עד שתמחקו אותם. אפשר למחוק אותם בכל עת.',
    turnOn: 'הפעלת שמירת היסטוריה',
    howData: 'איך אנחנו מטפלים במידע',
    availability: 'זמין בתוכניות מקצועי ועסקי',
    noItems: 'עדיין אין תרגומים שמורים. השתמשו ב„שמירה בהיסטוריה” על תוצאה.',
    confirmClear: 'למחוק את כל התרגומים השמורים? לא ניתן לבטל פעולה זו.',
    consent: 'אני מבין/ה שתרגומים שאבחר לשמור יישמרו בחשבון שלי עד שאמחק אותם.',
  },
  dictionary: {
    title: 'מילון', subtitle: 'סימנים שנבדקו על ידי מומחי שס״י ופורסמו עם רישיון מאושר.',
    search: 'חיפוש לפי משמעות או גלוס', empty: 'עדיין אין סימנים שפורסמו. ערכים יופיעו כאן לאחר בדיקת מומחים ואישור רישיון.',
    gloss: 'גלוס', meaning: 'משמעות', code: 'מזהה סימן',
  },
  usage: {
    title: 'שימוש ותוכנית', thisMonth: 'תרגומים החודש', resets: 'מתאפס ב־{date}', unlimited: 'ללא מגבלה חודשית',
    emoji: 'אימוג׳י', sign: 'שפת סימנים', plansTitle: 'תוכניות פשוטות לכל סוג של שיחה',
    plansSubtitle: 'התחילו בחינם. שדרגו כשתצטרכו יותר תרגומים או סביבת עבודה לצוות.',
    tba: 'המחירים יפורסמו בהמשך', priceTba: '[מחיר יפורסם]', getStarted: 'להתחלה', current: 'התוכנית הנוכחית',
    waitlist: 'הצטרפות לרשימת ההמתנה', onWaitlist: 'אתם ברשימת ההמתנה', contactSales: 'פנייה למכירות', popular: 'פופולרי', planned: 'מתוכנן',
    footnote: 'תרגום לשפת סימנים מכסה ביטויים נתמכים בלבד ומציג את סטטוס האימות בכל תוצאה. תכונות שמסומנות „מתוכנן” עדיין אינן זמינות.',
    tagline: { free: 'להתנסות ב־Signa', pro: 'לתקשורת יומיומית', business: 'לארגונים ולשירותים ציבוריים' },
    features: {
      free: [['ok', 'תרגומי אימוג׳י מוגבלים'], ['ok', 'תרגומי שפת סימנים נתמכים מוגבלים'], ['ok', 'פקדי נגן סטנדרטיים'], ['no', 'ללא שמירת היסטוריה']],
      pro: [['ok', 'מכסות תרגום גבוהות יותר'], ['ok', 'העדפות נגן מתקדמות'], ['ok', 'שמירת היסטוריה אופציונלית'], ['planned', 'תכונות פרודוקטיביות']],
      business: [['ok', 'חשבונות ארגוניים'], ['ok', 'ניהול חברים'], ['ok', 'מגבלות שימוש מרוכזות'], ['planned', 'דוחות ארגוניים'], ['planned', 'גישת API']],
    },
  },
  settings: {
    title: 'הגדרות ופרטיות', langSection: 'שפה ותרגום', interfaceLang: 'שפת ממשק', defaultMode: 'מצב תרגום ברירת מחדל',
    speed: 'מהירות ניגון מועדפת', a11y: 'נגישות', reduceMotion: 'הפחתת תנועה', reduceMotionHint: 'ממשק ללא אנימציות מעבר. הדמות ממשיכה לחתום.',
    highContrast: 'ניגודיות גבוהה', largeText: 'טקסט גדול', captions: 'כתוביות', privacy: 'פרטיות', saveHistory: 'שמירת היסטוריית תרגומים',
    saveHistoryHint: 'כבוי כברירת מחדל. הטקסט שלכם לא נשמר אחרי התרגום.', deleteHistory: 'מחיקת היסטוריה שמורה', dataPolicy: 'איך אנחנו מטפלים במידע',
    privacyPolicy: 'למדיניות הפרטיות', deleteAccount: 'מחיקת החשבון', deleteAccountHint: 'פעולה סופית שמוחקת את כל נתוני החשבון.',
    confirmDelete: 'הקלידו DELETE ואת הסיסמה כדי למחוק את החשבון לצמיתות.', password: 'סיסמה', saved: 'נשמר',
    account: 'חשבון', name: 'שם', exportData: 'הורדת המידע שלי', sessions: 'מכשירים מחוברים', signOutOthers: 'ניתוק מכשירים אחרים',
  },
  help: {
    title: 'עזרה ותמיכה',
    items: [
      ['מה המשמעות של „ניסיוני”?', 'תוצאה בשפת סימנים שמסומנת „ניסיוני” הופקה על ידי מנוע שלא אומת על ידי מומחי שס״י. היא בסדר המילים העברי ואינה דקדוק שס״י. רק תוצאות שמסומנות „מאומת” עברו בדיקת מומחים.'],
      ['האם הטקסט שלי נשמר?', 'לא. הטקסט מעובד לתרגום בלבד ונמחק מיד אחריו. שמירת היסטוריה היא אופציונלית (מקצועי/עסקי) ושומרת רק פריטים שבחרתם לשמור.'],
      ['למה חלק מהמשפט חסר?', 'Signa מציגה רק סימנים שנבדקו על ידי מומחי שס״י ויש להם אנימציה ברישיון. חלקים חסרים מסומנים במקום לנחש אותם.'],
      ['מתי המכסה מתאפסת?', 'המכסות החודשיות מתאפסות ביום הראשון של כל חודש (UTC).'],
    ],
  },
  auth: {
    login: 'התחברות', register: 'יצירת חשבון', email: 'אימייל', password: 'סיסמה', name: 'שם מלא',
    forgot: 'שכחתם סיסמה?', noAccount: 'עדיין אין לכם חשבון?', haveAccount: 'כבר יש לכם חשבון?',
    loginTitle: 'ברוכים השבים', registerTitle: 'יצירת חשבון Signa', passwordHint: 'לפחות 10 תווים',
    registered: 'החשבון נוצר. בדקו את האימייל כדי לאמת אותו, ואז התחברו.',
    forgotTitle: 'איפוס סיסמה', forgotSent: 'אם קיים חשבון עם האימייל הזה, שלחנו קישור לאיפוס.', sendLink: 'שליחת קישור לאיפוס',
    resetTitle: 'בחירת סיסמה חדשה', newPassword: 'סיסמה חדשה', resetDone: 'הסיסמה עודכנה. אפשר להתחבר עכשיו.',
    verifyTitle: 'מאמתים את האימייל…', verified: 'האימייל שלכם אומת.', invalidLink: 'הקישור אינו תקף או שפג תוקפו.',
    continue: 'המשך',
  },
  admin: { title: 'סקירה כללית', users: 'משתמשים רשומים', subs: 'מינויים פעילים', failures: 'כשלי תרגום', latency: 'זמן תגובה של מנוע הסימנים', perDay: 'בקשות תרגום ליום', coverage: 'כיסוי המילון', notAvailable: 'אין נתונים', last30: '30 הימים האחרונים', concepts: 'מושגים', renderable: 'ניתנים להצגה' },
};

const DICTS: Record<Locale, Dict> = { en, he };

interface I18nValue {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  t: Dict;
  setLocale: (l: Locale) => void;
  fmt: (s: string, vars: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);
const STORAGE_KEY = 'signa.locale';

function readStoredLocale(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'he' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('he');

  useEffect(() => {
    const stored = readStoredLocale();
    if (stored) setLocaleState(stored);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'he' ? 'rtl' : 'ltr';
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* storage unavailable: keep in memory */
    }
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      dir: locale === 'he' ? 'rtl' : 'ltr',
      t: DICTS[locale],
      setLocale,
      fmt: (s, vars) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')),
    }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error('useI18n outside provider');
  return v;
}

export function formatDate(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(locale === 'he' ? 'he-IL' : 'en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}
