'use client';

import { forwardRef, type ReactNode } from 'react';
import { Lock, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

interface Props {
  text: string;
  onText: (v: string) => void;
  maxChars: number;
  onSubmit: () => void;
  busy: boolean;
  showExamples?: boolean;
  privacyNote?: string | null;
  children?: ReactNode; // extra controls (e.g. emoji style)
  error?: string | null;
}

export const InputCard = forwardRef<HTMLTextAreaElement, Props>(function InputCard(
  { text, onText, maxChars, onSubmit, busy, showExamples, privacyNote, children, error },
  ref,
) {
  const { t } = useI18n();
  const over = text.length > maxChars;
  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && text.trim() && !over) onSubmit();
      }}
    >
      <div className="row between">
        <label htmlFor="message" style={{ fontWeight: 600, fontSize: 17 }}>{t.translate.prompt}</label>
        {showExamples && <span className="small muted">{t.translate.inputLang}: {t.translate.hebrew}</span>}
      </div>
      <div className="textarea-wrap">
        <textarea
          id="message"
          ref={ref}
          className="textarea dir-auto"
          dir="auto"
          value={text}
          maxLength={maxChars * 2}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit();
          }}
        />
        <div className="textarea-foot">
          {text ? (
            <button type="button" className="btn" style={{ padding: '4px 10px', fontSize: 14 }} onClick={() => onText('')}>
              <X size={14} /> {t.common.clear}
            </button>
          ) : <span />}
          <span className="small" style={{ color: over ? 'var(--danger)' : 'var(--muted)' }}>{text.length} / {maxChars}</span>
        </div>
      </div>

      {showExamples && (
        <div className="stack" style={{ gap: 8 }}>
          <span className="small muted">{t.translate.tryExample}</span>
          <div className="row wrap">
            {t.translate.examples.map((ex) => (
              <button key={ex} type="button" className="chip" dir="rtl" onClick={() => onText(ex)}>{ex}</button>
            ))}
          </div>
        </div>
      )}

      {children}

      {error && <div className="alert alert-error" role="alert">{error}</div>}

      <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !text.trim() || over}>
        {busy ? t.common.loading : t.translate.button}
      </button>

      {privacyNote && (
        <div className="note"><Lock size={16} style={{ flex: 'none', marginTop: 2, color: 'var(--success)' }} /> {privacyNote}</div>
      )}
    </form>
  );
});
