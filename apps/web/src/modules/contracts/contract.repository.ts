import "server-only";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import {
  contractSignatureEvents,
  contractSignatureRequests,
  contractSigners,
  contractStatusHistory,
  contracts,
  contractVersions,
  customers,
  organizations,
  proposalLinks,
  quoteOptionLines,
  quoteOptions,
  quotes,
  quoteVersions,
  taxSnapshotComponents,
  taxSnapshots,
} from "@/db/schema";

export class ContractRepository {
  constructor(readonly db: DatabaseExecutor = getDb()) {}
  async lockOrganization(id: string) {
    return (
      await this.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, id))
        .for("update")
    )[0];
  }
  async nextSequence(organizationId: string) {
    const [row] = await this.db
      .select({
        value: sql<number>`coalesce(max(${contracts.sequenceNumber}), 0) + 1`,
      })
      .from(contracts)
      .where(eq(contracts.organizationId, organizationId));
    return Number(row?.value ?? 1);
  }
  async lock(organizationId: string, id: string) {
    return (
      await this.db
        .select()
        .from(contracts)
        .where(
          and(
            eq(contracts.organizationId, organizationId),
            eq(contracts.id, id),
          ),
        )
        .for("update")
    )[0];
  }
  async find(organizationId: string, id: string) {
    return this.db.query.contracts.findFirst({
      where: and(
        eq(contracts.organizationId, organizationId),
        eq(contracts.id, id),
        sql`${contracts.archivedAt} is null`,
      ),
    });
  }
  async list(
    organizationId: string,
    input: {
      search?: string;
      status?: typeof contracts.$inferSelect.status;
      customerId?: string;
      quoteId?: string;
      limit: number;
    },
  ) {
    const filters = [
      eq(contracts.organizationId, organizationId),
      sql`${contracts.archivedAt} is null`,
    ];
    if (input.status) filters.push(eq(contracts.status, input.status));
    if (input.customerId)
      filters.push(eq(contracts.customerId, input.customerId));
    if (input.quoteId) filters.push(eq(contracts.quoteId, input.quoteId));
    if (input.search)
      filters.push(
        or(
          ilike(contracts.identifier, `%${input.search}%`),
          ilike(contractVersions.title, `%${input.search}%`),
        )!,
      );
    return this.db
      .select({
        contract: contracts,
        title: contractVersions.title,
        customerName: customers.name,
      })
      .from(contracts)
      .leftJoin(
        contractVersions,
        and(
          eq(contractVersions.organizationId, contracts.organizationId),
          eq(contractVersions.id, contracts.currentVersionId),
        ),
      )
      .leftJoin(
        customers,
        and(
          eq(customers.organizationId, contracts.organizationId),
          eq(customers.id, contracts.customerId),
        ),
      )
      .where(and(...filters))
      .orderBy(desc(contracts.createdAt), desc(contracts.id))
      .limit(input.limit);
  }
  async acceptedQuote(organizationId: string, quoteId: string) {
    return this.db.query.quotes.findFirst({
      where: and(
        eq(quotes.organizationId, organizationId),
        eq(quotes.id, quoteId),
        eq(quotes.status, "accepted"),
      ),
    });
  }
  async quoteVersion(organizationId: string, id: string) {
    return this.db.query.quoteVersions.findFirst({
      where: and(
        eq(quoteVersions.organizationId, organizationId),
        eq(quoteVersions.id, id),
      ),
    });
  }
  async quoteOption(organizationId: string, id: string) {
    return this.db.query.quoteOptions.findFirst({
      where: and(
        eq(quoteOptions.organizationId, organizationId),
        eq(quoteOptions.id, id),
      ),
    });
  }
  async customer(organizationId: string, id: string) {
    return this.db.query.customers.findFirst({
      where: and(
        eq(customers.organizationId, organizationId),
        eq(customers.id, id),
      ),
    });
  }
  async organization(id: string) {
    return this.db.query.organizations.findFirst({
      where: eq(organizations.id, id),
    });
  }
  async quoteLines(organizationId: string, optionId: string) {
    return this.db
      .select()
      .from(quoteOptionLines)
      .where(
        and(
          eq(quoteOptionLines.organizationId, organizationId),
          eq(quoteOptionLines.optionId, optionId),
        ),
      )
      .orderBy(asc(quoteOptionLines.sortOrder));
  }
  async taxSnapshot(organizationId: string, optionId: string) {
    const snapshot = await this.db.query.taxSnapshots.findFirst({
      where: and(
        eq(taxSnapshots.organizationId, organizationId),
        eq(taxSnapshots.optionId, optionId),
      ),
    });
    if (!snapshot) return null;
    return {
      ...snapshot,
      components: await this.db
        .select()
        .from(taxSnapshotComponents)
        .where(
          and(
            eq(taxSnapshotComponents.organizationId, organizationId),
            eq(taxSnapshotComponents.snapshotId, snapshot.id),
          ),
        )
        .orderBy(asc(taxSnapshotComponents.sortOrder)),
    };
  }
  async acceptedProposalSelection(
    organizationId: string,
    quoteId: string,
    versionId: string,
    optionId: string,
  ) {
    return this.db.query.proposalLinks.findFirst({
      where: and(
        eq(proposalLinks.organizationId, organizationId),
        eq(proposalLinks.quoteId, quoteId),
        eq(proposalLinks.versionId, versionId),
        eq(proposalLinks.selectedOptionId, optionId),
        eq(proposalLinks.status, "selected"),
      ),
    });
  }
  async create(value: typeof contracts.$inferInsert) {
    return (await this.db.insert(contracts).values(value).returning())[0]!;
  }
  async createVersion(value: typeof contractVersions.$inferInsert) {
    return (
      await this.db.insert(contractVersions).values(value).returning()
    )[0]!;
  }
  async setCurrent(organizationId: string, id: string, versionId: string) {
    await this.db
      .update(contracts)
      .set({ currentVersionId: versionId, updatedAt: new Date() })
      .where(
        and(eq(contracts.organizationId, organizationId), eq(contracts.id, id)),
      );
  }
  async version(
    organizationId: string,
    contractId: string,
    id: string,
    lock = false,
  ) {
    const query = this.db
      .select()
      .from(contractVersions)
      .where(
        and(
          eq(contractVersions.organizationId, organizationId),
          eq(contractVersions.contractId, contractId),
          eq(contractVersions.id, id),
        ),
      );
    return lock ? (await query.for("update"))[0] : (await query)[0];
  }
  async versions(organizationId: string, contractId: string) {
    return this.db
      .select()
      .from(contractVersions)
      .where(
        and(
          eq(contractVersions.organizationId, organizationId),
          eq(contractVersions.contractId, contractId),
        ),
      )
      .orderBy(asc(contractVersions.versionNumber));
  }
  async updateVersion(
    organizationId: string,
    contractId: string,
    id: string,
    expected: number,
    value: Partial<typeof contractVersions.$inferInsert>,
  ) {
    return (
      await this.db
        .update(contractVersions)
        .set({ ...value, rowVersion: sql`${contractVersions.rowVersion} + 1` })
        .where(
          and(
            eq(contractVersions.organizationId, organizationId),
            eq(contractVersions.contractId, contractId),
            eq(contractVersions.id, id),
            eq(contractVersions.rowVersion, expected),
          ),
        )
        .returning()
    )[0];
  }
  async addSigner(value: typeof contractSigners.$inferInsert) {
    return (
      await this.db.insert(contractSigners).values(value).returning()
    )[0]!;
  }
  async signers(organizationId: string, contractId: string) {
    return this.db
      .select()
      .from(contractSigners)
      .where(
        and(
          eq(contractSigners.organizationId, organizationId),
          eq(contractSigners.contractId, contractId),
        ),
      )
      .orderBy(asc(contractSigners.sortOrder));
  }
  async revokeActiveRequests(organizationId: string, contractId: string) {
    await this.db
      .update(contractSignatureRequests)
      .set({ status: "revoked", updatedAt: new Date() })
      .where(
        and(
          eq(contractSignatureRequests.organizationId, organizationId),
          eq(contractSignatureRequests.contractId, contractId),
          inArray(contractSignatureRequests.status, ["pending", "viewed"]),
        ),
      );
  }
  async createRequest(value: typeof contractSignatureRequests.$inferInsert) {
    return (
      await this.db.insert(contractSignatureRequests).values(value).returning()
    )[0]!;
  }
  async requestByHash(tokenHash: string, lock = false) {
    const query = this.db
      .select()
      .from(contractSignatureRequests)
      .where(eq(contractSignatureRequests.tokenHash, tokenHash));
    return lock ? (await query.for("update"))[0] : (await query)[0];
  }
  async requests(
    organizationId: string,
    contractId: string,
    versionId: string,
  ) {
    return this.db
      .select()
      .from(contractSignatureRequests)
      .where(
        and(
          eq(contractSignatureRequests.organizationId, organizationId),
          eq(contractSignatureRequests.contractId, contractId),
          eq(contractSignatureRequests.contractVersionId, versionId),
        ),
      )
      .orderBy(asc(contractSignatureRequests.createdAt));
  }
  async markViewed(id: string) {
    await this.db
      .update(contractSignatureRequests)
      .set({ status: "viewed", updatedAt: new Date() })
      .where(
        and(
          eq(contractSignatureRequests.id, id),
          eq(contractSignatureRequests.status, "pending"),
        ),
      );
  }
  async updateRequest(
    id: string,
    expected: readonly string[],
    value: Partial<typeof contractSignatureRequests.$inferInsert>,
  ) {
    return (
      await this.db
        .update(contractSignatureRequests)
        .set({
          ...value,
          rowVersion: sql`${contractSignatureRequests.rowVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contractSignatureRequests.id, id),
            inArray(contractSignatureRequests.status, [
              ...expected,
            ] as (typeof contractSignatureRequests.$inferSelect.status)[]),
          ),
        )
        .returning()
    )[0];
  }
  async event(value: typeof contractSignatureEvents.$inferInsert) {
    return (
      await this.db.insert(contractSignatureEvents).values(value).returning()
    )[0]!;
  }
  async events(organizationId: string, requestIds: string[]) {
    if (!requestIds.length) return [];
    return this.db
      .select()
      .from(contractSignatureEvents)
      .where(
        and(
          eq(contractSignatureEvents.organizationId, organizationId),
          inArray(contractSignatureEvents.signatureRequestId, requestIds),
        ),
      )
      .orderBy(asc(contractSignatureEvents.createdAt));
  }
  async transition(
    organizationId: string,
    id: string,
    from: typeof contracts.$inferSelect.status,
    value: Partial<typeof contracts.$inferInsert>,
  ) {
    return (
      await this.db
        .update(contracts)
        .set({ ...value, updatedAt: new Date() })
        .where(
          and(
            eq(contracts.organizationId, organizationId),
            eq(contracts.id, id),
            eq(contracts.status, from),
          ),
        )
        .returning()
    )[0];
  }
  async history(value: typeof contractStatusHistory.$inferInsert) {
    return (
      await this.db.insert(contractStatusHistory).values(value).returning()
    )[0]!;
  }
}
