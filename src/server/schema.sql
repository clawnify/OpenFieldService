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
  asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
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

-- Auto-incrementing identifier counter
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- The counter and prefix rows are written by the app (ensureSeeded in
-- src/server/index.ts): a deploy applies this file as DDL only, so a seed
-- row here fails the whole build.

-- Example service types are seeded by the app on first request
-- (ensureSeeded in src/server/index.ts), never here: DDL only.

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

-- Example materials are seeded by the app on first request
-- (ensureSeeded in src/server/index.ts), never here: DDL only.

-- Optional equipment lifecycle: records are retained, equipment is retired rather than deleted.
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  access_instructions TEXT NOT NULL DEFAULT '',
  safety_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_sites_customer ON sites(customer_id, name);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  site_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  serial_number TEXT NOT NULL COLLATE NOCASE,
  manufacturer TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'in_service' CHECK(status IN ('in_service', 'out_of_service', 'retired')),
  installation_date TEXT NOT NULL DEFAULT '',
  commissioning_date TEXT NOT NULL DEFAULT '',
  warranty_start TEXT NOT NULL DEFAULT '',
  warranty_end TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(site_id, customer_id) REFERENCES sites(id, customer_id) ON DELETE RESTRICT,
  UNIQUE(customer_id, serial_number)
);
CREATE INDEX IF NOT EXISTS idx_assets_customer ON assets(customer_id, name);
CREATE INDEX IF NOT EXISTS idx_assets_site ON assets(site_id);
CREATE INDEX IF NOT EXISTS idx_jobs_asset ON jobs(asset_id);

-- History is captured in the same statement as a change. job_id is a logical
-- reference: the snapshot survives deletion or reassignment of the original job.
CREATE TABLE IF NOT EXISTS asset_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  job_id INTEGER,
  summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_asset_history_asset ON asset_history(asset_id, id);

CREATE TRIGGER IF NOT EXISTS asset_registered AFTER INSERT ON assets BEGIN
  INSERT INTO asset_history(asset_id, summary, details)
  VALUES (NEW.id, 'Equipment registered', NEW.name || ' · ' || NEW.serial_number || ' · ' || (SELECT name FROM sites WHERE id = NEW.site_id));
END;
CREATE TRIGGER IF NOT EXISTS asset_moved AFTER UPDATE OF site_id ON assets
WHEN OLD.site_id != NEW.site_id BEGIN
  INSERT INTO asset_history(asset_id, summary, details)
  VALUES (NEW.id, 'Site changed', (SELECT name FROM sites WHERE id = OLD.site_id) || ' → ' || (SELECT name FROM sites WHERE id = NEW.site_id));
END;
CREATE TRIGGER IF NOT EXISTS asset_status_changed AFTER UPDATE OF status ON assets
WHEN OLD.status != NEW.status BEGIN
  INSERT INTO asset_history(asset_id, summary, details)
  VALUES (NEW.id, 'Equipment status changed', OLD.status || ' → ' || NEW.status);
END;

-- Validate both writes so changing a job's customer cannot cross-link equipment.
CREATE TRIGGER IF NOT EXISTS job_asset_customer_insert BEFORE INSERT ON jobs
WHEN NEW.asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM assets WHERE id = NEW.asset_id AND customer_id = NEW.customer_id
) BEGIN SELECT RAISE(ABORT, 'Equipment must belong to the job customer'); END;
CREATE TRIGGER IF NOT EXISTS job_asset_customer_update BEFORE UPDATE OF asset_id, customer_id ON jobs
WHEN NEW.asset_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM assets WHERE id = NEW.asset_id AND customer_id = NEW.customer_id
) BEGIN SELECT RAISE(ABORT, 'Equipment must belong to the job customer'); END;

CREATE TRIGGER IF NOT EXISTS asset_job_created AFTER INSERT ON jobs
WHEN NEW.asset_id IS NOT NULL BEGIN
  INSERT INTO asset_history(asset_id, job_id, summary, details)
  VALUES (NEW.asset_id, NEW.id, NEW.identifier || ' linked', NEW.status || ' · ' || NEW.scheduled_date || ' · ' || COALESCE(NEW.notes, ''));
END;
CREATE TRIGGER IF NOT EXISTS asset_job_updated AFTER UPDATE ON jobs
WHEN NEW.asset_id IS NOT NULL AND (
  OLD.asset_id IS NOT NEW.asset_id OR OLD.status IS NOT NEW.status OR
  OLD.scheduled_date IS NOT NEW.scheduled_date OR OLD.notes IS NOT NEW.notes OR
  OLD.completion_notes IS NOT NEW.completion_notes
) BEGIN
  INSERT INTO asset_history(asset_id, job_id, summary, details)
  VALUES (NEW.asset_id, NEW.id, NEW.identifier || CASE WHEN OLD.asset_id IS NOT NEW.asset_id THEN ' linked' ELSE ' updated' END,
    NEW.status || ' · ' || NEW.scheduled_date || ' · ' || COALESCE(NEW.notes, '') || ' ' || COALESCE(NEW.completion_notes, ''));
END;
CREATE TRIGGER IF NOT EXISTS asset_job_unlinked AFTER UPDATE OF asset_id ON jobs
WHEN OLD.asset_id IS NOT NULL AND OLD.asset_id IS NOT NEW.asset_id BEGIN
  INSERT INTO asset_history(asset_id, job_id, summary, details)
  VALUES (OLD.asset_id, OLD.id, OLD.identifier || ' unlinked', OLD.status || ' · ' || OLD.scheduled_date || ' · ' || COALESCE(OLD.notes, '') || ' ' || COALESCE(OLD.completion_notes, ''));
END;
CREATE TRIGGER IF NOT EXISTS asset_job_deleted BEFORE DELETE ON jobs
WHEN OLD.asset_id IS NOT NULL BEGIN
  INSERT INTO asset_history(asset_id, job_id, summary, details)
  VALUES (OLD.asset_id, OLD.id, OLD.identifier || ' deleted', OLD.status || ' · ' || OLD.scheduled_date || ' · ' || COALESCE(OLD.notes, '') || ' ' || COALESCE(OLD.completion_notes, ''));
END;
CREATE TRIGGER IF NOT EXISTS asset_job_note AFTER INSERT ON job_notes
WHEN (SELECT asset_id FROM jobs WHERE id = NEW.job_id) IS NOT NULL BEGIN
  INSERT INTO asset_history(asset_id, job_id, summary, details)
  SELECT asset_id, id, identifier || ' note added', NEW.content FROM jobs WHERE id = NEW.job_id;
END;
