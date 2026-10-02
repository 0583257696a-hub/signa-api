'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '@/lib/session';

export default function Home() {
  const router = useRouter();
  const { user, loading } = useSession();
  useEffect(() => {
    if (!loading) router.replace(user ? '/translate/' : '/login/');
  }, [loading, user, router]);
  return null;
}
