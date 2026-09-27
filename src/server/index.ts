import { createApp, createRoute, z } from "@clawnify/app";
import type { DBEnv } from "@clawnify/db";
import { query, get, run } from "./db.js";
import { equipmentApp } from "./equipment.js";

type Env = { Bindings: DBEnv };

const app = createApp<Env>({
  title: "OpenFieldService",
  version: "1.0.0",
  description:
    "Field service scheduling and business management with customers, technicians, service types, and job tracking.",
});

let uuidReady = false;
app.use("*", async (c, next) => {
  if (!uuidReady) {
    const column = await get<{ type: string }>("SELECT type FROM pragma_table_info('customers') WHERE name = 'id'");
    if (column?.type !== "TEXT") return c.json({ error: "Database upgrade required: back up the database and apply the UUID migration before using this version." }, 503);
    uuidReady = true;
  }
  await ensureSeeded();
  await next();
});

app.route("/", equipmentApp);

// ── First-run data ─────────────────────────────────────────────────
// A deploy applies `schema.sql` as DDL only — a seed INSERT there fails the
// whole build — so the counters and the example rows are written here, once,
// while their tables are still empty. A re-deploy never resurrects a row the
// user deleted, because the table is no longer empty.

const META_DEFAULTS: Array<[string, string]> = [
  ["job_counter", "0"],
  ["identifier_prefix", "JOB"],
  ["invoice_counter", "0"],
  ["invoice_prefix", "INV"],
];

/** id, name, description, default_duration, default_price, color */
const DEMO_SERVICE_TYPES: Array<[string, string, string, number, number, string]> = [
  ["5a0a7cf3-6450-4c09-aed2-3e0cf4c6e4ba", "Standard Service", "Standard service visit", 60, 150, "#16a34a"],
  ["7bdeae08-1581-4054-b7e2-10cfac6ace0a", "Inspection", "On-site inspection and assessment", 45, 75, "#0891b2"],
  ["65cfd387-d2a4-4d08-bf51-69e9d4b4e3c0", "Emergency", "Urgent same-day service call", 90, 300, "#dc2626"],
  ["1816835c-6e27-4cfe-a0bf-c9f634e10e0c", "Follow-up", "Follow-up visit after initial service", 30, 50, "#9333ea"],
  ["c5602a3e-5407-40a7-8f05-adbfb9838ebd", "Installation", "Equipment or system installation", 120, 400, "#ea580c"],
  ["eea3c561-5658-4195-bd61-a678c5113ca3", "Maintenance", "Routine maintenance visit", 60, 125, "#ca8a04"],
];

/** id, name, unit, unit_cost, in_stock */
const DEMO_MATERIALS: Array<[string, string, string, number, number]> = [
  ["4d7b2e93-24ed-4230-b56f-c7bbced6993d", "Service Fee", "ea", 0, 999],
  ["c0e9d6ae-cac3-4b10-955e-fb0c9f459f1e", "Filter Replacement", "ea", 25, 50],
  ["7fafaeef-2f0b-4706-8185-a88786aeff5b", "Sealant", "tube", 12, 30],
  ["9c14838e-2289-4dc6-a9a1-3f27f23d2ddf", "Travel Surcharge", "ea", 35, 999],
  ["278ff03f-8d20-4e0e-ba7c-93da37fdff60", "Disposable Supplies", "kit", 8, 100],
];

let seeded = false; // per-isolate fast path; the COUNT re-checks are cheap

async function ensureSeeded(): Promise<void> {
  if (seeded) return;
  seeded = true;
  try {
    // Load-bearing, not sample data: the job and invoice numbering depends on
    // these rows existing, so they are restored even on a populated database.
    for (const [key, value] of META_DEFAULTS) {
      await run("INSERT OR IGNORE INTO _meta (key, value) VALUES (?, ?)", [key, value]);
    }

    const serviceTypes = await get<{ n: number }>("SELECT COUNT(*) AS n FROM service_types");
    if ((serviceTypes?.n ?? 0) === 0) {
      for (const st of DEMO_SERVICE_TYPES) {
        await run(
          "INSERT OR IGNORE INTO service_types (id, name, description, default_duration, default_price, color) VALUES (?, ?, ?, ?, ?, ?)",
          st,
        );
      }
    }

    const materials = await get<{ n: number }>("SELECT COUNT(*) AS n FROM materials");
    if ((materials?.n ?? 0) === 0) {
      for (const m of DEMO_MATERIALS) {
        await run(
          "INSERT OR IGNORE INTO materials (id, name, unit, unit_cost, in_stock) VALUES (?, ?, ?, ?, ?)",
          m,
        );
      }
    }
  } catch {
    // A cold database mid-migration, or a table this build has not created
    // yet: the next request retries. Never fail a request over sample data.
    seeded = false;
  }
}

// ── Shared Schemas ─────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const OkSchema = z.object({ ok: z.boolean() }).openapi("Ok");

const CustomerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  address: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  notes: z.string(),
  job_count: z.number().int().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Customer");

const TechnicianSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  color: z.string(),
  active: z.number().int(),
  job_count: z.number().int().optional(),
  created_at: z.string(),
}).openapi("Technician");

const ServiceTypeSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  default_duration: z.number().int(),
  default_price: z.number(),
  color: z.string(),
  created_at: z.string(),
}).openapi("ServiceType");

