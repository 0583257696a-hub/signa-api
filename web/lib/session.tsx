'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, setApiLocale, setCsrfToken } from './api';
import { useI18n } from './i18n';

export interface User {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  locale: 'he' | 'en';
  direction: 'rtl' | 'ltr';
  timeZone: string;
  accessibility: { reduceMotion?: boolean; highContrast?: boolean; largeText?: boolean; captions?: boolean };
  preferences: { defaultMode?: 'sign' | 'emoji'; playbackSpeed?: number; emojiStyle?: 'minimal' | 'standard' | 'expressive' };
  privacy: { historyEnabled: boolean };
  isPlatformStaff: boolean;
}

export interface Usage {
  planId: string;
  period: { resetsAt: string };
  counters: Record<'translations' | 'emoji' | 'sign', { used: number; limit: number | null }>;
  limits: { emojiMaxInputChars: number; signMaxInputChars: number; emojiStyles: string[]; signEnabled: boolean; historyAvailable: boolean };
}

interface SessionValue {
  user: User | null;
  usage: Usage | null;
  loading: boolean;
  refresh: () => Promise<void>;
  refreshUsage: () => Promise<void>;
  setUser: (u: User) => void;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

function applyAccessibility(a: User['accessibility'] | undefined) {
  const el = document.documentElement;
  el.dataset.reduceMotion = String(!!a?.reduceMotion);
  el.dataset.contrast = a?.highContrast ? 'high' : 'normal';
  el.dataset.largeText = String(!!a?.largeText);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const [user, setUserState] = useState<User | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => setApiLocale(locale), [locale]);

  const setUser = useCallback((u: User) => {
    setUserState(u);
    applyAccessibility(u.accessibility);
  }, []);

  const refreshUsage = useCallback(async () => {
    try {
      setUsage((await api<Usage>('/usage')).data);
    } catch {
      /* usage widget is optional */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api<{ user: User; csrfToken: string }>('/auth/session');
      setUser(data.user);
      await refreshUsage();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setUserState(null);
        setCsrfToken(null);
      }
    } finally {
      setLoading(false);
    }
  }, [refreshUsage, setUser]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
    } finally {
      setCsrfToken(null);
      setUserState(null);
      setUsage(null);
    }
  }, []);

  return (
    <SessionContext.Provider value={{ user, usage, loading, refresh, refreshUsage, setUser, logout }}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside provider');
  return v;
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || 'S';
