import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applySchema, authHeaders, createCustomer, createJob, createUser, loginAs,
  mockGoogleApi, post, put, del, request, requestRaw, resetDatabase, satisfyCompletionRequirements,
  type GoogleMock,
} from "./helpers.js";

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

let google: GoogleMock | undefined;
afterEach(() => {
  google?.restore();
  google = undefined;
});

async function createTechnicianRow(adminAuth: RequestInit, name = "Compliance Tech") {
  const res = await post<{ id: number }>("/api/technicians", { name }, adminAuth);
  expect(res.response.status).toBe(201);
  return res.body;
}

async function createLinkedTechnician(email: string, adminAuth: RequestInit) {
  const user = await createUser({ email, password: "TechPass123", role: "technician" });
  const tech = await post<{ id: number }>("/api/technicians", { name: email, user_id: user.id }, adminAuth);
  expect(tech.response.status).toBe(201);
  const { cookie } = await loginAs(email, "TechPass123");
  return { userId: user.id, technicianId: tech.body.id, cookie };
}

async function assignTechnician(jobId: number, technicianId: number, adminAuth: RequestInit) {
  const res = await put(`/api/jobs/${jobId}`, { technician_id: technicianId }, adminAuth);
  expect(res.response.status).toBe(200);
}

async function jobInProgress(adminAuth: RequestInit, technicianId?: number) {
  const customer = await createCustomer();
  const job = await createJob(customer.id, "2026-09-01");
  const tech = technicianId ?? (await createTechnicianRow(adminAuth)).id;
  await assignTechnician(job.id, tech, adminAuth);
  const started = await post(`/api/jobs/${job.id}/transition`, { to_status: "in_progress" }, adminAuth);
  expect(started.response.status).toBe(200);
  return { jobId: job.id, technicianId: tech };
}

function uploadPhoto(jobId: number, kind: "pre_work_photo" | "post_work_photo", init: RequestInit) {
  const form = new FormData();
  form.append("kind", kind);
  form.append("file", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], `${kind}.jpg`, { type: "image/jpeg" }));
  const cookie = (init.headers as Record<string, string>).cookie;
  return request<{ id: number; kind: string }>(`/api/jobs/${jobId}/photos`, { method: "POST", headers: { cookie }, body: form });
}

const SIGNATURE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("completion gate — each requirement independently", () => {
  it("rejects completion with no pre-work photo", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    await uploadPhoto(jobId, "post_work_photo", auth);
    await put(`/api/jobs/${jobId}/completion-report`, { work_performed: "did the thing" }, auth);
    await post(`/api/jobs/${jobId}/completion-report/submit`, {}, auth);
    await post(`/api/jobs/${jobId}/signature`, { signer_name: "Jane", signature_data_url: SIGNATURE_DATA_URL }, auth);

    const result = await post<{ error: string }>(`/api/jobs/${jobId}/transition`, { to_status: "completed" }, auth);
    expect(result.response.status).toBe(400);
    expect(result.body.error).toContain("pre-work photo");
  });

  it("rejects completion with no post-work photo", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    await uploadPhoto(jobId, "pre_work_photo", auth);
    await put(`/api/jobs/${jobId}/completion-report`, { work_performed: "did the thing" }, auth);
    await post(`/api/jobs/${jobId}/completion-report/submit`, {}, auth);
    await post(`/api/jobs/${jobId}/signature`, { signer_name: "Jane", signature_data_url: SIGNATURE_DATA_URL }, auth);

    const result = await post<{ error: string }>(`/api/jobs/${jobId}/transition`, { to_status: "completed" }, auth);
    expect(result.response.status).toBe(400);
    expect(result.body.error).toContain("post-work photo");
  });

  it("rejects completion with no technician report at all", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    await uploadPhoto(jobId, "pre_work_photo", auth);
    await uploadPhoto(jobId, "post_work_photo", auth);
    await post(`/api/jobs/${jobId}/signature`, { signer_name: "Jane", signature_data_url: SIGNATURE_DATA_URL }, auth);

    const result = await post<{ error: string }>(`/api/jobs/${jobId}/transition`, { to_status: "completed" }, auth);
    expect(result.response.status).toBe(400);
    expect(result.body.error).toContain("technician report");
  });

  it("rejects completion when the report is only a draft (not submitted)", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    await uploadPhoto(jobId, "pre_work_photo", auth);
    await uploadPhoto(jobId, "post_work_photo", auth);
    const saved = await put<{ status: string }>(`/api/jobs/${jobId}/completion-report`, { work_performed: "did the thing" }, auth);
    expect(saved.body.status).toBe("draft");
    await post(`/api/jobs/${jobId}/signature`, { signer_name: "Jane", signature_data_url: SIGNATURE_DATA_URL }, auth);

    const result = await post<{ error: string }>(`/api/jobs/${jobId}/transition`, { to_status: "completed" }, auth);
    expect(result.response.status).toBe(400);
    expect(result.body.error).toContain("technician report");
  });

  it("rejects completion with no customer signature", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    await uploadPhoto(jobId, "pre_work_photo", auth);
    await uploadPhoto(jobId, "post_work_photo", auth);
    await put(`/api/jobs/${jobId}/completion-report`, { work_performed: "did the thing" }, auth);
    await post(`/api/jobs/${jobId}/completion-report/submit`, {}, auth);

    const result = await post<{ error: string }>(`/api/jobs/${jobId}/transition`, { to_status: "completed" }, auth);
    expect(result.response.status).toBe(400);
    expect(result.body.error).toContain("signature");
  });

  it("allows completion once every requirement is satisfied", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    await satisfyCompletionRequirements(jobId, auth);

    const check = await request<{ allowed: boolean }>(`/api/jobs/${jobId}/can-complete`, auth);
    expect(check.body.allowed).toBe(true);

    const result = await post(`/api/jobs/${jobId}/transition`, { to_status: "completed" }, auth);
    expect(result.response.status).toBe(200);
  });

  it("rejects a direct API bypass attempt — a malicious client cannot skip the mobile UI", async () => {
    // No photos, no report, no signature — just call the transition endpoint
    // directly, exactly as a client that never touched the mobile UI would.
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    const result = await post<{ error: string }>(`/api/jobs/${jobId}/transition`, { to_status: "completed" }, auth);
    expect(result.response.status).toBe(400);
    expect(result.body.error).toContain("Cannot complete job");
  });
});

