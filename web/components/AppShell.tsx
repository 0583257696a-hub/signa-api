'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { BarChart3, BookOpen, CircleHelp, Hand, History, Languages, LogOut, Settings, Shield } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { initials, useSession } from '@/lib/session';
import { LangToggle } from './ui';

export function Brand() {
  return (
    <Link href="/translate/" className="brand" style={{ textDecoration: 'none' }}>
      <span className="brand-mark"><Hand size={18} /></span> Signa
    </Link>
  );
}

export function PlanWidget() {
  const { usage } = useSession();
  const { t } = useI18n();
  if (!usage) return null;
  const c = usage.counters.translations;
  const planName = t.plans[usage.planId as 'free' | 'pro' | 'business'] ?? usage.planId;
  const pct = c.limit ? Math.min(100, (c.used / c.limit) * 100) : 0;
  return (
    <div className="plan-widget">
      <div className="row"><span>{planName} {t.common.plan}</span><b>{c.limit !== null ? `${c.used} / ${c.limit}` : c.used}</b></div>
      {c.limit !== null && <div className="meter"><span style={{ width: `${pct}%` }} /></div>}
      {usage.planId === 'free' && <Link href="/usage/" style={{ fontWeight: 600 }}>{t.plans.upgrade}</Link>}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { user, loading, logout } = useSession();
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace('/login/');
  }, [loading, user, router]);

  if (loading || !user) return <div className="auth-wrap"><div className="spinner" aria-label={t.common.loading} /></div>;

  const items = [
    { href: '/translate/', label: t.nav.translate, short: t.nav.translate, icon: Languages, mobile: true },
    { href: '/history/', label: t.nav.history, short: t.nav.historyShort, icon: History, mobile: true },
    { href: '/dictionary/', label: t.nav.dictionary, short: t.nav.dictionary, icon: BookOpen, mobile: true },
    { href: '/usage/', label: t.nav.usage, short: t.nav.usage, icon: BarChart3, mobile: false },
    { href: '/settings/', label: t.nav.settings, short: t.nav.settings, icon: Settings, mobile: true },
    { href: '/help/', label: t.nav.help, short: t.nav.help, icon: CircleHelp, mobile: false },
    ...(user.isPlatformStaff ? [{ href: '/admin/', label: t.nav.admin, short: t.nav.admin, icon: Shield, mobile: false }] : []),
  ];
  const active = items.find((i) => pathname.startsWith(i.href));

  const onLogout = async () => {
    await logout();
    router.replace('/login/');
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <nav className="nav" aria-label="Main">
          {items.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} aria-current={active?.href === href ? 'page' : undefined}>
              <Icon size={18} /> {label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <PlanWidget />
          <div className="user-chip">
            <span className="avatar">{initials(user.name)}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.name}</div>
              <small>{t.common.personal}</small>
            </div>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="mobile-brand"><Brand /></div>
          <h1>{active?.label ?? ''}</h1>
          <div className="topbar-actions">
            <LangToggle />
            <Link href="/help/" className="icon-btn hide-mobile" aria-label={t.nav.help}><CircleHelp size={18} /></Link>
            <div style={{ position: 'relative' }}>
              <button type="button" className="avatar" style={{ border: 0, cursor: 'pointer' }} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
                {initials(user.name)}
              </button>
              {menu && (
                <div className="card" role="menu" style={{ position: 'absolute', insetInlineEnd: 0, top: 44, padding: 8, minWidth: 180, zIndex: 20 }}>
                  <div className="small muted" style={{ padding: '6px 10px' }}>{user.email}</div>
                  <Link href="/settings/" className="btn btn-ghost" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => setMenu(false)}>
                    <Settings size={16} /> {t.nav.settings}
                  </Link>
                  <button type="button" className="btn btn-ghost" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={onLogout}>
                    <LogOut size={16} /> {t.common.signOut}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>

      <nav className="bottom-nav" aria-label="Main">
        {items.filter((i) => i.mobile).map(({ href, short, icon: Icon }) => (
          <Link key={href} href={href} aria-current={active?.href === href ? 'page' : undefined}>
            <Icon size={20} /> {short}
          </Link>
        ))}
      </nav>
    </div>
  );
}
