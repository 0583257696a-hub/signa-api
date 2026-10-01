-- Initial plan definitions and entitlements.
-- IMPORTANT: pricing_json is intentionally NULL. Commercial prices are a business
-- decision and must be configured by an operator (admin API) before billing goes live.
-- The limits below are initial operational defaults and are editable via the admin API.

INSERT INTO plans (id, name_en, name_he, is_active, is_public, availability, sort_order, pricing_json, trial_days, grace_period_days, created_at, updated_at) VALUES
  ('free',     'Free',     'חינמי',  1, 1, 'available',     0, NULL, 0,  0,  0, 0),
  ('pro',      'Pro',      'מקצועי', 1, 1, 'waitlist',      1, NULL, 14, 7,  0, 0),
  ('business', 'Business', 'עסקי',   1, 1, 'contact_sales', 2, NULL, 14, 14, 0, 0);

-- value_json: JSON value. A JSON null for a *_limit key means "no limit at this level".
-- translations.monthly_limit is a pooled limit across emoji + sign (shown as "12 / 50").
INSERT INTO plan_entitlements (plan_id, key, value_json, updated_at) VALUES
  ('free', 'translations.monthly_limit', '50',                                    0),
  ('free', 'history.available',          'false',                                 0),
  ('free', 'emoji.monthly_limit',        'null',                                  0),
  ('free', 'emoji.max_input_chars',      '500',                                   0),
  ('free', 'emoji.styles',               '["minimal","standard"]',                0),
  ('free', 'sign.enabled',               'true',                                  0),
  ('free', 'sign.monthly_limit',         'null',                                  0),
  ('free', 'sign.max_input_chars',       '500',                                   0),
  ('free', 'sign.max_concurrent_jobs',   '1',                                     0),
  ('free', 'org.max_members',            '0',                                     0),
  ('free', 'rate.requests_per_minute',   '30',                                    0),

  ('pro', 'translations.monthly_limit',  'null',                                  0),
  ('pro', 'history.available',           'true',                                  0),
  ('pro', 'emoji.monthly_limit',         '5000',                                  0),
  ('pro', 'emoji.max_input_chars',       '2000',                                  0),
  ('pro', 'emoji.styles',                '["minimal","standard","expressive"]',   0),
  ('pro', 'sign.enabled',                'true',                                  0),
  ('pro', 'sign.monthly_limit',          '500',                                   0),
  ('pro', 'sign.max_input_chars',        '1000',                                  0),
  ('pro', 'sign.max_concurrent_jobs',    '3',                                     0),
  ('pro', 'org.max_members',             '0',                                     0),
  ('pro', 'rate.requests_per_minute',    '120',                                   0),

  ('business', 'translations.monthly_limit', 'null',                             0),
  ('business', 'history.available',         'true',                               0),
  ('business', 'emoji.monthly_limit',       '50000',                              0),
  ('business', 'emoji.max_input_chars',     '5000',                               0),
  ('business', 'emoji.styles',              '["minimal","standard","expressive"]',0),
  ('business', 'sign.enabled',              'true',                               0),
  ('business', 'sign.monthly_limit',        '5000',                               0),
  ('business', 'sign.max_input_chars',      '2000',                               0),
  ('business', 'sign.max_concurrent_jobs',  '10',                                 0),
  ('business', 'org.max_members',          '50',                                 0),
  ('business', 'rate.requests_per_minute',  '600',                                0);

INSERT INTO feature_flags (key, enabled, description, updated_by, updated_at) VALUES
  ('sign_translation',     1, 'Accept ISL translation requests',                        NULL, 0),
  ('emoji_translation',    1, 'Accept emoji translation requests',                      NULL, 0),
  ('registration_open',    1, 'Allow new self-service registrations',                   NULL, 0),
  ('google_oauth',         0, 'Allow Google sign-in (also requires credentials)',       NULL, 0);
