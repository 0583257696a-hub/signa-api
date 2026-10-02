'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession, type User } from '@/lib/session';
import { AuthCard } from '@/components/AuthCard';
import { ErrorAlert } from '@/components/ui';

export default function LoginPage() {
  const { t, setLocale } = useI18n();
  const { user, loading, setUser, refreshUsage } = useSession();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace('/translate/');
  }, [loading, user, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data } = await api<{ user: User }>('/auth/login', { method: 'POST', body: { email, password } });
      setUser(data.user);
      setLocale(data.user.locale);
      await refreshUsage();
      router.replace('/translate/');
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : t.common.errorGeneric);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t.auth.loginTitle}>
      <form className="stack" onSubmit={submit}>
        <div className="field"><label htmlFor="email">{t.auth.email}</label><input id="email" className="input" type="email" autoComplete="email" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor="password">{t.auth.password}</label><input id="password" className="input" type="password" autoComplete="current-password" dir="ltr" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        <ErrorAlert message={error} />
        <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? t.common.loading : t.auth.login}</button>
        <div className="row between wrap small">
          <Link href="/forgot-password/">{t.auth.forgot}</Link>
          <span>{t.auth.noAccount} <Link href="/register/">{t.auth.register}</Link></span>
        </div>
      </form>
    </AuthCard>
  );
}
