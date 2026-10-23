// Content files: YAML turned into JSON at build time (vite.config.ts), checked
// lightly as it is loaded.
import type { Row } from "./registry";

/** Check a content table. Every row needs an id; `source` cites where a figure came from. */
export function table<T extends Row>(rows: unknown, name: string): T[] {
  if (!Array.isArray(rows)) throw new Error(`${name}: expected a list`);
  for (const r of rows as T[]) if (!r?.id) throw new Error(`${name}: row without id: ${JSON.stringify(r)}`);
  return rows as T[];
}

/** A content file holding a single mapping (lists of names and the like). */
export function data<T>(value: unknown): T {
  return value as T;
}
