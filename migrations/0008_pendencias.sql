-- Pendências: statement rows nobody can place yet (a Pix with no recipient on the statement, a card
-- bill, an unknown merchant). They wait here until someone says what they were, then become an
-- entry, a transfer between the núcleo's own accounts, or are left out.
CREATE TABLE pendencias (
  id                   INTEGER PRIMARY KEY,
  nucleo_id            INTEGER NOT NULL REFERENCES nucleos(id) ON DELETE CASCADE,
  conta                TEXT NOT NULL,
  date                 TEXT NOT NULL,
  hora                 TEXT NOT NULL DEFAULT '',
  amount_cents         INTEGER NOT NULL CHECK (amount_cents > 0),
  kind                 TEXT NOT NULL CHECK (kind IN ('in','out')),
  descricao            TEXT NOT NULL,
  -- the statement row's fingerprint (same as transactions.import_ref), when it has one
  ref                  TEXT,
  sugestao_payee       TEXT NOT NULL DEFAULT '',
  sugestao_category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','lancada','interna','ignorada')),
  -- free text: "where did it go / where did it come from"
  resposta             TEXT NOT NULL DEFAULT '',
  -- the entry this page created, so reopening can remove exactly that one
  transaction_id       INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  resolved_by          INTEGER REFERENCES users(id),
  resolved_at          TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX pendencias_ref ON pendencias(nucleo_id, ref) WHERE ref IS NOT NULL;
CREATE INDEX pendencias_status ON pendencias(nucleo_id, status, date);
