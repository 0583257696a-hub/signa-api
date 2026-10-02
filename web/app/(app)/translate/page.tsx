'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Hand, Smile } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { Segmented } from '@/components/ui';
import { InputCard } from '@/components/translate/InputCard';
import { SignPanel } from '@/components/translate/SignPanel';
import { EmojiPanel, type EmojiStyle } from '@/components/translate/EmojiPanel';

type Mode = 'sign' | 'emoji';

export default function TranslatePage() {
  const { t } = useI18n();
  const { user, usage } = useSession();
  const [mode, setMode] = useState<Mode>('sign');
  const [text, setText] = useState('');
  const [style, setStyle] = useState<EmojiStyle>('standard');
  const [busy, setBusy] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [signSubmit, setSignSubmit] = useState(0);
  const [emojiSubmit, setEmojiSubmit] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Initial mode: ?mode= in the URL, else the user's default preference.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('mode');
    if (q === 'sign' || q === 'emoji') setMode(q);
    else if (user?.preferences.defaultMode) setMode(user.preferences.defaultMode);
    if (user?.preferences.emojiStyle) setStyle(user.preferences.emojiStyle);
  }, [user]);

  const changeMode = (m: Mode) => {
    setMode(m);
    setInputError(null);
    const url = new URL(window.location.href);
    url.searchParams.set('mode', m);
    window.history.replaceState(null, '', url);
  };

  const focusInput = useCallback(() => textareaRef.current?.focus(), []);
  const maxChars = mode === 'sign' ? (usage?.limits.signMaxInputChars ?? 500) : (usage?.limits.emojiMaxInputChars ?? 500);
  const allowedStyles = usage?.limits.emojiStyles ?? ['minimal', 'standard'];
  const privacyNote = user?.privacy.historyEnabled ? t.translate.privacyHistoryOn : t.translate.privacy;

  const tabs = (
    <Segmented<Mode>
      value={mode}
      onChange={changeMode}
      label="Mode"
      options={[
        { value: 'sign', label: <><Hand size={16} /> {t.translate.tabSign}</> },
        { value: 'emoji', label: <><Smile size={16} /> <span className="hide-mobile">{t.translate.tabEmoji}</span><span className="show-mobile">{t.translate.tabEmojiShort}</span></> },
      ]}
    />
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h2>{mode === 'sign' ? t.translate.title : t.translate.emojiTitle}</h2>
          <p className="hide-mobile">{mode === 'sign' ? t.translate.subtitle : t.translate.emojiSubtitle}</p>
        </div>
        {tabs}
      </div>

      <div className="grid-2">
        <InputCard
          ref={textareaRef}
          text={text}
          onText={(v) => { setText(v); setInputError(null); }}
          maxChars={maxChars}
          busy={busy}
          error={inputError}
          showExamples={mode === 'sign'}
          privacyNote={mode === 'sign' ? privacyNote : null}
          onSubmit={() => (mode === 'sign' ? setSignSubmit((n) => n + 1) : setEmojiSubmit((n) => n + 1))}
        >
          {mode === 'emoji' && (
            <div className="stack" style={{ gap: 8 }}>
              <span style={{ fontWeight: 600 }}>{t.emoji.style}</span>
              <Segmented<EmojiStyle>
                className="full"
                value={style}
                onChange={setStyle}
                label={t.emoji.style}
                options={(['minimal', 'standard', 'expressive'] as const).map((s) => ({
                  value: s,
                  label: <span title={allowedStyles.includes(s) ? undefined : t.emoji.planOnly}>{t.emoji.styles[s]}</span>,
                  disabled: !allowedStyles.includes(s),
                }))}
              />
            </div>
          )}
        </InputCard>

        <div style={{ display: mode === 'sign' ? 'block' : 'none' }}>
          <SignPanel
            text={text}
            submitSignal={signSubmit}
            onBusy={setBusy}
            onInputError={setInputError}
            onEdit={focusInput}
            onTryEmoji={() => { changeMode('emoji'); setEmojiSubmit((n) => n + 1); }}
          />
        </div>
        <div style={{ display: mode === 'emoji' ? 'block' : 'none' }}>
          <EmojiPanel text={text} style={style} submitSignal={emojiSubmit} onBusy={setBusy} onInputError={setInputError} onEdit={focusInput} />
        </div>
      </div>
    </>
  );
}
