import { get, run } from "./db.js";
import { assertUploadAllowed, deleteObject, getObject, putObject, StorageError, type StorageEnv } from "./storage.js";

/**
 * Phase 13A hardening — Company Profile: the canonical, tenant-specific
 * source of business identity (name, contact, address, business/tax
 * identifiers, a default Contract footer) used by generated documents.
 * Currently consumed only by the Contracts/E-Sign signed PDF
 * (contracts.ts#buildCompanySnapshot / contract-pdf.ts) — see this module's
 * migration header (0019) for why this is a dedicated table rather than a
 * `global_settings` key, and docs/PLATFORM-GENERALIZATION-AUDIT.md's
 * addendum for the full rationale. Future reuse (Quote PDFs, invoices,
 * email templates, reports) is a deliberate design goal but NOT
 * implemented this pass.
 *
 * One row per organization, plain UPDATE semantics — no versioning. The
 * "don't retroactively alter a signed document" guarantee this feature
 * needs comes entirely from Contract creation snapshotting the CURRENT
 * profile into the already-immutable `contract_versions.company_snapshot`
 * column, not from anything in this module.
 */

export interface CompanyProfile {
  organization_id: number;
  company_name: string;
  legal_name: string;
  phone: string;
  email: string;
  website: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  business_number: string;
  tax_number: string;
  contract_footer: string;
  logo_key: string | null;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
}

const PROFILE_COLUMNS =
  "organization_id, company_name, legal_name, phone, email, website, address_line1, address_line2, city, state, postal_code, country, business_number, tax_number, contract_footer, logo_key, updated_by, created_at, updated_at";

function emptyProfile(organizationId: number): CompanyProfile {
  return {
    organization_id: organizationId, company_name: "", legal_name: "", phone: "", email: "", website: "",
    address_line1: "", address_line2: "", city: "", state: "", postal_code: "", country: "",
    business_number: "", tax_number: "", contract_footer: "", logo_key: null,
    updated_by: null, created_at: "", updated_at: "",
  };
}

/** Never returns null and never throws for a missing row — an organization
 *  that has never configured its profile gets a well-formed, all-empty
 *  CompanyProfile (Section 9: "if profile is absent, UI must load safely
 *  and Contract generation must not crash"). */
export async function getCompanyProfile(organizationId: number): Promise<CompanyProfile> {
  const row = await get<CompanyProfile>(
    `SELECT ${PROFILE_COLUMNS} FROM organization_profiles WHERE organization_id = ?`, [organizationId]
  );
  return row ?? emptyProfile(organizationId);
}

export class CompanyProfileValidationError extends Error {}

const MAX_SHORT = 200;
const MAX_LONG = 2000;

function assertLen(value: string, max: number, field: string): void {
  if (value.length > max) throw new CompanyProfileValidationError(`${field} must be ${max} characters or fewer`);
}

// Deliberately permissive — "avoid over-strict business identity
// validation" (Section 11). Just enough to catch an obviously-wrong value,
// not a full RFC-5322/RFC-3986 implementation.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WEBSITE_RE = /^https?:\/\/[^\s]+\.[^\s]+$/i;

export interface UpdateCompanyProfileInput {
  company_name?: string;
  legal_name?: string;
  phone?: string;
  email?: string;
  website?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  business_number?: string;
  tax_number?: string;
  contract_footer?: string;
}

function assertValid(input: UpdateCompanyProfileInput): void {
  const shortFields: (keyof UpdateCompanyProfileInput)[] = [
    "company_name", "legal_name", "phone", "email", "website", "address_line1", "address_line2",
    "city", "state", "postal_code", "country", "business_number", "tax_number",
  ];
  for (const field of shortFields) {
    if (input[field] !== undefined) assertLen(input[field]!, MAX_SHORT, field);
  }
  if (input.contract_footer !== undefined) assertLen(input.contract_footer, MAX_LONG, "contract_footer");
  if (input.email && !EMAIL_RE.test(input.email)) {
    throw new CompanyProfileValidationError("Email does not look like a valid email address");
  }
  if (input.website && !WEBSITE_RE.test(input.website)) {
    throw new CompanyProfileValidationError("Website must start with http:// or https:// and include a domain");
  }
}

/** Plain upsert — INSERT the first time, UPDATE every time after (D1's
 *  `ON CONFLICT` upsert, keyed on the UNIQUE organization_id). Never
 *  creates a second row per organization, never versions. */
export async function upsertCompanyProfile(
  organizationId: number, input: UpdateCompanyProfileInput, actorUserId: number
): Promise<CompanyProfile> {
  assertValid(input);
  const current = await getCompanyProfile(organizationId);
  const merged: UpdateCompanyProfileInput = {
    company_name: input.company_name ?? current.company_name,
    legal_name: input.legal_name ?? current.legal_name,
    phone: input.phone ?? current.phone,
    email: input.email ?? current.email,
    website: input.website ?? current.website,
    address_line1: input.address_line1 ?? current.address_line1,
    address_line2: input.address_line2 ?? current.address_line2,
    city: input.city ?? current.city,
    state: input.state ?? current.state,
    postal_code: input.postal_code ?? current.postal_code,
    country: input.country ?? current.country,
    business_number: input.business_number ?? current.business_number,
    tax_number: input.tax_number ?? current.tax_number,
    contract_footer: input.contract_footer ?? current.contract_footer,
  };

  await run(
    `INSERT INTO organization_profiles
       (organization_id, company_name, legal_name, phone, email, website, address_line1, address_line2, city, state, postal_code, country, business_number, tax_number, contract_footer, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(organization_id) DO UPDATE SET
       company_name = excluded.company_name, legal_name = excluded.legal_name, phone = excluded.phone,
       email = excluded.email, website = excluded.website, address_line1 = excluded.address_line1,
       address_line2 = excluded.address_line2, city = excluded.city, state = excluded.state,
       postal_code = excluded.postal_code, country = excluded.country, business_number = excluded.business_number,
       tax_number = excluded.tax_number, contract_footer = excluded.contract_footer, updated_by = excluded.updated_by,
       updated_at = datetime('now')`,
    [
      organizationId, merged.company_name, merged.legal_name, merged.phone, merged.email, merged.website,
      merged.address_line1, merged.address_line2, merged.city, merged.state, merged.postal_code, merged.country,
      merged.business_number, merged.tax_number, merged.contract_footer, actorUserId,
    ]
  );
  return getCompanyProfile(organizationId);
}

