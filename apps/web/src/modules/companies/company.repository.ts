import "server-only";
import { and, asc, count, eq, ilike, isNull, or } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { companies } from "@/db/schema";
import type { Company, NewCompany } from "./company.types";

export class CompanyRepository {
  constructor(private readonly executor: DatabaseExecutor = getDb()) {}
  async findById(organizationId: string, id: string): Promise<Company | null> {
    const [value] = await this.executor.select().from(companies).where(and(eq(companies.organizationId, organizationId), eq(companies.id, id), eq(companies.status, "active"), isNull(companies.archivedAt))).limit(1); return value ?? null;
  }
  async findMany(organizationId: string, input: { query?: string; limit: number; offset: number }) {
    const search = input.query ? or(ilike(companies.name, `%${input.query}%`), ilike(companies.legalName, `%${input.query}%`), ilike(companies.email, `%${input.query}%`), ilike(companies.phone, `%${input.query}%`)) : undefined;
    const where = and(eq(companies.organizationId, organizationId), eq(companies.status, "active"), isNull(companies.archivedAt), search);
    const [items, [{ total }]] = await Promise.all([this.executor.select().from(companies).where(where).orderBy(asc(companies.name)).limit(input.limit).offset(input.offset), this.executor.select({ total: count() }).from(companies).where(where)]);
    return { items, total };
  }
  async create(input: NewCompany): Promise<Company> { const [value] = await this.executor.insert(companies).values(input).returning(); return value; }
  async update(organizationId: string, id: string, input: Partial<NewCompany>): Promise<Company | null> {
    const [value] = await this.executor.update(companies).set({ ...input, id: undefined, organizationId: undefined, updatedAt: new Date() }).where(and(eq(companies.organizationId, organizationId), eq(companies.id, id), eq(companies.status, "active"))).returning(); return value ?? null;
  }
  async archive(organizationId: string, id: string, actorUserId: string): Promise<Company | null> {
    const [value] = await this.executor.update(companies).set({ status: "archived", archivedAt: new Date(), updatedAt: new Date(), updatedBy: actorUserId }).where(and(eq(companies.organizationId, organizationId), eq(companies.id, id), eq(companies.status, "active"))).returning(); return value ?? null;
  }
}
