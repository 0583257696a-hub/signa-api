'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Search, ShieldCheck, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession, type User } from '@/lib/session';
import { ErrorAlert } from '@/components/ui';

const DISCLOSURE_VERSION = '2026-10-01';

interface Item { id: string; kind: 'emoji' | 'sign'; sourceText: string; output: { result?: string; verificationStatus?: string; glosses?: string[] }; createdAt: string }

export default function HistoryPage() {
  const { t, locale } = useI18n();
  const { user, usage, setUser } = useSession();
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'' | 'emoji' | 'sign'>('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: '50' });
    if (q.trim()) params.set('q', q.trim());
    if (kind) params.set('kind', kind);
    try {
      setItems((await api<{ items: Item[] }>(`/history?${params}`)).data.items);
    } catch {
      setItems([]);
    }
  }, [q, kind]);

  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
  }, [load]);

  const enable = async () => {
    setError(null);
    try {
      const { data } = await api<{ user: User }>('/me/privacy/history', { method: 'PUT', body: { enabled: true, consentVersion: DISCLOSURE_VERSION } });
      setUser(data.user);
    } catch (e) {
      setError(e instanceof ApiError ? e.body.message : t.common.errorGeneric);
    }
  };

  const clearAll = async () => {
    if (!window.confirm(t.history.confirmClear)) return;
    await api('/history', { method: 'DELETE' });
    setItems([]);
  };

  const remove = async (id: string) => {
    await api(`/history/${id}`, { method: 'DELETE' });
    setItems((xs) => xs.filter((x) => x.id !== id));
  };

  const enabled = user?.privacy.historyEnabled;
  const available = usage?.limits.historyAvailable;

  return (
    <>
      <div className="page-head">
        <div><h2>{t.history.title}</h2><p>{t.history.subtitle}</p></div>
        <button type="button" className="btn" disabled={items.length === 0} onClick={clearAll}>{t.history.clear}</button>
      </div>

      <div className="row wrap" style={{ marginBottom: 16 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={16} style={{ position: 'absolute', insetInlineStart: 12, top: 13, color: 'var(--faint)' }} />
          <input className="input" style={{ paddingInlineStart: 36 }} placeholder={t.history.search} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="select" style={{ width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value as '' | 'emoji' | 'sign')}>
          <option value="">{t.history.allTypes}</option>
          <option value="sign">{t.translate.tabSign}</option>
          <option value="emoji">{t.translate.tabEmojiShort}</option>
        </select>
      </div>

      {items.length > 0 ? (
        <div className="stack">
          {items.map((it) => (
            <div key={it.id} className="card row between" style={{ alignItems: 'flex-start' }}>
              <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                <span className="small muted">{it.kind === 'sign' ? t.translate.tabSign : t.translate.tabEmojiShort} · {new Date(it.createdAt).toLocaleString(locale === 'he' ? 'he-IL' : 'en-US')}</span>
                <b dir="auto">{it.sourceText}</b>
                <span dir="auto" style={{ fontSize: 18 }}>{it.output.result ?? it.output.glosses?.join(' · ')}</span>
              </div>
              <button type="button" className="icon-btn" aria-label={t.common.delete} onClick={() => remove(it.id)}><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
      ) : (
        <div className="card empty">
          <div className="icon-circle"><ShieldCheck size={26} /></div>
          {enabled ? (
            <p>{t.history.noItems}</p>
          ) : (
            <>
              <h3>{t.history.emptyTitle}</h3>
              <p>{t.history.emptyBody}</p>
              {available && (
                <label className="row" style={{ justifyContent: 'center', marginBottom: 16 }}>
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  <span className="small">{t.history.consent}</span>
                </label>
              )}
              <div className="row" style={{ justifyContent: 'center' }}>
                {available ? (
                  <button type="button" className="btn btn-primary" disabled={!consent} onClick={enable}>{t.history.turnOn}</button>
                ) : (
                  <Link href="/usage/" className="btn btn-primary">{t.history.turnOn}</Link>
                )}
                <Link href="/help/" className="btn">{t.history.howData}</Link>
              </div>
              <p className="small muted" style={{ marginTop: 16 }}>{t.history.availability}</p>
              <ErrorAlert message={error} />
            </>
          )}
        </div>
      )}
    </>
  );
}