// ── Logo (Phase 13A final document hardening) ──────────────────────────
// Tenant-specific (Section 6: "no global singleton logo") — stored in R2
// via the same proxied storage.ts abstraction every other binary asset in
// this codebase uses (job photos, job signatures, signed Contract PDFs),
// never inline in D1. `organization_profiles.logo_key` (migration 0019,
// unused until now) is the pointer; the object itself lives at
// `organizations/{organizationId}/branding/logo-{uuid}.{ext}`, mirroring
// the `contracts/{orgId}/{contractId}/...` key convention already used
// for signed documents. A logo change affects only FUTURE documents — an
// already-signed Contract PDF embedded the logo bytes that existed at
// signing time and never re-reads this column (Section 11).

const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2MB — generous for a raster logo, far below the general 15MB media cap
// Deliberately narrower than storage.ts's general ALLOWED_CONTENT_TYPES
// (which also allows WebP/HEIC/GIF for job photos) — Section 8 explicitly
// asks for "PNG, JPEG" only. Also narrower than the general SVG-XSS
// concern storage.ts documents: this allowlist never includes SVG.
const LOGO_CONTENT_TYPES = new Set(["image/png", "image/jpeg"]);

function assertLogoUploadAllowed(size: number, contentType: string): void {
  if (!LOGO_CONTENT_TYPES.has(contentType)) {
    throw new StorageError("invalid_type", "Only PNG or JPEG images are supported for a company logo");
  }
  if (size > LOGO_MAX_BYTES) {
    throw new StorageError("too_large", `Logo file exceeds the ${LOGO_MAX_BYTES / (1024 * 1024)}MB upload limit`);
  }
  // Delegate the same magic-byte-adjacent size/type discipline storage.ts
  // already enforces elsewhere, rather than duplicating it — this call is
  // redundant with the checks above for the type allowlist (a subset) but
  // keeps a single source of truth for the byte-size ceiling logic shape.
  assertUploadAllowed(size, contentType);
}

function buildLogoKey(organizationId: number, contentType: string): string {
  const ext = contentType === "image/png" ? "png" : "jpg";
  return `organizations/${organizationId}/branding/logo-${crypto.randomUUID()}.${ext}`;
}

/** Uploads a new logo, replacing (and best-effort deleting) any previous
 *  one for this organization. Never throws on the OLD object's deletion
 *  failing — a stray orphaned R2 object is a harmless storage-hygiene
 *  issue, not a correctness one, and must never block the new upload from
 *  succeeding. */
export async function setCompanyLogo(
  env: StorageEnv, organizationId: number, bytes: Uint8Array, contentType: string, actorUserId: number
): Promise<CompanyProfile> {
  assertLogoUploadAllowed(bytes.byteLength, contentType);
  const current = await getCompanyProfile(organizationId);
  const key = buildLogoKey(organizationId, contentType);
  await putObject(env, key, bytes.buffer as ArrayBuffer, contentType);
  await run(
    `INSERT INTO organization_profiles (organization_id, logo_key, updated_by)
     VALUES (?, ?, ?)
     ON CONFLICT(organization_id) DO UPDATE SET logo_key = excluded.logo_key, updated_by = excluded.updated_by, updated_at = datetime('now')`,
    [organizationId, key, actorUserId]
  );
  if (current.logo_key) {
    try { await deleteObject(env, current.logo_key); } catch { /* best-effort cleanup, see doc comment */ }
  }
  return getCompanyProfile(organizationId);
}

export async function removeCompanyLogo(env: StorageEnv, organizationId: number, actorUserId: number): Promise<CompanyProfile> {
  const current = await getCompanyProfile(organizationId);
  await run(
    `INSERT INTO organization_profiles (organization_id, logo_key, updated_by)
     VALUES (?, NULL, ?)
     ON CONFLICT(organization_id) DO UPDATE SET logo_key = NULL, updated_by = excluded.updated_by, updated_at = datetime('now')`,
    [organizationId, actorUserId]
  );
  if (current.logo_key) {
    try { await deleteObject(env, current.logo_key); } catch { /* best-effort cleanup */ }
  }
  return getCompanyProfile(organizationId);
}

export interface LogoAsset { bytes: Uint8Array; contentType: string }

/** The sole read path for logo bytes — used by the Contract/Invoice PDF
 *  renderers (via a PNG/JPEG-aware caller, see contracts.ts) and by the
 *  admin-only preview route in index.ts. Returns null whenever there is no
 *  logo, or the object is unexpectedly missing from storage — never
 *  throws, since a missing logo must never fail document generation
 *  (Section 10: "PDF generation must not fail because logo is absent"). */
export async function getCompanyLogo(env: StorageEnv, organizationId: number): Promise<LogoAsset | null> {
  const profile = await getCompanyProfile(organizationId);
  if (!profile.logo_key) return null;
  const obj = await getObject(env, profile.logo_key);
  if (!obj) return null;
  const contentType = obj.httpMetadata?.contentType || "image/png";
  return { bytes: new Uint8Array(await obj.arrayBuffer()), contentType };
}
