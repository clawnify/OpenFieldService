import { OpenAPIHono, createRoute, z } from "@clawnify/app";
import { query, get, run } from "./db.js";

export const equipmentApp = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) return c.json({ error: result.error.issues.map((issue) => issue.message).join("; ") }, 400);
  },
});
const id = z.string().uuid();
const params = z.object({ id });
const text = z.string().trim().max(500);
const date = z.union([z.literal(""), z.string().date()]);
const error = z.object({ error: z.string() });
const json = <T extends z.ZodTypeAny>(schema: T) => ({ "application/json": { schema } });
const errors = {
  400: { description: "Invalid relationship or dates", content: json(error) },
  404: { description: "Not found", content: json(error) },
  409: { description: "Duplicate serial number", content: json(error) },
};

const siteFields = z.object({
  name: text.min(1), address: text.default(""), contact_name: text.default(""),
  contact_phone: text.default(""), contact_email: z.union([z.literal(""), z.string().email().max(254)]).default(""),
  timezone: z.string().max(100).refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "Use a valid timezone, such as Europe/Amsterdam").default("UTC"),
  access_instructions: z.string().trim().max(5000).default(""), safety_notes: z.string().trim().max(5000).default(""),
});
const siteSchema = siteFields.extend({ id, customer_id: id, created_at: z.string(), updated_at: z.string() });
type Site = z.infer<typeof siteSchema>;
const assetFields = z.object({
  site_id: id, name: text.min(1), serial_number: text.min(1),
  manufacturer: text.default(""), model: text.default(""),
  status: z.enum(["in_service", "out_of_service", "retired"]).default("in_service"),
  installation_date: date.default(""), commissioning_date: date.default(""),
  warranty_start: date.default(""), warranty_end: date.default(""),
  notes: z.string().trim().max(5000).default(""),
});
const assetSchema = assetFields.extend({
  id, customer_id: id, created_at: z.string(), updated_at: z.string(),
  site_name: z.string(), site_address: z.string(), customer_name: z.string(),
});
type Asset = z.infer<typeof assetSchema>;
const assetSelect = `SELECT a.*, s.name AS site_name, s.address AS site_address, c.name AS customer_name
  FROM assets a JOIN sites s ON s.id = a.site_id JOIN customers c ON c.id = a.customer_id`;
const historySchema = z.object({
  id, asset_id: id, job_id: id.nullable(), available_job_id: id.nullable(),
  summary: z.string(), details: z.string(), created_at: z.string(),
});
const pagination = z.object({ page: z.coerce.number().int().positive().default(1), search: z.string().max(200).default("") });

