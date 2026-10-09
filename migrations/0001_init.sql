-- Finance tracker: initial schema. Amounts are integer centavos.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  iterations    INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE devices (
  id           INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  user_agent   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at   TEXT
);

CREATE TABLE enroll_codes (
  code_hash         TEXT PRIMARY KEY,
  created_by_device INTEGER REFERENCES devices(id),
  expires_at        TEXT NOT NULL,
  used_at           TEXT
);

CREATE TABLE sessions (
  id         INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  device_id  INTEGER NOT NULL REFERENCES devices(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX sessions_device ON sessions(device_id);

CREATE TABLE login_attempts (
  device_id INTEGER NOT NULL,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX login_attempts_device ON login_attempts(device_id, at);

CREATE TABLE categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('in','out')),
  icon       TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT '#888888',
  is_preset  INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE transactions (
  id           INTEGER PRIMARY KEY,
  date         TEXT NOT NULL,                 -- YYYY-MM-DD
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  kind         TEXT NOT NULL CHECK (kind IN ('in','out')),
  category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  payee        TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX transactions_date ON transactions(date);
CREATE INDEX transactions_category ON transactions(category_id);

CREATE TABLE budgets (
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  month       TEXT NOT NULL,                  -- YYYY-MM
  cap_cents   INTEGER NOT NULL CHECK (cap_cents >= 0),
  PRIMARY KEY (category_id, month)
);

-- Preset categories (pt-BR). is_preset only drives a badge; all are deletable.
INSERT INTO categories (name, kind, icon, color, is_preset, sort) VALUES
  ('Moradia',       'out', '🏠', '#7a6f9a', 1, 1),
  ('Mercado',       'out', '🛒', '#6f8f6a', 1, 2),
  ('Restaurantes',  'out', '🍽️', '#a67a52', 1, 3),
  ('Transporte',    'out', '🚗', '#5f8296', 1, 4),
  ('Saúde',         'out', '💊', '#a06060', 1, 5),
  ('Assinaturas',   'out', '📺', '#8a6f93', 1, 6),
  ('Lazer',         'out', '🎉', '#a0677f', 1, 7),
  ('Roupas',        'out', '👕', '#5d8d87', 1, 8),
  ('Educação',      'out', '📚', '#a39358', 1, 9),
  ('Pets',          'out', '🐾', '#7f9358', 1, 10),
  ('Presentes',     'out', '🎁', '#9c5f6c', 1, 11),
  ('Impostos',      'out', '🧾', '#6f7682', 1, 12),
  ('Outros',        'out', '📦', '#7d7d7d', 1, 13),
  ('Salário',       'in',  '💼', '#5f8f68', 1, 1),
  ('Freelance',     'in',  '🧑‍💻', '#5f7d9c', 1, 2),
  ('Investimentos', 'in',  '📈', '#7c6f9c', 1, 3),
  ('Reembolso',     'in',  '↩️', '#5a8c93', 1, 4),
  ('Outros',        'in',  '📦', '#7d7d7d', 1, 5);
