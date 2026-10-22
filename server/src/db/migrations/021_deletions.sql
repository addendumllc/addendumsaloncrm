-- Deleted automatic follow-ups: their rule key is remembered so the same follow-up isn't created again.
CREATE TABLE deleted_task_keys (
  dedupe_key TEXT PRIMARY KEY,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