const JobNoteSchema = z.object({
  id: z.string().uuid(),
  job_id: z.string().uuid(),
  content: z.string(),
  created_at: z.string(),
}).openapi("JobNote");

const JobSchema = z.object({
  id: z.string().uuid(),
  identifier: z.string(),
  customer_id: z.string().uuid(),
  asset_id: z.string().uuid().nullable(),
  technician_id: z.string().uuid().nullable(),
  service_type_id: z.string().uuid().nullable(),
  status: z.string(),
  priority: z.string(),
  scheduled_date: z.string(),
  scheduled_time: z.string(),
  duration: z.number().int(),
  price: z.number(),
  address: z.string(),
  notes: z.string(),
  completion_notes: z.string(),
  is_recurring: z.number().int(),
  recurrence_interval: z.string(),
  next_recurrence_date: z.string(),
  customer_name: z.string().optional(),
  customer_phone: z.string().optional(),
  technician_name: z.string().nullable().optional(),
  technician_color: z.string().nullable().optional(),
  service_type_name: z.string().nullable().optional(),
  service_type_color: z.string().nullable().optional(),
  customer_job_count: z.number().int().optional(),
  customer_lifetime_revenue: z.number().optional(),
  customer_last_service_id: z.string().uuid().nullable().optional(),
  customer_last_service_identifier: z.string().nullable().optional(),
  customer_last_service_date: z.string().nullable().optional(),
  job_notes: z.array(JobNoteSchema).optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Job");

const IdParam = z.object({ id: z.string().uuid().openapi({ description: "Resource ID" }) });

// ── Helpers ────────────────────────────────────────────────────────

async function nextIdentifier(): Promise<string> {
  const prefix = await get<{ value: string }>("SELECT value FROM _meta WHERE key = 'identifier_prefix'");
  const counter = await get<{ value: string }>(
    "INSERT INTO _meta (key, value) VALUES ('job_counter', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value"
  );
  return `${prefix?.value || "JOB"}-${counter!.value}`;
}

async function nextInvoiceIdentifier(): Promise<string> {
  const prefix = await get<{ value: string }>("SELECT value FROM _meta WHERE key = 'invoice_prefix'");
  const counter = await get<{ value: string }>(
    "INSERT INTO _meta (key, value) VALUES ('invoice_counter', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value"
  );
  return `${prefix?.value || "INV"}-${counter!.value}`;
}

// ── Stats ──────────────────────────────────────────────────────────

const getStats = createRoute({
  method: "get",
  path: "/api/stats",
  responses: {
    200: {
      description: "Dashboard stats",
      content: { "application/json": { schema: z.object({
        jobs: z.number().int(),
        customers: z.number().int(),
        technicians: z.number().int(),
        service_types: z.number().int(),
        today_jobs: z.number().int(),
        upcoming_jobs: z.number().int(),
        completed_jobs: z.number().int(),
        revenue: z.number(),
        invoices_outstanding: z.number(),
        invoices_overdue: z.number(),
      }) } },
    },
  },
});

app.openapi(getStats, async (c) => {
  const jobs = await get<{ count: number }>("SELECT COUNT(*) as count FROM jobs");
  const customers = await get<{ count: number }>("SELECT COUNT(*) as count FROM customers");
  const technicians = await get<{ count: number }>("SELECT COUNT(*) as count FROM technicians WHERE active = 1");
  const serviceTypes = await get<{ count: number }>("SELECT COUNT(*) as count FROM service_types");
  const today = new Date().toISOString().split("T")[0];
  const todayJobs = await get<{ count: number }>("SELECT COUNT(*) as count FROM jobs WHERE scheduled_date = ?", [today]);
  const upcomingJobs = await get<{ count: number }>("SELECT COUNT(*) as count FROM jobs WHERE status IN ('scheduled', 'confirmed') AND scheduled_date >= ?", [today]);
  const completedJobs = await get<{ count: number }>("SELECT COUNT(*) as count FROM jobs WHERE status = 'completed'");
  const revenue = await get<{ total: number }>("SELECT COALESCE(SUM(price), 0) as total FROM jobs WHERE status = 'completed'");
  return c.json({
    jobs: jobs?.count || 0,
    customers: customers?.count || 0,
    technicians: technicians?.count || 0,
    service_types: serviceTypes?.count || 0,
    today_jobs: todayJobs?.count || 0,
    upcoming_jobs: upcomingJobs?.count || 0,
    completed_jobs: completedJobs?.count || 0,
    revenue: revenue?.total || 0,
    invoices_outstanding: (await get<{ count: number }>("SELECT COUNT(*) as count FROM invoices WHERE status IN ('sent')"))?.count || 0,
    invoices_overdue: (await get<{ count: number }>("SELECT COUNT(*) as count FROM invoices WHERE status = 'overdue'"))?.count || 0,
  }, 200);
});

// ── Jobs ───────────────────────────────────────────────────────────

const listJobs = createRoute({
  method: "get",
  path: "/api/jobs",
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      search: z.string().optional(),
      status: z.string().optional(),
      date: z.string().optional(),
      technician_id: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated job list",
      content: { "application/json": { schema: z.object({ jobs: z.array(JobSchema), total: z.number().int() }) } },
    },
  },
});

