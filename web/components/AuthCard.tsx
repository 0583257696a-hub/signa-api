'use client';

import type { ReactNode } from 'react';
import { Brand } from './AppShell';
import { LangToggle } from './ui';

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card stack">
        <div className="row between"><Brand /><LangToggle /></div>
        <div className="card stack">
          <h2 style={{ margin: 0, fontSize: 24 }}>{title}</h2>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Reads `#token=…` from the URL fragment (tokens are never sent in query strings). */
export function tokenFromHash(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token') ?? '';
}
