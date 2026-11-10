// Applied idempotently on API and worker startup (see migrate() in db.ts).
export const SCHEMA = /* sql */ `
-- Serializes concurrent startups (API and worker both migrate); runs as one implicit transaction.
SELECT pg_advisory_xact_lock(4242);

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS runs (
  id          text PRIMARY KEY,
  prompt      text NOT NULL,
  model       text NOT NULL,
  status      text NOT NULL DEFAULT 'queued',
  output      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Append-only step log; SSE streams it by id.
CREATE TABLE IF NOT EXISTS run_events (
  id          bigserial PRIMARY KEY,
  run_id      text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type        text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  -- workflow run + activity id (+ attempt): makes retried activities append each event once
  dedup_key   text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_events_run_id_id ON run_events (run_id, id);

-- One row per LLM attempt (retries cost money too, so each attempt is billed).
CREATE TABLE IF NOT EXISTS llm_calls (
  run_id              text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step                int  NOT NULL,
  attempt             int  NOT NULL,
  model               text NOT NULL,
  input_tokens        int  NOT NULL,
  output_tokens       int  NOT NULL,
  cache_read_tokens   int  NOT NULL DEFAULT 0,
  cache_write_tokens  int  NOT NULL DEFAULT 0,
  cost_usd            numeric(14, 8) NOT NULL,
  latency_ms          int  NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step, attempt)
);

-- Idempotency ledger: the first completed result for a key wins and is replayed on retries.
CREATE TABLE IF NOT EXISTS tool_executions (
  idempotency_key  text PRIMARY KEY,
  run_id           text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool             text NOT NULL,
  input            jsonb NOT NULL,
  output           text NOT NULL,
  is_error         boolean NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memories (
  id               bigserial PRIMARY KEY,
  idempotency_key  text UNIQUE,
  text             text NOT NULL,
  embedding        vector(256) NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Demo dataset for the read-only SQL tool.
CREATE SCHEMA IF NOT EXISTS demo;
CREATE TABLE IF NOT EXISTS demo.customers (
  id       int PRIMARY KEY,
  name     text NOT NULL,
  country  text NOT NULL
);
CREATE TABLE IF NOT EXISTS demo.orders (
  id           int PRIMARY KEY,
  customer_id  int NOT NULL REFERENCES demo.customers(id),
  amount_usd   numeric(10, 2) NOT NULL,
  created_at   date NOT NULL
);
INSERT INTO demo.customers VALUES
  (1, 'Acme Corp', 'US'), (2, 'Globex', 'DE'), (3, 'Initech', 'US'), (4, 'Umbrella', 'UK')
ON CONFLICT DO NOTHING;
INSERT INTO demo.orders VALUES
  (1, 1, 1200.00, '2026-09-01'), (2, 1, 450.50, '2026-09-15'), (3, 2, 980.00, '2026-09-20'),
  (4, 3, 75.25, '2026-10-02'), (5, 4, 3100.00, '2026-10-05'), (6, 2, 640.00, '2026-10-11')
ON CONFLICT DO NOTHING;
`;
