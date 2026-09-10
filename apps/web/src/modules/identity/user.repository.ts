import "server-only";
import { eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "@/db";
import { users } from "@/db/schema";
import type { NewUser, User } from "./identity.types";

export class UserRepository {
  constructor(private readonly executor: DatabaseExecutor = getDb()) {}

  async findById(id: string): Promise<User | null> {
    const [user] = await this.executor.select().from(users).where(eq(users.id, id)).limit(1);
    return user ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const [user] = await this.executor.select().from(users).where(eq(users.email, email)).limit(1);
    return user ?? null;
  }

  async create(input: NewUser): Promise<User> {
    const [user] = await this.executor.insert(users).values(input).returning();
    return user;
  }

  async recordLogin(id: string): Promise<void> {
    await this.executor.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, id));
  }
}