describe("authorization — compliance data ownership", () => {
  it("lets the assigned technician upload/report/sign/complete for their own job", async () => {
    const auth = await authHeaders();
    const tech = await createLinkedTechnician("owns-job@example.test", auth);
    const { jobId } = await jobInProgress(auth, tech.technicianId);
    const techAuth: RequestInit = { headers: { cookie: tech.cookie } };

    await satisfyCompletionRequirements(jobId, techAuth);
    const result = await post(`/api/jobs/${jobId}/transition`, { to_status: "completed" }, techAuth);
    expect(result.response.status).toBe(200);
  });

  it("rejects a technician acting on another technician's job", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("tech-a@example.test", auth);
    const techB = await createLinkedTechnician("tech-b@example.test", auth);
    const { jobId } = await jobInProgress(auth, techA.technicianId);
    const techBAuth: RequestInit = { headers: { cookie: techB.cookie } };

    const upload = await uploadPhoto(jobId, "pre_work_photo", techBAuth);
    expect(upload.response.status).toBe(403);
    const report = await put(`/api/jobs/${jobId}/completion-report`, { work_performed: "x" }, techBAuth);
    expect(report.response.status).toBe(403);
    const sig = await post(`/api/jobs/${jobId}/signature`, { signer_name: "X", signature_data_url: SIGNATURE_DATA_URL }, techBAuth);
    expect(sig.response.status).toBe(403);
  });

  it("rejects a technician-role user with no linked technician profile", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    await createUser({ email: "unlinked-compliance@example.test", password: "UnlinkedPass1", role: "technician" });
    const { cookie } = await loginAs("unlinked-compliance@example.test", "UnlinkedPass1");
    const unlinkedAuth: RequestInit = { headers: { cookie } };

    const upload = await uploadPhoto(jobId, "pre_work_photo", unlinkedAuth);
    expect(upload.response.status).toBe(403);
  });

  it("lets a dispatcher act on any job's compliance data, not just their own", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    await createUser({ email: "dispatch-compliance@example.test", password: "DispatchPass1", role: "dispatcher" });
    const { cookie } = await loginAs("dispatch-compliance@example.test", "DispatchPass1");
    const dispatchAuth: RequestInit = { headers: { cookie } };

    const upload = await uploadPhoto(jobId, "pre_work_photo", dispatchAuth);
    expect(upload.response.status).toBe(201);
  });

  it("lets an admin act on any job's compliance data", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    const upload = await uploadPhoto(jobId, "pre_work_photo", auth);
    expect(upload.response.status).toBe(201);
  });

  // P1 fix, mem:risks/technician-job-read-scoping: this test previously
  // asserted the opposite (200 for an unrelated technician) as the expected
  // behavior — that was the vulnerability, not a spec. Updated to assert the
  // corrected, intended behavior: compliance reads are ownership-scoped
  // exactly like the mutations already were.
  it("blocks an unrelated technician from reading photos, report, signatures, and the compliance audit trail — only the assigned technician (or admin/dispatcher) may", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("read-a@example.test", auth);
    const techB = await createLinkedTechnician("read-b@example.test", auth);
    const { jobId } = await jobInProgress(auth, techA.technicianId);
    await satisfyCompletionRequirements(jobId, auth);

    const techAAuth: RequestInit = { headers: { cookie: techA.cookie } };
    const techBAuth: RequestInit = { headers: { cookie: techB.cookie } };

    // The assigned technician can read their own job's compliance data.
    expect((await request(`/api/jobs/${jobId}/photos`, techAAuth)).response.status).toBe(200);
    expect((await request(`/api/jobs/${jobId}/completion-report`, techAAuth)).response.status).toBe(200);
    expect((await request(`/api/jobs/${jobId}/signatures`, techAAuth)).response.status).toBe(200);
    expect((await request(`/api/jobs/${jobId}/compliance-audit`, techAAuth)).response.status).toBe(200);

    // An unrelated technician is blocked from all four, and gets no data back.
    const photos = await request<{ error?: string; photos?: unknown[] }>(`/api/jobs/${jobId}/photos`, techBAuth);
    expect(photos.response.status).toBe(403);
    expect(photos.body.photos).toBeUndefined();

    const report = await request<{ error?: string }>(`/api/jobs/${jobId}/completion-report`, techBAuth);
    expect(report.response.status).toBe(403);

    const signatures = await request<{ error?: string; signatures?: unknown[] }>(`/api/jobs/${jobId}/signatures`, techBAuth);
    expect(signatures.response.status).toBe(403);
    expect(signatures.body.signatures).toBeUndefined();

    const audit = await request<{ error?: string; audit?: unknown[] }>(`/api/jobs/${jobId}/compliance-audit`, techBAuth);
    expect(audit.response.status).toBe(403);
    expect(audit.body.audit).toBeUndefined();

    // The raw photo file itself is also blocked, not just the listing.
    const photoRow = await request<{ photos: { id: number }[] }>(`/api/jobs/${jobId}/photos`, techAAuth);
    const photoId = photoRow.body.photos[0].id;
    const fileRes = await request(`/api/jobs/${jobId}/photos/${photoId}/file`, techBAuth);
    expect(fileRes.response.status).toBe(403);

    // admin/dispatcher are unaffected.
    expect((await request(`/api/jobs/${jobId}/compliance-audit`, auth)).response.status).toBe(200);
  });
});

