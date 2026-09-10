"use client";

import { SyncFailure, type LocalSyncMutation } from "./offline-queue";

export async function sha256(blob: Blob) {
  const bytes = await blob.arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function syncMutation(mutation: LocalSyncMutation) {
  const data = new FormData();
  data.set("mutation", JSON.stringify({
    clientMutationId: mutation.clientMutationId,
    jobId: mutation.jobId,
    operation: mutation.operation,
    payload: mutation.payload,
    localCreatedAt: mutation.localCreatedAt,
    dependsOn: mutation.dependsOn,
  }));
  if (mutation.file) {
    const filename = typeof mutation.payload.filename === "string" ? mutation.payload.filename : "staged-image";
    data.set("file", mutation.file, filename);
  }
  let response: Response;
  try {
    response = await fetch("/api/jobs/" + mutation.jobId + "/offline-sync", { method: "POST", body: data, credentials: "same-origin" });
  } catch {
    throw new SyncFailure("transient", "Network unavailable");
  }
  const body = await response.json().catch(() => ({ error: "Sync request failed" })) as { error?: string };
  if (response.ok) return body;
  if (response.status === 401) throw new SyncFailure("auth", "Sign in again to resume synchronization");
  if (response.status === 409 || response.status === 403 || response.status === 404) throw new SyncFailure("conflict", body.error ?? "Server state changed");
  throw new SyncFailure("transient", body.error ?? "Sync request failed");
}
