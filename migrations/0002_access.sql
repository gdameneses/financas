-- v2: admin approval instead of a shared secret, mandatory IP allowlist,
-- banned users, full access log, who-added on transactions, named flat icons.

-- Devices now start pending and carry the request that created them.
ALTER TABLE devices ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'; -- pending | approved | denied | revoked
ALTER TABLE devices ADD COLUMN requested_email TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN requested_ip TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN approved_by INTEGER REFERENCES users(id);
ALTER TABLE devices ADD COLUMN approved_at TEXT;
UPDATE devices SET status = 'revoked' WHERE revoked_at IS NOT NULL;

ALTER TABLE users ADD COLUMN banned_at TEXT;

ALTER TABLE transactions ADD COLUMN user_id INTEGER REFERENCES users(id);

DROP TABLE IF EXISTS enroll_codes;

CREATE TABLE allowed_ips (
  id         INTEGER PRIMARY KEY,
  cidr       TEXT NOT NULL UNIQUE,     -- "203.0.113.7" or "203.0.113.0/24" or IPv6 with prefix
  label      TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-time 8-digit codes handed to admins (e-mail + in-app) when an unknown IP/device asks for access.
-- Stored in clear on purpose: admins must be able to read it in the app; it lives 30 minutes.
CREATE TABLE access_codes (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL,
  device_id  INTEGER NOT NULL REFERENCES devices(id),
  ip         TEXT NOT NULL,
  email      TEXT NOT NULL,
  name       TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  emailed    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX access_codes_device ON access_codes(device_id, used_at);

CREATE TABLE access_log (
  id         INTEGER PRIMARY KEY,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  ip         TEXT NOT NULL,
  country    TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  device_id  INTEGER,
  user_id    INTEGER,
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  status     INTEGER NOT NULL,
  outcome    TEXT NOT NULL              -- ok | ip_denied | device_unknown | device_pending | device_denied | unauthenticated | banned | forbidden
);
CREATE INDEX access_log_at ON access_log(at);
CREATE INDEX access_log_outcome ON access_log(outcome, at);

-- Icons become Phosphor icon names (public/icons/sprite.svg). Map the presets; anything else → tag.
UPDATE categories SET icon = CASE name
  WHEN 'Moradia' THEN 'house'
  WHEN 'Mercado' THEN 'shopping-cart'
  WHEN 'Restaurantes' THEN 'fork-knife'
  WHEN 'Transporte' THEN 'car'
  WHEN 'Saúde' THEN 'first-aid-kit'
  WHEN 'Assinaturas' THEN 'television'
  WHEN 'Lazer' THEN 'confetti'
  WHEN 'Roupas' THEN 't-shirt'
  WHEN 'Educação' THEN 'book-open'
  WHEN 'Pets' THEN 'paw-print'
  WHEN 'Presentes' THEN 'gift'
  WHEN 'Impostos' THEN 'receipt'
  WHEN 'Salário' THEN 'briefcase'
  WHEN 'Freelance' THEN 'laptop'
  WHEN 'Investimentos' THEN 'trend-up'
  WHEN 'Reembolso' THEN 'arrow-u-up-left'
  WHEN 'Outros' THEN 'package'
  ELSE 'tag' END
WHERE is_preset = 1 OR icon NOT GLOB '[a-z]*';
