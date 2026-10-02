'use client';

import { useEffect, useState } from 'react';
import { BookOpen, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

interface Entry { id: string; code: string; gloss: string; label: { he: string | null; en: string | null }; senseDescription: string | null; hebrewTerms: string[] }

export default function DictionaryPage() {
  const { t, locale } = useI18n();
  const [q, setQ] = useState('');
  const [entries, setEntries] = useState<Entry[] | null>(null);

  useEffect(() => {
    const id = setTimeout(async () => {
      const p = new URLSearchParams({ limit: '100' });
      if (q.trim()) p.set('q', q.trim());
      try {
        setEntries((await api<{ entries: Entry[] }>(`/dictionary/entries?${p}`)).data.entries);
      } catch {
        setEntries([]);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [q]);

  return (
    <>
      <div className="page-head"><div><h2>{t.dictionary.title}</h2><p>{t.dictionary.subtitle}</p></div></div>
      <div style={{ position: 'relative', marginBottom: 16 }}>
        <Search size={16} style={{ position: 'absolute', insetInlineStart: 12, top: 13, color: 'var(--faint)' }} />
        <input className="input" style={{ paddingInlineStart: 36 }} placeholder={t.dictionary.search} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {entries === null ? (
        <div className="skeleton" style={{ height: 160 }} />
      ) : entries.length === 0 ? (
        <div className="card empty"><div className="icon-circle" style={{ background: 'var(--primary-soft)', color: 'var(--primary-ink)' }}><BookOpen size={24} /></div><p>{t.dictionary.empty}</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>{t.dictionary.code}</th><th>{t.dictionary.meaning}</th><th>{t.dictionary.gloss}</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td style={{ fontFamily: 'monospace' }}>{e.code}</td>
                  <td dir="auto">{(locale === 'he' ? e.label.he : e.label.en) ?? e.label.he ?? e.label.en}{e.senseDescription && <div className="small muted">{e.senseDescription}</div>}</td>
                  <td>{e.gloss}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
