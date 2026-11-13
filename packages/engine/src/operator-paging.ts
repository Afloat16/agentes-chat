import { type Database, eq, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import { UUID } from "./authority";
import { encodeCursor } from "./cursor";
import { cutText } from "./format";
import { redactCredentials } from "./tool-detail";

/**
 * Shared by the operator API's reads (ADR 0056): keyset paging, where a page ends at `[createdAt (ms), id]`, and
 * what a stored value may give an answer.
 */

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

// What a JSON column or a job's name holds is returned only when shaped like what the code writes there: a code, an
// id. Anything else in its place reads as absent, so text never leaves through a field meant for a code.
export const CODE = /^[A-Za-z][\w.:/-]{0,99}$/;
export const codeOf = (v: unknown) => (typeof v === "string" && CODE.test(v) ? v : null);
export const uuidOf = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : null);
/** What a provider, a CLI or the server said went wrong: its start, with anything shaped like a credential masked. */
export const errorText = (text: string | null, max: number) => (text ? cutText(redactCredentials(text), max) : null);