app.openapi(listJobs, async (c) => {
  const q = c.req.valid("query");
  const page = parseInt(q.page || "1", 10);
  const limit = parseInt(q.limit || "50", 10);
  const offset = (page - 1) * limit;

  let where = "WHERE 1=1";
  const params: unknown[] = [];

  if (q.search) {
    where += " AND (j.identifier LIKE ? OR c.name LIKE ? OR j.address LIKE ?)";
    const s = `%${q.search}%`;
    params.push(s, s, s);
  }
  if (q.status) {
    where += " AND j.status = ?";
    params.push(q.status);
  }
  if (q.date) {
    where += " AND j.scheduled_date = ?";
    params.push(q.date);
  }
  if (q.technician_id) {
    where += " AND j.technician_id = ?";
    params.push(q.technician_id);
  }

  const countRow = await get<{ count: number }>(
    `SELECT COUNT(*) as count FROM jobs j LEFT JOIN customers c ON j.customer_id = c.id ${where}`,
    params
  );

  const jobs = await query<z.infer<typeof JobSchema>>(
    `SELECT j.*, c.name as customer_name, c.phone as customer_phone,
       t.name as technician_name, t.color as technician_color,
       st.name as service_type_name, st.color as service_type_color
     FROM jobs j
     LEFT JOIN customers c ON j.customer_id = c.id
     LEFT JOIN technicians t ON j.technician_id = t.id
     LEFT JOIN service_types st ON j.service_type_id = st.id
     ${where}
     ORDER BY j.scheduled_date ASC, j.scheduled_time ASC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return c.json({ jobs, total: countRow?.count || 0 }, 200);
});

const getJob = createRoute({
  method: "get",
  path: "/api/jobs/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Job detail", content: { "application/json": { schema: z.object({ job: JobSchema }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getJob, async (c) => {
  const { id } = c.req.valid("param");
  const job = await get<z.infer<typeof JobSchema>>(
    `SELECT j.*, c.name as customer_name, c.phone as customer_phone,
       t.name as technician_name, t.color as technician_color,
       st.name as service_type_name, st.color as service_type_color,
       (SELECT COUNT(*) FROM jobs customer_jobs WHERE customer_jobs.customer_id = j.customer_id) as customer_job_count,
       (SELECT COALESCE(SUM(customer_invoices.total), 0) FROM invoices customer_invoices
        WHERE customer_invoices.customer_id = j.customer_id AND customer_invoices.status = 'paid') as customer_lifetime_revenue,
       last_service.id as customer_last_service_id,
       last_service.identifier as customer_last_service_identifier,
       last_service.scheduled_date as customer_last_service_date
     FROM jobs j
     LEFT JOIN customers c ON j.customer_id = c.id
     LEFT JOIN technicians t ON j.technician_id = t.id
     LEFT JOIN service_types st ON j.service_type_id = st.id
     LEFT JOIN jobs last_service ON last_service.id = (
       SELECT previous_job.id
       FROM jobs previous_job
       WHERE previous_job.customer_id = j.customer_id
         AND previous_job.id != j.id
         AND previous_job.status = 'completed'
       ORDER BY previous_job.scheduled_date DESC, previous_job.scheduled_time DESC, previous_job.created_at DESC
       LIMIT 1
     )
     WHERE j.id = ?`,
    [id]
  );
  if (!job) return c.json({ error: "Job not found" }, 404);
  const notes = await query<z.infer<typeof JobNoteSchema>>(
    "SELECT * FROM job_notes WHERE job_id = ? ORDER BY created_at DESC", [id]
  );
  const checklist = await query<Record<string, unknown>>(
    "SELECT * FROM job_checklist WHERE job_id = ? ORDER BY sort_order ASC", [id]
  );
  const jobMaterials = await query<Record<string, unknown>>(
    `SELECT jm.*, m.name as material_name, m.unit as material_unit
     FROM job_materials jm LEFT JOIN materials m ON jm.material_id = m.id
     WHERE jm.job_id = ? ORDER BY jm.rowid ASC`, [id]
  );
  return c.json({ job: { ...job, job_notes: notes, checklist, job_materials: jobMaterials } }, 200);
});

const createJob = createRoute({
  method: "post",
  path: "/api/jobs",
  request: {
    body: {
      content: { "application/json": { schema: z.object({
        customer_id: z.string().uuid(),
        asset_id: z.string().uuid().nullable().optional(),
        technician_id: z.string().uuid().nullable().optional(),
        service_type_id: z.string().uuid().nullable().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        scheduled_date: z.string(),
        scheduled_time: z.string().optional(),
        duration: z.number().int().optional(),
        price: z.number().optional(),
        address: z.string().optional(),
        notes: z.string().optional(),
        is_recurring: z.number().int().optional(),
        recurrence_interval: z.string().optional(),
      }) } },
    },
  },
  responses: {
    400: { description: "Invalid equipment relationship", content: { "application/json": { schema: ErrorSchema } } },
    201: { description: "Created", content: { "application/json": { schema: JobSchema } } },
  },
});

app.openapi(createJob, async (c) => {
  const data = c.req.valid("json");
  if (data.asset_id != null && !await get("SELECT id FROM assets WHERE id = ? AND customer_id = ?", [data.asset_id, data.customer_id])) {
    return c.json({ error: "Equipment must belong to the job customer" }, 400);
  }
  const identifier = await nextIdentifier();

  // Snapshot the equipment site's address; future site moves do not rewrite old jobs.
  let address = data.address || "";
  if (!address && data.asset_id != null) {
    const site = await get<{ address: string }>("SELECT s.address FROM sites s JOIN assets a ON a.site_id = s.id WHERE a.id = ?", [data.asset_id]);
    address = site?.address || "";
  }
  if (!address) {
    const cust = await get<{ address: string; city: string; state: string; zip: string }>(
      "SELECT address, city, state, zip FROM customers WHERE id = ?", [data.customer_id]
    );
    if (cust) {
      address = [cust.address, cust.city, cust.state, cust.zip].filter(Boolean).join(", ");
    }
  }

  // Default price/duration from service type
  let duration = data.duration || 60;
  let price = data.price || 0;
  if (data.service_type_id && (!data.duration || !data.price)) {
    const st = await get<{ default_duration: number; default_price: number }>(
      "SELECT default_duration, default_price FROM service_types WHERE id = ?", [data.service_type_id]
    );
    if (st) {
      if (!data.duration) duration = st.default_duration;
      if (!data.price) price = st.default_price;
    }
  }

  await run(
    `INSERT INTO jobs (identifier, customer_id, asset_id, technician_id, service_type_id, status, priority,
       scheduled_date, scheduled_time, duration, price, address, notes, is_recurring, recurrence_interval)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      identifier,
      data.customer_id,
      data.asset_id ?? null,
      data.technician_id ?? null,
      data.service_type_id ?? null,
      data.status || "scheduled",
      data.priority || "normal",
      data.scheduled_date,
      data.scheduled_time || "09:00",
      duration,
      price,
      address,
      data.notes || "",
      data.is_recurring || 0,
      data.recurrence_interval || "",
    ]
  );

  const job = await get<z.infer<typeof JobSchema>>(
    `SELECT j.*, c.name as customer_name, c.phone as customer_phone,
       t.name as technician_name, t.color as technician_color,
       st.name as service_type_name, st.color as service_type_color
     FROM jobs j
     LEFT JOIN customers c ON j.customer_id = c.id
     LEFT JOIN technicians t ON j.technician_id = t.id
     LEFT JOIN service_types st ON j.service_type_id = st.id
     WHERE j.identifier = ?`,
    [identifier]
  );
  return c.json(job!, 201);
});

