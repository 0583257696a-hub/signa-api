-- Lexical dictionary model.
-- A sign entry is a LEXICAL entry: a specific sign (form + meaning) linked to a semantic
-- concept. A concept (e.g. NEED_HELP) is NOT a hand movement: one concept may be expressed
-- by several entries (regional variants, different senses, grammatical forms).

-- Concept inventory. Seeded concepts are CANDIDATES for coverage planning only; they are
-- not translations and carry no sign data until an expert links a reviewed entry.
CREATE TABLE lexical_concepts (
  concept_key        TEXT PRIMARY KEY CHECK (concept_key GLOB '[A-Z]*' AND concept_key NOT GLOB '*[^A-Z0-9_]*'),
  category           TEXT NOT NULL,
  hebrew_terms_json  TEXT NOT NULL DEFAULT '[]',
  english_terms_json TEXT NOT NULL DEFAULT '[]',
  sense_description  TEXT,
  status             TEXT NOT NULL DEFAULT 'candidate'
                     CHECK (status IN ('candidate', 'in_progress', 'deferred', 'rejected')),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_lexical_concepts_category ON lexical_concepts (category, status);

-- Clearer names for existing columns.
ALTER TABLE sign_entries RENAME COLUMN variants_json TO hebrew_terms_json;       -- Hebrew words/phrases that may map to this entry
ALTER TABLE sign_entries RENAME COLUMN description TO sense_description;          -- precise meaning and context
ALTER TABLE sign_entries RENAME COLUMN grammar_json TO grammatical_features_json; -- validated grammatical features only

ALTER TABLE sign_entries ADD COLUMN concept_key TEXT REFERENCES lexical_concepts (concept_key);
ALTER TABLE sign_entries ADD COLUMN english_terms_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sign_entries ADD COLUMN part_of_speech TEXT;
ALTER TABLE sign_entries ADD COLUMN regional_variants_json TEXT NOT NULL DEFAULT '[]'; -- documented, verified community/regional variation
ALTER TABLE sign_entries ADD COLUMN sign_definition TEXT;                               -- linguistic description of the form
ALTER TABLE sign_entries ADD COLUMN non_manual_markers_json TEXT NOT NULL DEFAULT '[]'; -- lexical NMMs that are part of the sign
ALTER TABLE sign_entries ADD COLUMN dominant_hand TEXT
  CHECK (dominant_hand IS NULL OR dominant_hand IN ('one_handed', 'two_handed_symmetric', 'two_handed_asymmetric', 'not_applicable'));
ALTER TABLE sign_entries ADD COLUMN source_reference TEXT; -- provenance (corpus / dictionary / elicitation session)
ALTER TABLE sign_entries ADD COLUMN license_ref TEXT;      -- licence / agreement covering the lexical data
-- When several published entries share a concept and a Hebrew term, only an entry marked
-- as the default variant may be selected automatically; otherwise the term is ambiguous.
ALTER TABLE sign_entries ADD COLUMN is_default_variant INTEGER NOT NULL DEFAULT 0 CHECK (is_default_variant IN (0, 1));

CREATE INDEX idx_sign_entries_concept ON sign_entries (concept_key);
