-- ChamaPay schema — SQLite (portable) with a clean upgrade path to Postgres.
-- Every money column is stored in integer cents (KES cents) to avoid FP drift.
-- Every money-moving row is indexed by Daraja TransactionID for idempotency.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  msisdn        TEXT NOT NULL UNIQUE,            -- E.164, e.g. +254712345678
  email         TEXT UNIQUE,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',  -- member | treasurer | chair | admin
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chamas (
  id                     TEXT PRIMARY KEY,
  code                   TEXT NOT NULL UNIQUE,           -- short slug for account reference, e.g. ACME
  name                   TEXT NOT NULL,
  paybill                TEXT NOT NULL,                  -- Daraja shortcode
  account_ref_prefix     TEXT NOT NULL,                  -- what we expect in C2B BillRefNumber
  contribution_cents     INTEGER NOT NULL DEFAULT 0,     -- expected per-cycle amount
  cycle                  TEXT NOT NULL DEFAULT 'monthly',-- monthly | weekly | custom
  late_fee_cents         INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memberships (
  id            TEXT PRIMARY KEY,
  chama_id      TEXT NOT NULL REFERENCES chamas(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member',
  joined_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chama_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_chama ON memberships(chama_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user  ON memberships(user_id);

CREATE TABLE IF NOT EXISTS contribution_cycles (
  id            TEXT PRIMARY KEY,
  chama_id      TEXT NOT NULL REFERENCES chamas(id) ON DELETE CASCADE,
  period        TEXT NOT NULL,                   -- e.g. 2026-04 or 2026-W17
  opens_at      TEXT NOT NULL,
  closes_at     TEXT NOT NULL,
  expected_cents INTEGER NOT NULL,
  UNIQUE(chama_id, period)
);

CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,
  source            TEXT NOT NULL,              -- mpesa_c2b | mpesa_stk | mpesa_b2c | manual
  direction         TEXT NOT NULL,              -- credit | debit
  status            TEXT NOT NULL,              -- pending | matched | unmatched | reversed
  msisdn            TEXT,                       -- payer MSISDN (credit) or recipient (debit)
  amount_cents      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'KES',
  daraja_receipt    TEXT UNIQUE,                -- e.g. RFS7XYZ123 — canonical idempotency key
  daraja_merchant_request_id TEXT,
  daraja_checkout_request_id TEXT,
  account_ref       TEXT,                       -- BillRefNumber from C2B, or our generated one for STK
  transaction_desc  TEXT,
  raw_payload       TEXT NOT NULL,              -- full JSON from Daraja for audit
  chama_id          TEXT REFERENCES chamas(id),
  user_id           TEXT REFERENCES users(id),
  cycle_id          TEXT REFERENCES contribution_cycles(id),
  match_confidence  REAL,                       -- 0.0 – 1.0
  match_reason      TEXT,
  reviewed_by       TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_daraja_receipt ON payments(daraja_receipt);
CREATE INDEX IF NOT EXISTS idx_payments_chama ON payments(chama_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_msisdn ON payments(msisdn);

-- An append-only ledger. Every row is one double-entry line. Payments produce 2+ ledger entries.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id              TEXT PRIMARY KEY,
  chama_id        TEXT NOT NULL REFERENCES chamas(id) ON DELETE CASCADE,
  payment_id      TEXT REFERENCES payments(id),
  account         TEXT NOT NULL,                -- e.g. member:<uid>, chama:cash, loan:<loan_id>
  direction       TEXT NOT NULL,                -- debit | credit
  amount_cents    INTEGER NOT NULL,
  memo            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_chama ON ledger_entries(chama_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account);
CREATE INDEX IF NOT EXISTS idx_ledger_payment ON ledger_entries(payment_id);

CREATE TABLE IF NOT EXISTS loans (
  id                TEXT PRIMARY KEY,
  chama_id          TEXT NOT NULL REFERENCES chamas(id) ON DELETE CASCADE,
  borrower_id       TEXT NOT NULL REFERENCES users(id),
  principal_cents   INTEGER NOT NULL,
  interest_bps      INTEGER NOT NULL DEFAULT 0, -- basis points (100 = 1%)
  term_months       INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'requested', -- requested|approved|disbursed|repaying|settled|defaulted
  disbursed_at      TEXT,
  due_at            TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loans_chama ON loans(chama_id);
CREATE INDEX IF NOT EXISTS idx_loans_borrower ON loans(borrower_id);

CREATE TABLE IF NOT EXISTS daraja_callbacks (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,                  -- c2b_validation | c2b_confirmation | stk_callback | b2c_result | timeout
  received_at   TEXT NOT NULL DEFAULT (datetime('now')),
  payload       TEXT NOT NULL,                  -- raw JSON
  http_headers  TEXT,                           -- raw JSON
  processed     INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_daraja_callbacks_kind ON daraja_callbacks(kind);
CREATE INDEX IF NOT EXISTS idx_daraja_callbacks_processed ON daraja_callbacks(processed);

CREATE TABLE IF NOT EXISTS sms_outbox (
  id            TEXT PRIMARY KEY,
  msisdn        TEXT NOT NULL,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued', -- queued | sent | failed
  provider_id   TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sms_outbox_status ON sms_outbox(status);

CREATE TABLE IF NOT EXISTS anchors (
  id            TEXT PRIMARY KEY,
  chama_id      TEXT REFERENCES chamas(id),
  period        TEXT NOT NULL,                  -- which date-range this root covers
  merkle_root   TEXT NOT NULL,
  tx_hash       TEXT,                           -- on-chain tx hash
  chain_id      INTEGER,
  contract_address TEXT,
  payment_ids   TEXT NOT NULL,                  -- JSON array of payment ids in this anchor
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_anchors_chama ON anchors(chama_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  actor         TEXT,                           -- user id or 'system'
  action        TEXT NOT NULL,
  subject_type  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  metadata      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_log(subject_type, subject_id);
