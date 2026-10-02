'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';

interface Overview {
  registeredUsers: { total: number };
  activeSubscriptions: number;
  translations: { succeeded: number; failed: number; failureRate: number };
  requestsPerDay: { day: string; feature: string; n: number }[];
  signProviderLatencyMs: { avg: number } | null;
}
interface Coverage { categories: { category: string; concepts: number; renderable: number }[]; totals: { concepts: number; renderable: number } }

/** Real data only: no demo figures are shown. */
export default function AdminPage() {
  const { t } = useI18n();
  const { user } = useSession();
  const [ov, setOv] = useState<Overview | null>(null);
  const [cov, setCov] = useState<Coverage | null>(null);

  useEffect(() => {
    if (!user?.isPlatformStaff) return;
    api<Overview>('/admin/overview?days=30').then((r) => setOv(r.data), () => undefined);
    api<Coverage>('/admin/dictionary/coverage').then((r) => setCov(r.data), () => undefined);
  }, [user]);

  if (!user?.isPlatformStaff) return null;
  const days = [...new Set(ov?.requestsPerDay.map((d) => d.day) ?? [])];
  const max = Math.max(1, ...days.map((d) => (ov?.requestsPerDay.filter((x) => x.day === d).reduce((n, x) => n + x.n, 0) ?? 0)));
  const total = (ov?.translations.succeeded ?? 0) + (ov?.translations.failed ?? 0);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head"><div><h2>{t.admin.title}</h2><p>{t.admin.last30}</p></div></div>
      <div className="kpis">
        <div className="card"><span className="muted small">{t.admin.users}</span><div className="stat">{ov?.registeredUsers.total ?? '—'}</div></div>
        <div className="card"><span className="muted small">{t.admin.subs}</span><div className="stat">{ov?.activeSubscriptions ?? '—'}</div></div>
        <div className="card"><span className="muted small">{t.admin.failures}</span><div className="stat">{ov ? `${(ov.translations.failureRate * 100).toFixed(1)}%` : '—'}</div><span className="small muted">{t.common.of} {total}</span></div>
        <div className="card"><span className="muted small">{t.admin.latency}</span><div className="stat">{ov?.signProviderLatencyMs ? `${ov.signProviderLatencyMs.avg} ms` : t.admin.notAvailable}</div></div>
      </div>
      <div className="card">
        <div className="row between wrap"><h3>{t.admin.perDay}</h3>
          <div className="legend"><span><i style={{ background: 'var(--primary)' }} />{t.usage.sign}</span><span><i style={{ background: '#c9c9f2' }} />{t.usage.emoji}</span></div>
        </div>
        {days.length === 0 ? <p className="muted">—</p> : (
          <div className="bars">
            {days.map((d) => {
              const s = ov!.requestsPerDay.find((x) => x.day === d && x.feature === 'sign')?.n ?? 0;
              const e = ov!.requestsPerDay.find((x) => x.day === d && x.feature === 'emoji')?.n ?? 0;
              return (
                <div key={d} title={`${d}: ${s + e}`}>
                  <span style={{ height: `${(s / max) * 100}%`, background: 'var(--primary)' }} />
                  <span style={{ height: `${(e / max) * 100}%`, background: '#c9c9f2' }} />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {cov && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <div style={{ padding: '18px 22px 0' }}><h3>{t.admin.coverage}: {cov.totals.renderable} / {cov.totals.concepts} {t.admin.concepts}</h3></div>
          <table className="table">
            <tbody>
              {cov.categories.map((c) => (
                <tr key={c.category}><td>{c.category}</td><td>{c.renderable} / {c.concepts} {t.admin.renderable}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
