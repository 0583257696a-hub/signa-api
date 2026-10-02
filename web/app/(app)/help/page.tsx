'use client';

import { useI18n } from '@/lib/i18n';

export default function HelpPage() {
  const { t } = useI18n();
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <div className="page-head"><div><h2>{t.help.title}</h2></div></div>
      {t.help.items.map(([q, a]) => (
        <details key={q} className="card">
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{q}</summary>
          <p className="muted" style={{ marginBottom: 0 }}>{a}</p>
        </details>
      ))}
    </div>
  );
}
