import { z } from "zod";

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string().optional(),
});

export const IdParams = z.object({ id: z.string().uuid() });

/**
 * Cursor pagination: an opaque base64url of the last row's (created_at, id). created_at must
 * come from PostgreSQL as text at full (microsecond) precision: a JavaScript Date keeps only
 * milliseconds, and a rounded cursor would skip rows created within the same millisecond.
 */
export function encodeCursor(createdAtText: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAtText, id])).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): [string, string] | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "string")) {
      return value as [string, string];
    }
  } catch {}
  return undefined;
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
