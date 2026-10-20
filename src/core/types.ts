import type { Address } from "./address";
import type { Rng } from "./rng";
import type { Registry, Row } from "./registry";
import type { Town } from "./town";

export type Era = "early_medieval" | "high_medieval" | "late_medieval" | "early_modern";
export const ERAS: Era[] = ["early_medieval", "high_medieval", "late_medieval", "early_modern"];

export type EntityType =
  | "settlement"
  | "ward"
  | "building"
  | "household"
  | "person"
  | "business"
  | "institution";

export interface Field {
  module: string;
  value: unknown;
}

export interface Edge {
  id: string;
  from: Address;
  to: Address;
  kind: string;
  /** -1..1 (hostile..devoted), or a magnitude for debts */
  weight: number;
  module: string;
  facts?: Record<string, unknown>;
  knownBy: Address[] | "public";
}

export type Lordship = "free" | "manorial";

export interface Settings {
  base: string;
  pop: number;
  era: Era;
  /** a manorial village is owned outright by a lord (LF p.77) */
  lordship?: Lordship;
}

export interface Ctx {
  readonly town: Town;
  readonly moduleId: string;
  readonly era: Era;
  /** This module's own stream for (entity, purpose). */
  rng(entity: Address | { address: Address }, purpose?: string): Rng;
  /** Generate one field from its own stream; honours the DM's per-field reroll count. */
  gen<T>(entity: EntityLike, key: string, make: (rng: Rng) => T): T;
  /** Write a field this module owns. */
  set(entity: EntityLike, key: string, value: unknown): void;
  /** Create (or return) a child entity. `facts` are the stub's minimum fields. */
  create(type: EntityType, parent: Address, id: string, facts?: Record<string, unknown>): EntityLike;
  edge(e: Omit<Edge, "id" | "module" | "knownBy"> & { knownBy?: Edge["knownBy"] }): Edge;
  registry<T extends Row>(name: string): Registry<T>;
}

export interface EntityLike {
  readonly address: Address;
  readonly type: EntityType;
  get<T = unknown>(key: string): T;
}

export interface Hooks {
  onSettlementGenerated(ctx: Ctx, s: EntityLike): void;
  onBuildingResolved(ctx: Ctx, b: EntityLike): void;
  onHouseholdResolved(ctx: Ctx, h: EntityLike): void;
  onPersonResolved(ctx: Ctx, p: EntityLike): void;
  onInstitutionResolved(ctx: Ctx, i: EntityLike): void;
  onWardResolved(ctx: Ctx, w: EntityLike): void;
  /**
   * The settlement-wide phase: runs once, after every entity is resolved, the
   * first time anyone asks about edges. Links between households belong here,
   * so they never depend on what was looked at first. Other hooks must not
   * query edges.
   */
  onSocietyResolved(ctx: Ctx, s: EntityLike): void;
}

export interface PanelLink {
  text: string;
  address: Address;
}

export interface PanelRow {
  label: string;
  value: string | number | PanelLink | (string | PanelLink)[];
  /** The overlay key this row edits. Present means the row gets edit/reroll controls. */
  key?: string;
  options?: string[];
  rerollable?: boolean;
  /** Has a key (so it can be rerolled or reset) but isn't hand-editable. */
  noEdit?: boolean;
  hint?: string;
  /** buildings (or things in them) to light up on the map when the row is hovered */
  highlight?: Address[];
}

export interface PanelSpec {
  id: string;
  title: string;
  for: EntityType;
  order?: number;
  rows(town: Town, e: EntityLike): PanelRow[];
}

export interface SifterMatch {
  title: string;
  summary: string;
  involves: Address[];
}

export interface Sifter extends Row {
  title: string;
  match(town: Town): SifterMatch[];
}

export interface EdgeKind extends Row {
  label: string;
  inverse?: string;
  symmetric?: boolean;
}

export interface Module {
  id: string;
  version: string;
  requires?: string[];
  era?: Era[];
  /** Registries this module creates. */
  provides?: string[];
  /** Adds rows to registries (its own or others'). Runs at load, in load order. */
  register?(add: <T extends Row>(registry: string, rows: T[]) => void, override: <T extends Row>(registry: string, id: string, patch: Partial<T> | null) => void): void;
  hooks?: Partial<Hooks>;
  panels?: PanelSpec[];
  /** Fields this module owns that are worth showing in a breadcrumb or label. */
  label?(town: Town, e: EntityLike): string | undefined;
}

export interface SaveFile {
  format: 1;
  town: { seed: string; era: Era; config: { base: string; pop: number; lordship?: Lordship } };
  modules: Record<string, string>;
  overlay: Record<Address, Record<string, unknown>>;
  pinned: Record<Address, Record<string, unknown>>;
  events: { date: string; kind: string; target?: Address; text: string }[];
  clock: { date: string; block: string };
}
