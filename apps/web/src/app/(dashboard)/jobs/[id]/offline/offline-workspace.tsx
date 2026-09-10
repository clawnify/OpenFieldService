"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IndexedDbOfflineStore } from "@/modules/technician-sync/indexeddb-offline-store";
import { OfflineSyncQueue, offlineContextKey, type LocalSyncMutation, type LocalSyncOperation } from "@/modules/technician-sync/offline-queue";
import { sha256, syncMutation } from "@/modules/technician-sync/offline-transport";

type Snapshot = {
  organizationId: string; userId: string;
  job: { id: string; identifier: string; title: string; serviceAddress: string; status: string };
  checklist: Array<{ id: string; label: string; completed: boolean }>;
  report: null | { id: string; status: string; rowVersion: number; snapshotHash: string | null; workPerformed: string; findings: string; notes: string; materialsUsed: string };
  requirements: ReadonlyArray<{ readonly key: string; readonly label: string; readonly satisfied: boolean }>;
};
type DisplayState = "Online" | "Offline" | "Saved locally" | "Pending sync" | "Syncing" | "Synced" | "Conflict" | "Failed / retry required";

export function OfflineWorkspace({ initial }: { initial: Snapshot }) {
  const router = useRouter(), contextKey = offlineContextKey(initial.organizationId, initial.userId);
  const store = useRef<IndexedDbOfflineStore | null>(null), queue = useRef<OfflineSyncQueue | null>(null);
  const [mutations, setMutations] = useState<LocalSyncMutation[]>([]);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" ? true : navigator.onLine), [display, setDisplay] = useState<DisplayState>("Online");
  const [draft, setDraft] = useState({ workPerformed: initial.report?.workPerformed ?? "", findings: initial.report?.findings ?? "", notes: initial.report?.notes ?? "", materialsUsed: initial.report?.materialsUsed ?? "" });

  const refreshQueue = useCallback(async () => {
    if (!store.current) return;
    const values = await store.current.list(contextKey, initial.job.id);
    setMutations(values);
    if (values.some((item) => item.state === "conflict")) setDisplay("Conflict");
    else if (values.some((item) => item.state === "failed")) setDisplay("Failed / retry required");
    else if (values.length) setDisplay("Pending sync");
    else setDisplay(navigator.onLine ? "Synced" : "Offline");
  }, [contextKey, initial.job.id]);
  const flush = useCallback(async () => {
    if (!queue.current || !navigator.onLine) { setDisplay("Offline"); return; }
    const before = store.current ? await store.current.list(contextKey, initial.job.id) : [];
    if (!before.length) { setDisplay("Synced"); return; }
    setDisplay("Syncing");
    const after = await queue.current.flush(syncMutation);
    await refreshQueue();
    if (after.length < before.length) router.refresh();
  }, [contextKey, initial.job.id, refreshQueue, router]);

  useEffect(() => {
    let active = true;
    void IndexedDbOfflineStore.open(initial.organizationId, initial.userId).then(async (value) => {
      if (!active) { value.close(); return; }
      store.current = value; queue.current = new OfflineSyncQueue(value, contextKey);
      const cached = await value.getJob(initial.job.id), pending = await value.list(contextKey, initial.job.id);
      if (cached?.contextKey === contextKey && pending.length && cached.data.draft) setDraft(cached.data.draft as typeof draft);
      if (!pending.length) await value.cacheJob({ contextKey, jobId: initial.job.id, cachedAt: new Date().toISOString(), data: { ...initial, draft: { workPerformed: initial.report?.workPerformed ?? "", findings: initial.report?.findings ?? "", notes: initial.report?.notes ?? "", materialsUsed: initial.report?.materialsUsed ?? "" } } });
      await refreshQueue(); if (navigator.onLine) void flush();
    });
    const update = () => { setOnline(navigator.onLine); setDisplay(navigator.onLine ? "Online" : "Offline"); if (navigator.onLine) void flush(); };
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { active = false; window.removeEventListener("online", update); window.removeEventListener("offline", update); store.current?.close(); };
  }, [contextKey, flush, initial, refreshQueue]);

  const enqueue = async (operation: LocalSyncOperation, payload: Record<string, unknown>, file?: Blob, dependsOn: string[] = []) => {
    if (!queue.current || !store.current) return;
    const mutation = await queue.current.enqueue({ clientMutationId: crypto.randomUUID(), jobId: initial.job.id, operation, payload, file, localCreatedAt: new Date().toISOString(), dependsOn });
    await store.current.cacheJob({ contextKey, jobId: initial.job.id, cachedAt: mutation.localCreatedAt, data: { ...initial, draft } });
    setDisplay("Saved locally"); await refreshQueue(); if (navigator.onLine) void flush();
  };
  const stageImage = async (operation: "upload_evidence" | "capture_signature", file: File, extra: Record<string, unknown>) =>
    enqueue(operation, { filename: file.name, contentType: file.type, sizeBytes: file.size, sha256: await sha256(file), ...extra }, file);

  return <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm text-primary">{initial.job.identifier}</p><h1 className="text-3xl font-semibold">Technician field workspace</h1><p className="mt-1 text-muted-foreground">{initial.job.title} · {initial.job.serviceAddress}</p></div><div aria-live="polite" className="rounded-full border px-3 py-2 text-sm">{online ? "●" : "○"} {display}</div></header>
    <p className="mt-4 rounded-lg bg-muted p-3 text-sm">Work is stored only in this signed-in Technician workspace. Completion remains pending until every mutation is synchronized and confirmed by the server.</p>
    <section className="mt-6 rounded-xl border p-4"><div className="flex items-center justify-between"><h2 className="text-xl font-semibold">Sync queue</h2><button onClick={() => void flush()} disabled={!online || display === "Syncing"} className="rounded-md border px-4 py-2">Sync now</button></div><ul className="mt-3 space-y-2 text-sm">{mutations.length ? mutations.map((item) => <li key={item.clientMutationId} className="rounded-md border p-2">{item.operation.replaceAll("_", " ")} · {item.state}{item.error ? " · " + item.error : ""}</li>) : <li>All local work is synchronized.</li>}</ul></section>
    <section className="mt-6 rounded-xl border p-4"><h2 className="text-xl font-semibold">Checklist</h2><ul className="mt-3 space-y-2">{initial.checklist.map((item) => <li key={item.id} className="flex items-center justify-between gap-3 rounded-md border p-3"><span>{item.label}</span><button className="rounded-md border px-3 py-2" onClick={() => void enqueue("set_checklist", { itemId: item.id, completed: !item.completed })}>{item.completed ? "Reopen locally" : "Complete locally"}</button></li>)}</ul></section>
    <section className="mt-6 rounded-xl border p-4"><h2 className="text-xl font-semibold">Report draft</h2><div className="mt-3 grid gap-3">
      <label className="grid gap-1">Work performed<textarea className="min-h-24 rounded-md border p-3" value={draft.workPerformed} onChange={(event) => setDraft({ ...draft, workPerformed: event.target.value })} /></label>
      <label className="grid gap-1">Findings<textarea className="rounded-md border p-3" value={draft.findings} onChange={(event) => setDraft({ ...draft, findings: event.target.value })} /></label>
      <label className="grid gap-1">Materials used<textarea className="rounded-md border p-3" value={draft.materialsUsed} onChange={(event) => setDraft({ ...draft, materialsUsed: event.target.value })} /></label>
      <label className="grid gap-1">Notes<textarea className="rounded-md border p-3" value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
      <button className="rounded-md border px-4 py-2" onClick={() => void enqueue("save_report", { ...draft, expectedRowVersion: initial.report?.rowVersion ?? 0, baseReportId: initial.report?.id ?? null })}>Save draft locally</button>
      {initial.report?.status === "draft" && !mutations.some((item) => item.operation === "save_report") ? <button className="rounded-md border px-4 py-2" onClick={() => void enqueue("submit_report", { expectedRowVersion: initial.report!.rowVersion })}>Queue report submission</button> : null}
    </div></section>
    <section className="mt-6 grid gap-4 sm:grid-cols-2">{(["pre_work_photo", "post_work_photo"] as const).map((kind) => <label key={kind} className="grid gap-2 rounded-xl border p-4"><span className="font-semibold">{kind === "pre_work_photo" ? "Pre-work evidence" : "Post-work evidence"}</span><input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void stageImage("upload_evidence", file, { kind }); }} /></label>)}</section>
    <section className="mt-6 rounded-xl border p-4"><h2 className="text-xl font-semibold">Customer signature</h2>{initial.report?.status === "submitted" && initial.report.snapshotHash ? <div className="mt-3 grid gap-3"><input id="offline-signer-name" placeholder="Signer name" className="rounded-md border px-3 py-2" /><input id="offline-signer-relationship" placeholder="Relationship (optional)" className="rounded-md border px-3 py-2" /><input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0], name = (document.getElementById("offline-signer-name") as HTMLInputElement | null)?.value.trim(), relationship = (document.getElementById("offline-signer-relationship") as HTMLInputElement | null)?.value.trim() ?? ""; if (file && name) void stageImage("capture_signature", file, { signerName: name, signerRelationship: relationship, acknowledged: true, expectedReportSnapshotHash: initial.report!.snapshotHash }); }} /><p className="text-sm text-muted-foreground">Staging acknowledges the reviewed submitted report. A changed report is rejected during sync.</p></div> : <p className="mt-2 text-sm text-muted-foreground">Synchronize and submit the report online before staging a signature.</p>}</section>
    <section className="mt-6 rounded-xl border p-4"><h2 className="text-xl font-semibold">Notes and completion</h2><div className="mt-3 flex gap-2"><input id="offline-note" className="min-w-0 flex-1 rounded-md border px-3 py-2" placeholder="Field note" /><button className="rounded-md border px-3" onClick={() => { const input = document.getElementById("offline-note") as HTMLInputElement | null; if (input?.value.trim()) { void enqueue("add_note", { body: input.value.trim() }); input.value = ""; } }}>Save note locally</button></div><button className="mt-4 w-full rounded-md bg-primary px-4 py-3 text-primary-foreground" onClick={() => void enqueue("complete_job", {}, undefined, mutations.map((item) => item.clientMutationId))}>Queue completion request</button></section>
  </main>;
}
