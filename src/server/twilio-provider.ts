/** Phase 15 — Twilio provider boundary.
 *
 *  Mirrors payment-provider.ts's shape (a typed interface + one concrete
 *  adapter + real HMAC signature verification, never a vendor SDK) so
 *  Twilio is never called directly from route handlers or scattered through
 *  business logic. Implemented with `fetch` + Web Crypto only — the `twilio`
 *  npm SDK's Node-specific dependencies are not a proven fit for the
 *  Cloudflare Workers runtime this app deploys to, and neither REST calls
 *  nor signature validation need it (Twilio's request-signing algorithm is
 *  publicly documented and small enough to implement directly, the same way
 *  this codebase already hand-rolls Google OAuth/Calendar HTTP calls rather
 *  than adopting `googleapis`).
 *
 *  This module ONLY talks to Twilio's plain HTTP webhook/REST surface
 *  (voice call creation, status callbacks, request-signature verification).
 *  It never touches a Media Stream WebSocket — that stays entirely on the
 *  separate Voice Engine runtime per the Phase 14-approved architecture. */

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

/** Verifies Twilio's `X-Twilio-Signature` header per Twilio's documented
 *  algorithm: HMAC-SHA1(authToken, url + sorted "key"+"value" pairs for
 *  POST/x-www-form-urlencoded params, no delimiter), base64-encoded,
 *  compared in constant time. `url` must be the EXACT URL Twilio requested
 *  (including query string, matching the scheme/host Twilio actually used —
 *  see the webhook route for how this is reconstructed behind a proxy).
 *  Returns false (never throws) on any malformed input — callers must
 *  treat false as "reject, do not act on this payload." */
export async function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) data += key + params[key];
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    const expected = Buffer.from(sig).toString("base64");
    return safeEqual(expected, signature);
  } catch {
    return false;
  }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Full XML attribute escaping — not just `&`. Nothing in this file's own
 *  call sites can inject `<`/`>`/`"` into `streamUrl` today (it's built
 *  from a trusted env var plus a `crypto.getRandomValues`-derived
 *  base64url token, whose alphabet has no XML metacharacters), but a
 *  function whose entire purpose is building an XML document from a
 *  dynamic string should escape correctly regardless — independent
 *  Security review finding. */
function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Minimal TwiML builder — just enough to point Twilio's Media Stream at
 *  the separate Voice Engine runtime for one specific, already-authorized
 *  call. `streamUrl` must be a `wss://` URL carrying the short-lived,
 *  call-scoped session token from `issueCallSession` (phone-operations.ts)
 *  — never a bare, unauthenticated endpoint. */
export function buildInboundStreamTwiML(streamUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${escapeXmlAttribute(streamUrl)}" /></Connect></Response>`;
}

/** A TwiML response for when Phone Operations refuses the call (operating
 *  mode not ACTIVE, inbound disabled, concurrency/daily cap reached) —
 *  says so briefly and hangs up, rather than silently failing the webhook
 *  and leaving the caller on a dead line. */
export function buildRejectedCallTwiML(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>We are unable to take your call right now. Please try again later.</Say><Hangup/></Response>`;
}

export interface CreateOutboundCallInput {
  to: string;
  from: string;
  statusCallbackUrl: string;
  twimlUrl: string;
}

export interface CreateOutboundCallResult {
  providerCallSid: string;
}

/** Places a real outbound call via Twilio's REST API. `twimlUrl` is the
 *  URL Twilio fetches once the callee answers (the OFS voice webhook
 *  route, same one inbound calls hit) — Twilio itself decides when to
 *  request it, so this function never builds TwiML directly. */
export async function createOutboundCall(creds: TwilioCredentials, input: CreateOutboundCallInput): Promise<CreateOutboundCallResult> {
  const body = new URLSearchParams({ To: input.to, From: input.from, Url: input.twimlUrl, StatusCallback: input.statusCallbackUrl, StatusCallbackEvent: "initiated ringing answered completed" });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Calls.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64")}`,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Twilio call creation failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = await res.json() as { sid: string };
  return { providerCallSid: json.sid };
}

/** Maps a Twilio `CallStatus` status-callback value to this app's own
 *  `CallStatus` vocabulary (phone-operations.ts) — kept as a single,
 *  explicit table rather than assuming the strings line up, since Twilio's
 *  vocabulary (`in-progress`, `no-answer`) uses hyphens this app's schema
 *  does not. */
const TWILIO_STATUS_MAP: Record<string, string> = {
  queued: "queued",
  initiated: "queued",
  ringing: "ringing",
  "in-progress": "in_progress",
  completed: "completed",
  busy: "busy",
  failed: "failed",
  "no-answer": "no_answer",
  canceled: "canceled",
};

export function mapTwilioCallStatus(twilioStatus: string): string | null {
  return TWILIO_STATUS_MAP[twilioStatus] ?? null;
}
