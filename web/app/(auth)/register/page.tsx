'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AuthCard } from '@/components/AuthCard';
import { ErrorAlert } from '@/components/ui';

export default function RegisterPage() {
  const { t, locale } = useI18n();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await api('/auth/register', { method: 'POST', body: { name, email, password, locale, timeZone } });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : t.common.errorGeneric);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t.auth.registerTitle}>
      {done ? (
        <div className="stack">
          <div className="alert alert-success">{t.auth.registered}</div>
          <Link href="/login/" className="btn btn-primary btn-lg">{t.auth.login}</Link>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <div className="field"><label htmlFor="name">{t.auth.name}</label><input id="name" className="input" autoComplete="name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label htmlFor="email">{t.auth.email}</label><input id="email" className="input" type="email" autoComplete="email" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field">
            <label htmlFor="password">{t.auth.password}</label>
            <input id="password" className="input" type="password" autoComplete="new-password" dir="ltr" required minLength={10} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
            <span className="small muted">{t.auth.passwordHint}</span>
          </div>
          <ErrorAlert message={error} />
          <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? t.common.loading : t.auth.register}</button>
          <div className="small">{t.auth.haveAccount} <Link href="/login/">{t.auth.login}</Link></div>
        </form>
      )}
    </AuthCard>
  );
}
