'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AuthCard, tokenFromHash } from '@/components/AuthCard';
import { ErrorAlert } from '@/components/ui';

export default function ResetPasswordPage() {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/password/reset', { method: 'POST', body: { token: tokenFromHash(), password } });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : t.common.errorGeneric);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t.auth.resetTitle}>
      {done ? (
        <div className="stack"><div className="alert alert-success">{t.auth.resetDone}</div><Link href="/login/" className="btn btn-primary btn-lg">{t.auth.login}</Link></div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <div className="field">
            <label htmlFor="password">{t.auth.newPassword}</label>
            <input id="password" className="input" type="password" autoComplete="new-password" dir="ltr" required minLength={10} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
            <span className="small muted">{t.auth.passwordHint}</span>
          </div>
          <ErrorAlert message={error} />
          <button className="btn btn-primary btn-lg" disabled={busy}>{t.common.save}</button>
        </form>
      )}
    </AuthCard>
  );
}
