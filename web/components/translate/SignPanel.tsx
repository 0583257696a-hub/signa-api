'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import type { Job, SignResult, VerificationStatus } from '@/lib/types';
import { Player } from './Player';
import { LimitState, LoadingState, ServiceErrorState, UnsupportedState } from './states';

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; result: SignResult; source: string }
  | { kind: 'unsupported' }
  | { kind: 'error' }
  | { kind: 'limit'; limit: number; resetsAt: string | null };

const BADGE: Record<VerificationStatus, string> = {
  verified: 'badge-verified',
  partially_verified: 'badge-partial',
  experimental: 'badge-experimental',
  unsupported: 'badge-unsupported',
  failed: 'badge-failed',
};

export function StatusBadge({ status, short }: { status: VerificationStatus; short?: boolean }) {
  const { t } = useI18n();
  return <span className={`badge ${BADGE[status]}`}>{short ? t.sign.statusShort[status] : t.sign.status[status]}</span>;
}

/** Highlights which parts of the source are covered, fingerspelled or missing. */
function SourceHighlight({ text, result }: { text: string; result: SignResult }) {
  const { t } = useI18n();
  const spans = result.segments
    .filter((s) => s.sourceSpan && s.status !== 'pause')
    .sort((a, b) => a.sourceSpan!.start - b.sourceSpan!.start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const s of spans) {
    const { start, end } = s.sourceSpan!;
    if (start > cursor) parts.push(text.slice(cursor, start));
    const cls = s.status === 'verified_sign' ? 'mark-covered' : s.status === 'fingerspelled' ? 'mark-fingerspelled' : 'mark-missing';
    parts.push(<mark key={s.index} className={cls}>{text.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  const has = (k: string) => result.segments.some((s) => s.status === k);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="source-highlight" dir="auto">{parts}</div>
      <div className="legend">
        {has('verified_sign') && <span><i style={{ background: 'var(--success-soft)' }} />{t.sign.covered}</span>}
        {has('fingerspelled') && <span><i style={{ background: 'var(--warning-soft)' }} />{t.sign.fingerspelled}</span>}
        {result.segments.some((s) => !s.renderable && s.status !== 'pause') && <span><i style={{ background: 'var(--danger-soft)' }} />{t.sign.missing}</span>}
      </div>
    </div>
  );
}

export function SignPanel({
  text,
  submitSignal,
  onBusy,
  onInputError,
  onEdit,
  onTryEmoji,
}: {
  text: string;
  submitSignal: number;
  onBusy: (b: boolean) => void;
  onInputError: (msg: string | null) => void;
  onEdit: () => void;
  onTryEmoji: () => void;
}) {
  const { t } = useI18n();
  const { user, refreshUsage } = useSession();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [explain, setExplain] = useState(false);
  const [saved, setSaved] = useState(false);
  const run = useRef(0);
  const lastText = useRef('');

  const translate = useCallback(async (source: string) => {
    const my = ++run.current;
    lastText.current = source;
    setPhase({ kind: 'loading' });
    setSaved(false);
    onBusy(true);
    onInputError(null);
    try {
      const { data, meta } = await api<{ job: Job }>('/sign/translate', {
        method: 'POST',
        body: { text: source, language: 'he', outputFormat: 'avatar_sequence' },
        headers: { 'idempotency-key': newIdempotencyKey() },
      });
      let job = data.job;
      const pollMs = Number(meta.pollAfterMs ?? 1000) || 1000;
      const deadline = Date.now() + 120_000;
      while ((job.status === 'queued' || job.status === 'processing') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        if (my !== run.current) return;
        job = (await api<{ job: Job }>(`/sign/jobs/${job.id}`)).data.job;
      }
      if (my !== run.current) return;
      if (!job.resultAvailable) {
        if (job.status === 'completed' && job.verificationStatus === 'unsupported') setPhase({ kind: 'unsupported' });
        else setPhase({ kind: 'error' });
        return;
      }
      const { result } = (await api<{ result: SignResult }>(`/sign/jobs/${job.id}/result`)).data;
      if (my !== run.current) return;
      setPhase(result.verificationStatus === 'unsupported' ? { kind: 'unsupported' } : { kind: 'done', result, source });
    } catch (e) {
      if (my !== run.current) return;
      if (e instanceof ApiError) {
        if (e.code === 'quota_exceeded' && e.body.details?.limitType !== 'concurrent_jobs') {
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
      if (my === run.current) {
        onBusy(false);
        void refreshUsage();
      }
    }
  }, [onBusy, onInputError, refreshUsage]);

  useEffect(() => {
    if (submitSignal > 0) void translate(text);
    // Only react to explicit submissions, not to typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitSignal]);

  const status: VerificationStatus | null =
    phase.kind === 'done' ? phase.result.verificationStatus : phase.kind === 'unsupported' ? 'unsupported' : phase.kind === 'error' ? 'failed' : null;

  const saveToHistory = async () => {
    if (phase.kind !== 'done') return;
    try {
      await api('/history', {
        method: 'POST',
        body: {
          kind: 'sign',
          sourceText: phase.source,
          language: 'he',
          output: { verificationStatus: phase.result.verificationStatus, glosses: phase.result.segments.map((s) => s.gloss ?? '').filter(Boolean) },
        },
      });
      setSaved(true);
    } catch {
      /* ignore */
    }
  };

  return (
    <section className="card player-card" aria-live="polite">
      <div className="player-head">
        <h3>{t.sign.panelTitle}</h3>
        {status && <StatusBadge status={status} />}
        {status && (
          <button type="button" className="btn btn-ghost" style={{ color: 'var(--primary-ink)', padding: 0 }} aria-expanded={explain} onClick={() => setExplain((x) => !x)}>
            {t.sign.whatMeans}
          </button>
        )}
      </div>
      {explain && status && <div className="alert alert-info" style={{ margin: '0 22px 14px' }}>{t.sign.explain[status]}</div>}

      {phase.kind === 'idle' && <div className="player-body"><p className="muted" style={{ margin: 0 }}>{t.sign.empty}</p></div>}
      {phase.kind === 'loading' && <div className="player-body"><LoadingState /></div>}
      {phase.kind === 'unsupported' && <div className="player-body"><UnsupportedState onEdit={onEdit} onTryEmoji={onTryEmoji} /></div>}
      {phase.kind === 'error' && <div className="player-body"><ServiceErrorState onRetry={() => void translate(lastText.current)} /></div>}
      {phase.kind === 'limit' && <div className="player-body"><LimitState limit={phase.limit} resetsAt={phase.resetsAt} /></div>}

      {phase.kind === 'done' && (
        <>
          <Player
            segments={phase.result.segments}
            sourceText={phase.source}
            initialSpeed={user?.preferences.playbackSpeed ?? 1}
            captionsDefault={user?.accessibility.captions ?? true}
          />
          <div className="player-body" style={{ paddingTop: 0 }}>
            {!phase.result.engine.validated && <div className="small muted" style={{ textAlign: 'end' }}>{t.sign.illustrative}</div>}
            {!phase.result.quality.renderable && <SourceHighlight text={phase.source} result={phase.result} />}
            <div className="small muted" title={t.sign.coverageNote}>
              {t.sign.lexicalCoverage}: {Math.round(phase.result.quality.lexicalCoverage * 100)}% · {t.sign.coverageNote}
            </div>
            {user?.privacy.historyEnabled && (
              <div><button type="button" className="btn" disabled={saved} onClick={saveToHistory}>{saved ? t.emoji.saved : t.emoji.saveToHistory}</button></div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
