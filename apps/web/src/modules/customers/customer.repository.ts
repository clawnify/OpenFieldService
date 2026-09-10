import "server-only";
import { and, asc, count, eq, ilike, isNull, or } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { customers } from "@/db/schema";
import type { Customer, NewCustomer } from "./customer.types";

export interface CustomerPage { items: Customer[]; total: number }

export interface CustomerRepository {
  findById(organizationId: string, id: string): Promise<Customer | null>;
  findMany(organizationId: string, input: { query?: string; limit: number; offset: number }): Promise<CustomerPage>;
  create(input: NewCustomer): Promise<Customer>;
  update(organizationId: string, id: string, input: Partial<NewCustomer>): Promise<Customer | null>;
  archive(organizationId: string, id: string, actorUserId: string): Promise<Customer | null>;
  hasActiveForCompany(organizationId: string, companyId: string): Promise<boolean>;
}

export class DrizzleCustomerRepository implements CustomerRepository {
  constructor(private database?: DatabaseExecutor) {}

  private connection(): DatabaseExecutor { return this.database ??= getDb(); }

  async findById(organizationId: string, id: string): Promise<Customer | null> {
    const [customer] = await this.connection().select().from(customers).where(and(eq(customers.organizationId, organizationId), eq(customers.id, id), eq(customers.status, "active"), isNull(customers.archivedAt))).limit(1);
    return customer ?? null;
  }

  async findMany(organizationId: string, input: { query?: string; limit: number; offset: number }): Promise<CustomerPage> {
    const search = input.query ? or(ilike(customers.name, `%${input.query}%`), ilike(customers.email, `%${input.query}%`), ilike(customers.phone, `%${input.query}%`)) : undefined;
    const where = and(eq(customers.organizationId, organizationId), eq(customers.status, "active"), isNull(customers.archivedAt), search);
    const [items, [{ total }]] = await Promise.all([
      this.connection().select().from(customers).where(where).orderBy(asc(customers.name)).limit(input.limit).offset(input.offset),
      this.connection().select({ total: count() }).from(customers).where(where),
    ]);
    return { items, total };
  }

  async create(input: NewCustomer): Promise<Customer> {
    const [customer] = await this.connection().insert(customers).values(input).returning();
    return customer;
  }

  async update(organizationId: string, id: string, input: Partial<NewCustomer>): Promise<Customer | null> {
    const [customer] = await this.connection().update(customers).set({ ...input, organizationId: undefined, id: undefined, updatedAt: new Date() }).where(and(eq(customers.organizationId, organizationId), eq(customers.id, id), eq(customers.status, "active"), isNull(customers.archivedAt))).returning();
    return customer ?? null;
  }

  async archive(organizationId: string, id: string, actorUserId: string): Promise<Customer | null> {
    const [archived] = await this.connection().update(customers).set({ status: "archived", archivedAt: new Date(), updatedAt: new Date(), updatedBy: actorUserId }).where(and(eq(customers.organizationId, organizationId), eq(customers.id, id), eq(customers.status, "active"))).returning();
    return archived ?? null;
  }

  async hasActiveForCompany(organizationId: string, companyId: string): Promise<boolean> {
    const [row] = await this.connection().select({ id: customers.id }).from(customers).where(and(eq(customers.organizationId, organizationId), eq(customers.companyId, companyId), eq(customers.status, "active"))).limit(1);
    return Boolean(row);
  }
}
