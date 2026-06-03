import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Neon Postgres connection (HTTP driver). Point DATABASE_URL at the POOLED
 * connection string for the scoped `audio_worker` role.
 *
 * `neon()` opens no connection at construction — it only issues HTTP requests
 * when a query runs — so a placeholder URL keeps `tsc` / imports working when
 * DATABASE_URL is absent (e.g. typecheck in CI without secrets). No query runs
 * unless the worker actually executes.
 */
export type Database = NeonHttpDatabase<typeof schema>;

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn("[db] DATABASE_URL is not set — database queries will fail.");
}

const sql = neon(url ?? "postgresql://user:password@localhost/placeholder");

export const db: Database = drizzle(sql, { schema });
