'use client';

import { useEffect, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export function Segmented<T extends string>({
  value, options, onChange, className = '', label,
}: { value: T; options: { value: T; label: ReactNode; disabled?: boolean }[]; onChange: (v: T) => void; className?: string; label?: string }) {
  return (
    <div className={`segmented ${className}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function LangToggle() {
  const { locale, setLocale } = useI18n();
  return (
    <div className="lang-toggle" role="group" aria-label="Language">
      <button type="button" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>EN</button>
      <button type="button" aria-pressed={locale === 'he'} onClick={() => setLocale('he')}>עברית</button>
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function Toast({ message, onDone }: { message: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [message, onDone]);
  if (!message) return null;
  return (
    <div className="toast" role="status">
      <Check size={18} color="#7ee2a8" /> {message}
    </div>
  );
}

export function ErrorAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="alert alert-error" role="alert">{message}</div>;
}
