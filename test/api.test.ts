import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createUser, loginAs, mockGoogleGeocodingApi, mockGoogleRoutesApi,
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

  // Phase 10.1 — POST /api/jobs/{id}/geocode, the one narrow operational
  // trigger for real geocoding (mem:phase10/maps-routing-architecture-audit).
  // GEOCODING_PROVIDER is unset in the test environment (see wrangler.toml's
  // "none" default), so buildGeocodingProvider() selects NoopGeocodingProvider
  // for every test in this block UNLESS a test explicitly overrides `env` —
  // exercising the route/RBAC/persistence wiring here; the Google adapter's
  // own request/response/error behavior is covered by test/google-geocoding.test.ts.
  describe("Phase 10.1 — POST /api/jobs/{id}/geocode", () => {
    // worker-configuration.d.ts (wrangler-generated) is already stale
    // relative to wrangler.toml — it doesn't even know about the
    // pre-existing RESEND_FROM_ADDRESS var, let alone this phase's new
    // GEOCODING_PROVIDER/GOOGLE_MAPS_API_KEY. Same cast-through-unknown
    // pattern test/notification-dispatcher.test.ts already uses for the
    // identical situation (buildProviders(env as unknown as ...)).
    const geocodeEnv = env as unknown as { GEOCODING_PROVIDER?: string; GOOGLE_MAPS_API_KEY?: string };

    async function dispatcherAuth(email = "dispatch-geocode@example.test"): Promise<RequestInit> {
      await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
      const { cookie } = await loginAs(email, "DispatchPass1");
      return { headers: { cookie } };
    }

    async function technicianAuth(email = "tech-geocode@example.test"): Promise<RequestInit> {
      await createUser({ email, password: "TechPass123", role: "technician" });
      const { cookie } = await loginAs(email, "TechPass123");
      return { headers: { cookie } };
    }

    it("admin can trigger a geocode", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      const res = await post<{ ok: boolean; geocode_status: string }>(`/api/jobs/${job.id}/geocode`, {}, auth);
      expect(res.response.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("dispatcher can trigger a geocode", async () => {
      const auth = await dispatcherAuth();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      const res = await post<{ ok: boolean }>(`/api/jobs/${job.id}/geocode`, {}, auth);
      expect(res.response.status).toBe(200);
    });

    it("technician gets 403 BEFORE any job lookup or provider call — nonexistent job id still 403s, not 404", async () => {
      const auth = await technicianAuth();
      const res = await post(`/api/jobs/999999/geocode`, {}, auth);
      expect(res.response.status).toBe(403);
    });

    it("unauthenticated request gets 401", async () => {
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      const res = await post(`/api/jobs/${job.id}/geocode`, {});
      expect(res.response.status).toBe(401);
    });

    it("admin/dispatcher on a nonexistent job gets 404", async () => {
      const auth = await authHeaders();
      const res = await post(`/api/jobs/999999/geocode`, {}, auth);
      expect(res.response.status).toBe(404);
    });

    it("rejects a non-empty body (strict schema) — address/latitude/longitude/provider/api_key/actor_user_id/force injection all rejected", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      for (const injected of [
        { address: "999 Attacker Rd" },
        { latitude: 1, longitude: 1 },
        { provider: "google" },
        { api_key: "leaked" },
        { actor_user_id: 1 },
        { force: true },
      ]) {
        const res = await post(`/api/jobs/${job.id}/geocode`, injected, auth);
        expect(res.response.status).toBe(400);
      }
      // None of the rejected requests should have mutated the job at all.
      const rows = await queryDb<{ geocode_status: string; address: string }>(
        "SELECT geocode_status, address FROM jobs WHERE id = ?", [job.id]
      );
      expect(rows[0].geocode_status).toBe("pending");
      expect(rows[0].address).not.toBe("999 Attacker Rd");
    });

    it("a successful geocode persists coordinates and geocode_status via the real endpoint (mocked Google adapter selected via env)", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      const mock = mockGoogleGeocodingApi({ lat: 49.28, lng: -123.12 });
      const prevProvider = geocodeEnv.GEOCODING_PROVIDER;
      const prevKey = geocodeEnv.GOOGLE_MAPS_API_KEY;
      try {
        geocodeEnv.GEOCODING_PROVIDER = "google";
        geocodeEnv.GOOGLE_MAPS_API_KEY = "test-only-mock-key";
        const res = await post<{ ok: boolean; geocode_status: string; latitude: number; longitude: number }>(
          `/api/jobs/${job.id}/geocode`, {}, auth
        );
        expect(res.response.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, geocode_status: "geocoded", latitude: 49.28, longitude: -123.12 });
        expect(mock.state.calls).toHaveLength(1);
      } finally {
        geocodeEnv.GEOCODING_PROVIDER = prevProvider;
        geocodeEnv.GOOGLE_MAPS_API_KEY = prevKey;
        mock.restore();
      }
    });

    it("not_found (Noop's default) behavior persists geocode_status='failed'", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      // GEOCODING_PROVIDER is unset in this test env -> NoopGeocodingProvider
      // -> always not_found -> failed. This IS the real production-safe
      // default behavior when no real provider is configured.
      const res = await post<{ ok: boolean; geocode_status: string }>(`/api/jobs/${job.id}/geocode`, {}, auth);
      expect(res.response.status).toBe(200);
      expect(res.body.geocode_status).toBe("failed");
    });

    it("a transient provider failure (missing key while provider=google) leaves geocode_status='pending', not 'failed'", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      const prevProvider = geocodeEnv.GEOCODING_PROVIDER;
      const prevKey = geocodeEnv.GOOGLE_MAPS_API_KEY;
      try {
        geocodeEnv.GEOCODING_PROVIDER = "google";
        geocodeEnv.GOOGLE_MAPS_API_KEY = undefined;
        const res = await post<{ ok: boolean; geocode_status: string }>(`/api/jobs/${job.id}/geocode`, {}, auth);
        expect(res.response.status).toBe(200);
        expect(res.body.geocode_status).toBe("pending");
      } finally {
        geocodeEnv.GEOCODING_PROVIDER = prevProvider;
        geocodeEnv.GOOGLE_MAPS_API_KEY = prevKey;
      }
    });

    it("already-geocoded job (unchanged address) triggers ZERO provider calls — idempotency short-circuit", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      await geocodeJob(job.id, new MockGeocodingProvider({ status: "ok", latitude: 49.28, longitude: -123.12 }));

      const mock = mockGoogleGeocodingApi();
      const prevProvider = geocodeEnv.GEOCODING_PROVIDER;
      const prevKey = geocodeEnv.GOOGLE_MAPS_API_KEY;
      try {
        geocodeEnv.GEOCODING_PROVIDER = "google";
        geocodeEnv.GOOGLE_MAPS_API_KEY = "test-only-mock-key";
        const res = await post<{ ok: boolean; geocode_status: string; latitude: number; longitude: number }>(
          `/api/jobs/${job.id}/geocode`, {}, auth
        );
        expect(res.response.status).toBe(200);
        expect(res.body).toMatchObject({ geocode_status: "geocoded", latitude: 49.28, longitude: -123.12 });
        expect(mock.state.calls).toHaveLength(0);
      } finally {
        geocodeEnv.GEOCODING_PROVIDER = prevProvider;
        geocodeEnv.GOOGLE_MAPS_API_KEY = prevKey;
        mock.restore();
      }
    });

    it("changing the job's address afterward clears coordinates back to pending, and a subsequent geocode trigger DOES call the provider again", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      await geocodeJob(job.id, new MockGeocodingProvider({ status: "ok", latitude: 49.28, longitude: -123.12 }));

      const addressChange = await put(`/api/jobs/${job.id}`, { address: "500 New Rd, Surrey, BC" }, auth);
      expect(addressChange.response.status).toBe(200);
      const cleared = await queryDb<{ geocode_status: string }>("SELECT geocode_status FROM jobs WHERE id = ?", [job.id]);
      expect(cleared[0].geocode_status).toBe("pending");

      const mock = mockGoogleGeocodingApi({ lat: 49.1, lng: -122.8 });
      const prevProvider = geocodeEnv.GEOCODING_PROVIDER;
      const prevKey = geocodeEnv.GOOGLE_MAPS_API_KEY;
      try {
        geocodeEnv.GEOCODING_PROVIDER = "google";
        geocodeEnv.GOOGLE_MAPS_API_KEY = "test-only-mock-key";
        const res = await post<{ geocode_status: string }>(`/api/jobs/${job.id}/geocode`, {}, auth);
        expect(res.response.status).toBe(200);
        expect(res.body.geocode_status).toBe("geocoded");
        expect(mock.state.calls).toHaveLength(1);
      } finally {
        geocodeEnv.GEOCODING_PROVIDER = prevProvider;
        geocodeEnv.GOOGLE_MAPS_API_KEY = prevKey;
        mock.restore();
      }
    });

    it("has zero Calendar side effect (no calendar_event_mappings row created)", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      await post(`/api/jobs/${job.id}/geocode`, {}, auth);
      const mappings = await queryDb("SELECT * FROM calendar_event_mappings WHERE job_id = ?", [job.id]);
      expect(mappings).toHaveLength(0);
    });

    it("has zero Notification side effect (no additional notification_outbox row beyond the job-creation baseline)", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      const before = await queryDb("SELECT id FROM notification_outbox WHERE entity_type = 'job' AND entity_id = ?", [job.id]);
      await post(`/api/jobs/${job.id}/geocode`, {}, auth);
      const after = await queryDb("SELECT id FROM notification_outbox WHERE entity_type = 'job' AND entity_id = ?", [job.id]);
      expect(after).toHaveLength(before.length);
    });

    it("has zero Scheduler mutation (scheduled_date/time/duration/technician_id unchanged)", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25", { scheduled_time: "10:00", duration: 60 });
      const before = await queryDb<{ scheduled_date: string; scheduled_time: string; duration: number; technician_id: number | null }>(
        "SELECT scheduled_date, scheduled_time, duration, technician_id FROM jobs WHERE id = ?", [job.id]
      );
      await post(`/api/jobs/${job.id}/geocode`, {}, auth);
      const after = await queryDb<{ scheduled_date: string; scheduled_time: string; duration: number; technician_id: number | null }>(
        "SELECT scheduled_date, scheduled_time, duration, technician_id FROM jobs WHERE id = ?", [job.id]
      );
      expect(after[0]).toEqual(before[0]);
    });

    it("has zero financial/compliance mutation (no invoice, no compliance_audit row)", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      await post(`/api/jobs/${job.id}/geocode`, {}, auth);
      const invoices = await queryDb("SELECT * FROM invoices WHERE job_id = ?", [job.id]);
      const audit = await queryDb("SELECT * FROM job_compliance_audit WHERE job_id = ?", [job.id]);
      expect(invoices).toHaveLength(0);
      expect(audit).toHaveLength(0);
    });

    it("job status is never mutated by a geocode trigger", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      const before = await queryDb<{ status: string }>("SELECT status FROM jobs WHERE id = ?", [job.id]);
      await post(`/api/jobs/${job.id}/geocode`, {}, auth);
      const after = await queryDb<{ status: string }>("SELECT status FROM jobs WHERE id = ?", [job.id]);
      expect(after[0].status).toBe(before[0].status);
    });

    // Concurrency (Section 22) — two simultaneous first-time geocode calls
    // for the same pending job. No atomic claim exists (see the route
    // handler's own disclosed-residual-race comment) — this test proves the
    // ACTUAL behavior rather than assuming an exact-once guarantee: the job
    // always ends up in one valid, consistent final state (never partially
    // corrupted), and both concurrent requests get a 200 with matching
    // coordinates. It does NOT assert exactly one provider call, since that
    // is not guaranteed by this phase's architecture.
    it("two concurrent geocode requests for the same pending job both succeed and leave the job in one consistent final state", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-08-25");
      const mock = mockGoogleGeocodingApi({ lat: 49.5, lng: -123.5, delayMs: 20 });
      const prevProvider = geocodeEnv.GEOCODING_PROVIDER;
      const prevKey = geocodeEnv.GOOGLE_MAPS_API_KEY;
      try {
        geocodeEnv.GEOCODING_PROVIDER = "google";
        geocodeEnv.GOOGLE_MAPS_API_KEY = "test-only-mock-key";
        const [a, b] = await Promise.all([
          post<{ geocode_status: string }>(`/api/jobs/${job.id}/geocode`, {}, auth),
          post<{ geocode_status: string }>(`/api/jobs/${job.id}/geocode`, {}, auth),
        ]);
        expect(a.response.status).toBe(200);
        expect(b.response.status).toBe(200);
        expect(a.body.geocode_status).toBe("geocoded");
        expect(b.body.geocode_status).toBe("geocoded");
        const rows = await queryDb<{ latitude: number; longitude: number; geocode_status: string }>(
          "SELECT latitude, longitude, geocode_status FROM jobs WHERE id = ?", [job.id]
        );
        expect(rows[0]).toMatchObject({ latitude: 49.5, longitude: -123.5, geocode_status: "geocoded" });
        // Disclosed residual behavior: this may be 1 or 2, never more.
        expect(mock.state.calls.length).toBeGreaterThanOrEqual(1);
        expect(mock.state.calls.length).toBeLessThanOrEqual(2);
      } finally {
        geocodeEnv.GEOCODING_PROVIDER = prevProvider;
        geocodeEnv.GOOGLE_MAPS_API_KEY = prevKey;
        mock.restore();
      }
    });
  });

  // Phase 10.2 — Dispatcher Map UI (mem:phase10/maps-routing-architecture-audit).
  // No new job-data endpoint (Section 8's explicit "do not create
  // /api/map/all-jobs") — the existing GET /api/schedule response now
  // additionally carries latitude/longitude/geocode_status via JobSchema's
  // additive fields, and GET /api/config/maps is the one tiny new
  // (non-job-data) config-only route.
  describe("Phase 10.2 — Dispatcher Map data and config", () => {
    async function dispatcherAuth(email = "dispatch-map@example.test"): Promise<RequestInit> {
      await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
      const { cookie } = await loginAs(email, "DispatchPass1");
      return { headers: { cookie } };
    }

    async function technicianAuth(email = "tech-map@example.test"): Promise<RequestInit> {
      await createUser({ email, password: "TechPass123", role: "technician" });
      const { cookie } = await loginAs(email, "TechPass123");
      return { headers: { cookie } };
    }

    it("GET /api/schedule includes latitude/longitude/geocode_status for a geocoded job", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-09-05");
      await geocodeJob(job.id, new MockGeocodingProvider({ status: "ok", latitude: 49.28, longitude: -123.12 }));

      const res = await request<{ jobs: { id: number; latitude: number | null; longitude: number | null; geocode_status: string }[] }>(
        "/api/schedule?start=2026-09-01&end=2026-09-30", auth
      );
      const found = res.body.jobs.find((j) => j.id === job.id);
      expect(found).toMatchObject({ latitude: 49.28, longitude: -123.12, geocode_status: "geocoded" });
    });

    it("GET /api/schedule still includes a never-geocoded (pending) job, with null coordinates — never dropped, never fabricated", async () => {
      const auth = await authHeaders();
      const customer = await createCustomer();
      const job = await createJob(customer.id, "2026-09-06");

      const res = await request<{ jobs: { id: number; latitude: number | null; longitude: number | null; geocode_status: string }[] }>(
        "/api/schedule?start=2026-09-01&end=2026-09-30", auth
      );
      const found = res.body.jobs.find((j) => j.id === job.id);
      expect(found).toMatchObject({ latitude: null, longitude: null, geocode_status: "pending" });
    });

    it("a malformed date range does not 500 — returns 200 with a safely-empty or unaffected result", async () => {
      const auth = await authHeaders();
      const res = await request("/api/schedule?start=not-a-date&end=also-not-a-date", auth);
      expect(res.response.status).toBe(200);
    });

    describe("GET /api/config/maps", () => {
      // Every test in this block explicitly sets/clears GOOGLE_MAPS_BROWSER_API_KEY
      // itself, rather than assuming it's ambiently unset — a developer's
      // real local .dev.vars may legitimately have a real browser key
      // configured for their own manual testing (vitest-pool-workers reads
      // .dev.vars too), so the test must not depend on that being absent.
      const mapsEnvKey = env as unknown as { GOOGLE_MAPS_BROWSER_API_KEY?: string };

      it("admin gets a config response, never the server geocoding secret", async () => {
        const auth = await authHeaders();
        const prev = mapsEnvKey.GOOGLE_MAPS_BROWSER_API_KEY;
        try {
          mapsEnvKey.GOOGLE_MAPS_BROWSER_API_KEY = undefined;
          const res = await request<{ enabled: boolean; browserApiKey: string | null }>("/api/config/maps", auth);
          expect(res.response.status).toBe(200);
          expect(res.body).toEqual({ enabled: false, browserApiKey: null });
        } finally {
          mapsEnvKey.GOOGLE_MAPS_BROWSER_API_KEY = prev;
        }
      });

      it("dispatcher gets the same config response", async () => {
        const auth = await dispatcherAuth();
        const res = await request<{ enabled: boolean }>("/api/config/maps", auth);
        expect(res.response.status).toBe(200);
      });

      // Phase 10.3 — widened from 403 to 200: this config carries zero job
      // data and zero secrets (only GOOGLE_MAPS_BROWSER_API_KEY, never the
      // server geocoding secret), and the Technician Route View now
      // legitimately needs it to render its own map. See
      // mem:phase10/maps-routing-architecture-audit's Phase 10.3 section.
      it("technician also gets a config response (needed for the Technician Route View's own map)", async () => {
        const auth = await technicianAuth();
        const res = await request<{ enabled: boolean; browserApiKey: string | null }>("/api/config/maps", auth);
        expect(res.response.status).toBe(200);
      });

      it("unauthenticated gets 401", async () => {
        const res = await request("/api/config/maps");
        expect(res.response.status).toBe(401);
      });

      it("reflects a configured browser key distinctly from the server geocoding secret", async () => {
        const auth = await authHeaders();
        const prev = mapsEnvKey.GOOGLE_MAPS_BROWSER_API_KEY;
        try {
          mapsEnvKey.GOOGLE_MAPS_BROWSER_API_KEY = "test-only-mock-browser-key";
          const res = await request<{ enabled: boolean; browserApiKey: string | null }>("/api/config/maps", auth);
          expect(res.body).toEqual({ enabled: true, browserApiKey: "test-only-mock-browser-key" });
        } finally {
          mapsEnvKey.GOOGLE_MAPS_BROWSER_API_KEY = prev;
        }
      });
    });
  });

  // Phase 10.3 — Technician Route View (mem:phase10/maps-routing-architecture-audit).
  // ZERO new API endpoints — the dataset is the existing GET /api/schedule
  // (already technician-scoped, already carries lat/lng/geocode_status
  // since Phase 10.2) narrowed to a single day. These tests confirm that
  // exact combination (own-scoping + single-day range + geocode fields)
  // together, since Phase 10.2's own tests only exercised each piece
  // separately.
  describe("Phase 10.3 — Technician Route data scoping (GET /api/schedule, single-day)", () => {
    async function createLinkedTechnician(email: string, adminAuth: RequestInit) {
      const user = await createUser({ email, password: "TechPass123", role: "technician" });
      const tech = await post<{ id: number }>("/api/technicians", { name: email, user_id: user.id }, adminAuth);
      expect(tech.response.status).toBe(201);
      const { cookie } = await loginAs(email, "TechPass123");
      return { technicianId: tech.body.id, auth: { headers: { cookie } } as RequestInit };
    }

    it("a technician's own route day includes only their own jobs, with correct lat/lng/geocode_status", async () => {
      const auth = await authHeaders();
      const techA = await createLinkedTechnician("route-tech-a@example.test", auth);
      const techB = await createLinkedTechnician("route-tech-b@example.test", auth);
      const customer = await createCustomer();
      const routeDate = "2026-09-15";
      const jobA1 = await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "09:00" });
      const jobA2 = await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "13:00" });
      const jobB1 = await createJob(customer.id, routeDate, { technician_id: techB.technicianId, scheduled_time: "10:00" });
      await geocodeJob(jobA1.id, new MockGeocodingProvider({ status: "ok", latitude: 49.1, longitude: -123.1 }));

      const res = await request<{ jobs: { id: number; latitude: number | null; geocode_status: string }[] }>(
        `/api/schedule?start=${routeDate}&end=${routeDate}`, techA.auth
      );
      const ids = res.body.jobs.map((j) => j.id);
      expect(ids).toContain(jobA1.id);
      expect(ids).toContain(jobA2.id);
      expect(ids).not.toContain(jobB1.id); // IDOR: technician B's job never appears for technician A
      const found1 = res.body.jobs.find((j) => j.id === jobA1.id);
      expect(found1).toMatchObject({ latitude: 49.1, geocode_status: "geocoded" });
    });

    it("a technician cannot retrieve another technician's route via ?technician_id= override (IDOR)", async () => {
      const auth = await authHeaders();
      const techA = await createLinkedTechnician("route-tech-c@example.test", auth);
      const techB = await createLinkedTechnician("route-tech-d@example.test", auth);
      const customer = await createCustomer();
      const routeDate = "2026-09-16";
      const jobB = await createJob(customer.id, routeDate, { technician_id: techB.technicianId, scheduled_time: "09:00" });

      const res = await request<{ jobs: { id: number }[] }>(
        `/api/schedule?start=${routeDate}&end=${routeDate}&technician_id=${techB.technicianId}`, techA.auth
      );
      expect(res.body.jobs.map((j) => j.id)).not.toContain(jobB.id);
    });

    it("non-geocoded jobs are still included in the route day, never dropped, never fabricated", async () => {
      const auth = await authHeaders();
      const techA = await createLinkedTechnician("route-tech-e@example.test", auth);
      const customer = await createCustomer();
      const routeDate = "2026-09-17";
      const job = await createJob(customer.id, routeDate, { technician_id: techA.technicianId });

      const res = await request<{ jobs: { id: number; latitude: number | null; geocode_status: string }[] }>(
        `/api/schedule?start=${routeDate}&end=${routeDate}`, techA.auth
      );
      const found = res.body.jobs.find((j) => j.id === job.id);
      expect(found).toMatchObject({ latitude: null, geocode_status: "pending" });
    });

    it("unauthenticated request gets 401", async () => {
      const res = await request("/api/schedule?start=2026-09-15&end=2026-09-15");
      expect(res.response.status).toBe(401);
    });

    it("loading a technician's own route never triggers a server geocoding call", async () => {
      const auth = await authHeaders();
      const techA = await createLinkedTechnician("route-tech-f@example.test", auth);
      const customer = await createCustomer();
      const routeDate = "2026-09-18";
      await createJob(customer.id, routeDate, { technician_id: techA.technicianId });

      const before = await queryDb<{ c: number }>("SELECT COUNT(*) as c FROM jobs WHERE geocode_status = 'geocoded'");
      await request(`/api/schedule?start=${routeDate}&end=${routeDate}`, techA.auth);
      const after = await queryDb<{ c: number }>("SELECT COUNT(*) as c FROM jobs WHERE geocode_status = 'geocoded'");
      expect(after[0].c).toBe(before[0].c);
    });
  });

  // Phase 10.4 — GET /api/technician/route, the ONE paid-request trigger in
  // this codebase (mem:phase10/maps-routing-architecture-audit). ROUTING_PROVIDER
  // is unset in the test environment (wrangler.toml's "none" default), so
  // buildRoutingProvider() selects NoopRoutingProvider for every test here
  // UNLESS a test explicitly overrides `env` (same routingEnv cast pattern
  // test/api.test.ts's own Phase 10.1 block already uses for geocodeEnv) —
  // exercising the route/RBAC/cost-isolation wiring here; the Google
  // adapter's own request/response/error behavior is covered by
  // test/google-routing.test.ts, and routing.ts's own batching/ordering/
  // missing-coordinate logic by test/routing.test.ts.
  describe("Phase 10.4 — GET /api/technician/route", () => {
    const routingEnv = env as unknown as { ROUTING_PROVIDER?: string; GOOGLE_ROUTES_API_KEY?: string };

    async function createLinkedTechnician(email: string, adminAuth: RequestInit) {
      const user = await createUser({ email, password: "TechPass123", role: "technician" });
      const tech = await post<{ id: number }>("/api/technicians", { name: email, user_id: user.id }, adminAuth);
      expect(tech.response.status).toBe(201);
      const { cookie } = await loginAs(email, "TechPass123");
      return { technicianId: tech.body.id, auth: { headers: { cookie } } as RequestInit };
    }

    async function dispatcherAuth(email = "dispatch-route@example.test"): Promise<RequestInit> {
      await createUser({ email, password: "DispatchPass1", role: "dispatcher" });
      const { cookie } = await loginAs(email, "DispatchPass1");
      return { headers: { cookie } };
    }

    it("a technician's own route returns legs for their own scheduled stops only", async () => {
      const auth = await authHeaders();
      const techA = await createLinkedTechnician("route4-tech-a@example.test", auth);
      const techB = await createLinkedTechnician("route4-tech-b@example.test", auth);
      const customer = await createCustomer();
      const routeDate = "2026-10-05";
      const jobA1 = await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "09:00" });
      const jobA2 = await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "13:00" });
      await createJob(customer.id, routeDate, { technician_id: techB.technicianId, scheduled_time: "10:00" });
      await geocodeJob(jobA1.id, new MockGeocodingProvider({ status: "ok", latitude: 49.1, longitude: -123.1 }));
      await geocodeJob(jobA2.id, new MockGeocodingProvider({ status: "ok", latitude: 49.2, longitude: -123.2 }));

      // Force the provider OFF for this test's duration — never assume
      // ROUTING_PROVIDER is ambiently unset (a developer's real .dev.vars
      // may legitimately carry ROUTING_PROVIDER=google + a real key for
      // their own manual verification — vitest-pool-workers reads
      // .dev.vars too; see the identical Phase 10.2 fix precedent for
      // GOOGLE_MAPS_BROWSER_API_KEY). This test only cares about leg/order
      // shape, not the disabled-provider error code — see the dedicated
      // "provider disabled (default)" test below for that.
      const prevProvider = routingEnv.ROUTING_PROVIDER;
      const prevKey = routingEnv.GOOGLE_ROUTES_API_KEY;
      try {
        routingEnv.ROUTING_PROVIDER = undefined;
        routingEnv.GOOGLE_ROUTES_API_KEY = undefined;
        const res = await request<{ technician_id: number; legs: { from_job_id: number; to_job_id: number; status: string }[] }>(
          `/api/technician/route?date=${routeDate}`, techA.auth
        );
        expect(res.response.status).toBe(200);
        expect(res.body.technician_id).toBe(techA.technicianId);
        expect(res.body.legs).toEqual([{ from_job_id: jobA1.id, to_job_id: jobA2.id, status: "unavailable", error_code: "PROVIDER_UNAVAILABLE" }]);
      } finally {
        routingEnv.ROUTING_PROVIDER = prevProvider;
        routingEnv.GOOGLE_ROUTES_API_KEY = prevKey;
      }
    });

    it("a technician cannot route another technician's day via ?technician_id= override (IDOR)", async () => {
      const auth = await authHeaders();
      const techA = await createLinkedTechnician("route4-tech-c@example.test", auth);
      const techB = await createLinkedTechnician("route4-tech-d@example.test", auth);
      const customer = await createCustomer();
      const routeDate = "2026-10-06";
      const jobA = await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "09:00" });
      const jobB = await createJob(customer.id, routeDate, { technician_id: techB.technicianId, scheduled_time: "09:00" });

      const res = await request<{ technician_id: number; legs: unknown[] }>(
        `/api/technician/route?date=${routeDate}&technician_id=${techB.technicianId}`, techA.auth
      );
      expect(res.response.status).toBe(200);
      expect(res.body.technician_id).toBe(techA.technicianId); // forced to the caller's OWN id, never techB's
      expect(res.body.legs).toEqual([]); // techA has only 1 own job that day — techB's job never appears
      void jobA; void jobB;
    });

    it("query-string injection (extra params like origin_lat/origin_lng) never influences the computed route — only date/technician_id are read", async () => {
      const auth = await authHeaders();
      const techA = await createLinkedTechnician("route4-tech-inj@example.test", auth);
      const customer = await createCustomer();
      const routeDate = "2026-10-07";
      await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "09:00" });

      const clean = await request(`/api/technician/route?date=${routeDate}`, techA.auth);
      const injected = await request(
        `/api/technician/route?date=${routeDate}&origin_lat=1&origin_lng=2&address=999+Attacker+Rd&provider=fake`, techA.auth
      );
      expect(injected.response.status).toBe(200);
      expect(injected.body).toEqual(clean.body);
    });

    it("admin can route a specific technician/day", async () => {
      const auth = await authHeaders();
      const techA = await createLinkedTechnician("route4-tech-admin@example.test", auth);
      const customer = await createCustomer();
      const routeDate = "2026-10-08";
      await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "09:00" });

      const res = await request<{ technician_id: number }>(`/api/technician/route?date=${routeDate}&technician_id=${techA.technicianId}`, auth);
      expect(res.response.status).toBe(200);
      expect(res.body.technician_id).toBe(techA.technicianId);
    });

    it("dispatcher can route a specific technician/day", async () => {
      const auth = await authHeaders();
      const dAuth = await dispatcherAuth();
      const techA = await createLinkedTechnician("route4-tech-dispatch@example.test", auth);
      const customer = await createCustomer();
      const routeDate = "2026-10-09";
      await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "09:00" });

      const res = await request<{ technician_id: number }>(`/api/technician/route?date=${routeDate}&technician_id=${techA.technicianId}`, dAuth);
      expect(res.response.status).toBe(200);
    });

    it("admin/dispatcher without technician_id gets 400 — this endpoint never sweeps a company-wide/multi-technician route", async () => {
      const auth = await authHeaders();
      const res = await request(`/api/technician/route?date=2026-10-10`, auth);
      expect(res.response.status).toBe(400);
    });

    it("unauthenticated request gets 401", async () => {
      const res = await request(`/api/technician/route?date=2026-10-11&technician_id=1`);
      expect(res.response.status).toBe(401);
    });

    it("an invalid date format gets 400, never a raw 500", async () => {
      const auth = await authHeaders();
      const res = await request(`/api/technician/route?date=not-a-date&technician_id=1`, auth);
      expect(res.response.status).toBe(400);
    });

    it("provider disabled (default) — every leg reports unavailable/PROVIDER_UNAVAILABLE, the route stays fully renderable", async () => {
      const auth = await authHeaders();
      const techA = await createLinkedTechnician("route4-tech-disabled@example.test", auth);
      const customer = await createCustomer();
      const routeDate = "2026-10-12";
      const j1 = await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "09:00" });
      const j2 = await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "10:00" });
      await geocodeJob(j1.id, new MockGeocodingProvider({ status: "ok", latitude: 49.1, longitude: -123.1 }));
      await geocodeJob(j2.id, new MockGeocodingProvider({ status: "ok", latitude: 49.2, longitude: -123.2 }));

      // Force ROUTING_PROVIDER OFF regardless of what a developer's real
      // .dev.vars carries (see the identical override in the first test in
      // this describe block) — this is the one test whose entire point is
      // asserting the disabled-provider behavior, so it must not silently
      // pass-through to (or worse, actually invoke) a real configured
      // provider just because the ambient environment happens to have one.
      const prevProvider = routingEnv.ROUTING_PROVIDER;
      const prevKey = routingEnv.GOOGLE_ROUTES_API_KEY;
      try {
        routingEnv.ROUTING_PROVIDER = undefined;
        routingEnv.GOOGLE_ROUTES_API_KEY = undefined;
        const res = await request<{ legs: { status: string; error_code?: string }[]; total_distance_meters: number | null }>(
          `/api/technician/route?date=${routeDate}`, techA.auth
        );
        expect(res.body.legs).toEqual([{ from_job_id: j1.id, to_job_id: j2.id, status: "unavailable", error_code: "PROVIDER_UNAVAILABLE" }]);
        expect(res.body.total_distance_meters).toBeNull();
      } finally {
        routingEnv.ROUTING_PROVIDER = prevProvider;
        routingEnv.GOOGLE_ROUTES_API_KEY = prevKey;
      }
    });

    it("provider configured but key missing — fails safely as PROVIDER_AUTH_ERROR, no crash, no secret-shaped error", async () => {
      const auth = await authHeaders();
      const techA = await createLinkedTechnician("route4-tech-nokey@example.test", auth);
      const customer = await createCustomer();
      const routeDate = "2026-10-13";
      const j1 = await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "09:00" });
      const j2 = await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "10:00" });
      await geocodeJob(j1.id, new MockGeocodingProvider({ status: "ok", latitude: 49.1, longitude: -123.1 }));
      await geocodeJob(j2.id, new MockGeocodingProvider({ status: "ok", latitude: 49.2, longitude: -123.2 }));

      const prevProvider = routingEnv.ROUTING_PROVIDER;
      const prevKey = routingEnv.GOOGLE_ROUTES_API_KEY;
      try {
        routingEnv.ROUTING_PROVIDER = "google";
        routingEnv.GOOGLE_ROUTES_API_KEY = undefined;
        const res = await request<{ legs: { status: string; error_code?: string }[] }>(`/api/technician/route?date=${routeDate}`, techA.auth);
        expect(res.response.status).toBe(200);
        expect(res.body.legs[0].status).toBe("unavailable");
        expect(res.body.legs[0].error_code).toBe("PROVIDER_AUTH_ERROR");
        expect(JSON.stringify(res.body)).not.toMatch(/AIza|api[_-]?key/i);
      } finally {
        routingEnv.ROUTING_PROVIDER = prevProvider;
        routingEnv.GOOGLE_ROUTES_API_KEY = prevKey;
      }
    });

    it("a real computed route (mocked Google adapter selected via env) returns ok legs with distance/duration and a real total", async () => {
      const auth = await authHeaders();
      const techA = await createLinkedTechnician("route4-tech-real@example.test", auth);
      const customer = await createCustomer();
      const routeDate = "2026-10-14";
      const j1 = await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "09:00" });
      const j2 = await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "10:00" });
      await geocodeJob(j1.id, new MockGeocodingProvider({ status: "ok", latitude: 49.1, longitude: -123.1 }));
      await geocodeJob(j2.id, new MockGeocodingProvider({ status: "ok", latitude: 49.2, longitude: -123.2 }));

      const mock = mockGoogleRoutesApi({ legDistances: [12400], legDurations: [1080] });
      const prevProvider = routingEnv.ROUTING_PROVIDER;
      const prevKey = routingEnv.GOOGLE_ROUTES_API_KEY;
      try {
        routingEnv.ROUTING_PROVIDER = "google";
        routingEnv.GOOGLE_ROUTES_API_KEY = "test-only-mock-key";
        const res = await request<{ legs: { status: string; distance_meters?: number; duration_seconds?: number }[]; total_distance_meters: number | null }>(
          `/api/technician/route?date=${routeDate}`, techA.auth
        );
        expect(res.body.legs).toEqual([{ from_job_id: j1.id, to_job_id: j2.id, status: "ok", distance_meters: 12400, duration_seconds: 1080 }]);
        expect(res.body.total_distance_meters).toBe(12400);
        expect(mock.state.calls).toHaveLength(1);
      } finally {
        routingEnv.ROUTING_PROVIDER = prevProvider;
        routingEnv.GOOGLE_ROUTES_API_KEY = prevKey;
        mock.restore();
      }
    });

    it("never triggers a server geocoding call, never mutates jobs/schedule, never touches Calendar or Notifications", async () => {
      const auth = await authHeaders();
      const techA = await createLinkedTechnician("route4-tech-isolation@example.test", auth);
      const customer = await createCustomer();
      const routeDate = "2026-10-15";
      const j1 = await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "09:00" });
      const j2 = await createJob(customer.id, routeDate, { technician_id: techA.technicianId, scheduled_time: "10:00" });

      const before = await queryDb<{ id: number; scheduled_date: string; scheduled_time: string; technician_id: number; status: string; geocode_status: string }>(
        "SELECT id, scheduled_date, scheduled_time, technician_id, status, geocode_status FROM jobs WHERE id IN (?, ?) ORDER BY id", [j1.id, j2.id]
      );
      const outboxBefore = await queryDb<{ c: number }>("SELECT COUNT(*) as c FROM notification_outbox");
      const calendarBefore = await queryDb<{ c: number }>("SELECT COUNT(*) as c FROM calendar_event_mappings");

      await request(`/api/technician/route?date=${routeDate}`, techA.auth);

      const after = await queryDb<{ id: number; scheduled_date: string; scheduled_time: string; technician_id: number; status: string; geocode_status: string }>(
        "SELECT id, scheduled_date, scheduled_time, technician_id, status, geocode_status FROM jobs WHERE id IN (?, ?) ORDER BY id", [j1.id, j2.id]
      );
      const outboxAfter = await queryDb<{ c: number }>("SELECT COUNT(*) as c FROM notification_outbox");
      const calendarAfter = await queryDb<{ c: number }>("SELECT COUNT(*) as c FROM calendar_event_mappings");

      expect(after).toEqual(before);
      expect(outboxAfter[0].c).toBe(outboxBefore[0].c);
      expect(calendarAfter[0].c).toBe(calendarBefore[0].c);
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

  it("creates invoices with calculated line and tax totals (integer cents, not floating-point dollars — see src/server/financial.ts). Phase 13D: tax is resolved from the org's Tax Profile, no longer a client-supplied tax_rate — see test/financial.test.ts's dedicated Tax & Jurisdiction integration coverage for that behavior; a client-supplied tax_rate here is simply ignored.", async () => {
    const auth = await authHeaders();
    await post("/api/tax-profile", {
      tax_enabled: true, country_code: "CA", region_code: "AB", currency: "CAD", prices_include_tax: false, default_taxable: true,
      components: [{ code: "GST", name: "GST", rate_percent: 5 }],
    }, auth);
    const customer = await createCustomer();
    const created = await post<{ id: number; identifier: string; subtotal_cents: number; tax_amount_cents: number; total_cents: number }>(
      "/api/invoices",
      {
        customer_id: customer.id,
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
