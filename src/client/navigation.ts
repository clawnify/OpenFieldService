/**
 * Minimal, provider-agnostic navigation/contact-action abstraction for the
 * technician mobile experience (Phase 6). No MapService/provider-adapter
 * layer exists yet in this codebase (confirmed by audit) — that belongs to
 * the future Maps phase (`mem:project/fsm-upgrade-plan`). This file is
 * deliberately just three small pure functions, not a service class, so
 * callers depend on a narrow interface (`buildNavigationUrl`) rather than a
 * concrete map provider; swapping the implementation later (e.g. a native
 * app deep link) only touches this one file.
 *
 * Dependency-free (no Preact/JSX imports) so it can be unit-tested directly
 * under the Workers-pool test runtime, same precedent as
 * `signature-geometry.ts` (Phase 4 mobile-layout fix).
 */

/** Universal Google Maps directions link — opens the native Maps app on iOS/
 *  Android if installed, else the web app. Returns null for a blank address
 *  rather than building a useless maps link to nowhere. */
export function buildNavigationUrl(address: string): string | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(trimmed)}`;
}

/** Strips everything but digits and a leading "+" so tel:/sms: links work
 *  regardless of how the phone number happens to be formatted in the DB
 *  (e.g. "(604) 555-1234"). Returns null for a blank/unusable number. */
function normalizePhone(phone: string): string | null {
  const trimmed = phone.trim();
  if (!trimmed) return null;
  const normalized = (trimmed.startsWith("+") ? "+" : "") + trimmed.replace(/\D/g, "");
  return normalized.replace(/^\+?$/, "") ? normalized : null;
}

export function buildTelUrl(phone: string): string | null {
  const normalized = normalizePhone(phone);
  return normalized ? `tel:${normalized}` : null;
}

export function buildSmsUrl(phone: string): string | null {
  const normalized = normalizePhone(phone);
  return normalized ? `sms:${normalized}` : null;
}