async function update(table: "sites" | "assets", resourceId: string, data: Record<string, unknown>) {
  const fields = Object.keys(data);
  if (!fields.length) return;
  await run(`UPDATE ${table} SET ${fields.map((key) => `${key} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`, [...Object.values(data), resourceId]);
}

function invalidDates(asset: z.infer<typeof assetFields>) {
  if (asset.warranty_start && asset.warranty_end && asset.warranty_end < asset.warranty_start) return "Warranty end must not precede its start";
  if (asset.installation_date && asset.commissioning_date && asset.commissioning_date < asset.installation_date) return "Commissioning date must not precede installation";
}

// Only translate the expected unique constraint; infrastructure failures remain errors.
function duplicateSerial(err: unknown) {
  return err instanceof Error && err.message.includes("UNIQUE constraint failed: assets.customer_id, assets.serial_number");
}

equipmentApp.openapi(createRoute({
  method: "get", path: "/api/customers/{id}/sites", request: { params },
  responses: { 200: { description: "Customer sites", content: json(z.object({ sites: z.array(siteSchema) })) }, ...errors },
}), async (c) => {
  const { id } = c.req.valid("param");
  if (!await get("SELECT id FROM customers WHERE id = ?", [id])) return c.json({ error: "Customer not found" }, 404);
  return c.json({ sites: await query<Site>("SELECT * FROM sites WHERE customer_id = ? ORDER BY name, id", [id]) }, 200);
});

equipmentApp.openapi(createRoute({
  method: "post", path: "/api/customers/{id}/sites", request: { params, body: { content: json(siteFields.strict()) } },
  responses: { 201: { description: "Site created", content: json(siteSchema) }, ...errors },
}), async (c) => {
  const { id } = c.req.valid("param");
  if (!await get("SELECT id FROM customers WHERE id = ?", [id])) return c.json({ error: "Customer not found" }, 404);
  const data = c.req.valid("json");
  const site = await get<Site>(`INSERT INTO sites (customer_id, ${Object.keys(data).join(", ")}) VALUES (?, ${Object.keys(data).map(() => "?").join(", ")}) RETURNING *`, [id, ...Object.values(data)]);
  return c.json(site!, 201);
});

equipmentApp.openapi(createRoute({
  method: "put", path: "/api/sites/{id}", request: { params, body: { content: json(siteFields.partial().strict()) } },
  responses: { 200: { description: "Site updated", content: json(siteSchema) }, ...errors },
}), async (c) => {
  const { id } = c.req.valid("param");
  if (!await get("SELECT id FROM sites WHERE id = ?", [id])) return c.json({ error: "Site not found" }, 404);
  await update("sites", id, c.req.valid("json"));
  return c.json((await get<Site>("SELECT * FROM sites WHERE id = ?", [id]))!, 200);
});

equipmentApp.openapi(createRoute({
  method: "get", path: "/api/customers/{id}/assets", request: { params, query: pagination },
  responses: { 200: { description: "Customer equipment, 50 per page", content: json(z.object({ assets: z.array(assetSchema), total: z.number().int() })) }, ...errors },
}), async (c) => {
  const { id } = c.req.valid("param");
  const { page, search } = c.req.valid("query");
  if (!await get("SELECT id FROM customers WHERE id = ?", [id])) return c.json({ error: "Customer not found" }, 404);
  const where = " WHERE a.customer_id = ? AND (a.name LIKE ? OR a.serial_number LIKE ? OR a.model LIKE ?)";
  const values = [id, ...Array(3).fill(`%${search}%`)];
  const total = await get<{ n: number }>("SELECT COUNT(*) AS n FROM assets a" + where, values);
  return c.json({ assets: await query<Asset>(assetSelect + where + " ORDER BY a.name, a.id LIMIT 50 OFFSET ?", [...values, (page - 1) * 50]), total: total!.n }, 200);
});

equipmentApp.openapi(createRoute({
  method: "post", path: "/api/customers/{id}/assets", request: { params, body: { content: json(assetFields.strict()) } },
  responses: { 201: { description: "Equipment registered", content: json(assetSchema) }, ...errors },
}), async (c) => {
  const { id } = c.req.valid("param");
  const data = c.req.valid("json");
  if (!await get("SELECT id FROM customers WHERE id = ?", [id])) return c.json({ error: "Customer not found" }, 404);
  if (!await get("SELECT id FROM sites WHERE id = ? AND customer_id = ?", [data.site_id, id])) return c.json({ error: "Site must belong to this customer" }, 400);
  const message = invalidDates(data);
  if (message) return c.json({ error: message }, 400);
  try {
    const asset = await get<Asset>(`INSERT INTO assets (customer_id, ${Object.keys(data).join(", ")}) VALUES (?, ${Object.keys(data).map(() => "?").join(", ")}) RETURNING *`, [id, ...Object.values(data)]);
    return c.json((await get<Asset>(assetSelect + " WHERE a.id = ?", [asset!.id]))!, 201);
  } catch (err) {
    if (duplicateSerial(err)) return c.json({ error: "This customer already has equipment with that serial number" }, 409);
    throw err;
  }
});

equipmentApp.openapi(createRoute({
  method: "get", path: "/api/assets/{id}", request: { params },
  responses: { 200: { description: "Equipment and current site instructions", content: json(z.object({ asset: assetSchema, site: siteSchema })) }, ...errors },
}), async (c) => {
  const { id } = c.req.valid("param");
  const asset = await get<Asset>(assetSelect + " WHERE a.id = ?", [id]);
  if (!asset) return c.json({ error: "Equipment not found" }, 404);
  return c.json({ asset, site: (await get<Site>("SELECT * FROM sites WHERE id = ?", [asset.site_id]))! }, 200);
});

equipmentApp.openapi(createRoute({
  method: "put", path: "/api/assets/{id}", request: { params, body: { content: json(assetFields.partial().strict()) } },
  responses: { 200: { description: "Equipment updated; site moves and status changes retained in history", content: json(assetSchema) }, ...errors },
}), async (c) => {
  const { id } = c.req.valid("param");
  const existing = await get<Asset>(assetSelect + " WHERE a.id = ?", [id]);
  if (!existing) return c.json({ error: "Equipment not found" }, 404);
  const data = c.req.valid("json");
  if (data.site_id !== undefined && !await get("SELECT id FROM sites WHERE id = ? AND customer_id = ?", [data.site_id, existing.customer_id])) return c.json({ error: "Site must belong to this customer" }, 400);
  const message = invalidDates({ ...existing, ...data });
  if (message) return c.json({ error: message }, 400);
  try {
    await update("assets", id, data);
  } catch (err) {
    if (duplicateSerial(err)) return c.json({ error: "This customer already has equipment with that serial number" }, 409);
    throw err;
  }
  return c.json((await get<Asset>(assetSelect + " WHERE a.id = ?", [id]))!, 200);
});

equipmentApp.openapi(createRoute({
  method: "get", path: "/api/assets/{id}/history", request: { params, query: pagination.pick({ page: true }) },
  responses: { 200: { description: "Equipment history, newest first, 50 per page", content: json(z.object({ history: z.array(historySchema), total: z.number().int() })) }, ...errors },
}), async (c) => {
  const { id } = c.req.valid("param");
  const { page } = c.req.valid("query");
  if (!await get("SELECT id FROM assets WHERE id = ?", [id])) return c.json({ error: "Equipment not found" }, 404);
  const total = await get<{ n: number }>("SELECT COUNT(*) AS n FROM asset_history WHERE asset_id = ?", [id]);
  const history = await query<z.infer<typeof historySchema>>(`SELECT h.*, j.id AS available_job_id FROM asset_history h
    LEFT JOIN jobs j ON j.id = h.job_id AND j.customer_id = (SELECT customer_id FROM assets WHERE id = h.asset_id)
    WHERE h.asset_id = ? ORDER BY h.created_at DESC, h.rowid DESC LIMIT 50 OFFSET ?`, [id, (page - 1) * 50]);
  return c.json({ history, total: total!.n }, 200);
});
