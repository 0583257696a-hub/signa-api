'use client';

import { formatDate, useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { PlansGrid } from '@/components/PlansGrid';

export default function UsagePage() {
  const { t, fmt, locale } = useI18n();
  const { usage } = useSession();
  return (
    <div className="stack" style={{ gap: 32 }}>
      <div className="page-head"><div><h2>{t.usage.title}</h2></div></div>
      {usage && (
        <div className="card stack">
          <div className="row between wrap">
            <h3 style={{ margin: 0 }}>{t.usage.thisMonth}</h3>
            <span className="small muted">{fmt(t.usage.resets, { date: formatDate(usage.period.resetsAt, locale) })}</span>
          </div>
          {(['translations', 'emoji', 'sign'] as const).map((k) => {
            const c = usage.counters[k];
            const label = k === 'translations' ? t.usage.thisMonth : k === 'emoji' ? t.usage.emoji : t.usage.sign;
            return (
              <div key={k} className="stack" style={{ gap: 4 }}>
                <div className="row between small"><span>{label}</span><b>{c.limit !== null ? `${c.used} / ${c.limit}` : `${c.used} · ${t.usage.unlimited}`}</b></div>
                {c.limit !== null && <div className="meter" style={{ margin: 0 }}><span style={{ width: `${Math.min(100, (c.used / Math.max(1, c.limit)) * 100)}%` }} /></div>}
              </div>
            );
          })}
        </div>
      )}
      <PlansGrid />
    </div>
  );
}
