"use client";

import type { LocalSyncMutation, OfflineQueueStore } from "./offline-queue";

export interface CachedTechnicianJob {
  contextKey: string;
  jobId: string;
  cachedAt: string;
  data: Record<string, unknown>;
}

function request<T>(value: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("Local persistence failed"));
  });
}

export class IndexedDbOfflineStore implements OfflineQueueStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(organizationId: string, userId: string) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(organizationId) || !uuid.test(userId)) throw new Error("Invalid offline context");
    const opening = indexedDB.open("ofs-technician-" + organizationId + "-" + userId, 1);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      if (!db.objectStoreNames.contains("mutations")) db.createObjectStore("mutations", { keyPath: "clientMutationId" }).createIndex("context", "contextKey");
      if (!db.objectStoreNames.contains("jobs")) db.createObjectStore("jobs", { keyPath: "jobId" });
    };
    return new IndexedDbOfflineStore(await request(opening));
  }

  async put(mutation: LocalSyncMutation) { await request(this.db.transaction("mutations", "readwrite").objectStore("mutations").put(mutation)); }
  async list(contextKey: string, jobId?: string) {
    const values = await request(this.db.transaction("mutations").objectStore("mutations").index("context").getAll(contextKey)) as LocalSyncMutation[];
    return values.filter((item) => !jobId || item.jobId === jobId);
  }
  async remove(clientMutationId: string) { await request(this.db.transaction("mutations", "readwrite").objectStore("mutations").delete(clientMutationId)); }
  async cacheJob(job: CachedTechnicianJob) { await request(this.db.transaction("jobs", "readwrite").objectStore("jobs").put(job)); }
  async getJob(jobId: string) { return request(this.db.transaction("jobs").objectStore("jobs").get(jobId)) as Promise<CachedTechnicianJob | undefined>; }
  close() { this.db.close(); }
}

