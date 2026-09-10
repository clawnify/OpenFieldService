import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { can } from "@/auth/permissions";
import { currentActor } from "@/auth/current-actor";
import { ApplicationError } from "@/lib/errors";
import { JobCompletionService } from "@/modules/job-completion/job-completion.service";
import {
  captureJobCustomerSignatureAction,
  completeCompliantJobAction,
  saveJobReportAction,
  submitJobReportAction,
  uploadCompletionEvidenceAction,
} from "./actions";

export default async function JobCompletionPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  const { id } = await params;
  let view: Awaited<ReturnType<JobCompletionService["getCompletionView"]>>;
  try {
    view = await new JobCompletionService().getCompletionView(actor, id);
  } catch (error) {
    if (error instanceof ApplicationError) notFound();
    throw error;
  }
  const report = view.report;
  const preWork = view.evidence.filter((row) => row.evidence.kind === "pre_work_photo");
  const postWork = view.evidence.filter((row) => row.evidence.kind === "post_work_photo");
  const mutable = view.job.status === "scheduled" || view.job.status === "in_progress";

  return <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
    <Link className="text-sm text-primary underline" href={"/jobs/" + id}>Back to {view.job.identifier}</Link>
    <h1 className="mt-3 text-3xl font-semibold sm:text-4xl">Job completion</h1>
    <p className="mt-2 text-muted-foreground">{view.job.title} · {view.job.status}</p>
    {actor.role === "member" ? <Link className="mt-3 inline-block text-sm text-primary underline" href={"/jobs/" + id + "/offline"}>Open offline field workspace</Link> : null}

    <section className="mt-8 rounded-xl border p-5">
      <h2 className="text-xl font-semibold">Completion gate</h2>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {view.requirements.map((item) => <li key={item.key} className="rounded-md border p-3">
          <span aria-hidden>{item.satisfied ? "✓" : "○"}</span> {item.label}
        </li>)}
      </ul>
      {view.completion ? <p className="mt-4 text-sm text-muted-foreground">Completed {view.completion.completedAt.toISOString()} with immutable evidence record {view.completion.id}.</p> : null}
    </section>

    <section className="mt-8 grid gap-6 lg:grid-cols-2">
      {([["pre_work_photo", "Pre-work evidence", preWork], ["post_work_photo", "Post-work evidence", postWork]] as const).map(([kind, label, rows]) =>
        <div key={kind} className="rounded-xl border p-5">
          <h2 className="text-xl font-semibold">{label}</h2>
          <ul className="mt-3 space-y-2">{rows.map((row) => <li key={row.evidence.id} className="rounded-md border p-3">
            <a className="underline" href={"/api/attachments/" + row.attachment.id + "/download"}>{row.attachment.filename}</a>
          </li>)}</ul>
          {mutable && can(actor, "job.evidence.manage") ? <form action={uploadCompletionEvidenceAction.bind(null, id, kind)} className="mt-4 grid gap-3">
            <input required type="file" name="file" accept="image/*" />
            <button className="rounded-md border px-4 py-2">Upload {label.toLowerCase()}</button>
          </form> : null}
        </div>)}
    </section>

    <section className="mt-8 rounded-xl border p-5">
      <h2 className="text-xl font-semibold">Technician report</h2>
      <p className="mt-1 text-sm text-muted-foreground">Status: {report?.status ?? "not started"}. Submitting freezes the reviewed content; editing it later returns it to draft.</p>
      {mutable && can(actor, "job.report.write") ? <form action={saveJobReportAction.bind(null, id)} className="mt-4 grid gap-3">
        <input type="hidden" name="expectedRowVersion" value={report?.rowVersion ?? 0} />
        <label className="grid gap-1">Work performed<textarea required name="workPerformed" defaultValue={report?.workPerformed ?? ""} className="min-h-28 rounded-md border p-3" /></label>
        <label className="grid gap-1">Findings<textarea name="findings" defaultValue={report?.findings ?? ""} className="min-h-20 rounded-md border p-3" /></label>
        <label className="grid gap-1">Materials used<textarea name="materialsUsed" defaultValue={report?.materialsUsed ?? ""} className="min-h-20 rounded-md border p-3" /></label>
        <label className="grid gap-1">Notes<textarea name="notes" defaultValue={report?.notes ?? ""} className="min-h-20 rounded-md border p-3" /></label>
        <button className="rounded-md border px-4 py-2">Save report draft</button>
      </form> : null}
      {mutable && report?.status === "draft" && can(actor, "job.report.submit") ? <form action={submitJobReportAction.bind(null, id, report.rowVersion)} className="mt-3">
        <button className="rounded-md bg-primary px-4 py-2 text-primary-foreground">Submit report for customer review</button>
      </form> : null}
    </section>

    <section className="mt-8 rounded-xl border p-5">
      <h2 className="text-xl font-semibold">Customer acknowledgement and signature</h2>
      <p className="mt-1 text-sm text-muted-foreground">The signature image is private and is bound to the exact submitted report snapshot.</p>
      {view.signatures.length ? <ul className="mt-3 space-y-2">{view.signatures.map((signature) => <li key={signature.id} className="rounded-md border p-3">{signature.signerName} · {signature.capturedAt.toISOString()}</li>)}</ul> : null}
      {mutable && report?.status === "submitted" && can(actor, "job.signature.capture") ? <form action={captureJobCustomerSignatureAction.bind(null, id)} className="mt-4 grid gap-3">
        <input required name="signerName" placeholder="Customer signer name" className="rounded-md border px-3 py-2" />
        <input name="signerRelationship" placeholder="Relationship (optional)" className="rounded-md border px-3 py-2" />
        <input required type="file" name="file" accept="image/*" />
        <label className="flex items-start gap-2"><input required type="checkbox" name="acknowledged" value="yes" /> I acknowledge the work described in this submitted Job report.</label>
        <button className="rounded-md border px-4 py-2">Capture customer signature</button>
      </form> : null}
    </section>

    {view.job.status === "in_progress" && can(actor, "job.complete") ? <section className="mt-8 rounded-xl border p-5">
      <h2 className="text-xl font-semibold">Review and complete</h2>
      <p className="mt-1 text-sm text-muted-foreground">{view.allowed ? "All persisted completion requirements are satisfied." : "Complete the missing requirements above."}</p>
      <form action={completeCompliantJobAction.bind(null, id)} className="mt-4">
        <button disabled={!view.allowed} className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">Complete Job</button>
      </form>
    </section> : null}
  </main>;
}