const updateJob = createRoute({
  method: "put",
  path: "/api/jobs/{id}",
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: z.object({
        customer_id: z.string().uuid().optional(),
        asset_id: z.string().uuid().nullable().optional(),
        technician_id: z.string().uuid().nullable().optional(),
        service_type_id: z.string().uuid().nullable().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        scheduled_date: z.string().optional(),
        scheduled_time: z.string().optional(),
        duration: z.number().int().optional(),
        price: z.number().optional(),
        address: z.string().optional(),
        notes: z.string().optional(),
        completion_notes: z.string().optional(),
        is_recurring: z.number().int().optional(),
        recurrence_interval: z.string().optional(),
      }) } },
    },
  },
  responses: {
    400: { description: "Invalid equipment relationship", content: { "application/json": { schema: ErrorSchema } } },
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateJob, async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const existing = await get<Record<string, unknown>>("SELECT * FROM jobs WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "Job not found" }, 404);
  const assetId = data.asset_id === undefined ? existing.asset_id : data.asset_id;
  const customerId = data.customer_id ?? existing.customer_id;
  if (assetId != null && !await get("SELECT id FROM assets WHERE id = ? AND customer_id = ?", [assetId, customerId])) {
    return c.json({ error: "Equipment must belong to the job customer" }, 400);
  }

  const fields: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      vals.push(v);
    }
  }
  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    await run(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
  }
  return c.json({ ok: true }, 200);
});

const deleteJob = createRoute({
  method: "delete",
  path: "/api/jobs/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(deleteJob, async (c) => {
  const { id } = c.req.valid("param");
  await run("DELETE FROM jobs WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Job Notes ──────────────────────────────────────────────────────

const addJobNote = createRoute({
  method: "post",
  path: "/api/jobs/{id}/notes",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({ content: z.string() }) } } },
  },
  responses: {
    201: { description: "Note added", content: { "application/json": { schema: JobNoteSchema } } },
  },
});

app.openapi(addJobNote, async (c) => {
  const { id } = c.req.valid("param");
  const { content } = c.req.valid("json");
  const note = await get<z.infer<typeof JobNoteSchema>>("INSERT INTO job_notes (job_id, content) VALUES (?, ?) RETURNING *", [id, content]);
  return c.json(note!, 201);
});

