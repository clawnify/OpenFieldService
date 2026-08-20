import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob,
  post, put, del, request, resetDatabase, queryDb,
} from "./helpers.js";
import { MockGeocodingProvider, geocodeJob } from "../src/server/geocoding.js";

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

describe("existing field service API", () => {
  it("creates, searches, updates, and reads customers with service history", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await createJob(customer.id, "2026-01-10");

    const update = await put<{ ok: boolean }>(`/api/customers/${customer.id}`, { phone: "555-0199" }, auth);
    const search = await request<{ customers: Array<{ id: number; job_count: number }>; total: number }>(
      "/api/customers?search=Ada&page=1&limit=50", auth,
    );
    const detail = await request<{ customer: { phone: string }; jobs: Array<{ scheduled_date: string }> }>(
      `/api/customers/${customer.id}`, auth,
    );

    expect(update.body.ok).toBe(true);
    expect(search.body).toMatchObject({ total: 1, customers: [{ id: customer.id, job_count: 1 }] });
    expect(detail.body.customer.phone).toBe("555-0199");
    expect(detail.body.jobs).toHaveLength(1);
  });

  it("creates, updates, and lists technicians", async () => {
    const auth = await authHeaders();
    const created = await post<{ id: number; name: string; active: number }>("/api/technicians", {
      name: "Grace Hopper",
      email: "grace@example.test",
      color: "#123456",
    }, auth);
    const update = await put<{ ok: boolean }>(`/api/technicians/${created.body.id}`, { active: 0 }, auth);
    const list = await request<{ technicians: Array<{ id: number; active: number }> }>("/api/technicians", auth);
    const activeLookup = await request<{ technicians: Array<{ id: number }> }>("/api/technicians/all", auth);

    expect(created.response.status).toBe(201);
    expect(update.body.ok).toBe(true);
    expect(list.body.technicians).toContainEqual(expect.objectContaining({ id: created.body.id, active: 0 }));
    expect(activeLookup.body.technicians).not.toContainEqual(expect.objectContaining({ id: created.body.id }));
  });

  it("retains seeded service types and supports catalog CRUD", async () => {
    const auth = await authHeaders();
    const initial = await request<{ service_types: Array<{ id: number }> }>("/api/service-types", auth);
    const created = await post<{ id: number; name: string }>("/api/service-types", {
      name: "Heat Pump Tune-up",
      default_duration: 75,
      default_price: 189.5,
      color: "#abcdef",
    }, auth);
    const update = await put<{ ok: boolean }>(`/api/service-types/${created.body.id}`, { default_duration: 90 }, auth);
    const removed = await del<{ ok: boolean }>(`/api/service-types/${created.body.id}`, auth);

    expect(initial.body.service_types).toHaveLength(6);
    expect(created.response.status).toBe(201);
    expect(update.body.ok).toBe(true);
    expect(removed.body.ok).toBe(true);
  });

  it("retains seeded materials and supports inventory catalog CRUD", async () => {
    const auth = await authHeaders();
    const initial = await request<{ materials: Array<{ id: number }> }>("/api/materials", auth);
    const created = await post<{ ok: boolean }>("/api/materials", {
      name: "Contactor",
      unit: "ea",
      unit_cost: 42.25,
      in_stock: 8,
    }, auth);
    const list = await request<{ materials: Array<{ id: number; name: string; unit_cost: number }> }>("/api/materials", auth);
    const contactor = list.body.materials.find((material) => material.name === "Contactor");
    const update = await put<{ ok: boolean }>(`/api/materials/${contactor?.id}`, { in_stock: 7 }, auth);

    expect(initial.body.materials).toHaveLength(5);
    expect(created.response.status).toBe(201);
    expect(contactor).toMatchObject({ unit_cost: 42.25 });
    expect(update.body.ok).toBe(true);
  });

  it("applies existing customer-address and service defaults when creating jobs", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const created = await createJob(customer.id, "2026-03-14", { scheduled_time: "10:30" });
    const detail = await request<{ job: {
      identifier: string;
      address: string;
      duration: number;
      price: number;
      scheduled_time: string;
    } }>(`/api/jobs/${created.id}`, auth);

    expect(detail.body.job).toMatchObject({
      identifier: "JOB-1",
      address: "100 Main St, Burnaby, BC, V5A 1A1",
      duration: 60,
      price: 150,
      scheduled_time: "10:30",
    });
  });

  // Phase 10.0 — Location Data Model + Provider Interfaces
  // (mem:phase10/maps-routing-architecture-audit). jobs.address is the
  // authoritative, already-snapshotted service location this whole
  // geocoding model is built on — these tests prove PUT /api/jobs/{id}
  // correctly clears stale coordinates whenever that address actually
  // changes, server-side, never relying on the UI to remember to do it.
  describe("Phase 10.0 — address change clears geocoded coordinates", () => {
    it("changing a job's address resets latitude/longitude/geocoded_at/geocode_status back to pending", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      await geocodeJob(job.id, new MockGeocodingProvider({ status: "ok", latitude: 49.28, longitude: -123.12 }));
      const before = await queryDb<{ geocode_status: string }>("SELECT geocode_status FROM jobs WHERE id = ?", [job.id]);
      expect(before[0].geocode_status).toBe("geocoded");

      const update = await put<{ ok: boolean }>(`/api/jobs/${job.id}`, { address: "999 New Service Rd, Surrey, BC" }, auth);
      expect(update.response.status).toBe(200);

      const rows = await queryDb<{ latitude: number | null; longitude: number | null; geocoded_at: string | null; geocode_status: string; address: string }>(
        "SELECT latitude, longitude, geocoded_at, geocode_status, address FROM jobs WHERE id = ?", [job.id]
      );
      expect(rows[0]).toMatchObject({
        latitude: null, longitude: null, geocoded_at: null, geocode_status: "pending",
        address: "999 New Service Rd, Surrey, BC",
      });
    });

    it("resubmitting the SAME unchanged address does NOT discard an already-resolved geocode", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      await geocodeJob(job.id, new MockGeocodingProvider({ status: "ok", latitude: 49.28, longitude: -123.12 }));
      const current = await queryDb<{ address: string }>("SELECT address FROM jobs WHERE id = ?", [job.id]);

      await put<{ ok: boolean }>(`/api/jobs/${job.id}`, { address: current[0].address, notes: "unrelated edit" }, auth);

      const rows = await queryDb<{ geocode_status: string }>("SELECT geocode_status FROM jobs WHERE id = ?", [job.id]);
      expect(rows[0].geocode_status).toBe("geocoded");
    });

    it("editing an unrelated field (not address) does NOT clear an already-resolved geocode", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      await geocodeJob(job.id, new MockGeocodingProvider({ status: "ok", latitude: 49.28, longitude: -123.12 }));

      await put<{ ok: boolean }>(`/api/jobs/${job.id}`, { notes: "just a note update" }, auth);

      const rows = await queryDb<{ geocode_status: string; latitude: number | null }>(
        "SELECT geocode_status, latitude FROM jobs WHERE id = ?", [job.id]
      );
      expect(rows[0]).toMatchObject({ geocode_status: "geocoded", latitude: 49.28 });
    });

    it("geocoding a job never touches Google Calendar sync state or creates a NEW notification (no cross-domain side effects)", async () => {
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      // createJob() itself already enqueues an appointment-confirmation
      // notification (Phase 9.1) — capture that baseline count first so
      // this test proves geocoding adds no ADDITIONAL row, rather than
      // wrongly asserting zero notifications ever exist for the job.
      const before = await queryDb(
        "SELECT id FROM notification_outbox WHERE entity_type = 'job' AND entity_id = ?", [job.id]
      );

      await geocodeJob(job.id, new MockGeocodingProvider({ status: "ok", latitude: 49.28, longitude: -123.12 }));

      const mappings = await queryDb("SELECT * FROM calendar_event_mappings WHERE job_id = ?", [job.id]);
      expect(mappings).toHaveLength(0);
      const after = await queryDb(
        "SELECT id FROM notification_outbox WHERE entity_type = 'job' AND entity_id = ?", [job.id]
      );
      expect(after).toHaveLength(before.length);
    });
  });

  it("finds jobs by customer name, job number, address, or phone (see the job-list.tsx search bar's placeholder promise)", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer(); // "Ada Heating", phone "555-0100", address "100 Main St"
    const job = await createJob(customer.id, "2026-03-20");
    const otherCustomer = await createCustomer("Unrelated Co");
    await createJob(otherCustomer.id, "2026-03-21");

    const jobDetail = await request<{ job: { identifier: string } }>(`/api/jobs/${job.id}`, auth);

    const byName = await request<{ jobs: { id: number }[] }>("/api/jobs?search=Ada", auth);
    expect(byName.body.jobs.map((j) => j.id)).toEqual([job.id]);

    const byJobNumber = await request<{ jobs: { id: number }[] }>(`/api/jobs?search=${jobDetail.body.job.identifier}`, auth);
    expect(byJobNumber.body.jobs.map((j) => j.id)).toEqual([job.id]);

    // createCustomer() always seeds the same "100 Main St" address regardless
    // of the name override, so both fixture customers legitimately match this
    // search — assert the target job is included, not that it's the only hit.
    const byAddress = await request<{ jobs: { id: number }[] }>("/api/jobs?search=Main St", auth);
    expect(byAddress.body.jobs.map((j) => j.id)).toContain(job.id);

    // Same fixture limitation as the address case above — phone is also a
    // fixed default in createCustomer() regardless of name.
    const byPhone = await request<{ jobs: { id: number }[] }>("/api/jobs?search=555-0100", auth);
    expect(byPhone.body.jobs.map((j) => j.id)).toContain(job.id);

    const noMatch = await request<{ jobs: { id: number }[] }>("/api/jobs?search=nonexistent-xyz", auth);
    expect(noMatch.body.jobs).toEqual([]);
  });

  it("adds job materials and returns them from job detail", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const job = await createJob(customer.id, "2026-04-01");
    const added = await post<{ ok: boolean }>(`/api/jobs/${job.id}/materials`, {
      material_id: 2,
      quantity: 2,
    }, auth);
    const detail = await request<{ job: { job_materials: Array<{ material_name: string; quantity: number; unit_cost: number }> } }>(
      `/api/jobs/${job.id}`, auth,
    );

    expect(added.body.ok).toBe(true);
    expect(detail.body.job.job_materials).toEqual([
      expect.objectContaining({ material_name: "Filter Replacement", quantity: 2, unit_cost: 25 }),
    ]);
  });

  it("creates invoices with calculated line and tax totals (integer cents, not floating-point dollars — see src/server/financial.ts)", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    const created = await post<{ id: number; identifier: string; subtotal_cents: number; tax_amount_cents: number; total_cents: number }>(
      "/api/invoices",
      {
        customer_id: customer.id,
        tax_rate: 5,
        due_date: "2026-05-31",
        lines: [
          { description: "Diagnostic", quantity: 1, unit_price_cents: 10000 },
          { description: "Part", quantity: 2, unit_price_cents: 2500 },
        ],
      },
      auth,
    );
    const detail = await request<{ invoice: { lines: unknown[]; total_cents: number } }>(`/api/invoices/${created.body.id}`, auth);

    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({ identifier: "INV-1", subtotal_cents: 15000, tax_amount_cents: 750, total_cents: 15750 });
    expect(detail.body.invoice.lines).toHaveLength(2);
    expect(detail.body.invoice.total_cents).toBe(15750);
  });

  it("returns arbitrary schedule ranges longer than seven days with inclusive boundaries", async () => {
    const auth = await authHeaders();
    const customer = await createCustomer();
    await createJob(customer.id, "2026-01-01");
    await createJob(customer.id, "2026-01-20");
    await createJob(customer.id, "2026-02-15");

    const schedule = await request<{ jobs: Array<{ scheduled_date: string }> }>(
      "/api/schedule?start=2026-01-01&end=2026-01-31", auth,
    );

    expect(schedule.response.status).toBe(200);
    expect(schedule.body.jobs.map((job) => job.scheduled_date)).toEqual(["2026-01-01", "2026-01-20"]);
  });
});
