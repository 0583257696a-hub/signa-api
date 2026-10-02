'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Captions, Check, ChartNoAxesColumn, Maximize, Pause, Play, Repeat, RotateCcw, SkipBack, SkipForward } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import type { Segment } from '@/lib/types';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5] as const;
const TICK = 50;

/** Neutral placeholder figure. No sign is drawn: real animation assets are rendered when available. */
function AvatarPlaceholder() {
  return (
    <svg viewBox="0 0 400 260" width="100%" height="100%" role="img" aria-hidden="true" style={{ display: 'block' }}>
      <ellipse cx="200" cy="265" rx="210" ry="50" fill="#dedee6" />
      <path d="M95 260 C 100 190, 140 165, 200 160 C 260 165, 300 190, 305 260 Z" fill="#33364a" />
      <path d="M183 150 h34 v22 a17 17 0 0 1 -34 0 Z" fill="#c99a78" />
      <circle cx="200" cy="105" r="48" fill="#d7a886" />
      <path d="M152 100 C 150 60, 250 55, 248 100 C 240 78, 165 75, 152 100 Z" fill="#4a3426" />
      <circle cx="183" cy="108" r="4" fill="#2a2a2a" />
      <circle cx="217" cy="108" r="4" fill="#2a2a2a" />
      <path d="M187 128 Q200 137 213 128" stroke="#8a5a40" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function Player({
  segments,
  sourceText,
  initialSpeed = 1,
  captionsDefault = true,
}: {
  segments: Segment[];
  sourceText: string;
  initialSpeed?: number;
  captionsDefault?: boolean;
}) {
  const { t, fmt } = useI18n();
  const playable = useMemo(() => segments.filter((s) => s.renderable && s.timing.durationMs > 0), [segments]);
  const total = playable.reduce((n, s) => n + s.timing.durationMs, 0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [speed, setSpeed] = useState<number>(SPEEDS.includes(initialSpeed as 1) ? initialSpeed : 1);
  const [captions, setCaptions] = useState(captionsDefault);
  const stageRef = useRef<HTMLDivElement>(null);

  // Position within the playable timeline.
  const starts = useMemo(() => {
    let acc = 0;
    return playable.map((s) => {
      const st = acc;
      acc += s.timing.durationMs;
      return st;
    });
  }, [playable]);
  const currentIdx = Math.max(0, starts.findIndex((st, i) => time >= st && time < st + playable[i]!.timing.durationMs));
  const current = playable[time >= total ? playable.length - 1 : currentIdx];

  useEffect(() => {
    setTime(0);
    setPlaying(playable.length > 0);
  }, [playable]);

  useEffect(() => {
    if (!playing || total === 0) return;
    const id = setInterval(() => {
      setTime((tm) => {
        const next = tm + TICK * speed;
        if (next >= total) {
          if (loop) return 0;
          setPlaying(false);
          return total;
        }
        return next;
      });
    }, TICK);
    return () => clearInterval(id);
  }, [playing, speed, loop, total]);

  const jump = useCallback((i: number) => {
    const k = Math.min(Math.max(i, 0), playable.length - 1);
    setTime(starts[k] ?? 0);
  }, [playable.length, starts]);

  const label = (s: Segment) =>
    (s.sourceSpan ? sourceText.slice(s.sourceSpan.start, s.sourceSpan.end) : '') || s.signEntry?.label || s.gloss || '—';

  const video = current?.assets.find((a) => a.url && (a.mimeType === 'video/mp4' || a.mimeType === 'video/webm'));

  if (playable.length === 0) return null;

  return (
    <>
      <div className="stage" ref={stageRef}>
        <span className="stage-label">{t.sign.renderPlaceholder}</span>
        <span className="stage-speed" dir="ltr">{speed}×</span>
        {video?.url ? (
          <video key={video.id} src={video.url} autoPlay muted playsInline style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <div style={{ width: '62%', alignSelf: 'end' }}><AvatarPlaceholder /></div>
        )}
        {captions && current && <span className="stage-caption" dir="auto">{label(current)}</span>}
      </div>

      <div className="player-body">
        <div className="progress">
          <span>{fmtTime(time)}</span>
          <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.round(time)}>
            {playable.map((s, i) => {
              const st = starts[i]!;
              const pct = Math.min(100, Math.max(0, ((time - st) / s.timing.durationMs) * 100));
              return (
                <span key={s.index} style={{ flex: s.timing.durationMs }}>
                  <i style={{ width: `${pct}%` }} />
                </span>
              );
            })}
          </div>
          <span>{fmtTime(total)}</span>
        </div>

        <div className="controls">
          <button type="button" className="icon-btn" style={{ border: 0 }} aria-label={t.sign.controls.prev} onClick={() => jump(currentIdx - 1)}><SkipBack size={18} /></button>
          <button type="button" className="play-btn" aria-label={playing ? t.sign.controls.pause : t.sign.controls.play} onClick={() => {
            if (!playing && time >= total) setTime(0);
            setPlaying((p) => !p);
          }}>
            {playing ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button type="button" className="icon-btn" style={{ border: 0 }} aria-label={t.sign.controls.next} onClick={() => jump(currentIdx + 1)}><SkipForward size={18} /></button>
          <button type="button" className="icon-btn" style={{ border: 0 }} aria-label={t.sign.controls.replay} onClick={() => { setTime(0); setPlaying(true); }}><RotateCcw size={18} /></button>
          <button type="button" className="icon-btn" style={{ border: 0, background: loop ? 'var(--primary-soft)' : undefined }} aria-pressed={loop} aria-label={t.sign.controls.loop} onClick={() => setLoop((l) => !l)}><Repeat size={18} /></button>
          <div className="segmented compact" role="group" aria-label="Speed" dir="ltr">
            {SPEEDS.map((s) => (
              <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>
            ))}
          </div>
          <button type="button" className="icon-btn" style={{ borderRadius: 10, border: 0, background: captions ? 'var(--primary-soft)' : undefined, color: captions ? 'var(--primary-ink)' : undefined }} aria-pressed={captions} aria-label={t.sign.controls.captions} onClick={() => setCaptions((c) => !c)}><Captions size={18} /></button>
          <button type="button" className="icon-btn" style={{ border: 0 }} aria-label={t.sign.controls.fullscreen} onClick={() => stageRef.current?.requestFullscreen?.()}><Maximize size={18} /></button>
        </div>

        <div className="row between wrap small muted">
          <span>{fmt(t.sign.segmentOf, { n: currentIdx + 1, total: playable.length })}</span>
        </div>

        <div className="segments">
          {segments.filter((s) => s.status !== 'pause').map((s) => {
            const pIdx = playable.indexOf(s);
            const state = pIdx < 0 ? 'na' : pIdx < currentIdx || (time >= total && !playing) ? 'played' : pIdx === currentIdx ? 'playing' : 'next';
            return (
              <button
                key={s.index}
                type="button"
                className={`segment ${s.renderable ? '' : 'unrenderable'}`}
                aria-current={state === 'playing'}
                disabled={!s.renderable}
                onClick={() => pIdx >= 0 && jump(pIdx)}
              >
                <span className="seg-top">
                  <span>{state === 'played' ? <Check size={14} color="var(--success)" /> : state === 'playing' ? <ChartNoAxesColumn size={14} color="var(--primary)" /> : null}</span>
                  <span>{String(s.index + 1).padStart(2, '0')}</span>
                </span>
                <span className="seg-word" dir="auto">{label(s)}</span>
                <span className="seg-state">
                  {state === 'na' ? t.sign.notAvailable : state === 'played' ? t.sign.played : state === 'playing' ? t.sign.playing : t.sign.upNext}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
