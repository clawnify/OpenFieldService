import { notFound, redirect } from "next/navigation";
import { currentActor } from "@/auth/current-actor";
import { ApplicationError } from "@/lib/errors";
import { JobCompletionService } from "@/modules/job-completion/job-completion.service";
import { JobService } from "@/modules/jobs/job.service";
import { OfflineWorkspace } from "./offline-workspace";

export default async function TechnicianOfflinePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  if (actor.role !== "member") notFound();
  const { id } = await params;
  let completion: Awaited<ReturnType<JobCompletionService["getCompletionView"]>>;
  let job: Awaited<ReturnType<JobService["getJob"]>>;
  try {
    [completion, job] = await Promise.all([new JobCompletionService().getCompletionView(actor, id), new JobService().getJob(actor, id)]);
  } catch (error) {
    if (error instanceof ApplicationError) notFound();
    throw error;
  }
  return <OfflineWorkspace initial={{
      organizationId: actor.organizationId, userId: actor.userId,
      job: { id: completion.job.id, identifier: completion.job.identifier, title: completion.job.title, serviceAddress: completion.job.serviceAddress, status: completion.job.status },
      checklist: job.checklist.map((item) => ({ id: item.id, label: item.label, completed: item.completed })),
      report: completion.report ? { id: completion.report.id, status: completion.report.status, rowVersion: completion.report.rowVersion, snapshotHash: completion.report.snapshotHash, workPerformed: completion.report.workPerformed, findings: completion.report.findings, notes: completion.report.notes, materialsUsed: completion.report.materialsUsed } : null,
      requirements: completion.requirements,
    }} />;
}
