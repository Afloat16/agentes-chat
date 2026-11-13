import { type Database, eq, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import { encodeCursor } from "./cursor";

/** Keyset paging shared by the operator API's reads (ADR 0056): a page ends at `[createdAt (ms), id]`. */

// Cut to milliseconds (what a JS Date and a cursor carry), so paging compares exactly what it returned.
export const ms = (column: unknown) =>
  sql<Date>`date_trunc('milliseconds', ${column})`.mapWith((v: string | Date) => new Date(v));

export const UuidCursor = z.tuple([z.iso.datetime(), z.uuid()]);

export interface PageQuery {
  limit: number;
  /** `next` of the previous page. */
  cursor?: string;
}

/** The first `limit` of the `limit + 1` rows read, and the cursor after them when there are more. */
export function pageOf<T>(rows: T[], limit: number, key: (last: T) => [Date, string]) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  if (rows.length <= limit || !last) return { items, next: null };
  const [at, id] = key(last);
  return { items, next: encodeCursor([at.toISOString(), id]) };
}

export const orgExists = async (db: Database, orgId: string) =>
  (
    await db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
  ).length > 0;
