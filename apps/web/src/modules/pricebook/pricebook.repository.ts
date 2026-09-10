import { and, asc, count, eq, ilike, or } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { pricebookCategories, pricebookItems } from "@/db/schema";
export class PricebookRepository {
  constructor(private readonly db: DatabaseExecutor = getDb()) {}
  findCategory(org: string, id: string) {
    return this.db.query.pricebookCategories.findFirst({
      where: and(
        eq(pricebookCategories.organizationId, org),
        eq(pricebookCategories.id, id),
      ),
    });
  }
  listCategories(org: string) {
    return this.db
      .select()
      .from(pricebookCategories)
      .where(eq(pricebookCategories.organizationId, org))
      .orderBy(
        asc(pricebookCategories.sortOrder),
        asc(pricebookCategories.name),
      );
  }
  async createCategory(values: typeof pricebookCategories.$inferInsert) {
    return (
      await this.db.insert(pricebookCategories).values(values).returning()
    )[0]!;
  }
  findItem(org: string, id: string) {
    return this.db.query.pricebookItems.findFirst({
      where: and(
        eq(pricebookItems.organizationId, org),
        eq(pricebookItems.id, id),
      ),
    });
  }
  async createItem(values: typeof pricebookItems.$inferInsert) {
    return (
      await this.db.insert(pricebookItems).values(values).returning()
    )[0]!;
  }
  async updateItem(
    org: string,
    id: string,
    values: Partial<typeof pricebookItems.$inferInsert>,
  ) {
    return (
      await this.db
        .update(pricebookItems)
        .set({ ...values, updatedAt: new Date() })
        .where(
          and(
            eq(pricebookItems.organizationId, org),
            eq(pricebookItems.id, id),
          ),
        )
        .returning()
    )[0];
  }
  async list(
    org: string,
    f: {
      query?: string;
      categoryId?: string;
      type?: typeof pricebookItems.$inferSelect.type;
      status?: typeof pricebookItems.$inferSelect.status;
      limit: number;
      offset: number;
    },
  ) {
    const where = and(
      eq(pricebookItems.organizationId, org),
      f.categoryId ? eq(pricebookItems.categoryId, f.categoryId) : undefined,
      f.type ? eq(pricebookItems.type, f.type) : undefined,
      f.status ? eq(pricebookItems.status, f.status) : undefined,
      f.query
        ? or(
            ilike(pricebookItems.name, `%${f.query}%`),
            ilike(pricebookItems.sku, `%${f.query}%`),
          )
        : undefined,
    );
    const [items, total] = await Promise.all([
      this.db
        .select()
        .from(pricebookItems)
        .where(where)
        .orderBy(asc(pricebookItems.name), asc(pricebookItems.id))
        .limit(f.limit)
        .offset(f.offset),
      this.db.select({ value: count() }).from(pricebookItems).where(where),
    ]);
    return { items, total: total[0]?.value ?? 0 };
  }
  async hasCategoryReferences(org: string, id: string) {
    const rows = await this.db
      .select({ value: count() })
      .from(pricebookItems)
      .where(
        and(
          eq(pricebookItems.organizationId, org),
          eq(pricebookItems.categoryId, id),
        ),
      );
    return (rows[0]?.value ?? 0) > 0;
  }
  async archiveCategory(org: string, id: string) {
    return this.db
      .update(pricebookCategories)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(pricebookCategories.organizationId, org),
          eq(pricebookCategories.id, id),
        ),
      );
  }
  async lockItem(org: string, id: string) {
    const rows = await this.db
      .select()
      .from(pricebookItems)
      .where(
        and(eq(pricebookItems.organizationId, org), eq(pricebookItems.id, id)),
      )
      .for("update");
    return rows[0];
  }
}
