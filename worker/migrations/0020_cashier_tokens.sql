-- A cashier's PIN sign-in, remembered by the server (2026-11-23). (Marked { added: 20 } in src/schema.js.)
-- When a PIN is right, the server hands the cashier device a random token (only its hash is kept here),
-- tied to the employee, the pharmacy and the signed-in account, for 7 days. Receipts and returns then
-- carry it, so the server knows the cashier on a receipt really typed their PIN on that device; a receipt
-- without it is still taken and marked for the owner to look at. Additive: older app builds keep working.
--
-- Rollback (only if needed; nothing else depends on it):
--   DROP TABLE IF EXISTS cashier_tokens;
CREATE TABLE IF NOT EXISTS cashier_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cashier_tokens_employee_id ON cashier_tokens (employee_id);
CREATE INDEX IF NOT EXISTS ix_cashier_tokens_expires_at ON cashier_tokens (expires_at);
