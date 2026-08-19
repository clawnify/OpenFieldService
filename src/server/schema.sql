-- HISTORICAL BASELINE — kept as a human-readable snapshot of the schema as of
-- migrations/0001_baseline.sql. Schema changes are no longer made here: they go in
-- new numbered files under migrations/, applied via
-- `wrangler d1 migrations apply open-fieldservice-db --local` (see package.json "dev").
-- Editing this file has no effect on any database.

-- Customers
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  zip TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Technicians (field workers)
CREATE TABLE IF NOT EXISTS technicians (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  color TEXT NOT NULL DEFAULT '#16a34a',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Service types (configurable per vertical)
CREATE TABLE IF NOT EXISTS service_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  default_duration INTEGER NOT NULL DEFAULT 60,
  default_price REAL NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#6b7280',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Jobs (scheduled service visits)
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  technician_id INTEGER REFERENCES technicians(id) ON DELETE SET NULL,
  service_type_id INTEGER REFERENCES service_types(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  priority TEXT NOT NULL DEFAULT 'normal',
  scheduled_date TEXT NOT NULL DEFAULT (date('now')),
  scheduled_time TEXT DEFAULT '09:00',
  duration INTEGER NOT NULL DEFAULT 60,
  price REAL NOT NULL DEFAULT 0,
  address TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  completion_notes TEXT DEFAULT '',
  is_recurring INTEGER NOT NULL DEFAULT 0,
  recurrence_interval TEXT DEFAULT '',
  next_recurrence_date TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Job history / activity log
CREATE TABLE IF NOT EXISTS job_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Checklist items per job (inspection forms, task lists)
CREATE TABLE IF NOT EXISTS job_checklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Materials / inventory used on jobs
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'ea',
  unit_cost REAL NOT NULL DEFAULT 0,
  in_stock REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  quantity REAL NOT NULL DEFAULT 1,
  unit_cost REAL NOT NULL DEFAULT 0
);

-- Invoices
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  subtotal REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  due_date TEXT DEFAULT '',
  paid_date TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0
);

-- Users (authentication and administration)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Sessions (server-side session tokens backing the auth cookie)
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Default administrator account, seeded once so the app is reachable on first run.
-- Email: admin@fieldscheduler.local   Password: ChangeMe123!
-- Change this password immediately after first login (Change My Password in the dashboard).
INSERT OR IGNORE INTO users (id, name, email, password_hash, role, active)
VALUES (1, 'Administrator', 'admin@fieldscheduler.local', 'pbkdf2$100000$MRKZi18lsdnQ4dUqDaT2Bw$-oGMJCsCbFbs4tCQ7fVtK8MU2Jzco8_tV3X2DNAHftA', 'admin', 1);

-- Google Calendar connection, one per Field Scheduler user (each user has their own).
-- Tokens are AES-GCM encrypted at rest (see src/server/crypto.ts); never selected
-- into API responses in plaintext form.
CREATE TABLE IF NOT EXISTS calendar_integrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'google',
  google_account_email TEXT NOT NULL DEFAULT '',
  google_calendar_id TEXT NOT NULL DEFAULT 'primary',
  google_calendar_summary TEXT NOT NULL DEFAULT 'Primary Calendar',
  access_token_encrypted TEXT NOT NULL DEFAULT '',
  refresh_token_encrypted TEXT NOT NULL DEFAULT '',
  token_expires_at TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  sync_enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'connected',
  connected_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Short-lived CSRF nonce for the OAuth redirect round-trip; rows are deleted as
-- soon as the callback consumes them (or ignored/expired otherwise).
CREATE TABLE IF NOT EXISTS calendar_oauth_states (
  state TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  return_origin TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Maps a Field Scheduler job to the Google Calendar event synced for it, per user
-- (each connected user gets their own event for the same job). The unique
-- constraint is what prevents duplicate events on repeated syncs/updates.
CREATE TABLE IF NOT EXISTS calendar_event_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'google',
  calendar_id TEXT NOT NULL DEFAULT '',
  external_event_id TEXT NOT NULL DEFAULT '',
  last_synced_at TEXT,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  sync_error TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_integrations_user ON calendar_integrations(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_oauth_states_user ON calendar_oauth_states(user_id);
CREATE INDEX IF NOT EXISTS idx_event_mappings_user ON calendar_event_mappings(user_id);
CREATE INDEX IF NOT EXISTS idx_event_mappings_job ON calendar_event_mappings(job_id);

-- Auto-incrementing identifier counter
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO _meta (key, value) VALUES ('job_counter', '0');
INSERT OR IGNORE INTO _meta (key, value) VALUES ('identifier_prefix', 'JOB');
INSERT OR IGNORE INTO _meta (key, value) VALUES ('invoice_counter', '0');
INSERT OR IGNORE INTO _meta (key, value) VALUES ('invoice_prefix', 'INV');
-- IANA timezone used when building Google Calendar events from job date/time,
-- so wall-clock times don't shift when viewed in another timezone. No timezone
-- setting existed before this integration; change it for your business's locale.
INSERT OR IGNORE INTO _meta (key, value) VALUES ('timezone', 'UTC');

-- Example service types (users customize for their vertical)
INSERT OR IGNORE INTO service_types (id, name, description, default_duration, default_price, color)
VALUES
  (1, 'Standard Service', 'Standard service visit', 60, 150, '#16a34a'),
  (2, 'Inspection', 'On-site inspection and assessment', 45, 75, '#0891b2'),
  (3, 'Emergency', 'Urgent same-day service call', 90, 300, '#dc2626'),
  (4, 'Follow-up', 'Follow-up visit after initial service', 30, 50, '#9333ea'),
  (5, 'Installation', 'Equipment or system installation', 120, 400, '#ea580c'),
  (6, 'Maintenance', 'Routine maintenance visit', 60, 125, '#ca8a04');

CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_technician ON jobs(technician_id);
CREATE INDEX IF NOT EXISTS idx_jobs_service_type ON jobs(service_type_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_date ON jobs(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_job_notes_job ON job_notes(job_id);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
CREATE INDEX IF NOT EXISTS idx_job_checklist_job ON job_checklist(job_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_job ON job_materials(job_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_job ON invoices(job_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);

-- Example materials
INSERT OR IGNORE INTO materials (id, name, unit, unit_cost, in_stock)
VALUES
  (1, 'Service Fee', 'ea', 0, 999),
  (2, 'Filter Replacement', 'ea', 25, 50),
  (3, 'Sealant', 'tube', 12, 30),
  (4, 'Travel Surcharge', 'ea', 35, 999),
  (5, 'Disposable Supplies', 'kit', 8, 100);
