import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexedDbOfflineStore } from "./indexeddb-offline-store";
import { offlineContextKey, type LocalSyncMutation } from "./offline-queue";

const org = "81111111-1111-4111-8111-111111111111";
const user = "82222222-2222-4222-8222-222222222222";
const other = "83333333-3333-4333-8333-333333333333";
const job = "84444444-4444-4444-8444-444444444444";

function mutation(contextKey: string): LocalSyncMutation {
  return {
    clientMutationId: crypto.randomUUID(), contextKey, jobId: job, operation: "upload_evidence",
    payload: { filename: "offline.jpg" }, file: new Blob(["staged"], { type: "image/jpeg" }),
    localCreatedAt: new Date().toISOString(), dependsOn: [], state: "pending", attempts: 0,
  };
}

describe("IndexedDB Technician persistence", () => {
  it("survives close/reopen with staged blobs and cached Job state", async () => {
    const context = offlineContextKey(org, user), first = await IndexedDbOfflineStore.open(org, user), queued = mutation(context);
    await first.put(queued);
    await first.cacheJob({ contextKey: context, jobId: job, cachedAt: new Date().toISOString(), data: { title: "Assigned Job", draft: { workPerformed: "Local draft" } } });
    first.close();
    const reopened = await IndexedDbOfflineStore.open(org, user);
    const values = await reopened.list(context, job), cached = await reopened.getJob(job);
    expect(values).toHaveLength(1);
    expect(await values[0].file?.text()).toBe("staged");
    expect(cached?.data).toMatchObject({ title: "Assigned Job", draft: { workPerformed: "Local draft" } });
    await reopened.remove(queued.clientMutationId);
    expect(await reopened.list(context, job)).toHaveLength(0);
    reopened.close();
  });

  it("uses separate databases for another authenticated user", async () => {
    const first = await IndexedDbOfflineStore.open(org, user), second = await IndexedDbOfflineStore.open(org, other);
    expect(await second.list(offlineContextKey(org, other), job)).toHaveLength(0);
    expect(await second.getJob(job)).toBeUndefined();
    first.close(); second.close();
  });

  it("rejects unsafe context identifiers", async () => {
    await expect(IndexedDbOfflineStore.open("not-an-organization", user)).rejects.toThrow("Invalid offline context");
  });
});