describe("media (photos)", () => {
  it("uploads and lists a photo with the correct metadata", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    const uploaded = await uploadPhoto(jobId, "pre_work_photo", auth);
    expect(uploaded.response.status).toBe(201);
    expect(uploaded.body).toMatchObject({ job_id: jobId, kind: "pre_work_photo", content_type: "image/jpeg" });

    const list = await request<{ photos: { id: number; kind: string }[] }>(`/api/jobs/${jobId}/photos`, auth);
    expect(list.body.photos).toHaveLength(1);
    expect(list.body.photos[0].kind).toBe("pre_work_photo");
  });

  it("serves the uploaded file back through the proxied download route", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    const uploaded = await uploadPhoto(jobId, "pre_work_photo", auth);
    const cookie = (auth.headers as Record<string, string>).cookie;
    const fileRes = await requestRaw(`/api/jobs/${jobId}/photos/${uploaded.body.id}/file`, { headers: { cookie } });
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("content-type")).toBe("image/jpeg");
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
  });

  it("rejects a non-image upload", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    const form = new FormData();
    form.append("kind", "pre_work_photo");
    form.append("file", new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" }));
    const cookie = (auth.headers as Record<string, string>).cookie;
    const result = await request<{ error: string }>(`/api/jobs/${jobId}/photos`, { method: "POST", headers: { cookie }, body: form });
    expect(result.response.status).toBe(400);
  });

  it("rejects an unknown photo kind", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    const form = new FormData();
    form.append("kind", "vacation_photo");
    form.append("file", new File([new Uint8Array([1, 2, 3])], "x.jpg", { type: "image/jpeg" }));
    const cookie = (auth.headers as Record<string, string>).cookie;
    const result = await request(`/api/jobs/${jobId}/photos`, { method: "POST", headers: { cookie }, body: form });
    expect(result.response.status).toBe(400);
  });

  it("soft-deletes a photo (excluded from list and from the completion count) before completion", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    const uploaded = await uploadPhoto(jobId, "pre_work_photo", auth);

    const deleted = await del(`/api/jobs/${jobId}/photos/${uploaded.body.id}`, auth);
    expect(deleted.response.status).toBe(200);

    const list = await request<{ photos: unknown[] }>(`/api/jobs/${jobId}/photos`, auth);
    expect(list.body.photos).toHaveLength(0);

    const check = await request<{ requirements: { key: string; satisfied: boolean }[] }>(`/api/jobs/${jobId}/can-complete`, auth);
    expect(check.body.requirements.find((r) => r.key === "pre_work_photos")?.satisfied).toBe(false);
  });

  it("rejects deleting compliance media once a job has been completed", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    await satisfyCompletionRequirements(jobId, auth);
    await post(`/api/jobs/${jobId}/transition`, { to_status: "completed" }, auth);

    const list = await request<{ photos: { id: number }[] }>(`/api/jobs/${jobId}/photos`, auth);
    const del1 = await del(`/api/jobs/${jobId}/photos/${list.body.photos[0].id}`, auth);
    expect(del1.response.status).toBe(400);
  });
});

