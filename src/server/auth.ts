import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import { get, run } from "./db.js";

export type Role = "admin" | "dispatcher" | "technician";

export interface UserRow {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  active: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  active: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

const SESSION_COOKIE = "fs_session";
const PBKDF2_ITERATIONS = 100_000;
const DEFAULT_SESSION_HOURS = 12;
const REMEMBER_SESSION_DAYS = 30;

// Valid-format hash with no real password behind it. Verifying against this
// on an unknown email keeps the login handler's timing consistent with a
// real user lookup, so failed logins don't reveal whether the email exists.
const DUMMY_HASH =
  "pbkdf2$100000$Xu1n2FZ3M-yQxvT8bC5jHw$k3Jc0y7VvQhY8p2mZ9tR1nL4wS6dF0xB7eK5aU2iP3oQ";

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** PBKDF2-SHA256 password hash, stored as `pbkdf2$<iterations>$<salt>$<hash>` (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const salt = fromBase64Url(parts[2]);
  const expected = fromBase64Url(parts[3]);
  const actual = await deriveBits(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

/** Same as verifyPassword, but falls back to a dummy hash when `stored` is missing (unknown user). */
export async function verifyPasswordOrDummy(password: string, stored: string | undefined): Promise<boolean> {
  return verifyPassword(password, stored ?? DUMMY_HASH);
}

function generateToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toBase64Url(new Uint8Array(digest));
}

export function sanitizeUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createSession(userId: number, remember: boolean): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const hours = remember ? REMEMBER_SESSION_DAYS * 24 : DEFAULT_SESSION_HOURS;
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  await run(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    [tokenHash, userId, expiresAt.toISOString()]
  );
  return { token, expiresAt };
}

function isHttps(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

export function setSessionCookie(c: Context, token: string, remember: boolean, expiresAt: Date): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: "Lax",
    path: "/",
    ...(remember ? { expires: expiresAt } : {}),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function getSessionUser(c: Context): Promise<PublicUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const session = await get<{ user_id: number; expires_at: string }>(
    "SELECT user_id, expires_at FROM sessions WHERE token_hash = ?",
    [tokenHash]
  );
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
    return null;
  }
  const row = await get<UserRow>("SELECT * FROM users WHERE id = ?", [session.user_id]);
  if (!row || !row.active) return null;
  return sanitizeUser(row);
}

export async function invalidateUserSessions(userId: number): Promise<void> {
  await run("DELETE FROM sessions WHERE user_id = ?", [userId]);
}

export async function logoutCurrentSession(c: Context): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const tokenHash = await hashToken(token);
    await run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
  }
  clearSessionCookie(c);
}
