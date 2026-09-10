import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export default async function setupPostgres() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  const sql = postgres(databaseUrl, { max: 1 });
  await sql.unsafe("drop schema if exists public cascade; create schema public");
  const directory = fileURLToPath(new URL("../db/migrations", import.meta.url));
  const files = (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
  for (const file of files) {
    const migration = (await readFile(`${directory}/${file}`, "utf8")).replaceAll("--> statement-breakpoint", "");
    await sql.unsafe(migration);
  }
  await sql.end();
}
