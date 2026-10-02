'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Check, Clock, Minus } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';

interface Plan { id: 'free' | 'pro' | 'business'; name: { en: string; he: string }; availability: 'available' | 'waitlist' | 'contact_sales'; pricing: unknown | null }

export function PlansGrid() {
  const { t, locale } = useI18n();
  const { user, usage } = useSession();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [waitlisted, setWaitlisted] = useState<string | null>(null);

  useEffect(() => {
    api<{ plans: Plan[] }>('/plans').then((r) => setPlans(r.data.plans), () => setPlans([]));
  }, []);

  const join = async (id: string) => {
    try {
      await api(`/plans/${id}/waitlist`, { method: 'POST', body: {} });
      setWaitlisted(id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) window.location.href = '/login/';
    }
  };

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div style={{ textAlign: 'center' }} className="stack">
        <h2 style={{ margin: 0, fontSize: 34, letterSpacing: '-0.02em' }}>{t.usage.plansTitle}</h2>
        <p className="muted" style={{ margin: 0 }}>{t.usage.plansSubtitle}</p>
        <div><span className="badge badge-experimental" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}>{t.usage.tba}</span></div>
      </div>
      <div className="plans">
        {plans.map((p) => {
          const current = usage?.planId === p.id;
          return (
            <div key={p.id} className={`card plan-card ${p.id === 'pro' ? 'featured' : ''}`}>
              <div className="row between">
                <h3 style={{ margin: 0, fontSize: 21 }}>{locale === 'he' ? p.name.he : p.name.en}</h3>
                {p.id === 'pro' && <span className="badge no-dot" style={{ background: 'var(--primary-soft)', color: 'var(--primary-ink)' }}>{t.usage.popular}</span>}
              </div>
              <span className="muted">{t.usage.tagline[p.id]}</span>
              <div className="price">{p.id === 'free' ? '$0' : <span className="muted" style={{ fontSize: 24 }}>{t.usage.priceTba}</span>}</div>
              <ul>
                {(t.usage.features[p.id] ?? []).map(([k, label]) => (
                  <li key={label} className={k === 'no' ? 'muted' : undefined}>
                    {k === 'ok' ? <Check size={16} color="var(--success)" /> : k === 'no' ? <Minus size={16} /> : <Clock size={16} color="var(--muted)" />}
                    <span>{label} {k === 'planned' && <span className="badge badge-neutral no-dot small">{t.usage.planned}</span>}</span>
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: 'auto' }}>
                {p.availability === 'available' && (
                  current ? <button className="btn btn-lg" disabled>{t.usage.current}</button> : <Link href={user ? '/translate/' : '/register/'} className="btn btn-lg">{t.usage.getStarted}</Link>
                )}
                {p.availability === 'waitlist' && (
                  <button type="button" className="btn btn-primary btn-lg" disabled={waitlisted === p.id} onClick={() => join(p.id)}>
                    {waitlisted === p.id ? t.usage.onWaitlist : t.usage.waitlist}
                  </button>
                )}
                {p.availability === 'contact_sales' && <a className="btn btn-dark btn-lg" href="mailto:sales@signa.example">{t.usage.contactSales}</a>}
              </div>
            </div>
          );
        })}
      </div>
      <p className="small muted" style={{ textAlign: 'center', maxWidth: 680, margin: '0 auto' }}>{t.usage.footnote}</p>
    </div>
  );
}
