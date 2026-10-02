'use client';

import Link from 'next/link';
import { AlertTriangle, CircleAlert } from 'lucide-react';
import { formatDate, useI18n } from '@/lib/i18n';

export function LoadingState() {
  const { t } = useI18n();
  return (
    <div className="stack" aria-busy="true">
      <div className="stage" style={{ placeItems: 'center', borderRadius: 14 }}>
        <div className="stack" style={{ alignItems: 'center' }}>
          <div className="spinner" />
          <span className="muted">{t.sign.loading}</span>
        </div>
      </div>
      <div className="segments">
        {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 72 }} />)}
      </div>
    </div>
  );
}

export function UnsupportedState({ onEdit, onTryEmoji }: { onEdit: () => void; onTryEmoji: () => void }) {
  const { t } = useI18n();
  return (
    <div className="stack" style={{ padding: 8 }}>
      <span className="icon-btn" style={{ borderRadius: 10, background: 'var(--surface-2)' }}><CircleAlert size={18} /></span>
      <h3 style={{ margin: 0 }}>{t.sign.unsupportedTitle}</h3>
      <p className="muted" style={{ margin: 0 }}>{t.sign.unsupportedBody}</p>
      <div className="row wrap">
        <button type="button" className="btn btn-primary" onClick={onEdit}>{t.sign.editMessage}</button>
        <button type="button" className="btn" onClick={onTryEmoji}>{t.sign.tryEmojis}</button>
      </div>
    </div>
  );
}

export function ServiceErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="stack">
      <div className="alert alert-error row" style={{ alignItems: 'flex-start' }}>
        <AlertTriangle size={20} style={{ flex: 'none' }} />
        <div>
          <b>{t.sign.serviceErrorTitle}</b>
          <div>{t.sign.serviceErrorBody}</div>
        </div>
      </div>
      <div><button type="button" className="btn" onClick={onRetry}>{t.common.retry}</button></div>
    </div>
  );
}

export function LimitState({ limit, resetsAt }: { limit: number; resetsAt: string | null }) {
  const { t, fmt, locale } = useI18n();
  return (
    <div className="stack">
      <div className="meter" style={{ margin: 0 }}><span style={{ width: '100%' }} /></div>
      <h3 style={{ margin: 0 }}>{fmt(t.sign.limitTitle, { limit })}</h3>
      <p className="muted" style={{ margin: 0 }}>{fmt(t.sign.limitBody, { date: formatDate(resetsAt, locale) })}</p>
      <div><Link href="/usage/" className="btn btn-primary">{t.plans.seePlans}</Link></div>
    </div>
  );
}