const deleteJobNote = createRoute({
  method: "delete",
  path: "/api/notes/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(deleteJobNote, async (c) => {
  const { id } = c.req.valid("param");
  await run("DELETE FROM job_notes WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Customers ──────────────────────────────────────────────────────

const listCustomers = createRoute({
  method: "get",
  path: "/api/customers",
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      search: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated customer list",
      content: { "application/json": { schema: z.object({ customers: z.array(CustomerSchema), total: z.number().int() }) } },
    },
  },
});

app.openapi(listCustomers, async (c) => {
  const q = c.req.valid("query");
  const page = parseInt(q.page || "1", 10);
  const limit = parseInt(q.limit || "50", 10);
  const offset = (page - 1) * limit;

  let where = "";
  const params: unknown[] = [];
  if (q.search) {
    where = "WHERE c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.address LIKE ?";
    const s = `%${q.search}%`;
    params.push(s, s, s, s);
  }

  const countRow = await get<{ count: number }>(`SELECT COUNT(*) as count FROM customers c ${where}`, params);
  const customers = await query<z.infer<typeof CustomerSchema>>(
    `SELECT c.*, COALESCE(jc.cnt, 0) as job_count
     FROM customers c
     LEFT JOIN (SELECT customer_id, COUNT(*) as cnt FROM jobs GROUP BY customer_id) jc ON jc.customer_id = c.id
     ${where}
     ORDER BY c.name ASC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return c.json({ customers, total: countRow?.count || 0 }, 200);
});

const listAllCustomers = createRoute({
  method: "get",
  path: "/api/customers/all",
  responses: {
    200: {
      description: "All customers (for dropdowns)",
      content: { "application/json": { schema: z.object({ customers: z.array(z.object({ id: z.string().uuid(), name: z.string(), address: z.string() })) }) } },
    },
  },
});

app.openapi(listAllCustomers, async (c) => {
  const customers = await query<Pick<z.infer<typeof CustomerSchema>, "id" | "name" | "address">>("SELECT id, name, address FROM customers ORDER BY name ASC");
  return c.json({ customers }, 200);
});

const getCustomer = createRoute({
  method: "get",
  path: "/api/customers/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Customer detail", content: { "application/json": { schema: z.object({ customer: CustomerSchema, jobs: z.array(JobSchema) }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getCustomer, async (c) => {
  const { id } = c.req.valid("param");
  const customer = await get<z.infer<typeof CustomerSchema>>("SELECT * FROM customers WHERE id = ?", [id]);
  if (!customer) return c.json({ error: "Customer not found" }, 404);
  const jobs = await query<z.infer<typeof JobSchema>>(
    `SELECT j.*, t.name as technician_name, t.color as technician_color,
       st.name as service_type_name, st.color as service_type_color
     FROM jobs j
     LEFT JOIN technicians t ON j.technician_id = t.id
     LEFT JOIN service_types st ON j.service_type_id = st.id
     WHERE j.customer_id = ?
     ORDER BY j.scheduled_date DESC
     LIMIT 50`,
    [id]
  );
  return c.json({ customer, jobs }, 200);
});

const createCustomer = createRoute({
  method: "post",
  path: "/api/customers",
  request: {
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string(),
        email: z.string().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
        notes: z.string().optional(),
      }) } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: CustomerSchema } } },
  },
});

app.openapi(createCustomer, async (c) => {
  const data = c.req.valid("json");
  const customer = await get<z.infer<typeof CustomerSchema>>(
    "INSERT INTO customers (name, email, phone, address, city, state, zip, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    [data.name, data.email || "", data.phone || "", data.address || "",
    data.city || "", data.state || "", data.zip || "", data.notes || ""]
  );
  return c.json(customer!, 201);
});

const updateCustomer = createRoute({
  method: "put",
  path: "/api/customers/{id}",
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
        notes: z.string().optional(),
      }) } },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(updateCustomer, async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const fields: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      vals.push(v);
    }
  }
  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    await run(`UPDATE customers SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
  }
  return c.json({ ok: true }, 200);
});

const deleteCustomer = createRoute({
  method: "delete",
  path: "/api/customers/{id}",
  request: { params: IdParam },
  responses: {
    409: { description: "Invalid equipment relationship", content: { "application/json": { schema: ErrorSchema } } },
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(deleteCustomer, async (c) => {
  const { id } = c.req.valid("param");
  if (await get("SELECT id FROM sites WHERE customer_id = ? LIMIT 1", [id])) {
    return c.json({ error: "This customer has sites or equipment. Keep the customer to preserve equipment history." }, 409);
  }
  await run("DELETE FROM customers WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Technicians ────────────────────────────────────────────────────

const listTechnicians = createRoute({
  method: "get",
  path: "/api/technicians",
  responses: {
    200: {
      description: "All technicians",
      content: { "application/json": { schema: z.object({ technicians: z.array(TechnicianSchema) }) } },
    },
  },
});

app.openapi(listTechnicians, async (c) => {
  const technicians = await query<z.infer<typeof TechnicianSchema>>(
    `SELECT t.*, COALESCE(jc.cnt, 0) as job_count
     FROM technicians t
     LEFT JOIN (SELECT technician_id, COUNT(*) as cnt FROM jobs WHERE status IN ('scheduled','confirmed','in_progress') GROUP BY technician_id) jc ON jc.technician_id = t.id
     ORDER BY t.name ASC`
  );
  return c.json({ technicians }, 200);
});

const listAllTechnicians = createRoute({
  method: "get",
  path: "/api/technicians/all",
  responses: {
    200: {
      description: "Active technicians (for dropdowns)",
      content: { "application/json": { schema: z.object({ technicians: z.array(z.object({ id: z.string().uuid(), name: z.string(), color: z.string() })) }) } },
    },
  },
});

app.openapi(listAllTechnicians, async (c) => {
  const technicians = await query<Pick<z.infer<typeof TechnicianSchema>, "id" | "name" | "color">>(
    "SELECT id, name, color FROM technicians WHERE active = 1 ORDER BY name ASC"
  );
  return c.json({ technicians }, 200);
});

const createTechnician = createRoute({
  method: "post",
  path: "/api/technicians",
  request: {
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string(),
        email: z.string().optional(),
        phone: z.string().optional(),
        color: z.string().optional(),
      }) } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: TechnicianSchema } } },
  },
});

app.openapi(createTechnician, async (c) => {
  const data = c.req.valid("json");
  const tech = await get<z.infer<typeof TechnicianSchema>>(
    "INSERT INTO technicians (name, email, phone, color) VALUES (?, ?, ?, ?) RETURNING *",
    [data.name, data.email || "", data.phone || "", data.color || "#16a34a"]
  );
  return c.json(tech!, 201);
});

const updateTechnician = createRoute({
  method: "put",
  path: "/api/technicians/{id}",
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        color: z.string().optional(),
        active: z.number().int().optional(),
      }) } },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(updateTechnician, async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const fields: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      vals.push(v);
    }
  }
  if (fields.length > 0) {
    await run(`UPDATE technicians SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
  }
  return c.json({ ok: true }, 200);
});

const deleteTechnician = createRoute({
  method: "delete",
  path: "/api/technicians/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(deleteTechnician, async (c) => {
  const { id } = c.req.valid("param");
  await run("DELETE FROM technicians WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Service Types ──────────────────────────────────────────────────

const listServiceTypes = createRoute({
  method: "get",
  path: "/api/service-types",
  responses: {
    200: {
      description: "All service types",
      content: { "application/json": { schema: z.object({ service_types: z.array(ServiceTypeSchema) }) } },
    },
  },
});

app.openapi(listServiceTypes, async (c) => {
  const types = await query<z.infer<typeof ServiceTypeSchema>>("SELECT * FROM service_types ORDER BY name ASC");
  return c.json({ service_types: types }, 200);
});

const createServiceType = createRoute({
  method: "post",
  path: "/api/service-types",
  request: {
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string(),
        description: z.string().optional(),
        default_duration: z.number().int().optional(),
        default_price: z.number().optional(),
        color: z.string().optional(),
      }) } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: ServiceTypeSchema } } },
  },
});

app.openapi(createServiceType, async (c) => {
  const data = c.req.valid("json");
  const st = await get<z.infer<typeof ServiceTypeSchema>>(
    "INSERT INTO service_types (name, description, default_duration, default_price, color) VALUES (?, ?, ?, ?, ?) RETURNING *",
    [data.name, data.description || "", data.default_duration || 60, data.default_price || 0, data.color || "#6b7280"]
  );
  return c.json(st!, 201);
});

const updateServiceType = createRoute({
  method: "put",
  path: "/api/service-types/{id}",
  request: {
    params: IdParam,
    body: {
      content: { "application/json": { schema: z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        default_duration: z.number().int().optional(),
        default_price: z.number().optional(),
        color: z.string().optional(),
      }) } },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(updateServiceType, async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const fields: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      vals.push(v);
    }
  }
  if (fields.length > 0) {
    await run(`UPDATE service_types SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
  }
  return c.json({ ok: true }, 200);
});

