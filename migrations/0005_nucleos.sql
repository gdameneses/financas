-- Multi-tenancy: every ledger belongs to a "núcleo" (household/group). Users join núcleos through
-- invites; each user has a current núcleo. Everything that existed before this migration belongs to
-- núcleo 1, and every existing user administers it.

CREATE TABLE nucleos (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE nucleo_members (
  nucleo_id INTEGER NOT NULL REFERENCES nucleos(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('admin','membro')),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (nucleo_id, user_id)
);
CREATE INDEX nucleo_members_user ON nucleo_members(user_id);

-- 8-digit single-use invite codes, 7-day TTL. Stored in clear: the núcleo admin reads them in-app.
CREATE TABLE nucleo_invites (
  id         INTEGER PRIMARY KEY,
  nucleo_id  INTEGER NOT NULL REFERENCES nucleos(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin','membro')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  used_by    INTEGER REFERENCES users(id)
);
CREATE INDEX nucleo_invites_code ON nucleo_invites(code, used_at);

-- Wrong invite guesses are counted per IP bucket (codes are not bound to a device).
CREATE TABLE invite_attempts (
  ip_bucket TEXT NOT NULL,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX invite_attempts_bucket ON invite_attempts(ip_bucket, at);

ALTER TABLE users ADD COLUMN current_nucleo_id INTEGER REFERENCES nucleos(id);
-- Set by an app admin when approving a device: the account created on it joins this núcleo at once.
ALTER TABLE devices ADD COLUMN join_nucleo_id INTEGER REFERENCES nucleos(id);

-- Nullable on purpose (SQLite cannot add a NOT NULL column without a default, and a default of 1
-- would silently drop forgotten rows into núcleo 1). Application code always sets it.
ALTER TABLE categories ADD COLUMN nucleo_id INTEGER REFERENCES nucleos(id);
ALTER TABLE transactions ADD COLUMN nucleo_id INTEGER REFERENCES nucleos(id);
CREATE INDEX categories_nucleo ON categories(nucleo_id, kind, sort);
CREATE INDEX transactions_nucleo_date ON transactions(nucleo_id, date);

-- Existing data → núcleo 1; existing users administer it and start there.
INSERT INTO nucleos (id, name, created_by) SELECT 1, 'Casa', (SELECT MIN(id) FROM users) WHERE EXISTS (SELECT 1 FROM users);
INSERT INTO nucleo_members (nucleo_id, user_id, role) SELECT 1, id, 'admin' FROM users;
UPDATE users SET current_nucleo_id = 1 WHERE EXISTS (SELECT 1 FROM nucleos WHERE id = 1);
UPDATE categories SET nucleo_id = 1 WHERE EXISTS (SELECT 1 FROM nucleos WHERE id = 1);
UPDATE transactions SET nucleo_id = 1 WHERE EXISTS (SELECT 1 FROM nucleos WHERE id = 1);
-- A fresh database (no users yet) gets no núcleo 1: the preset categories seeded by 0001 are orphans
-- and go away; each new núcleo seeds its own presets from src/presets.ts.
DELETE FROM budgets WHERE category_id IN (SELECT id FROM categories WHERE nucleo_id IS NULL);
DELETE FROM categories WHERE nucleo_id IS NULL;
