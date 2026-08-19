-- Migration number: 0012 	 2026-08-19T22:00:00.000Z
--
-- Promotes the previously-hidden `_meta.timezone` value into the existing
-- versioned Global Settings architecture (migrations/0002) as
-- `BUSINESS_TIMEZONE`, closing the fresh-environment risk documented in
-- mem:risks/google-calendar-timezone-default: a brand-new database used to
-- silently default every Google Calendar sync (and the notification
-- day-before reminder) to UTC, with no admin-facing way to change it short
-- of a hidden manual SQL UPDATE against `_meta`.
--
-- This is the first migration in this codebase to pre-seed a
-- `global_settings` row (every other setting — CleanBC/BC Hydro thresholds,
-- referral sources, heating sources — is only ever created at runtime
-- through the admin UI/API). That's a deliberate, narrow exception: this
-- specific setting's whole purpose is to guarantee a safe value exists
-- BEFORE any admin ever opens Global Settings, which an API-only setting
-- cannot do.
--
-- Backfill logic: if `_meta.timezone` already holds a real, non-UTC value
-- (i.e. an operator already ran the old manual-SQL workaround this
-- migration replaces), that value is carried forward so no one's already-
-- correct configuration is silently overwritten. Otherwise (still at the
-- 'UTC' seed default, or somehow absent) this seeds this business's actual
-- current timezone directly, per this task's own explicit instruction —
-- never a placeholder, never UTC.
--
-- `_meta.timezone` itself is left completely untouched by this migration
-- (no UPDATE, no DELETE) — it remains only as a read-only backward-
-- compatibility fallback in `src/server/business-timezone.ts`'s shared
-- resolver, for a database that hasn't run this migration yet. No current
-- code path writes to it anymore.
--
-- Idempotent: the WHERE NOT EXISTS guard means re-applying this migration
-- (or a test harness that reapplies all migrations fresh) never inserts a
-- second BUSINESS_TIMEZONE row — global_settings has no UNIQUE(key)
-- constraint (by design: multiple historical versions of the same key
-- coexist), so `INSERT OR IGNORE` would not have guarded this correctly.
INSERT INTO global_settings (key, value, data_type, category, description, effective_from, updated_by)
SELECT
  'BUSINESS_TIMEZONE',
  COALESCE(
    (SELECT value FROM _meta WHERE key = 'timezone' AND value IS NOT NULL AND value != '' AND value != 'UTC'),
    'America/Vancouver'
  ),
  'string',
  'business_operations',
  'Default timezone used for scheduling, Google Calendar sync, reminders, and other time-based operations.',
  datetime('now'),
  NULL
WHERE NOT EXISTS (SELECT 1 FROM global_settings WHERE key = 'BUSINESS_TIMEZONE');