const deleteServiceType = createRoute({
  method: "delete",
  path: "/api/service-types/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(deleteServiceType, async (c) => {
  const { id } = c.req.valid("param");
  await run("DELETE FROM service_types WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Schedule (calendar view) ───────────────────────────────────────

const getSchedule = createRoute({
  method: "get",
  path: "/api/schedule",
  request: {
    query: z.object({
      start: z.string(),
      end: z.string(),
      technician_id: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Jobs within date range",
      content: { "application/json": { schema: z.object({ jobs: z.array(JobSchema) }) } },
    },
  },
});

app.openapi(getSchedule, async (c) => {
  const q = c.req.valid("query");
  let where = "WHERE j.scheduled_date >= ? AND j.scheduled_date <= ?";
  const params: unknown[] = [q.start, q.end];
  if (q.technician_id) {
    where += " AND j.technician_id = ?";
    params.push(q.technician_id);
  }
  const jobs = await query<z.infer<typeof JobSchema>>(
    `SELECT j.*, c.name as customer_name, c.phone as customer_phone,
       t.name as technician_name, t.color as technician_color,
       st.name as service_type_name, st.color as service_type_color
     FROM jobs j
     LEFT JOIN customers c ON j.customer_id = c.id
     LEFT JOIN technicians t ON j.technician_id = t.id
     LEFT JOIN service_types st ON j.service_type_id = st.id
     ${where}
     ORDER BY j.scheduled_date ASC, j.scheduled_time ASC`,
    params
  );
  return c.json({ jobs }, 200);
});

// ── Job Checklist ──────────────────────────────────────────────────

const addChecklistItem = createRoute({
  method: "post",
  path: "/api/jobs/{id}/checklist",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({ label: z.string() }) } } },
  },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(addChecklistItem, async (c) => {
  const { id } = c.req.valid("param");
  const { label } = c.req.valid("json");
  const maxOrder = await get<{ m: number }>("SELECT COALESCE(MAX(sort_order), 0) as m FROM job_checklist WHERE job_id = ?", [id]);
  await run("INSERT INTO job_checklist (job_id, label, sort_order) VALUES (?, ?, ?)", [id, label, (maxOrder?.m || 0) + 1]);
  return c.json({ ok: true }, 201);
});

const toggleChecklistItem = createRoute({
  method: "put",
  path: "/api/checklist/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Toggled", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(toggleChecklistItem, async (c) => {
  const { id } = c.req.valid("param");
  await run("UPDATE job_checklist SET checked = CASE WHEN checked = 0 THEN 1 ELSE 0 END WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

const deleteChecklistItem = createRoute({
  method: "delete",
  path: "/api/checklist/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(deleteChecklistItem, async (c) => {
  const { id } = c.req.valid("param");
  await run("DELETE FROM job_checklist WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Materials ──────────────────────────────────────────────────────

const listMaterials = createRoute({
  method: "get",
  path: "/api/materials",
  responses: {
    200: {
      description: "All materials",
      content: { "application/json": { schema: z.object({ materials: z.array(z.object({
        id: z.string().uuid(),
        name: z.string(),
        unit: z.string(),
        unit_cost: z.number(),
        in_stock: z.number(),
        created_at: z.string(),
      })) }) } },
    },
  },
});

app.openapi(listMaterials, async (c) => {
  const materials = await query<{ id: string; name: string; unit: string; unit_cost: number; in_stock: number; created_at: string }>("SELECT * FROM materials ORDER BY name ASC");
  return c.json({ materials }, 200);
});

const createMaterial = createRoute({
  method: "post",
  path: "/api/materials",
  request: {
    body: { content: { "application/json": { schema: z.object({
      name: z.string(),
      unit: z.string().optional(),
      unit_cost: z.number().optional(),
      in_stock: z.number().optional(),
    }) } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(createMaterial, async (c) => {
  const data = c.req.valid("json");
  await run("INSERT INTO materials (name, unit, unit_cost, in_stock) VALUES (?, ?, ?, ?)",
    [data.name, data.unit || "ea", data.unit_cost || 0, data.in_stock || 0]);
  return c.json({ ok: true }, 201);
});

const updateMaterial = createRoute({
  method: "put",
  path: "/api/materials/{id}",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      name: z.string().optional(),
      unit: z.string().optional(),
      unit_cost: z.number().optional(),
      in_stock: z.number().optional(),
    }) } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(updateMaterial, async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const fields: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) { fields.push(`${k} = ?`); vals.push(v); }
  }
  if (fields.length > 0) await run(`UPDATE materials SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
  return c.json({ ok: true }, 200);
});

const deleteMaterial = createRoute({
  method: "delete",
  path: "/api/materials/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(deleteMaterial, async (c) => {
  const { id } = c.req.valid("param");
  await run("DELETE FROM materials WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Job Materials ──────────────────────────────────────────────────

const addJobMaterial = createRoute({
  method: "post",
  path: "/api/jobs/{id}/materials",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      material_id: z.string().uuid(),
      quantity: z.number(),
      unit_cost: z.number().optional(),
    }) } } },
  },
  responses: {
    201: { description: "Added", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(addJobMaterial, async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  let cost = data.unit_cost;
  if (cost === undefined) {
    const mat = await get<{ unit_cost: number }>("SELECT unit_cost FROM materials WHERE id = ?", [data.material_id]);
    cost = mat?.unit_cost || 0;
  }
  await run("INSERT INTO job_materials (job_id, material_id, quantity, unit_cost) VALUES (?, ?, ?, ?)",
    [id, data.material_id, data.quantity, cost]);
  return c.json({ ok: true }, 201);
});

const deleteJobMaterial = createRoute({
  method: "delete",
  path: "/api/job-materials/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(deleteJobMaterial, async (c) => {
  const { id } = c.req.valid("param");
  await run("DELETE FROM job_materials WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Invoices ───────────────────────────────────────────────────────

const listInvoices = createRoute({
  method: "get",
  path: "/api/invoices",
  request: {
    query: z.object({
      page: z.string().optional(),
      limit: z.string().optional(),
      status: z.string().optional(),
      search: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Paginated invoice list",
      content: { "application/json": { schema: z.object({
        invoices: z.array(z.any()),
        total: z.number().int(),
      }) } },
    },
  },
});

app.openapi(listInvoices, async (c) => {
  const q = c.req.valid("query");
  const page = parseInt(q.page || "1", 10);
  const limit = parseInt(q.limit || "50", 10);
  const offset = (page - 1) * limit;

  let where = "WHERE 1=1";
  const params: unknown[] = [];
  if (q.status) { where += " AND i.status = ?"; params.push(q.status); }
  if (q.search) {
    where += " AND (i.identifier LIKE ? OR c.name LIKE ?)";
    const s = `%${q.search}%`;
    params.push(s, s);
  }

  const countRow = await get<{ count: number }>(
    `SELECT COUNT(*) as count FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id ${where}`, params
  );
  const invoices = await query<Record<string, unknown>>(
    `SELECT i.*, c.name as customer_name, j.identifier as job_identifier
     FROM invoices i
     LEFT JOIN customers c ON i.customer_id = c.id
     LEFT JOIN jobs j ON i.job_id = j.id
     ${where}
     ORDER BY i.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return c.json({ invoices, total: countRow?.count || 0 }, 200);
});

const getInvoice = createRoute({
  method: "get",
  path: "/api/invoices/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Invoice detail", content: { "application/json": { schema: z.object({ invoice: z.any() }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getInvoice, async (c) => {
  const { id } = c.req.valid("param");
  const invoice = await get<Record<string, unknown>>(
    `SELECT i.*, c.name as customer_name, j.identifier as job_identifier
     FROM invoices i
     LEFT JOIN customers c ON i.customer_id = c.id
     LEFT JOIN jobs j ON i.job_id = j.id
     WHERE i.id = ?`, [id]
  );
  if (!invoice) return c.json({ error: "Invoice not found" }, 404);
  const lines = await query<Record<string, unknown>>(
    "SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid ASC", [id]
  );
  return c.json({ invoice: { ...invoice, lines } }, 200);
});

const createInvoice = createRoute({
  method: "post",
  path: "/api/invoices",
  request: {
    body: { content: { "application/json": { schema: z.object({
      customer_id: z.string().uuid(),
      job_id: z.string().uuid().nullable().optional(),
      tax_rate: z.number().optional(),
      notes: z.string().optional(),
      due_date: z.string().optional(),
      lines: z.array(z.object({
        description: z.string(),
        quantity: z.number(),
        unit_price: z.number(),
      })),
    }) } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.any() } } },
  },
});

app.openapi(createInvoice, async (c) => {
  const data = c.req.valid("json");
  const identifier = await nextInvoiceIdentifier();
  const taxRate = data.tax_rate || 0;

  let subtotal = 0;
  for (const line of data.lines) {
    subtotal += line.quantity * line.unit_price;
  }
  const taxAmount = subtotal * (taxRate / 100);
  const total = subtotal + taxAmount;

  await run(
    `INSERT INTO invoices (identifier, customer_id, job_id, status, subtotal, tax_rate, tax_amount, total, notes, due_date)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
    [identifier, data.customer_id, data.job_id ?? null,
    subtotal, taxRate, taxAmount, total,
    data.notes || "", data.due_date || ""]
  );

  const invoice = await get<{ id: string }>("SELECT id FROM invoices WHERE identifier = ?", [identifier]);
  for (const line of data.lines) {
    const lineTotal = line.quantity * line.unit_price;
    await run(
      "INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price, total) VALUES (?, ?, ?, ?, ?)",
      [invoice!.id, line.description, line.quantity, line.unit_price, lineTotal]
    );
  }

  const result = await get<Record<string, unknown>>(
    `SELECT i.*, c.name as customer_name FROM invoices i
     LEFT JOIN customers c ON i.customer_id = c.id WHERE i.id = ?`, [invoice!.id]
  );
  return c.json(result!, 201);
});

const updateInvoice = createRoute({
  method: "put",
  path: "/api/invoices/{id}",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: z.object({
      status: z.string().optional(),
      notes: z.string().optional(),
      due_date: z.string().optional(),
      paid_date: z.string().optional(),
    }) } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(updateInvoice, async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  const fields: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) { fields.push(`${k} = ?`); vals.push(v); }
  }
  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    await run(`UPDATE invoices SET ${fields.join(", ")} WHERE id = ?`, [...vals, id]);
  }
  return c.json({ ok: true }, 200);
});

const deleteInvoice = createRoute({
  method: "delete",
  path: "/api/invoices/{id}",
  request: { params: IdParam },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
  },
});

app.openapi(deleteInvoice, async (c) => {
  const { id } = c.req.valid("param");
  await run("DELETE FROM invoices WHERE id = ?", [id]);
  return c.json({ ok: true }, 200);
});

// ── Create invoice from job ────────────────────────────────────────

const invoiceFromJob = createRoute({
  method: "post",
  path: "/api/jobs/{id}/invoice",
  request: { params: IdParam },
  responses: {
    201: { description: "Invoice created from job", content: { "application/json": { schema: z.any() } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(invoiceFromJob, async (c) => {
  const { id } = c.req.valid("param");
  const job = await get<z.infer<typeof JobSchema>>(
    `SELECT j.*, st.name as service_type_name FROM jobs j
     LEFT JOIN service_types st ON j.service_type_id = st.id WHERE j.id = ?`, [id]
  );
  if (!job) return c.json({ error: "Job not found" }, 404);

  const identifier = await nextInvoiceIdentifier();
  const price = job.price as number;

  // Gather materials used
  const mats = await query<Record<string, unknown>>(
    `SELECT jm.*, m.name as material_name FROM job_materials jm
     LEFT JOIN materials m ON jm.material_id = m.id WHERE jm.job_id = ?`, [id]
  );

  let subtotal = price;
  const lines: { description: string; quantity: number; unit_price: number; total: number }[] = [
    { description: (job.service_type_name as string) || "Service", quantity: 1, unit_price: price, total: price },
  ];
  for (const m of mats) {
    const lineTotal = (m.quantity as number) * (m.unit_cost as number);
    lines.push({
      description: m.material_name as string,
      quantity: m.quantity as number,
      unit_price: m.unit_cost as number,
      total: lineTotal,
    });
    subtotal += lineTotal;
  }

  await run(
    `INSERT INTO invoices (identifier, customer_id, job_id, status, subtotal, tax_rate, tax_amount, total, notes, due_date)
     VALUES (?, ?, ?, 'draft', ?, 0, 0, ?, '', '')`,
    [identifier, job.customer_id, job.id, subtotal, subtotal]
  );

  const inv = await get<{ id: string }>("SELECT id FROM invoices WHERE identifier = ?", [identifier]);
  for (const line of lines) {
    await run(
      "INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price, total) VALUES (?, ?, ?, ?, ?)",
      [inv!.id, line.description, line.quantity, line.unit_price, line.total]
    );
  }

  return c.json({ ok: true, invoice_id: inv!.id }, 201);
});

export default app;
