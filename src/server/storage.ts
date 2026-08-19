/**
 * Provider-agnostic-in-spirit media storage for technician compliance evidence
 * (pre/post-work photos, customer signatures). No storage abstraction existed
 * anywhere in this codebase before Phase 4 (verified: no R2/KV binding in
 * wrangler.toml, no upload code) — this is a new, single, worker-proxied layer,
 * not a parallel mechanism alongside something already there.
 *
 * Deliberately proxied (technician's device -> our API -> R2) rather than
 * presigned URLs: no storage credentials are ever generated for or sent to the
 * client, and it's the smaller surface for a first cut. Presigned URLs are a
 * reasonable later upgrade if upload volume/size ever becomes a bottleneck.
 */

export interface StorageEnv {
  MEDIA: R2Bucket;
}

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB — generous for a phone photo, not unbounded

// Explicit allowlist, not a startsWith("image/") prefix check — "image/svg+xml"
// matches that prefix but SVG can embed <script>/event-handler JS, and this
// file is served back inline from the app's own origin (see the /file route
// in index.ts), so allowing it would be a stored-XSS path via a "photo" upload.
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif"]);

export class StorageError extends Error {
  code: "too_large" | "invalid_type";
  constructor(code: StorageError["code"], message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

/** jobs/{jobId}/{category}/{random}.{ext} — random component prevents guessing
 *  another job's object key, category keeps pre/post-work and signatures from
 *  ever colliding even if IDs coincide. */
export function buildMediaKey(jobId: number, category: string, filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, "") : "";
  return `jobs/${jobId}/${category}/${crypto.randomUUID()}${ext}`;
}

export function assertUploadAllowed(size: number, contentType: string): void {
  if (size > MAX_UPLOAD_BYTES) {
    throw new StorageError("too_large", `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB upload limit`);
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new StorageError("invalid_type", "Only JPEG, PNG, WebP, HEIC, or GIF images are supported");
  }
}

export async function putObject(
  env: StorageEnv, key: string, data: ArrayBuffer, contentType: string
): Promise<void> {
  await env.MEDIA.put(key, data, { httpMetadata: { contentType } });
}

export async function getObject(env: StorageEnv, key: string): Promise<R2ObjectBody | null> {
  return env.MEDIA.get(key);
}

export async function deleteObject(env: StorageEnv, key: string): Promise<void> {
  await env.MEDIA.delete(key);
}
