-- Planning: per-category pacing behaviour and budget alerts as a first-class entity.

-- continuo: spend accrues through the month (groceries) → pace alerts make sense
-- fixo:     paid in one go (rent, subscriptions)          → only "over budget"
-- livre:    bursty / discretionary (leisure, gifts)        → 80% and 100% only
ALTER TABLE categories ADD COLUMN pace TEXT NOT NULL DEFAULT 'continuo' CHECK (pace IN ('continuo','fixo','livre'));
UPDATE categories SET pace = 'fixo'  WHERE is_preset = 1 AND name IN ('Moradia','Assinaturas','Impostos','Educação');
UPDATE categories SET pace = 'livre' WHERE is_preset = 1 AND name IN ('Lazer','Presentes','Roupas');

CREATE TABLE alerts (
  id           INTEGER PRIMARY KEY,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  month        TEXT NOT NULL,                       -- YYYY-MM
  level        TEXT NOT NULL CHECK (level IN ('ritmo','80','100')),
  spent_pct    INTEGER NOT NULL,                    -- at the moment it fired
  elapsed_pct  INTEGER NOT NULL,
  spent_cents  INTEGER NOT NULL,
  cap_cents    INTEGER NOT NULL,
  projected_cents INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  dismissed_at TEXT,
  dismissed_by INTEGER REFERENCES users(id),
  note         TEXT NOT NULL DEFAULT '',
  note_by      INTEGER REFERENCES users(id),
  note_at      TEXT,
  UNIQUE (category_id, month, level)
);
CREATE INDEX alerts_month ON alerts(month, dismissed_at);
