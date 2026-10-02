'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { AuthCard, tokenFromHash } from '@/components/AuthCard';

export default function VerifyEmailPage() {
  const { t } = useI18n();
  const [state, setState] = useState<'pending' | 'ok' | 'invalid'>('pending');

  useEffect(() => {
    const token = tokenFromHash();
    if (!token) {
      setState('invalid');
      return;
    }
    api('/auth/email/verify', { method: 'POST', body: { token } }).then(
      () => setState('ok'),
      () => setState('invalid'),
    );
  }, []);

  return (
    <AuthCard title={t.auth.verifyTitle}>
      {state === 'pending' && <div className="spinner" />}
      {state === 'ok' && <div className="alert alert-success">{t.auth.verified}</div>}
      {state === 'invalid' && <div className="alert alert-error">{t.auth.invalidLink}</div>}
      {state !== 'pending' && <Link href="/login/" className="btn btn-primary btn-lg">{t.auth.continue}</Link>}
    </AuthCard>
  );
}
