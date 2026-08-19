import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  authHeaders, del, loginAs, post, put, queryDb, request, resetDatabase, applySchema, createUser,
} from "./helpers.js";

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

describe("global settings", () => {
  it("lets an admin create a setting and read it back", async () => {
    const auth = await authHeaders();
    const created = await post<{ setting: { key: string; value: string } }>("/api/settings", {
      key: "CLEANBC_INCOME_THRESHOLD",
      value: "120000",
      data_type: "number",
      category: "cleanbc",
      description: "Maximum household income for CleanBC eligibility",
    }, auth);
    expect(created.response.status).toBe(201);
    expect(created.body.setting).toMatchObject({ key: "CLEANBC_INCOME_THRESHOLD", value: "120000" });

    const list = await request<{ settings: { key: string }[] }>("/api/settings", auth);
    expect(list.body.settings.map((s) => s.key)).toContain("CLEANBC_INCOME_THRESHOLD");
  });

  it("filters by category", async () => {
    const auth = await authHeaders();
    await post("/api/settings", { key: "A", value: "1", data_type: "number", category: "cleanbc" }, auth);
    await post("/api/settings", { key: "B", value: "2", data_type: "number", category: "bc_hydro" }, auth);

    const cleanbc = await request<{ settings: { key: string }[] }>("/api/settings?category=cleanbc", auth);
    expect(cleanbc.body.settings.map((s) => s.key)).toEqual(["A"]);
  });

  it("rejects a non-admin from creating, publishing, or retiring settings", async () => {
    await createUser({ email: "dispatch@example.test", password: "DispatchPass1", role: "dispatcher" });
    const { cookie } = await loginAs("dispatch@example.test", "DispatchPass1");

    const create = await post("/api/settings", { key: "X", value: "1", data_type: "number" }, { headers: { cookie } });
    expect(create.response.status).toBe(403);

    const auth = await authHeaders();
    await post("/api/settings", { key: "X", value: "1", data_type: "number" }, auth);
    const retire = await del("/api/settings/X", { headers: { cookie } });
    expect(retire.response.status).toBe(403);
  });

  it("validates value against data_type", async () => {
    const auth = await authHeaders();
    const badNumber = await post<{ error: string }>("/api/settings", { key: "N", value: "abc", data_type: "number" }, auth);
    expect(badNumber.response.status).toBe(400);

    const badBool = await post<{ error: string }>("/api/settings", { key: "B", value: "yes", data_type: "boolean" }, auth);
    expect(badBool.response.status).toBe(400);

    const badJson = await post<{ error: string }>("/api/settings", { key: "J", value: "{not json", data_type: "json" }, auth);
    expect(badJson.response.status).toBe(400);
  });

  it("publishing a new version closes out the old one instead of mutating it, preserving history", async () => {
    const auth = await authHeaders();
    await post("/api/settings", {
      key: "CLEANBC_HOUSE_SIZE_THRESHOLD", value: "1800", data_type: "number", category: "cleanbc",
    }, auth);

    const later = new Date(Date.now() + 60_000).toISOString();
    const publishNew = await post<{ setting: { value: string } }>("/api/settings", {
      key: "CLEANBC_HOUSE_SIZE_THRESHOLD", value: "2000", data_type: "number", effective_from: later,
    }, auth);
    expect(publishNew.response.status).toBe(201);
    expect(publishNew.body.setting.value).toBe("2000");

    const rows = await queryDb<{ value: string; effective_until: string | null }>(
      "SELECT value, effective_until FROM global_settings WHERE key = ? ORDER BY effective_from ASC",
      ["CLEANBC_HOUSE_SIZE_THRESHOLD"]
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].value).toBe("1800");
    expect(rows[0].effective_until).not.toBeNull(); // old version closed, not deleted or overwritten
    expect(rows[1].value).toBe("2000");
    expect(rows[1].effective_until).toBeNull(); // new version open-ended

    // The list endpoint (current-as-of-now) still reports the OLD value, because the
    // new version isn't effective until 60s from now — nothing retroactively changed.
    const current = await request<{ settings: { key: string; value: string }[] }>("/api/settings", auth);
    const setting = current.body.settings.find((s) => s.key === "CLEANBC_HOUSE_SIZE_THRESHOLD");
    expect(setting?.value).toBe("1800");
  });

  it("rejects publishing a version effective before the current one", async () => {
    const auth = await authHeaders();
    await post("/api/settings", { key: "K", value: "1", data_type: "number" }, auth);
    const past = new Date(Date.now() - 60_000).toISOString();
    const result = await post<{ error: string }>("/api/settings", { key: "K", value: "2", data_type: "number", effective_from: past }, auth);
    expect(result.response.status).toBe(400);
  });

  it("returns full version history for a key", async () => {
    const auth = await authHeaders();
    await post("/api/settings", { key: "H", value: "1", data_type: "number" }, auth);
    await post("/api/settings", { key: "H", value: "2", data_type: "number" }, auth);

    const history = await request<{ history: { value: string }[] }>("/api/settings/H/history", auth);
    expect(history.response.status).toBe(200);
    expect(history.body.history.map((h) => h.value)).toEqual(["2", "1"]);
  });

  it("retires a setting so it stops resolving, without deleting its history", async () => {
    const auth = await authHeaders();
    await post("/api/settings", { key: "R", value: "1", data_type: "number" }, auth);

    const retire = await del<{ ok: boolean }>("/api/settings/R", auth);
    expect(retire.response.status).toBe(200);

    const current = await request<{ settings: { key: string }[] }>("/api/settings", auth);
    expect(current.body.settings.map((s) => s.key)).not.toContain("R");

    const history = await request<{ history: unknown[] }>("/api/settings/R/history", auth);
    expect(history.body.history).toHaveLength(1);

    const retireAgain = await del("/api/settings/R", auth);
    expect(retireAgain.response.status).toBe(404);
  });
});

