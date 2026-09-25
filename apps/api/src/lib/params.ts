import { z } from "zod";
import { AppError } from "./errors";

const uuid = z.uuid();

/** Parse a route :id; malformed ids are treated as not found rather than a server error. */
export function idParam(params: unknown, label: string): string {
  const raw = (params as { id?: unknown })?.id;
  const parsed = uuid.safeParse(raw);
  if (!parsed.success) throw new AppError(404, "not_found", `${label} was not found.`);
  return parsed.data;
}

/** Escape LIKE wildcards in user search text. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
