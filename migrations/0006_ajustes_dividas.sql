-- Balance adjustments and debts.

-- A category flagged `ajuste` corrects the balance when the app disagrees with the cash on hand:
-- its entries count in the balances but stay out of charts, planning, alerts and reports.
ALTER TABLE categories ADD COLUMN ajuste INTEGER NOT NULL DEFAULT 0 CHECK (ajuste IN (0, 1));

-- Every existing núcleo gets one in and one out (new núcleos get them from src/presets.ts).
INSERT INTO categories (nucleo_id, name, kind, icon, color, is_preset, sort, pace, ajuste)
SELECT id, 'Ajuste de saldo', 'out', 'scales', '#8d8872', 1, 99, 'livre', 1 FROM nucleos;
INSERT INTO categories (nucleo_id, name, kind, icon, color, is_preset, sort, pace, ajuste)
SELECT id, 'Ajuste de saldo', 'in', 'scales', '#8d8872', 1, 99, 'livre', 1 FROM nucleos;

-- Main debts of a núcleo. The balance is updated by hand (nothing deducts it automatically);
-- `updated_at` says how fresh it is. Money is integer centavos; interest is basis points per month
-- (1,99 % a.m. = 199), NULL when unknown.
CREATE TABLE debts (
  id                INTEGER PRIMARY KEY,
  nucleo_id         INTEGER NOT NULL REFERENCES nucleos(id),
  name              TEXT NOT NULL,
  creditor          TEXT NOT NULL DEFAULT '',
  balance_cents     INTEGER NOT NULL CHECK (balance_cents >= 0),
  installment_cents INTEGER NOT NULL DEFAULT 0 CHECK (installment_cents >= 0),
  due_day           INTEGER CHECK (due_day BETWEEN 1 AND 31),
  interest_bp       INTEGER CHECK (interest_bp >= 0),
  note              TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX debts_nucleo ON debts(nucleo_id);
