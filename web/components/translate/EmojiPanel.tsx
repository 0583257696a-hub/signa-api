'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Pencil, RefreshCw, Share } from 'lucide-react';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { EmojiResult } from '@/lib/types';
import { Segmented, Toast } from '../ui';
import { LimitState, ServiceErrorState } from './states';

export type EmojiStyle = 'minimal' | 'standard' | 'expressive';

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; result: EmojiResult; noMatch: boolean }
  | { kind: 'error' }
  | { kind: 'limit'; limit: number; resetsAt: string | null };

async function copyText(s: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    return false;
  }
}

export function EmojiPanel({
  text, style, submitSignal, onBusy, onInputError, onEdit,
}: {
  text: string;
  style: EmojiStyle;
  submitSignal: number;
  onBusy: (b: boolean) => void;
  onInputError: (m: string | null) => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const { user, refreshUsage } = useSession();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [view, setView] = useState<'emoji_only' | 'text_and_emoji'>('text_and_emoji');
  const [toast, setToast] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const last = useRef<{ text: string; style: EmojiStyle; variant: number }>({ text: '', style: 'standard', variant: 0 });

  const translate = useCallback(async (source: string, st: EmojiStyle, variant: number) => {
    last.current = { text: source, style: st, variant };
    setPhase({ kind: 'loading' });
    setSaved(false);
    onBusy(true);
    onInputError(null);
    try {
      const { data, meta } = await api<EmojiResult>('/emoji/translate', {
        method: 'POST',
        body: { text: source, mode: 'text_and_emoji', style: st, language: 'auto', variant },
        headers: { 'idempotency-key': newIdempotencyKey() },
      });
      setPhase({ kind: 'done', result: data, noMatch: Boolean(meta.noMatch) });
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'quota_exceeded') {
          setPhase({ kind: 'limit', limit: Number(e.body.details?.limit ?? 0), resetsAt: (e.body.details?.resetsAt as string) ?? null });
          return;
        }
        if (['validation_error', 'input_too_long', 'empty_input', 'entitlement_required', 'feature_disabled', 'rate_limited'].includes(e.code)) {
          onInputError(e.body.message);
          setPhase({ kind: 'idle' });
          return;
        }
      }
      setPhase({ kind: 'error' });
    } finally {
      onBusy(false);
      void refreshUsage();
    }
  }, [onBusy, onInputError, refreshUsage]);

  useEffect(() => {
    if (submitSignal > 0) void translate(text, style, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitSignal]);

  const shown = phase.kind === 'done' ? (view === 'emoji_only' ? phase.result.alternatives.emojiOnly : phase.result.alternatives.textAndEmoji) : '';

  const onCopy = async (whatsapp: boolean) => {
    if (await copyText(shown)) setToast(whatsapp ? t.emoji.copied : t.emoji.copiedPlain);
  };

  const onShare = async () => {
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await navigator.share({ text: shown });
        return;
      } catch {
        /* cancelled */
      }
    }
    await onCopy(true);
  };

  const save = async () => {
    if (phase.kind !== 'done') return;
    try {
      await api('/history', {
        method: 'POST',
        body: { kind: 'emoji', sourceText: last.current.text, language: phase.result.language, output: { result: shown, mode: view, style: phase.result.style } },
      });
      setSaved(true);
    } catch {
      /* ignore */
    }
  };

  return (
    <section className="card stack" aria-live="polite">
      <div className="row between wrap">
        <h3 style={{ margin: 0 }}>{t.emoji.result}</h3>
        <Segmented
          className="compact soft"
          value={view}
          onChange={setView}
          options={[{ value: 'emoji_only', label: t.emoji.emojisOnly }, { value: 'text_and_emoji', label: t.emoji.textEmojis }]}
        />
      </div>

      {phase.kind === 'idle' && <p className="muted" style={{ margin: 0 }}>{t.emoji.idle}</p>}
      {phase.kind === 'loading' && <div className="skeleton" style={{ height: 120 }} />}
      {phase.kind === 'error' && <ServiceErrorState onRetry={() => void translate(last.current.text, last.current.style, last.current.variant)} />}
      {phase.kind === 'limit' && <LimitState limit={phase.limit} resetsAt={phase.resetsAt} />}

      {phase.kind === 'done' && (
        <>
          {phase.noMatch ? (
            <div className="alert alert-info">{t.emoji.noMatch}</div>
          ) : (
            <>
              <div className="preview-area">
                <div className="bubble" dir="auto">
                  {shown}
                  <small>{t.emoji.preview}</small>
                </div>
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <span className="small muted">{t.emoji.emojisOnly}</span>
                <div className="emoji-row" aria-label={t.emoji.emojisOnly}>{phase.result.emojis.join(' ')}</div>
              </div>
              <div className="row wrap">
                <button type="button" className="btn btn-dark hide-mobile" onClick={() => onCopy(false)}><Copy size={16} /> {t.emoji.copy}</button>
                <button type="button" className="btn btn-whatsapp hide-mobile" onClick={() => onCopy(true)}><Share size={16} /> {t.emoji.copyWhatsapp}</button>
                <button type="button" className="btn btn-dark show-mobile" style={{ flex: 1 }} onClick={() => onCopy(true)}>
                  <Copy size={16} /> {t.emoji.copyWhatsapp}
                </button>
              </div>
              <div className="row wrap">
                <button type="button" className="btn" onClick={() => void translate(last.current.text, last.current.style, (last.current.variant + 1) % 10)}>
                  <RefreshCw size={16} /> {t.emoji.regenerate}
                </button>
                <button type="button" className="btn" onClick={onEdit}><Pencil size={16} /> {t.common.edit}</button>
                <button type="button" className="icon-btn" aria-label="Share" onClick={onShare}><Share size={16} /></button>
                {user?.privacy.historyEnabled && (
                  <button type="button" className="btn" disabled={saved} onClick={save}>{saved ? t.emoji.saved : t.emoji.saveToHistory}</button>
                )}
              </div>
            </>
          )}
          <p className="small muted" style={{ margin: 0 }}>{t.emoji.note}</p>
        </>
      )}
      <Toast message={toast} onDone={() => setToast(null)} />
    </section>
  );
}
