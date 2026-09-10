import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getServerEnv } from "@/lib/env";
import * as schema from "./schema";

const globalDatabase = globalThis as unknown as { sql?: ReturnType<typeof postgres>; database?: ReturnType<typeof createDatabase> };

function createDatabase() {
  const sql = globalDatabase.sql ?? postgres(getServerEnv().DATABASE_URL, { max: 10, prepare: false });
  if (process.env.NODE_ENV !== "production") globalDatabase.sql = sql;
  return drizzle(sql, { schema });
}

export function getDb() {
  globalDatabase.database ??= createDatabase();
  return globalDatabase.database;
}

export type Database = ReturnType<typeof createDatabase>;
export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DatabaseExecutor = Database | DatabaseTransaction;
