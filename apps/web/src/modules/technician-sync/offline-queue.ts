export type LocalSyncState = "pending" | "syncing" | "conflict" | "failed";
export type LocalSyncOperation = "save_report" | "submit_report" | "set_checklist" | "add_note" | "upload_evidence" | "capture_signature" | "complete_job";

export interface LocalSyncMutation {
  clientMutationId: string;
  contextKey: string;
  jobId: string;
  operation: LocalSyncOperation;
  payload: Record<string, unknown>;
  file?: Blob;
  localCreatedAt: string;
  dependsOn: string[];
  state: LocalSyncState;
  attempts: number;
  nextAttemptAt?: string;
  error?: string;
}

export interface OfflineQueueStore {
  put(mutation: LocalSyncMutation): Promise<void>;
  list(contextKey: string, jobId?: string): Promise<LocalSyncMutation[]>;
  remove(clientMutationId: string): Promise<void>;
}

export type SyncFailureKind = "auth" | "conflict" | "transient";
export class SyncFailure extends Error {
  constructor(readonly kind: SyncFailureKind, message: string) { super(message); }
}

const flights = new Map<string, Promise<ReadonlyArray<LocalSyncMutation>>>();

export function offlineContextKey(organizationId: string, userId: string) {
  return organizationId + ":" + userId;
}

export function retryDelayMs(attempt: number) {
  return Math.min(60_000, 1_000 * (2 ** Math.min(Math.max(attempt - 1, 0), 6)));
}

export class OfflineSyncQueue {
  constructor(private readonly store: OfflineQueueStore, private readonly contextKey: string) {}

  async enqueue(input: Omit<LocalSyncMutation, "contextKey" | "state" | "attempts">) {
    const mutation: LocalSyncMutation = { ...input, contextKey: this.contextKey, state: "pending", attempts: 0 };
    await this.store.put(mutation);
    return mutation;
  }

  flush(transport: (mutation: LocalSyncMutation) => Promise<unknown>) {
    const existing = flights.get(this.contextKey);
    if (existing) return existing;
    const flight = this.run(transport).finally(() => flights.delete(this.contextKey));
    flights.set(this.contextKey, flight);
    return flight;
  }

  private async run(transport: (mutation: LocalSyncMutation) => Promise<unknown>) {
    const ordered = (await this.store.list(this.contextKey)).sort((a, b) =>
      a.localCreatedAt.localeCompare(b.localCreatedAt) || a.clientMutationId.localeCompare(b.clientMutationId));
    const remaining = new Set(ordered.map((item) => item.clientMutationId));
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const mutation of ordered) {
        if (!remaining.has(mutation.clientMutationId) || mutation.state === "conflict") continue;
        if (mutation.nextAttemptAt && Date.parse(mutation.nextAttemptAt) > Date.now()) continue;
        if (mutation.dependsOn.some((id) => remaining.has(id))) continue;
        const syncing = { ...mutation, state: "syncing" as const, attempts: mutation.attempts + 1, error: undefined };
        await this.store.put(syncing);
        try {
          await transport(syncing);
          await this.store.remove(syncing.clientMutationId);
          remaining.delete(syncing.clientMutationId);
          progressed = true;
        } catch (error) {
          const failure = error instanceof SyncFailure ? error : new SyncFailure("transient", "Network unavailable");
          const failed: LocalSyncMutation = {
            ...syncing,
            state: failure.kind === "conflict" ? "conflict" : "failed",
            error: failure.message,
            nextAttemptAt: failure.kind === "transient" ? new Date(Date.now() + retryDelayMs(syncing.attempts)).toISOString() : undefined,
          };
          await this.store.put(failed);
          return this.store.list(this.contextKey);
        }
      }
    }
    return this.store.list(this.contextKey);
  }
}

export class MemoryOfflineQueueStore implements OfflineQueueStore {
  constructor(readonly values = new Map<string, LocalSyncMutation>()) {}
  async put(mutation: LocalSyncMutation) { this.values.set(mutation.clientMutationId, structuredClone(mutation)); }
  async list(contextKey: string, jobId?: string) {
    return [...this.values.values()].filter((item) => item.contextKey === contextKey && (!jobId || item.jobId === jobId)).map((item) => structuredClone(item));
  }
  async remove(clientMutationId: string) { this.values.delete(clientMutationId); }
}
