import { describe, expect, it, vi } from "vitest";
import { MemoryOfflineQueueStore, OfflineSyncQueue, SyncFailure, offlineContextKey, retryDelayMs } from "./offline-queue";
import { technicianSyncMutationSchema } from "./technician-sync.schema";
import { technicianSyncPayloadHash } from "./technician-sync.rules";

const orgA = "11111111-1111-4111-8111-111111111111", userA = "22222222-2222-4222-8222-222222222222";
const job = "33333333-3333-4333-8333-333333333333";
function input(id: string, operation: "add_note" | "complete_job" = "add_note", dependsOn: string[] = []) {
  return { clientMutationId: id, jobId: job, operation, payload: operation === "add_note" ? { body: id } : {}, localCreatedAt: "2026-09-09T20:00:00.000Z", dependsOn };
}

describe("Technician offline queue", () => {
  it("partitions local work by organization and user", async () => {
    const store = new MemoryOfflineQueueStore();
    await new OfflineSyncQueue(store, offlineContextKey(orgA, userA)).enqueue(input("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
    expect(await store.list(offlineContextKey(orgA, userA))).toHaveLength(1);
    expect(await store.list(offlineContextKey(orgA, "44444444-4444-4444-8444-444444444444"))).toHaveLength(0);
  });
  it("survives queue reconstruction using persisted state", async () => {
    const values = new Map();
    const first = new MemoryOfflineQueueStore(values);
    await new OfflineSyncQueue(first, offlineContextKey(orgA, userA)).enqueue(input("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab"));
    const reopened = new MemoryOfflineQueueStore(values);
    expect(await reopened.list(offlineContextKey(orgA, userA), job)).toHaveLength(1);
  });
  it("orders dependencies deterministically", async () => {
    const store = new MemoryOfflineQueueStore(), queue = new OfflineSyncQueue(store, offlineContextKey(orgA, userA));
    const first = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac", second = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad";
    await queue.enqueue(input(second, "complete_job", [first]));
    await queue.enqueue(input(first));
    const seen: string[] = [];
    await queue.flush(async (mutation) => { seen.push(mutation.clientMutationId); });
    expect(seen).toEqual([first, second]);
  });
  it("uses one active flush per context", async () => {
    const store = new MemoryOfflineQueueStore(), queue = new OfflineSyncQueue(store, offlineContextKey(orgA, userA));
    await queue.enqueue(input("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae"));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const transport = vi.fn(async () => blocked);
    const a = queue.flush(transport), b = queue.flush(transport);
    release(); await Promise.all([a, b]);
    expect(transport).toHaveBeenCalledOnce();
  });
  it("preserves conflicts and recoverable transient failures", async () => {
    const store = new MemoryOfflineQueueStore(), queue = new OfflineSyncQueue(store, offlineContextKey(orgA, userA));
    await queue.enqueue(input("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaf"));
    await queue.flush(async () => { throw new SyncFailure("conflict", "stale"); });
    expect((await store.list(offlineContextKey(orgA, userA)))[0]).toMatchObject({ state: "conflict", error: "stale" });
    expect(retryDelayMs(20)).toBe(60_000);
  });
  it("retains work across authentication expiry and removes it after reauthentication", async () => {
    const context = offlineContextKey(orgA, userA), store = new MemoryOfflineQueueStore(), queue = new OfflineSyncQueue(store, context);
    await queue.enqueue(input("cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
    await queue.flush(async () => { throw new SyncFailure("auth", "Sign in again"); });
    expect((await store.list(context))[0]).toMatchObject({ state: "failed", error: "Sign in again" });
    await queue.flush(async () => undefined);
    expect(await store.list(context)).toHaveLength(0);
  });
  it("strictly validates mutations and produces stable payload hashes", () => {
    const value = technicianSyncMutationSchema.parse(input("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    expect(technicianSyncPayloadHash(value)).toMatch(/^[0-9a-f]{64}$/);
    expect(technicianSyncPayloadHash(value)).toBe(technicianSyncPayloadHash(structuredClone(value)));
    expect(() => technicianSyncMutationSchema.parse({ ...input("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc"), organizationId: orgA })).toThrow();
  });
});
