// Registries: named tables of content rows (occupations, traits, tiers, sifters,
// rumour sources…) that modules add to at load and may patch. Every override is
// logged, and the log goes into saves, so a mod's changes are visible.
import type { Era } from "./types";

/** A content row: an id, the eras it fits (all, if none), and where its figures came from. */
export interface Row {
  id: string;
  era?: Era[];
  source?: string;
}

/** One module's patch (or removal, `patch: null`) of another's row. */
export interface OverrideRecord {
  registry: string;
  id: string;
  by: string;
  patch: Record<string, unknown> | null;
}

/**
 * A table of content rows contributed by modules. Rows keep insertion order,
 * which is load order, so iteration is deterministic.
 */
export class Registry<T extends Row> {
  private rows = new Map<string, { row: T; owner: string }>();

  constructor(readonly name: string, private log: OverrideRecord[]) {}

  add(row: T, owner: string): void {
    const prev = this.rows.get(row.id);
    if (prev) throw new Error(`${this.name}: "${row.id}" already added by ${prev.owner}`);
    this.rows.set(row.id, { row, owner });
  }

  /** Patch or (with null) remove a row owned by another module. Logged in saves. */
  override(id: string, patch: Partial<T> | null, by: string): void {
    const prev = this.rows.get(id);
    if (!prev) return;
    this.log.push({ registry: this.name, id, by, patch: patch as Record<string, unknown> | null });
    if (patch === null) this.rows.delete(id);
    else this.rows.set(id, { row: { ...prev.row, ...patch, id }, owner: prev.owner });
  }

  has(id: string): boolean {
    return this.rows.has(id);
  }

  get(id: string): T {
    const r = this.rows.get(id);
    if (!r) throw new Error(`${this.name}: no row "${id}"`);
    return r.row;
  }

  find(id: string): T | undefined {
    return this.rows.get(id)?.row;
  }

  /** All rows, optionally limited to an era. Rows with no era tag fit any era. */
  list(era?: Era): T[] {
    const out: T[] = [];
    for (const { row } of this.rows.values()) {
      if (!era || !row.era || row.era.includes(era)) out.push(row);
    }
    return out;
  }
}
