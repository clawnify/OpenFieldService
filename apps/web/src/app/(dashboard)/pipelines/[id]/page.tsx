import { notFound, redirect } from "next/navigation";
import { can } from "@/auth/permissions";
import { currentActor } from "@/auth/current-actor";
import { NotFoundError } from "@/lib/errors";
import { PipelineService } from "@/modules/pipelines/pipeline.service";
import { setDefaultPipelineAction } from "../actions";
import { StageForm } from "./stage-form";
import { StageOrder } from "./stage-order";
export default async function PipelinePage({ params }: { params: Promise<{ id: string }> }) { const actor = await currentActor(); if (!actor) redirect("/login"); const { id } = await params; let result; try { result = await new PipelineService().getPipeline(actor, id); } catch (error) { if (error instanceof NotFoundError) notFound(); throw error; } const canEdit = can(actor, "pipeline_stage.update"); const canCreateStage = can(actor, "pipeline_stage.create"); const setDefault = setDefaultPipelineAction.bind(null, result.pipeline.id); return <main className="mx-auto max-w-3xl px-6 py-12"><p className="text-sm font-medium text-primary">Pipeline</p><div className="mt-2 flex items-start justify-between gap-4"><div><h1 className="text-4xl font-semibold tracking-tight">{result.pipeline.name}</h1><p className="mt-2 text-muted-foreground">{result.pipeline.description}</p></div>{result.pipeline.isDefault ? <span className="rounded-full bg-primary/10 px-3 py-1 text-sm text-primary">Default</span> : can(actor, "pipeline.update") ? <form action={setDefault}><button className="rounded-md border px-3 py-2 text-sm">Make default</button></form> : null}</div><StageOrder pipelineId={id} initialStages={result.stages} canEdit={canEdit} />{canCreateStage ? <StageForm pipelineId={id} /> : null}</main>; }