describe("technician login linkage", () => {
  it("links a technician to a technician-role user", async () => {
    const auth = await authHeaders();
    const tech = await createUser({ email: "tech1@example.test", password: "TechPass123", role: "technician" });

    const created = await post<{ id: number; user_id: number | null; user_email: string | null }>(
      "/api/technicians", { name: "Tech One", user_id: tech.id }, auth
    );
    expect(created.response.status).toBe(201);
    expect(created.body.user_id).toBe(tech.id);

    const list = await request<{ technicians: { name: string; user_email: string | null }[] }>("/api/technicians", auth);
    const row = list.body.technicians.find((t) => t.name === "Tech One");
    expect(row?.user_email).toBe("tech1@example.test");
  });

  it("rejects linking a non-technician-role user", async () => {
    const auth = await authHeaders();
    const dispatcher = await createUser({ email: "dispatch2@example.test", password: "DispatchPass1", role: "dispatcher" });
    const result = await post<{ error: string }>("/api/technicians", { name: "Bad Link", user_id: dispatcher.id }, auth);
    expect(result.response.status).toBe(400);
  });

  it("rejects linking the same user to two technician profiles", async () => {
    const auth = await authHeaders();
    const tech = await createUser({ email: "tech2@example.test", password: "TechPass123", role: "technician" });
    const first = await post<{ id: number }>("/api/technicians", { name: "Tech Two", user_id: tech.id }, auth);
    expect(first.response.status).toBe(201);

    const second = await post<{ error: string }>("/api/technicians", { name: "Tech Two Duplicate", user_id: tech.id }, auth);
    expect(second.response.status).toBe(400);
  });

  it("rejects linking a nonexistent user id", async () => {
    const auth = await authHeaders();
    const result = await post<{ error: string }>("/api/technicians", { name: "Ghost Link", user_id: 999999 }, auth);
    expect(result.response.status).toBe(400);
  });

  it("allows unlinking a technician via update", async () => {
    const auth = await authHeaders();
    const tech = await createUser({ email: "tech3@example.test", password: "TechPass123", role: "technician" });
    const created = await post<{ id: number }>("/api/technicians", { name: "Tech Three", user_id: tech.id }, auth);

    const updated = await put("/api/technicians/" + created.body.id, { user_id: null }, auth);
    expect(updated.response.status).toBe(200);

    const list = await request<{ technicians: { id: number; user_id: number | null }[] }>("/api/technicians", auth);
    const row = list.body.technicians.find((t) => t.id === created.body.id);
    expect(row?.user_id).toBeNull();
  });
});

describe("role migration", () => {
  it("no longer accepts the legacy \"staff\" role value", async () => {
    const auth = await authHeaders();
    const result = await post<{ error?: unknown }>("/api/users", {
      name: "Legacy Role", email: "legacy@example.test", password: "LegacyPass123", role: "staff",
    }, auth);
    expect(result.response.status).toBe(400);
  });

  it("accepts the three current roles", async () => {
    const auth = await authHeaders();
    for (const role of ["admin", "dispatcher", "technician"] as const) {
      const result = await post<{ user: { role: string } }>("/api/users", {
        name: `User ${role}`, email: `${role}@example.test`, password: "SomePass123", role,
      }, auth);
      expect(result.response.status).toBe(201);
      expect(result.body.user.role).toBe(role);
    }
  });
});
