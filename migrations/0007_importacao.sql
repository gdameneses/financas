-- Statement import (Mais → Importar extrato).

-- A transaction that came from (or was matched to) a statement row remembers the row's fingerprint,
-- so the same row is never offered twice, and the counterparty as the bank spells it, so the next
-- row from the same place gets the same category and name suggested.
ALTER TABLE transactions ADD COLUMN import_ref TEXT;
ALTER TABLE transactions ADD COLUMN import_desc TEXT;
CREATE INDEX transactions_import_ref ON transactions(nucleo_id, import_ref);

-- Statement rows somebody looked at and chose not to import. They stay out of the next import.
CREATE TABLE import_ignored (
  nucleo_id  INTEGER NOT NULL REFERENCES nucleos(id) ON DELETE CASCADE,
  ref        TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (nucleo_id, ref)
);

-- Account holders of the núcleo, as banks print them (upper case, no accents). A transfer to or
-- from one of these names is money moving between the núcleo's own accounts: not an entry.
CREATE TABLE nucleo_titulares (
  nucleo_id  INTEGER NOT NULL REFERENCES nucleos(id) ON DELETE CASCADE,
  nome       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (nucleo_id, nome)
);
