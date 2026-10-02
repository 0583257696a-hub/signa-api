'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Shield } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useI18n, type Locale } from '@/lib/i18n';
import { useSession, type User } from '@/lib/session';
import { ErrorAlert, Switch, Toast } from '@/components/ui';

const DISCLOSURE_VERSION = '2026-10-01';

export default function SettingsPage() {
  const { t, setLocale } = useI18n();
  const { user, usage, setUser, logout } = useSession();
  const router = useRouter();
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [password, setPassword] = useState('');
  if (!user) return null;

  const patch = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      const { data } = await api<{ user: User }>('/me', { method: 'PATCH', body });
      setUser(data.user);
      setToast(t.settings.saved);
    } catch (e) {
      setError(e instanceof ApiError ? e.body.message : t.common.errorGeneric);
    }
  };

  const setHistory = async (enabled: boolean) => {
    setError(null);
    try {
      const { data } = await api<{ user: User }>('/me/privacy/history', { method: 'PUT', body: enabled ? { enabled, consentVersion: DISCLOSURE_VERSION } : { enabled } });
      setUser(data.user);
    } catch (e) {
      setError(e instanceof ApiError ? e.body.message : t.common.errorGeneric);
    }
  };

  const deleteHistory = async () => {
    if (!window.confirm(t.history.confirmClear)) return;
    await api('/history', { method: 'DELETE' });
    setToast(t.settings.saved);
  };

  const deleteAccount = async () => {
    setError(null);
    try {
      await api('/me', { method: 'DELETE', body: { password, confirm: confirmText } });
      await logout();
      router.replace('/login/');
    } catch (e) {
      setError(e instanceof ApiError ? e.body.message : t.common.errorGeneric);
    }
  };

  const exportData = async () => {
    const { data } = await api('/me/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'signa-my-data.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const a11y = user.accessibility;
  return (
    <div className="stack" style={{ gap: 20, maxWidth: 820 }}>
      <div className="page-head"><div><h2>{t.settings.title}</h2></div></div>
      <ErrorAlert message={error} />

      <section className="card">
        <h3>{t.settings.langSection}</h3>
        <div className="grid-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
          <div className="field">
            <label htmlFor="lang">{t.settings.interfaceLang}</label>
            <select id="lang" className="select" value={user.locale} onChange={(e) => { setLocale(e.target.value as Locale); void patch({ locale: e.target.value }); }}>
              <option value="he">עברית</option>
              <option value="en">English</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="mode">{t.settings.defaultMode}</label>
            <select id="mode" className="select" value={user.preferences.defaultMode ?? 'sign'} onChange={(e) => patch({ preferences: { defaultMode: e.target.value } })}>
              <option value="sign">{t.translate.tabSign}</option>
              <option value="emoji">{t.translate.tabEmojiShort}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="speed">{t.settings.speed}</label>
            <select id="speed" className="select" value={String(user.preferences.playbackSpeed ?? 1)} onChange={(e) => patch({ preferences: { playbackSpeed: Number(e.target.value) } })}>
              {[0.5, 0.75, 1, 1.25, 1.5].map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
          </div>
        </div>
      </section>

      <section className="card">
        <h3>{t.settings.a11y}</h3>
        {([
          ['reduceMotion', t.settings.reduceMotion, t.settings.reduceMotionHint],
          ['highContrast', t.settings.highContrast, ''],
          ['largeText', t.settings.largeText, ''],
          ['captions', t.settings.captions, ''],
        ] as const).map(([key, label, hint]) => (
          <div key={key} className="setting-row">
            <div><b style={{ fontWeight: 500 }}>{label}</b>{hint && <p>{hint}</p>}</div>
            <Switch label={label} checked={!!a11y[key]} onChange={(v) => patch({ accessibility: { [key]: v } })} />
          </div>
        ))}
      </section>

      <section className="card">
        <h3 className="row"><Shield size={18} color="var(--success)" /> {t.settings.privacy}</h3>
        <div className="setting-row">
          <div><b style={{ fontWeight: 500 }}>{t.settings.saveHistory}</b><p>{usage?.limits.historyAvailable ? t.settings.saveHistoryHint : t.emoji.planOnly}</p></div>
          <Switch label={t.settings.saveHistory} checked={user.privacy.historyEnabled} disabled={!usage?.limits.historyAvailable && !user.privacy.historyEnabled} onChange={setHistory} />
        </div>
        <div className="setting-row">
          <b style={{ fontWeight: 500 }}>{t.settings.deleteHistory}</b>
          <button type="button" className="btn" onClick={deleteHistory}>{t.common.delete}</button>
        </div>
        <div className="setting-row">
          <b style={{ fontWeight: 500 }}>{t.settings.dataPolicy}</b>
          <Link href="/help/">{t.settings.privacyPolicy}</Link>
        </div>
        <div className="setting-row">
          <b style={{ fontWeight: 500 }}>{t.settings.exportData}</b>
          <button type="button" className="btn" onClick={exportData}>{t.settings.exportData}</button>
        </div>
        <div className="setting-row">
          <div><b style={{ fontWeight: 500 }}>{t.settings.deleteAccount}</b><p>{t.settings.deleteAccountHint}</p></div>
          <button type="button" className="btn btn-danger" onClick={() => setDeleting((d) => !d)}>{t.settings.deleteAccount}</button>
        </div>
        {deleting && (
          <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
            <p className="small" style={{ margin: 0 }}>{t.settings.confirmDelete}</p>
            <input className="input" dir="ltr" placeholder="DELETE" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
            <input className="input" dir="ltr" type="password" placeholder={t.settings.password} value={password} onChange={(e) => setPassword(e.target.value)} />
            <div><button type="button" className="btn btn-danger" disabled={confirmText !== 'DELETE'} onClick={deleteAccount}>{t.settings.deleteAccount}</button></div>
          </div>
        )}
      </section>
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}
