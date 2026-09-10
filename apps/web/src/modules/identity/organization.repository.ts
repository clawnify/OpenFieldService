import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { organizations } from "@/db/schema";
import type { NewOrganization, Organization } from "./identity.types";

export class OrganizationRepository {
  constructor(private readonly executor: DatabaseExecutor = getDb()) {}

  async findById(id: string): Promise<Organization | null> {
    const [organization] = await this.executor.select().from(organizations).where(and(eq(organizations.id, id), eq(organizations.active, true))).limit(1);
    return organization ?? null;
  }

  async findBySlug(slug: string): Promise<Organization | null> {
    const [organization] = await this.executor.select().from(organizations).where(and(eq(organizations.slug, slug), eq(organizations.active, true))).limit(1);
    return organization ?? null;
  }

  async create(input: NewOrganization): Promise<Organization> {
    const [organization] = await this.executor.insert(organizations).values(input).returning();
    return organization;
  }

  async update(id: string, input: Pick<NewOrganization, "name">): Promise<Organization | null> {
    const [organization] = await this.executor.update(organizations).set({ name: input.name, updatedAt: new Date() }).where(and(eq(organizations.id, id), eq(organizations.active, true))).returning();
    return organization ?? null;
  }

  async lock(id: string): Promise<void> {
    await this.executor.execute(sql`select id from ${organizations} where ${organizations.id} = ${id}::uuid for update`);
  }
}
