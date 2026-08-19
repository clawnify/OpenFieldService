-- Migration number: 0002 	 2026-08-17T17:44:00.000Z
--
-- FSM upgrade, Phase 1 (Foundation):
--   * RBAC grows from admin/staff to admin/dispatcher/technician
--   * technicians can now be linked to a login (users.id) so a technician can
--     eventually sign in and see only their own jobs (Phase 8)
--   * global_settings: versioned, effective-dated configuration store so future
--     phases (rebate thresholds, eligibility warning windows, etc.) never need a
--     code deploy to change a government-defined number, and historical jobs can
--     still resolve the rule that was active when their eligibility was evaluated

-- Existing "staff" accounts become "dispatcher" — the new role name for the same
-- day-to-day scheduling/jobs/customers/invoices capability set. No user loses access.
UPDATE users SET role = 'dispatcher' WHERE role = 'staff';

-- Nullable, optional: most technicians will never log in (dispatcher manages them as
-- a lookup, same as today). Only technicians who need the mobile flow (Phase 8) get
-- a linked user account with role = 'technician'.
ALTER TABLE technicians ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- One technician profile per login (and vice versa) — partial index so multiple
-- technicians can still share the common NULL (not-linked) state.
CREATE UNIQUE INDEX IF NOT EXISTS idx_technicians_user ON technicians(user_id) WHERE user_id IS NOT NULL;

-- Global, versioned configuration. A "change" is a new row, not an UPDATE of the
-- current one — see src/server/settings.ts for the resolution logic (current value
-- vs. value as of a given date). This is what lets admins change CleanBC/BC Hydro
-- thresholds without a deploy, while jobs whose eligibility was already evaluated
-- keep the rule that applied to them at the time.
CREATE TABLE IF NOT EXISTS global_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  data_type TEXT NOT NULL DEFAULT 'string',
  category TEXT NOT NULL DEFAULT 'general',
  description TEXT NOT NULL DEFAULT '',
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  effective_until TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_global_settings_key ON global_settings(key);
CREATE INDEX IF NOT EXISTS idx_global_settings_key_effective ON global_settings(key, effective_from);