describe("technician report", () => {
  it("creates a draft on first save and updates it on subsequent saves", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);

    const first = await put<{ status: string; work_performed: string }>(`/api/jobs/${jobId}/completion-report`, { work_performed: "step 1" }, auth);
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({ status: "draft", work_performed: "step 1" });

    const second = await put<{ work_performed: string }>(`/api/jobs/${jobId}/completion-report`, { work_performed: "step 1 and 2" }, auth);
    expect(second.body.work_performed).toBe("step 1 and 2");
  });

  it("submitting requires non-empty work_performed", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    const result = await post<{ error: string }>(`/api/jobs/${jobId}/completion-report/submit`, {}, auth);
    expect(result.response.status).toBe(400);
  });

  it("submitting sets status=submitted with an actor and timestamp", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    await put(`/api/jobs/${jobId}/completion-report`, { work_performed: "did it" }, auth);
    const submitted = await post<{ status: string; submitted_by: number | null; submitted_at: string | null }>(
      `/api/jobs/${jobId}/completion-report/submit`, {}, auth
    );
    expect(submitted.response.status).toBe(200);
    expect(submitted.body.status).toBe("submitted");
    expect(submitted.body.submitted_by).toBeTruthy();
    expect(submitted.body.submitted_at).toBeTruthy();
  });

  it("editing a submitted report reverts it to draft (must be resubmitted)", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    await put(`/api/jobs/${jobId}/completion-report`, { work_performed: "v1" }, auth);
    await post(`/api/jobs/${jobId}/completion-report/submit`, {}, auth);

    const edited = await put<{ status: string }>(`/api/jobs/${jobId}/completion-report`, { work_performed: "v2" }, auth);
    expect(edited.body.status).toBe("draft");
  });

  it("rejects report edits from an unauthorized technician", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("report-a@example.test", auth);
    const techB = await createLinkedTechnician("report-b@example.test", auth);
    const { jobId } = await jobInProgress(auth, techA.technicianId);
    const result = await put(`/api/jobs/${jobId}/completion-report`, { work_performed: "x" }, { headers: { cookie: techB.cookie } });
    expect(result.response.status).toBe(403);
  });
});

