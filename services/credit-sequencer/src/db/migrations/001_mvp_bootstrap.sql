-- Up Migration

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  agent_pub_key TEXT,
  signature_scheme TEXT,
  balance_micros NUMERIC NOT NULL DEFAULT 0,
  next_agent_nonce BIGINT NOT NULL DEFAULT 0,
  credited_micros NUMERIC NOT NULL DEFAULT 0,
  debited_outstanding_micros NUMERIC NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  request_id TEXT PRIMARY KEY,
  intent_hash TEXT NOT NULL,
  auth_id TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS authorizations (
  auth_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_nonce BIGINT NOT NULL,
  amount_micros BIGINT NOT NULL CHECK (amount_micros > 0),
  merchant_id TEXT NOT NULL,
  chain_ref TEXT NOT NULL,
  issued_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  execution_grace_until BIGINT NOT NULL CHECK (execution_grace_until >= expires_at),
  log_seq_no BIGINT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ISSUED', 'EXECUTED', 'RECLAIMED')),
  reclaimed_at BIGINT,
  executed_at BIGINT,
  sequencer_key_id TEXT NOT NULL,
  sequencer_sig TEXT NOT NULL,
  authorization_json JSONB NOT NULL,
  UNIQUE(agent_id, agent_nonce)
);

CREATE TABLE IF NOT EXISTS executions (
  auth_id TEXT PRIMARY KEY,
  chain_ref TEXT NOT NULL,
  execution_tx_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  relayer_key_id TEXT,
  reported_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS relayer_keys (
  chain_ref TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (chain_ref, key_id)
);

CREATE TABLE IF NOT EXISTS execution_attempts (
  auth_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  reporter_key_id TEXT NOT NULL,
  reported_at BIGINT NOT NULL,
  report_sig TEXT NOT NULL,
  PRIMARY KEY (report_id)
);

CREATE TABLE IF NOT EXISTS auth_leaves (
  log_seq_no BIGINT PRIMARY KEY,
  auth_id TEXT UNIQUE NOT NULL,
  prev_leaf_hash TEXT NOT NULL,
  leaf_hash TEXT NOT NULL,
  epoch_id BIGINT
);

CREATE TABLE IF NOT EXISTS commitments (
  epoch_id BIGINT PRIMARY KEY,
  root TEXT NOT NULL,
  count INTEGER NOT NULL,
  prev_root TEXT NOT NULL,
  sequencer_key_id TEXT NOT NULL,
  posted_tx_hash TEXT,
  posted_at BIGINT
);

CREATE TABLE IF NOT EXISTS sequencer_counters (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
  log_seq_no BIGINT NOT NULL,
  last_leaf_hash TEXT NOT NULL,
  last_epoch_id BIGINT NOT NULL,
  last_root TEXT NOT NULL
);

INSERT INTO sequencer_counters(singleton, log_seq_no, last_leaf_hash, last_epoch_id, last_root)
VALUES (TRUE, 0, '0x0000000000000000000000000000000000000000000000000000000000000000', 0, '0x0000000000000000000000000000000000000000000000000000000000000000')
ON CONFLICT (singleton) DO NOTHING;

-- Down Migration

DROP TABLE IF EXISTS sequencer_counters;
DROP TABLE IF EXISTS commitments;
DROP TABLE IF EXISTS auth_leaves;
DROP TABLE IF EXISTS execution_attempts;
DROP TABLE IF EXISTS relayer_keys;
DROP TABLE IF EXISTS executions;
DROP TABLE IF EXISTS authorizations;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS agents;
