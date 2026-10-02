'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AuthCard } from '@/components/AuthCard';

export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/auth/password/forgot', { method: 'POST', body: { email } });
    } catch {
      /* same message either way */
    }
    setSent(true);
    setBusy(false);
  };

  return (
    <AuthCard title={t.auth.forgotTitle}>
      {sent ? (
        <div className="stack"><div className="alert alert-success">{t.auth.forgotSent}</div><Link href="/login/">{t.common.back}</Link></div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <div className="field"><label htmlFor="email">{t.auth.email}</label><input id="email" className="input" type="email" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <button className="btn btn-primary btn-lg" disabled={busy}>{t.auth.sendLink}</button>
          <Link href="/login/" className="small">{t.common.back}</Link>
        </form>
      )}
    </AuthCard>
  );
}