describe("customer signature", () => {
  it("captures a signature with signer name and relationship", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    const result = await post<{ signer_name: string; signer_relationship: string; captured_by: number | null }>(
      `/api/jobs/${jobId}/signature`,
      { signer_name: "John Homeowner", signer_relationship: "Owner", signature_data_url: SIGNATURE_DATA_URL },
      auth
    );
    expect(result.response.status).toBe(201);
    expect(result.body).toMatchObject({ signer_name: "John Homeowner", signer_relationship: "Owner" });
    expect(result.body.captured_by).toBeTruthy();
  });

  it("rejects a malformed signature payload", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    const result = await post(`/api/jobs/${jobId}/signature`, { signer_name: "X", signature_data_url: "not-a-data-url" }, auth);
    expect(result.response.status).toBe(400);
  });

  it("rejects signature capture from an unauthorized technician", async () => {
    const auth = await authHeaders();
    const techA = await createLinkedTechnician("sig-a@example.test", auth);
    const techB = await createLinkedTechnician("sig-b@example.test", auth);
    const { jobId } = await jobInProgress(auth, techA.technicianId);
    const result = await post(
      `/api/jobs/${jobId}/signature`, { signer_name: "X", signature_data_url: SIGNATURE_DATA_URL }, { headers: { cookie: techB.cookie } }
    );
    expect(result.response.status).toBe(403);
  });

  it("records an audit event for the capture", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    await post(`/api/jobs/${jobId}/signature`, { signer_name: "Jane", signature_data_url: SIGNATURE_DATA_URL }, auth);
    const audit = await request<{ audit: { event_type: string }[] }>(`/api/jobs/${jobId}/compliance-audit`, auth);
    expect(audit.body.audit.some((a) => a.event_type === "signature_captured")).toBe(true);
  });
});

describe("full compliance audit trail", () => {
  it("records every stage: upload, report save/submit, signature, and the completion attempt/success", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    await satisfyCompletionRequirements(jobId, auth);
    await post(`/api/jobs/${jobId}/transition`, { to_status: "completed" }, auth);

    const audit = await request<{ audit: { event_type: string }[] }>(`/api/jobs/${jobId}/compliance-audit`, auth);
    const types = audit.body.audit.map((a) => a.event_type);
    expect(types).toContain("photo_uploaded");
    expect(types).toContain("report_saved");
    expect(types).toContain("report_submitted");
    expect(types).toContain("signature_captured");
    expect(types).toContain("completion_attempted");
    expect(types).toContain("completion_succeeded");
  });

  it("records a completion_rejected event when a completion attempt fails the gate", async () => {
    const auth = await authHeaders();
    const { jobId } = await jobInProgress(auth);
    const result = await post(`/api/jobs/${jobId}/transition`, { to_status: "completed" }, auth);
    expect(result.response.status).toBe(400);

    const audit = await request<{ audit: { event_type: string }[] }>(`/api/jobs/${jobId}/compliance-audit`, auth);
    const types = audit.body.audit.map((a) => a.event_type);
    expect(types).toContain("completion_attempted");
    expect(types).toContain("completion_rejected");
    expect(types).not.toContain("completion_succeeded");
  });
});

describe("Google Calendar regression — completion does not introduce a second sync path", () => {
  async function connectGoogleCalendar(cookie: string) {
    const connectRes = await requestRaw("/api/integrations/google-calendar/connect", { headers: { cookie } });
    expect(connectRes.status).toBe(302);
    const authUrl = new URL(connectRes.headers.get("location")!);
    const state = authUrl.searchParams.get("state")!;
    const callbackRes = await requestRaw(
      `/api/integrations/google-calendar/callback?code=mock-auth-code&state=${state}`, { headers: { cookie } }
    );
    expect(callbackRes.status).toBe(302);
  }

  it("a completion transition still fires exactly one sync call, same as any other transition", async () => {
    google = mockGoogleApi();
    const auth = await authHeaders();
    const cookie = (auth.headers as Record<string, string>).cookie;
    await connectGoogleCalendar(cookie);

    const { jobId } = await jobInProgress(auth);
    await satisfyCompletionRequirements(jobId, auth);
    expect(google.state.events.size).toBe(1); // created on job creation

    google.state.calls = [];
    const result = await post(`/api/jobs/${jobId}/transition`, { to_status: "completed" }, auth);
    expect(result.response.status).toBe(200);

    const writeCalls = google.state.calls.filter((c) => c.method === "POST" || c.method === "PATCH");
    expect(writeCalls).toHaveLength(1);
    expect(google.state.events.size).toBe(1); // still exactly one event — no duplicate from completion
  });

  it("a rejected completion attempt triggers no Google Calendar sync at all", async () => {
    google = mockGoogleApi();
    const auth = await authHeaders();
    const cookie = (auth.headers as Record<string, string>).cookie;
    await connectGoogleCalendar(cookie);

    const { jobId } = await jobInProgress(auth);
    google.state.calls = [];
    const result = await post(`/api/jobs/${jobId}/transition`, { to_status: "completed" }, auth);
    expect(result.response.status).toBe(400);
    expect(google.state.calls).toHaveLength(0);
  });
});
