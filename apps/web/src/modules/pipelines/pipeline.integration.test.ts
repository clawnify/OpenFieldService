import { describe, expect, it } from "vitest";
import { AuditRepository } from "@/modules/audit/audit.repository";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { OrganizationService } from "@/modules/identity/organization.service";
import { UserService } from "@/modules/identity/user.service";
import { PipelineService } from "./pipeline.service";

const organizations = new OrganizationService(); const service = new PipelineService();
describe.sequential("PostgreSQL pipelines and stages", () => {
  let orgA: Awaited<ReturnType<typeof organizations.createOrganizationWithOwner>>; let orgB: typeof orgA;
  const actorA = () => ({ userId: orgA.user.id, organizationId: orgA.organization.id, role: "owner" as const }); const actorB = () => ({ userId: orgB.user.id, organizationId: orgB.organization.id, role: "owner" as const });
  it("creates isolated synthetic tenants", async () => { orgA = await organizations.createOrganizationWithOwner({ name: "Pipeline Alpha", slug: "pipeline-alpha" }, { name: "Alpha Owner", email: "pipeline-alpha@example.test", password: "Synthetic-Pass-123" }); orgB = await organizations.createOrganizationWithOwner({ name: "Pipeline Beta", slug: "pipeline-beta" }, { name: "Beta Owner", email: "pipeline-beta@example.test", password: "Synthetic-Pass-456" }); });

  it("creates the first pipeline as default with deterministically ordered stages", async () => {
    const result = await service.createPipeline(actorA(), { name: "Sales", description: "Synthetic pipeline", stages: [{ name: "New", kind: "open", probability: 10, color: "#2563EB" }, { name: "Won", kind: "won", probability: 100 }, { name: "Lost", kind: "lost", probability: 0 }] });
    expect(result.pipeline.isDefault).toBe(true); expect(result.stages.map((stage) => [stage.name, stage.position])).toEqual([["New", 0], ["Won", 1], ["Lost", 2]]);
    expect((await new AuditRepository().listForEntity(actorA().organizationId, "pipeline", result.pipeline.id)).map((event) => event.action)).toEqual(["pipeline.created"]);
  });

  it("enforces active names and terminal stage invariants", async () => {
    await expect(service.createPipeline(actorA(), { name: "sales" })).rejects.toBeInstanceOf(ConflictError);
    const pipeline = await service.createPipeline(actorA(), { name: "Renewals" });
    await expect(service.createStage(actorA(), pipeline.pipeline.id, { name: "Won", kind: "won", probability: 90 })).rejects.toBeInstanceOf(ValidationError);
    const stage = await service.createStage(actorA(), pipeline.pipeline.id, { name: "Won", kind: "won", probability: 100 });
    await expect(service.createStage(actorA(), pipeline.pipeline.id, { name: "won", kind: "won", probability: 100 })).rejects.toBeInstanceOf(ConflictError);
    await expect(service.updateStage(actorA(), pipeline.pipeline.id, stage.id, { probability: 80 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("sets one tenant-local default atomically", async () => {
    const pipelines = await service.listPipelines(actorA()); const renewals = pipelines.find((pipeline) => pipeline.name === "Renewals")!; await service.setDefaultPipeline(actorA(), { pipelineId: renewals.id });
    const after = await service.listPipelines(actorA()); expect(after.filter((pipeline) => pipeline.isDefault)).toHaveLength(1); expect(after.find((pipeline) => pipeline.isDefault)?.id).toBe(renewals.id);
    const foreign = await service.createPipeline(actorB(), { name: "Foreign Default" }); await expect(service.setDefaultPipeline(actorA(), { pipelineId: foreign.pipeline.id })).rejects.toBeInstanceOf(NotFoundError); expect((await service.listPipelines(actorB())).find((pipeline) => pipeline.id === foreign.pipeline.id)?.isDefault).toBe(true);
  });

  it("serializes competing default and reorder operations", async () => {
    const first = await service.createPipeline(actorA(), { name: "Concurrent One", stages: [{ name: "A", kind: "open", probability: 10 }, { name: "B", kind: "open", probability: 20 }] }); const second = await service.createPipeline(actorA(), { name: "Concurrent Two" });
    await Promise.all([service.setDefaultPipeline(actorA(), { pipelineId: first.pipeline.id }), service.setDefaultPipeline(actorA(), { pipelineId: second.pipeline.id })]); expect((await service.listPipelines(actorA())).filter((pipeline) => pipeline.isDefault)).toHaveLength(1);
    const forward = first.stages.map((stage) => stage.id); const reverse = [...forward].reverse(); await Promise.all([service.reorderStages(actorA(), first.pipeline.id, { stageIds: reverse }), service.reorderStages(actorA(), first.pipeline.id, { stageIds: forward })]); const final = (await service.getPipeline(actorA(), first.pipeline.id)).stages; expect(final.map((stage) => stage.position)).toEqual([0, 1]); expect([forward, reverse]).toContainEqual(final.map((stage) => stage.id));
  });

  it("never exposes or mutates another tenant pipeline or stage", async () => {
    const foreign = await service.createPipeline(actorB(), { name: "Private Pipeline", stages: [{ name: "Private Stage", kind: "open", probability: 20 }] });
    await expect(service.getPipeline(actorA(), foreign.pipeline.id)).rejects.toBeInstanceOf(NotFoundError); await expect(service.updatePipeline(actorA(), foreign.pipeline.id, { name: "Breach" })).rejects.toBeInstanceOf(NotFoundError); await expect(service.archivePipeline(actorA(), foreign.pipeline.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.updateStage(actorA(), foreign.pipeline.id, foreign.stages[0].id, { name: "Breach" })).rejects.toBeInstanceOf(NotFoundError); await expect(service.archiveStage(actorA(), foreign.pipeline.id, foreign.stages[0].id)).rejects.toBeInstanceOf(NotFoundError); expect((await service.listPipelines(actorA())).some((pipeline) => pipeline.name === "Private Pipeline")).toBe(false);
  });

  it("rejects cross-tenant and cross-pipeline stage injection", async () => {
    const local = await service.createPipeline(actorA(), { name: "Installations", stages: [{ name: "Survey", kind: "open", probability: 20 }, { name: "Approved", kind: "open", probability: 60 }] });
    const other = await service.createPipeline(actorA(), { name: "Service Agreements", stages: [{ name: "Draft", kind: "open", probability: 10 }] }); const foreignPipeline = await service.createPipeline(actorB(), { name: "Injection Source", stages: [{ name: "Foreign Stage", kind: "open", probability: 10 }] }); const foreign = foreignPipeline.stages[0];
    await expect(service.reorderStages(actorA(), local.pipeline.id, { stageIds: [local.stages[1].id, other.stages[0].id] })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.reorderStages(actorA(), local.pipeline.id, { stageIds: [local.stages[1].id, foreign.id] })).rejects.toBeInstanceOf(ValidationError);
    expect((await service.getPipeline(actorA(), local.pipeline.id)).stages.map((stage) => stage.id)).toEqual(local.stages.map((stage) => stage.id));
  });

  it("reorders a complete stage set and rolls malformed requests back", async () => {
    const pipeline = await service.createPipeline(actorA(), { name: "Reorder Test", stages: [{ name: "One", kind: "open", probability: 10 }, { name: "Two", kind: "open", probability: 20 }, { name: "Three", kind: "open", probability: 30 }] }); const reversed = [...pipeline.stages].reverse().map((stage) => stage.id);
    expect((await service.reorderStages(actorA(), pipeline.pipeline.id, { stageIds: reversed })).map((stage) => stage.id)).toEqual(reversed);
    await expect(service.reorderStages(actorA(), pipeline.pipeline.id, { stageIds: reversed.slice(0, 2) })).rejects.toBeInstanceOf(ValidationError); expect((await service.getPipeline(actorA(), pipeline.pipeline.id)).stages.map((stage) => stage.id)).toEqual(reversed);
  });

  it("allows empty pipelines and last-stage archive while maintaining contiguous positions", async () => {
    const empty = await service.createPipeline(actorA(), { name: "Empty Allowed" }); expect((await service.getPipeline(actorA(), empty.pipeline.id)).stages).toHaveLength(0);
    const stage = await service.createStage(actorA(), empty.pipeline.id, { name: "Only", kind: "open", probability: 0 }); await service.archiveStage(actorA(), empty.pipeline.id, stage.id); expect((await service.getPipeline(actorA(), empty.pipeline.id)).stages).toHaveLength(0);
  });

  it("requires explicit replacement when archiving a default and blocks the sole active pipeline", async () => {
    const soloOrg = await organizations.createOrganizationWithOwner({ name: "Pipeline Solo", slug: "pipeline-solo" }, { name: "Solo Owner", email: "pipeline-solo@example.test", password: "Synthetic-Pass-789" }); const soloActor = { userId: soloOrg.user.id, organizationId: soloOrg.organization.id, role: "owner" as const }; const solo = await service.createPipeline(soloActor, { name: "Only" }); await expect(service.archivePipeline(soloActor, solo.pipeline.id)).rejects.toBeInstanceOf(ConflictError);
    const currentDefault = (await service.listPipelines(actorA())).find((pipeline) => pipeline.isDefault)!; const replacement = (await service.listPipelines(actorA())).find((pipeline) => pipeline.id !== currentDefault.id)!; await expect(service.archivePipeline(actorA(), currentDefault.id)).rejects.toBeInstanceOf(ConflictError); await service.archivePipeline(actorA(), currentDefault.id, { replacementPipelineId: replacement.id }); expect((await service.listPipelines(actorA())).find((pipeline) => pipeline.isDefault)?.id).toBe(replacement.id);
  });

  it("enforces persisted read-only RBAC", async () => {
    const viewerResult = await new UserService().createUserWithMembership(actorA(), { name: "Pipeline Viewer", email: "pipeline-viewer@example.test", password: "Synthetic-Viewer-123" }, "viewer"); const viewer = { userId: viewerResult.user.id, organizationId: orgA.organization.id, role: "viewer" as const }; const visible = await service.listPipelines(viewer); expect(visible.length).toBeGreaterThan(0); await expect(service.createPipeline(viewer, { name: "Denied" })).rejects.toBeInstanceOf(ForbiddenError); await expect(service.createStage(viewer, visible[0].id, { name: "Denied", kind: "open", probability: 0 })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
