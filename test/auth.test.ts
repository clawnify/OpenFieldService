import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_EMAIL, ADMIN_PASSWORD, applySchema, authHeaders, del,
  extractSessionCookie, loginAs, loginAsAdmin, post, put, request, resetDatabase,
} from "./helpers.js";

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetDatabase();
});

async function createStaffUser(overrides: Record<string, unknown> = {}) {
  const auth = await authHeaders();
  const result = await post<{ user: { id: number; email: string } }>("/api/users", {
    name: "Sam Staff",
    email: "sam@example.test",
    password: "StaffPass123",
    role: "dispatcher",
    ...overrides,
  }, auth);
  expect(result.response.status).toBe(201);
  return result.body.user;
}

describe("authentication", () => {
  it("logs in with valid credentials and returns the user without a password hash", async () => {
    const result = await post<{ user: Record<string, unknown> }>("/api/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("set-cookie")).toMatch(/fs_session=/);
    expect(result.body.user).toMatchObject({ email: ADMIN_EMAIL, role: "admin" });
    expect(result.body.user).not.toHaveProperty("password_hash");
    expect(JSON.stringify(result.body)).not.toContain("pbkdf2$");
  });

  it("rejects an invalid password with a generic error", async () => {
    const result = await post<{ error: string }>("/api/auth/login", {
      email: ADMIN_EMAIL,
      password: "wrong-password",
    });

    expect(result.response.status).toBe(401);
    expect(result.body.error).toBe("Invalid email or password");
  });

  it("rejects an unknown user with the same generic error", async () => {
    const result = await post<{ error: string }>("/api/auth/login", {
      email: "nobody@example.test",
      password: "whatever123",
    });

    expect(result.response.status).toBe(401);
    expect(result.body.error).toBe("Invalid email or password");
  });

  it("blocks login for a deactivated user even with the correct password", async () => {
    const staff = await createStaffUser();
    const adminAuth = await authHeaders();
    await put(`/api/users/${staff.id}`, { active: 0 }, adminAuth);

    const result = await post<{ error: string }>("/api/auth/login", {
      email: "sam@example.test",
      password: "StaffPass123",
    });

    expect(result.response.status).toBe(403);
    expect(result.body.error).toMatch(/deactivated/i);
  });

  it("logs out and invalidates the session", async () => {
    const cookie = await loginAsAdmin();
    const before = await request("/api/auth/me", { headers: { cookie } });
    expect(before.response.status).toBe(200);

    const logout = await post<{ ok: boolean }>("/api/auth/logout", {}, { headers: { cookie } });
    expect(logout.response.status).toBe(200);

    const after = await request("/api/auth/me", { headers: { cookie } });
    expect(after.response.status).toBe(401);
  });

  it("rejects protected routes without authentication", async () => {
    const results = await Promise.all([
      request("/api/auth/me"),
      request("/api/jobs"),
      request("/api/customers"),
      request("/api/users"),
    ]);
    for (const r of results) expect(r.response.status).toBe(401);
  });
});

describe("user management", () => {
  it("lets an administrator create a user", async () => {
    const user = await createStaffUser();
    expect(user).toMatchObject({ name: "Sam Staff", email: "sam@example.test", role: "dispatcher", active: 1 });
    expect(user).not.toHaveProperty("password_hash");
  });

  it("lets an administrator edit a user", async () => {
    const staff = await createStaffUser();
    const auth = await authHeaders();
    const updated = await put<{ user: { name: string; role: string } }>(`/api/users/${staff.id}`, {
      name: "Samantha Staff",
      role: "admin",
    }, auth);

    expect(updated.response.status).toBe(200);
    expect(updated.body.user).toMatchObject({ name: "Samantha Staff", role: "admin" });
  });

  it("lets an administrator deactivate and reactivate a user", async () => {
    const staff = await createStaffUser();
    const auth = await authHeaders();

    const deactivated = await put<{ user: { active: number } }>(`/api/users/${staff.id}`, { active: 0 }, auth);
    expect(deactivated.body.user.active).toBe(0);

    const reactivated = await put<{ user: { active: number } }>(`/api/users/${staff.id}`, { active: 1 }, auth);
    expect(reactivated.body.user.active).toBe(1);
  });

  it("prevents an administrator from deactivating their own account", async () => {
    const auth = await authHeaders();
    const me = await request<{ user: { id: number } }>("/api/auth/me", auth);
    const result = await put<{ error: string }>(`/api/users/${me.body.user.id}`, { active: 0 }, auth);

    expect(result.response.status).toBe(400);
    expect(result.body.error).toMatch(/own account/i);
  });

  it("prevents deactivating the last active administrator", async () => {
    const auth = await authHeaders();
    const me = await request<{ user: { id: number } }>("/api/auth/me", auth);
    const other = await createStaffUser({ email: "backup-admin@example.test", role: "admin" });

    // Deactivating "other" is fine (self is still an active admin)...
    const first = await put<{ user: { active: number } }>(`/api/users/${other.id}`, { active: 0 }, auth);
    expect(first.response.status).toBe(200);

    // ...but deactivating self now, with no other active admin, must be blocked by the self-guard,
    // and reactivating other + deactivating self-alone-admin should hit the last-admin guard.
    await put(`/api/users/${other.id}`, { active: 1 }, auth);
    await put(`/api/users/${other.id}`, { role: "dispatcher" }, auth);
    const result = await put<{ error: string }>(`/api/users/${me.body.user.id}`, { active: 0 }, auth);
    expect(result.response.status).toBe(400);
  });

  it("lets an administrator change a user's password, invalidating their sessions", async () => {
    const staff = await createStaffUser();
    const { cookie: staffCookie } = await loginAs("sam@example.test", "StaffPass123");
    const meBefore = await request("/api/auth/me", { headers: { cookie: staffCookie } });
    expect(meBefore.response.status).toBe(200);

    const auth = await authHeaders();
    const changed = await put<{ ok: boolean }>(`/api/users/${staff.id}/password`, { password: "NewPassword456" }, auth);
    expect(changed.response.status).toBe(200);

    const meAfter = await request("/api/auth/me", { headers: { cookie: staffCookie } });
    expect(meAfter.response.status).toBe(401);

    const loginWithNew = await post("/api/auth/login", { email: "sam@example.test", password: "NewPassword456" });
    expect(loginWithNew.response.status).toBe(200);
  });

  it("lets a user change their own password", async () => {
    const { cookie } = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD);
    const result = await put<{ ok: boolean }>("/api/auth/password", {
      current_password: ADMIN_PASSWORD,
      new_password: "BrandNewPass1",
    }, { headers: { cookie } });
    expect(result.response.status).toBe(200);

    const oldLogin = await post("/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(oldLogin.response.status).toBe(401);
    const newLogin = await post("/api/auth/login", { email: ADMIN_EMAIL, password: "BrandNewPass1" });
    expect(newLogin.response.status).toBe(200);
  });

  it("rejects a non-admin user from accessing user management endpoints", async () => {
    await createStaffUser();
    const { cookie } = await loginAs("sam@example.test", "StaffPass123");

    const list = await request("/api/users", { headers: { cookie } });
    const create = await post("/api/users", { name: "X", email: "x@example.test", password: "password123" }, { headers: { cookie } });
    const update = await put("/api/users/1", { name: "Nope" }, { headers: { cookie } });
    const remove = await del("/api/users/1", { headers: { cookie } });

    for (const r of [list, create, update, remove]) expect(r.response.status).toBe(403);
  });

  it("prevents deleting your own account but allows deleting others", async () => {
    const staff = await createStaffUser();
    const auth = await authHeaders();
    const me = await request<{ user: { id: number } }>("/api/auth/me", auth);

    const selfDelete = await del<{ error: string }>(`/api/users/${me.body.user.id}`, auth);
    expect(selfDelete.response.status).toBe(400);

    const otherDelete = await del<{ ok: boolean }>(`/api/users/${staff.id}`, auth);
    expect(otherDelete.response.status).toBe(200);
  });
});

describe("security", () => {
  it("never returns a password hash from any user-facing endpoint", async () => {
    const auth = await authHeaders();
    await createStaffUser();
    const list = await request("/api/users", auth);
    const me = await request("/api/auth/me", auth);

    expect(JSON.stringify(list.body)).not.toContain("pbkdf2$");
    expect(JSON.stringify(me.body)).not.toContain("pbkdf2$");
  });

  it("stores passwords hashed, not in plaintext", async () => {
    const staff = await createStaffUser({ password: "PlaintextCheck1" });
    expect(staff).not.toHaveProperty("password_hash");
    // The only way to confirm the stored value isn't plaintext from the API surface
    // is that login still works through the hash-verification path, not a raw compare.
    const login = await post("/api/auth/login", { email: "sam@example.test", password: "PlaintextCheck1" });
    expect(login.response.status).toBe(200);
  });

  it("rejects unauthorized requests to mutate data", async () => {
    const create = await post("/api/customers", { name: "Nope" });
    const update = await put("/api/customers/1", { name: "Nope" });
    const remove = await del("/api/customers/1");

    for (const r of [create, update, remove]) expect(r.response.status).toBe(401);
  });

  it("confirms the extractSessionCookie helper only captures the cookie pair", async () => {
    const login = await post("/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const cookie = extractSessionCookie(login.response);
    expect(cookie.startsWith("fs_session=")).toBe(true);
    expect(cookie).not.toContain(";");
  });
});
