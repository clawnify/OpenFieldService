import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import { authorize } from "@/auth/authorization";
import { getDb } from "@/db";
import { AuditRepository } from "@/modules/audit/audit.repository";
import type { RequestActor } from "@/modules/customers/customer.service";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { createObjectKey, r2Storage, type ObjectStorage } from "@/lib/r2";
import { parseInput } from "@/lib/validation";
import {
  ContractReport,
  type ContractPdfModel,
} from "@/reports/contract-report";
import { ContractRepository } from "./contract.repository";
import {
  addSignerSchema,
  consentSchema,
  contractFilterSchema,
  createContractSchema,
  declineContractSchema,
  publicContractTokenSchema,
  sendContractSchema,
  signContractSchema,
  updateContractVersionSchema,
  voidContractSchema,
} from "./contract.schema";
import {
  assertCanRevise,
  assertDraft,
  binarySha256,
  contractDocumentHash,
  createContractCapability,
  deriveSigningStatus,
  hashContractCapability,
  parseDrawnSignature,
} from "./contract.rules";

type ContractRow = Awaited<ReturnType<ContractRepository["find"]>> & {};
type VersionRow = NonNullable<
  Awaited<ReturnType<ContractRepository["version"]>>
>;
const json = <T>(value: string): T => JSON.parse(value) as T;
const dataUrl = (bytes: Uint8Array) =>
  `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;

export class ContractService {
  constructor(private readonly storage: ObjectStorage = r2Storage) {}

  async create(actor: RequestActor, raw: unknown) {
    await authorize(actor, "contract.create");
    const input = parseInput(createContractSchema, raw);
    try {
      return await getDb().transaction(async (tx) => {
        const repository = new ContractRepository(tx);
        await repository.lockOrganization(actor.organizationId);
        const quote = await repository.acceptedQuote(
          actor.organizationId,
          input.quoteId,
        );
        if (!quote?.acceptedVersionId || !quote.acceptedOptionId)
          throw new ConflictError(
            "A Contract requires an accepted Quote option",
          );
        const [version, option, customer, organization] = await Promise.all([
          repository.quoteVersion(
            actor.organizationId,
            quote.acceptedVersionId,
          ),
          repository.quoteOption(actor.organizationId, quote.acceptedOptionId),
          repository.customer(actor.organizationId, quote.customerId),
          repository.organization(actor.organizationId),
        ]);
        if (
          !version ||
          version.quoteId !== quote.id ||
          !option ||
          option.quoteId !== quote.id ||
          option.versionId !== version.id ||
          !customer ||
          !organization
        )
          throw new ConflictError("Accepted Quote provenance is invalid");
        const lines = await repository.quoteLines(
            actor.organizationId,
            option.id,
          ),
          tax = await repository.taxSnapshot(actor.organizationId, option.id),
          selection = await repository.acceptedProposalSelection(
            actor.organizationId,
            quote.id,
            version.id,
            option.id,
          );
        const existing = (
          await repository.list(actor.organizationId, {
            quoteId: quote.id,
            limit: 1,
          })
        )[0];
        if (
          existing &&
          !["cancelled", "voided"].includes(existing.contract.status)
        )
          throw new ConflictError(
            "This accepted Quote already has a live Contract",
          );
        const sequenceNumber = await repository.nextSequence(
          actor.organizationId,
        );
        const commercial = {
          quoteId: quote.id,
          quoteIdentifier: quote.identifier,
          quoteVersionId: version.id,
          quoteVersionNumber: version.versionNumber,
          optionId: option.id,
          optionName: option.name,
          optionTier: option.tier,
          lines: lines.map((line) => ({
            description: line.description,
            category: line.category,
            quantityMilli: line.quantityMilli,
            unit: line.unit,
            unitPriceCents: line.unitPriceCents,
            taxable: line.taxable,
            totalCents: line.totalCents,
          })),
          subtotalCents: option.subtotalCents,
          discountCents: option.discountCents,
          taxCents: option.taxCents,
          totalCents: option.totalCents,
          taxSnapshot: tax
            ? {
                enabled: tax.enabled,
                countryCode: tax.countryCode,
                regionCode: tax.regionCode,
                currency: tax.currency,
                pricesIncludeTax: tax.pricesIncludeTax,
                taxableBaseCents: tax.taxableBaseCents,
                totalTaxCents: tax.totalTaxCents,
                components: tax.components.map((component) => ({
                  code: component.code,
                  name: component.name,
                  rateBasisPoints: component.rateBasisPoints,
                  amountCents: component.amountCents,
                })),
              }
            : null,
          customerSelection: selection
            ? {
                selectorName: selection.selectorName,
                selectedAt: selection.selectedAt?.toISOString() ?? null,
                selectorIp: selection.selectorIp,
                selectorUserAgent: selection.selectorUserAgent,
              }
            : null,
        };
        const customerSnapshot = {
          id: customer.id,
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          address: [
            customer.addressLine1,
            customer.addressLine2,
            customer.city,
            customer.region,
            customer.postalCode,
          ]
            .filter(Boolean)
            .join(", "),
        };
        const companySnapshot = { name: organization.name };
        const contract = await repository.create({
          organizationId: actor.organizationId,
          sequenceNumber,
          identifier: `CONTRACT-${sequenceNumber}`,
          customerId: customer.id,
          quoteId: quote.id,
          acceptedQuoteVersionId: version.id,
          acceptedOptionId: option.id,
          acceptedTotalCents: option.totalCents,
          createdBy: actor.userId,
        });
        const contractVersion = await repository.createVersion({
          organizationId: actor.organizationId,
          contractId: contract.id,
          versionNumber: 1,
          title: input.title,
          body: input.body,
          commercialSnapshot: JSON.stringify(commercial),
          customerSnapshot: JSON.stringify(customerSnapshot),
          companySnapshot: JSON.stringify(companySnapshot),
          effectiveOn: input.effectiveOn,
          expiresAt: input.expiresAt,
          createdBy: actor.userId,
        });
        await repository.setCurrent(
          actor.organizationId,
          contract.id,
          contractVersion.id,
        );
        await repository.history({
          organizationId: actor.organizationId,
          contractId: contract.id,
          fromStatus: null,
          toStatus: "draft",
          actorUserId: actor.userId,
          reason: "Created from accepted Quote",
        });
        await new AuditRepository(tx).record({
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "contract.created",
          entityType: "contract",
          entityId: contract.id,
          metadata: {
            quoteId: quote.id,
            quoteVersionId: version.id,
            optionId: option.id,
          },
        });
        return {
          ...contract,
          currentVersionId: contractVersion.id,
          version: contractVersion,
        };
      });
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      if (
        error instanceof Error &&
        /contracts_live_quote_unique|contracts_org_sequence_unique/.test(
          error.message,
        )
      )
        throw new ConflictError(
          "Contract creation conflicted with another request",
        );
      throw error;
    }
  }

  async get(actor: RequestActor, id: string) {
    await authorize(actor, "contract.read");
    const repository = new ContractRepository(),
      contract = await repository.find(actor.organizationId, id);
    if (!contract?.currentVersionId)
      throw new NotFoundError("Contract not found");
    const version = await repository.version(
      actor.organizationId,
      contract.id,
      contract.currentVersionId,
    );
    if (!version) throw new NotFoundError("Contract version not found");
    const requests = (
      await repository.requests(actor.organizationId, contract.id, version.id)
    ).map((value) => {
      const { tokenHash, signatureImageKey, ...request } = value;
      void tokenHash;
      void signatureImageKey;
      return request;
    });
    const { signedDocumentKey, ...safeVersion } = version;
    void signedDocumentKey;
    return {
      contract,
      version: safeVersion,
      signers: await repository.signers(actor.organizationId, contract.id),
      requests,
    };
  }
  async list(actor: RequestActor, raw: unknown = {}) {
    await authorize(actor, "contract.read");
    return new ContractRepository().list(
      actor.organizationId,
      parseInput(contractFilterSchema, raw),
    );
  }

  async updateDraft(actor: RequestActor, id: string, raw: unknown) {
    await authorize(actor, "contract.update");
    const input = parseInput(updateContractVersionSchema, raw);
    return getDb().transaction(async (tx) => {
      const repository = new ContractRepository(tx),
        contract = await repository.lock(actor.organizationId, id);
      if (!contract?.currentVersionId)
        throw new NotFoundError("Contract not found");
      assertDraft(contract.status);
      const current = await repository.version(
        actor.organizationId,
        id,
        contract.currentVersionId,
        true,
      );
      if (!current) throw new NotFoundError("Contract version not found");
      const version = await repository.updateVersion(
        actor.organizationId,
        id,
        current.id,
        input.expectedRowVersion,
        {
          title: input.title,
          body: input.body,
          effectiveOn: input.effectiveOn,
          expiresAt: input.expiresAt,
        },
      );
      if (!version)
        throw new ConflictError("Contract version changed; reload and retry");
      await new AuditRepository(tx).record({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: "contract.updated",
        entityType: "contract",
        entityId: id,
        metadata: { versionId: version.id },
      });
      return version;
    });
  }

  async createRevision(actor: RequestActor, id: string) {
    await authorize(actor, "contract.update");
    return getDb().transaction(async (tx) => {
      const repository = new ContractRepository(tx),
        contract = await repository.lock(actor.organizationId, id);
      if (!contract?.currentVersionId)
        throw new NotFoundError("Contract not found");
      assertCanRevise(contract.status);
      const source = await repository.version(
        actor.organizationId,
        id,
        contract.currentVersionId,
        true,
      );
      if (!source) throw new NotFoundError("Contract version not found");
      const versions = await repository.versions(actor.organizationId, id);
      await repository.revokeActiveRequests(actor.organizationId, id);
      const revision = await repository.createVersion({
        organizationId: actor.organizationId,
        contractId: id,
        versionNumber: (versions.at(-1)?.versionNumber ?? 0) + 1,
        title: source.title,
        body: source.body,
        commercialSnapshot: source.commercialSnapshot,
        customerSnapshot: source.customerSnapshot,
        companySnapshot: source.companySnapshot,
        effectiveOn: source.effectiveOn,
        expiresAt: source.expiresAt,
        createdBy: actor.userId,
      });
      await repository.setCurrent(actor.organizationId, id, revision.id);
      await repository.transition(actor.organizationId, id, contract.status, {
        status: "draft",
      });
      await repository.history({
        organizationId: actor.organizationId,
        contractId: id,
        fromStatus: contract.status,
        toStatus: "draft",
        actorUserId: actor.userId,
        reason: "Revision created",
      });
      await new AuditRepository(tx).record({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: "contract.revision_created",
        entityType: "contract",
        entityId: id,
        metadata: {
          sourceVersionId: source.id,
          versionId: revision.id,
          versionNumber: revision.versionNumber,
        },
      });
      return revision;
    });
  }

  async addSigner(actor: RequestActor, id: string, raw: unknown) {
    await authorize(actor, "contract.signing.manage");
    const input = parseInput(addSignerSchema, raw);
    return getDb().transaction(async (tx) => {
      const repository = new ContractRepository(tx),
        contract = await repository.lock(actor.organizationId, id);
      if (!contract) throw new NotFoundError("Contract not found");
      assertDraft(contract.status);
      const existing = await repository.signers(actor.organizationId, id),
        signer = await repository.addSigner({
          organizationId: actor.organizationId,
          contractId: id,
          ...input,
          sortOrder: existing.length,
        });
      await new AuditRepository(tx).record({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: "contract.signer_added",
        entityType: "contract",
        entityId: id,
        metadata: { signerId: signer.id, role: signer.role },
      });
      return signer;
    });
  }

  async send(actor: RequestActor, id: string, raw: unknown = {}) {
    await authorize(actor, "contract.send");
    const input = parseInput(sendContractSchema, raw);
    return getDb().transaction(async (tx) => {
      const repository = new ContractRepository(tx),
        contract = await repository.lock(actor.organizationId, id);
      if (!contract?.currentVersionId)
        throw new NotFoundError("Contract not found");
      assertDraft(contract.status);
      const version = await repository.version(
          actor.organizationId,
          id,
          contract.currentVersionId,
          true,
        ),
        signers = await repository.signers(actor.organizationId, id);
      if (!version) throw new NotFoundError("Contract version not found");
      if (!signers.length)
        throw new ConflictError("Add at least one signer before sending");
      const documentHash = contractDocumentHash({
        title: version.title,
        body: version.body,
        commercialSnapshot: version.commercialSnapshot,
        customerSnapshot: version.customerSnapshot,
        companySnapshot: version.companySnapshot,
        effectiveOn: version.effectiveOn,
        expiresAt: version.expiresAt,
      });
      const frozen = await repository.updateVersion(
        actor.organizationId,
        id,
        version.id,
        version.rowVersion,
        { documentHash },
      );
      if (!frozen)
        throw new ConflictError("Contract version changed concurrently");
      const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000),
        links = [];
      for (const signer of signers) {
        const token = createContractCapability(),
          request = await repository.createRequest({
            organizationId: actor.organizationId,
            contractId: id,
            contractVersionId: version.id,
            signerId: signer.id,
            tokenHash: hashContractCapability(token),
            expiresAt,
            consentTextVersion: input.consentTextVersion,
            createdBy: actor.userId,
          });
        links.push({
          signerId: signer.id,
          signerName: signer.name,
          token,
          requestId: request.id,
        });
      }
      const updated = await repository.transition(
        actor.organizationId,
        id,
        "draft",
        { status: "sent" },
      );
      if (!updated) throw new ConflictError("Contract changed concurrently");
      await repository.history({
        organizationId: actor.organizationId,
        contractId: id,
        fromStatus: "draft",
        toStatus: "sent",
        actorUserId: actor.userId,
        reason: "Sent for signature",
      });
      await new AuditRepository(tx).record({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: "contract.sent",
        entityType: "contract",
        entityId: id,
        metadata: { versionId: version.id, signerCount: signers.length },
      });
      return { links, contract: updated };
    });
  }

  async revokeSigningRequest(
    actor: RequestActor,
    id: string,
    requestId: string,
  ) {
    await authorize(actor, "contract.signing.manage");
    return getDb().transaction(async (tx) => {
      const repository = new ContractRepository(tx),
        contract = await repository.lock(actor.organizationId, id);
      if (!contract?.currentVersionId)
        throw new NotFoundError("Contract not found");
      const requests = await repository.requests(
          actor.organizationId,
          id,
          contract.currentVersionId,
        ),
        request = requests.find((value) => value.id === requestId);
      if (!request) throw new NotFoundError("Signing request not found");
      if (!["pending", "viewed"].includes(request.status))
        throw new ConflictError("Completed signing requests cannot be revoked");
      if (
        !(await repository.updateRequest(request.id, ["pending", "viewed"], {
          status: "revoked",
        }))
      )
        throw new ConflictError("Signing request changed concurrently");
      const nextStatuses = requests.map((value) =>
          value.id === request.id ? "revoked" : value.status,
        ),
        nextStatus = deriveSigningStatus(nextStatuses);
      if (nextStatus !== contract.status) {
        await repository.transition(actor.organizationId, id, contract.status, {
          status: nextStatus,
        });
        await repository.history({
          organizationId: actor.organizationId,
          contractId: id,
          fromStatus: contract.status,
          toStatus: nextStatus,
          actorUserId: actor.userId,
          reason: "Signing request revoked",
        });
      }
      await repository.event({
        organizationId: actor.organizationId,
        signatureRequestId: request.id,
        eventType: "revoked",
      });
      await new AuditRepository(tx).record({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: "contract.signing_link_revoked",
        entityType: "contract",
        entityId: id,
        metadata: { requestId },
      });
    });
  }

  async publicView(rawToken: string) {
    const token = parseInput(publicContractTokenSchema, rawToken);
    return getDb().transaction(async (tx) => {
      const repository = new ContractRepository(tx);
      let request = await repository.requestByHash(
        hashContractCapability(token),
      );
      if (
        !request ||
        ["revoked", "expired"].includes(request.status) ||
        request.expiresAt < new Date()
      )
        return null;
      const contract = await repository.lock(
        request.organizationId,
        request.contractId,
      );
      request = await repository.requestByHash(
        hashContractCapability(token),
        true,
      );
      if (
        !request ||
        ["revoked", "expired"].includes(request.status) ||
        request.expiresAt < new Date()
      )
        return null;
      const version = await repository.version(
          request.organizationId,
          request.contractId,
          request.contractVersionId,
        ),
        signer = (
          await repository.signers(request.organizationId, request.contractId)
        ).find((x) => x.id === request.signerId);
      if (
        !contract ||
        !version ||
        !signer ||
        contract.currentVersionId !== version.id ||
        ["voided", "cancelled"].includes(contract.status)
      )
        return null;
      if (request.status === "pending") {
        await repository.markViewed(request.id);
        await repository.event({
          organizationId: request.organizationId,
          signatureRequestId: request.id,
          eventType: "viewed",
        });
      }
      const { customerSelection, ...publicCommercial } = json<
        Record<string, unknown> & { customerSelection?: unknown }
      >(version.commercialSnapshot);
      void customerSelection;
      return {
        identifier: contract.identifier,
        status: request.status,
        title: version.title,
        body: version.body,
        effectiveOn: version.effectiveOn,
        expiresAt: request.expiresAt,
        consentTextVersion: request.consentTextVersion,
        consentAt: request.consentAt,
        signer: { name: signer.name, role: signer.role },
        customer: json<{ name: string }>(version.customerSnapshot),
        company: json<{ name: string }>(version.companySnapshot),
        commercial: publicCommercial,
      };
    });
  }

  async consent(
    rawToken: string,
    raw: unknown,
    meta: { ip: string | null; userAgent: string | null },
  ) {
    const token = parseInput(publicContractTokenSchema, rawToken),
      input = parseInput(consentSchema, raw);
    return getDb().transaction(async (tx) => {
      const repository = new ContractRepository(tx),
        request = await repository.requestByHash(
          hashContractCapability(token),
          true,
        );
      if (
        !request ||
        !["pending", "viewed"].includes(request.status) ||
        request.expiresAt < new Date()
      )
        throw new NotFoundError("Signing request is invalid or expired");
      if (input.consentTextVersion !== request.consentTextVersion)
        throw new ConflictError("Consent text has changed");
      if (!request.consentAt) {
        await repository.updateRequest(request.id, ["pending", "viewed"], {
          consentAt: new Date(),
        });
        await repository.event({
          organizationId: request.organizationId,
          signatureRequestId: request.id,
          eventType: "consented",
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
          metadata: JSON.stringify({
            consentTextVersion: input.consentTextVersion,
          }),
        });
      }
    });
  }

  async sign(
    rawToken: string,
    raw: unknown,
    meta: { ip: string | null; userAgent: string | null },
  ) {
    const token = parseInput(publicContractTokenSchema, rawToken),
      input = parseInput(signContractSchema, raw);
    let imageKey: string | null = null,
      artifactKey: string | null = null;
    try {
      return await getDb().transaction(async (tx) => {
        const repository = new ContractRepository(tx);
        let request = await repository.requestByHash(
          hashContractCapability(token),
        );
        if (!request)
          throw new NotFoundError("Signing request is invalid or expired");
        const contract = await repository.lock(
          request.organizationId,
          request.contractId,
        );
        request = await repository.requestByHash(
          hashContractCapability(token),
          true,
        );
        if (!request)
          throw new NotFoundError("Signing request is invalid or expired");
        if (
          !contract?.currentVersionId ||
          contract.currentVersionId !== request.contractVersionId
        )
          throw new NotFoundError("Signing request is invalid or expired");
        if (request.status === "signed")
          return { contractId: contract.id, idempotent: true };
        if (
          !["sent", "partially_signed"].includes(contract.status) ||
          request.expiresAt < new Date()
        )
          throw new NotFoundError("Signing request is invalid or expired");
        if (
          !request.consentAt ||
          !["pending", "viewed"].includes(request.status)
        )
          throw new ConflictError("Consent is required before signing");
        const version = await repository.version(
          request.organizationId,
          contract.id,
          request.contractVersionId,
          true,
        );
        if (!version?.documentHash)
          throw new ConflictError("Contract document is not frozen");
        const signer = (
          await repository.signers(request.organizationId, contract.id)
        ).find((x) => x.id === request.signerId);
        if (
          !signer ||
          signer.name.trim().toLocaleLowerCase() !==
            input.signerName.trim().toLocaleLowerCase()
        )
          throw new ConflictError(
            "Signer identity does not match this request",
          );
        let imageBytes: Uint8Array | null = null;
        if (input.method === "drawn") {
          imageBytes = parseDrawnSignature(input.signatureImageDataUrl!);
          imageKey = createObjectKey(
            request.organizationId,
            "contract_signature",
            request.id,
          );
          await this.storage.put(imageKey, imageBytes, "image/png");
        }
        const now = new Date(),
          signedRequest = await repository.updateRequest(
            request.id,
            ["pending", "viewed"],
            {
              status: "signed",
              signedAt: now,
              method: input.method,
              signerName: input.signerName,
              signerIp: meta.ip,
              signerUserAgent: meta.userAgent,
              signatureImageKey: imageKey,
            },
          );
        if (!signedRequest)
          throw new ConflictError("Signing request was answered concurrently");
        await repository.event({
          organizationId: request.organizationId,
          signatureRequestId: request.id,
          eventType: "signed",
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
          metadata: JSON.stringify({ method: input.method }),
        });
        const requests = await repository.requests(
            request.organizationId,
            contract.id,
            version.id,
          ),
          nextStatus = deriveSigningStatus(requests.map((x) => x.status));
        let artifactHash: string | null = null;
        if (nextStatus === "signed") {
          const model = await this.pdfModel(
            repository,
            contract,
            version,
            requests,
          );
          const pdf = new Uint8Array(
            await renderToBuffer(ContractReport({ model })),
          );
          artifactKey = createObjectKey(
            request.organizationId,
            "contract",
            contract.id,
          );
          artifactHash = binarySha256(pdf);
          await this.storage.put(artifactKey, pdf, "application/pdf");
          const finalized = await repository.updateVersion(
            request.organizationId,
            contract.id,
            version.id,
            version.rowVersion,
            {
              signedDocumentKey: artifactKey,
              signedDocumentHash: artifactHash,
              signedAt: now,
            },
          );
          if (!finalized)
            throw new ConflictError(
              "Contract finalization conflicted with another request",
            );
        }
        if (nextStatus !== contract.status) {
          const changed = await repository.transition(
            request.organizationId,
            contract.id,
            contract.status,
            { status: nextStatus },
          );
          if (!changed)
            throw new ConflictError("Contract status changed concurrently");
          await repository.history({
            organizationId: request.organizationId,
            contractId: contract.id,
            fromStatus: contract.status,
            toStatus: nextStatus,
            actorUserId: null,
            reason: "Derived from signature requests",
          });
        }
        await new AuditRepository(tx).record({
          organizationId: request.organizationId,
          actorUserId: null,
          action:
            nextStatus === "signed"
              ? "contract.signed_document_retained"
              : "contract.signed",
          entityType: "contract",
          entityId: contract.id,
          metadata: {
            versionId: version.id,
            requestId: request.id,
            artifactHash,
          },
        });
        return {
          contractId: contract.id,
          idempotent: false,
          status: nextStatus,
        };
      });
    } catch (error) {
      if (artifactKey)
        try {
          await this.storage.delete(artifactKey);
        } catch {}
      if (imageKey)
        try {
          await this.storage.delete(imageKey);
        } catch {}
      throw error;
    }
  }

  async decline(
    rawToken: string,
    raw: unknown,
    meta: { ip: string | null; userAgent: string | null },
  ) {
    const token = parseInput(publicContractTokenSchema, rawToken),
      input = parseInput(declineContractSchema, raw);
    return getDb().transaction(async (tx) => {
      const repository = new ContractRepository(tx);
      let request = await repository.requestByHash(
        hashContractCapability(token),
      );
      if (
        !request ||
        !["pending", "viewed"].includes(request.status) ||
        request.expiresAt < new Date()
      )
        throw new NotFoundError("Signing request is invalid or expired");
      const contract = await repository.lock(
        request.organizationId,
        request.contractId,
      );
      request = await repository.requestByHash(
        hashContractCapability(token),
        true,
      );
      if (
        !request ||
        !["pending", "viewed"].includes(request.status) ||
        request.expiresAt < new Date()
      )
        throw new NotFoundError("Signing request is invalid or expired");
      if (!contract || !["sent", "partially_signed"].includes(contract.status))
        throw new ConflictError("Contract cannot be declined");
      if (
        !(await repository.updateRequest(request.id, ["pending", "viewed"], {
          status: "declined",
          declinedReason: input.reason,
        }))
      )
        throw new ConflictError("Signing request changed concurrently");
      await repository.event({
        organizationId: request.organizationId,
        signatureRequestId: request.id,
        eventType: "declined",
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      });
      await repository.transition(
        request.organizationId,
        contract.id,
        contract.status,
        { status: "declined" },
      );
      await repository.history({
        organizationId: request.organizationId,
        contractId: contract.id,
        fromStatus: contract.status,
        toStatus: "declined",
        actorUserId: null,
        reason: "Signer declined",
      });
      await new AuditRepository(tx).record({
        organizationId: request.organizationId,
        actorUserId: null,
        action: "contract.declined",
        entityType: "contract",
        entityId: contract.id,
        metadata: { requestId: request.id },
      });
    });
  }

  async void(actor: RequestActor, id: string, raw: unknown) {
    await authorize(actor, "contract.void");
    const input = parseInput(voidContractSchema, raw);
    return getDb().transaction(async (tx) => {
      const repository = new ContractRepository(tx),
        contract = await repository.lock(actor.organizationId, id);
      if (!contract) throw new NotFoundError("Contract not found");
      if (
        !["sent", "partially_signed", "signed", "declined", "expired"].includes(
          contract.status,
        )
      )
        throw new ConflictError("Contract cannot be voided from this state");
      await repository.revokeActiveRequests(actor.organizationId, id);
      const changed = await repository.transition(
        actor.organizationId,
        id,
        contract.status,
        { status: "voided", voidedAt: new Date(), voidReason: input.reason },
      );
      if (!changed) throw new ConflictError("Contract changed concurrently");
      await repository.history({
        organizationId: actor.organizationId,
        contractId: id,
        fromStatus: contract.status,
        toStatus: "voided",
        actorUserId: actor.userId,
        reason: input.reason,
      });
      await new AuditRepository(tx).record({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: "contract.voided",
        entityType: "contract",
        entityId: id,
        metadata: {},
      });
      return changed;
    });
  }

  async signedDocumentUrl(actor: RequestActor, id: string) {
    await authorize(actor, "contract.read");
    const repository = new ContractRepository(),
      contract = await repository.find(actor.organizationId, id);
    if (!contract?.currentVersionId)
      throw new NotFoundError("Contract not found");
    const version = await repository.version(
      actor.organizationId,
      contract.id,
      contract.currentVersionId,
    );
    if (!version) throw new NotFoundError("Contract version not found");
    if (
      !version.signedDocumentKey ||
      !version.signedDocumentHash ||
      !version.signedAt ||
      !["signed", "voided"].includes(contract.status)
    )
      throw new ConflictError("A retained signed document is not available");
    try {
      if (!this.storage.get)
        throw new Error("Storage integrity verification is unavailable");
      const bytes = await this.storage.get(version.signedDocumentKey);
      if (binarySha256(bytes) !== version.signedDocumentHash)
        throw new Error("Signed artifact hash mismatch");
      return {
        url: await this.storage.signedDownloadUrl(
          version.signedDocumentKey,
          300,
        ),
        filename: `${contract.identifier}-signed.pdf`,
        sha256: version.signedDocumentHash,
        expiresIn: 300,
      };
    } catch {
      throw new ConflictError(
        "Signed document storage is temporarily unavailable",
      );
    }
  }

  private async pdfModel(
    repository: ContractRepository,
    contract: NonNullable<ContractRow>,
    version: VersionRow,
    requests: Awaited<ReturnType<ContractRepository["requests"]>>,
  ): Promise<ContractPdfModel> {
    const signers = await repository.signers(
        contract.organizationId,
        contract.id,
      ),
      commercial = json<{
        quoteIdentifier: string;
        optionName: string;
        lines: ContractPdfModel["commercial"]["lines"];
        subtotalCents: number;
        discountCents: number;
        taxCents: number;
        totalCents: number;
        taxSnapshot?: {
          currency?: string;
          components?: ContractPdfModel["commercial"]["taxComponents"];
        } | null;
      }>(version.commercialSnapshot);
    const signatures: ContractPdfModel["signatures"] = [];
    for (const request of requests.filter((x) => x.status === "signed")) {
      const signer = signers.find((x) => x.id === request.signerId);
      if (!signer || !request.signedAt || !request.method) continue;
      let imageDataUrl: string | undefined;
      if (request.signatureImageKey && this.storage.get) {
        try {
          imageDataUrl = dataUrl(
            await this.storage.get(request.signatureImageKey),
          );
        } catch {}
      }
      signatures.push({
        signerName: request.signerName ?? signer.name,
        role: signer.role,
        method: request.method,
        signedAt: request.signedAt.toISOString(),
        ip: request.signerIp,
        userAgent: request.signerUserAgent,
        imageDataUrl,
      });
    }
    return {
      identifier: contract.identifier,
      versionNumber: version.versionNumber,
      title: version.title,
      body: version.body,
      effectiveOn: version.effectiveOn,
      company: json(version.companySnapshot),
      customer: json(version.customerSnapshot),
      commercial: {
        quoteIdentifier: commercial.quoteIdentifier,
        optionName: commercial.optionName,
        lines: commercial.lines,
        subtotalCents: commercial.subtotalCents,
        discountCents: commercial.discountCents,
        taxCents: commercial.taxCents,
        totalCents: commercial.totalCents,
        currency: commercial.taxSnapshot?.currency ?? "CAD",
        taxComponents: commercial.taxSnapshot?.components ?? [],
      },
      signatures,
      documentHash: version.documentHash ?? "",
    };
  }
}
