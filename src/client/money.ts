/** The server represents every monetary value as integer cents (see
 *  src/server/financial.ts) — this is the one place the client converts that
 *  to a display dollar string. Never do cents/100 formatting inline in a
 *  component; import this instead so every amount in the app is formatted
 *  identically. Matches the plain "$X.XX" style already used everywhere else
 *  in this codebase (job price, invoice totals before Phase 5) rather than
 *  introducing locale-aware Intl formatting as a one-off. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** Phase 8.4 — Lead estimated_value_cents input. Parses a dollar-amount
 *  input string ("$1,250.00", "1250", "1250.5") into integer cents WITHOUT
 *  floating-point corruption — strips currency formatting, splits on the
 *  decimal point, and works in integers throughout. Never multiplies a
 *  float by 100 (the exact operation that corrupts values like
 *  19.99 -> 1998.9999999999998 in IEEE 754). Returns null for a blank or
 *  unparseable input — never NaN, never 0 as a silent stand-in for
 *  "invalid," so the caller can distinguish "no value entered" from "zero
 *  dollars entered." */
export function parseDollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[^0-9.]/g, "").trim();
  if (!cleaned) return null;
  const parts = cleaned.split(".");
  if (parts.length > 2) return null;
  const [wholePart, fracPart = ""] = parts;
  const whole = wholePart ? parseInt(wholePart, 10) : 0;
  if (Number.isNaN(whole)) return null;
  const fracDigits = (fracPart + "00").slice(0, 2);
  const fracCents = parseInt(fracDigits, 10);
  if (Number.isNaN(fracCents)) return null;
  return whole * 100 + fracCents;
}

/** The inverse of parseDollarsToCents(), for pre-filling an editable money
 *  input (not a read-only display — see formatCents() above for that). */
export function formatCentsForInput(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toFixed(2);
}
