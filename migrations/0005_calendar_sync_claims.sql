-- Migration number: 0005 	 2026-08-17T20:00:00.000Z
--
-- P0 fix: Google Calendar sync idempotency/concurrency (see Serena memory
-- risks/google-calendar-sync-race for the full investigation this closes).
--
-- calendar_sync_claims is a lightweight D1-only mutual-exclusion primitive:
-- syncJobForUser() claims (user_id, job_id) via a plain INSERT before doing
-- anything else (a single D1 INSERT against a PRIMARY KEY is atomic — of two
-- concurrent INSERTs for the same pair, exactly one succeeds) and releases it
-- (DELETE) when done. A second concurrent sync for the same pair sees the
-- INSERT fail, treats that as "another sync is already in flight," and skips
-- rather than proceeding — this is what stops two requests from both reaching
-- the "no mapping yet, create a new Google event" branch at once.
--
-- claimed_at exists so a request that crashes/times out mid-sync (never
-- reaching the release) doesn't permanently wedge all future syncs for that
-- job — a claim older than the staleness window (see calendar-sync.ts) is
-- treated as abandoned and can be stolen.
--
-- This is defense in depth, not the primary fix — the primary fix is the
-- deterministic Google event ID (see google-calendar.ts), which protects
-- against duplicate *Google-side* events even if this table were somehow
-- bypassed. Per explicit instruction: do not rely on this lock alone.

CREATE TABLE IF NOT EXISTS calendar_sync_claims (
  user_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, job_id)
);
