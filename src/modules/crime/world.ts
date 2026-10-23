// The underworld as a whole: the content tables, and a structured view of the
// crews, fences, payoffs and the rest, read back from the fields and edges the
// society phase wrote. Pure and memoised.
import type { Address } from "../../core/address";
import type { Block } from "../../core/calendar";
import { data } from "../../core/content";
import type { Entity, Town } from "../../core/town";
import type { Edge, Module } from "../../core/types";
import crimeYaml from "./content/crime.yaml";

export type Level = "quiet" | "usual" | "rife";
export const LEVELS: Level[] = ["quiet", "usual", "rife"];

export interface Rank { id: string; cant: string; plain: string; chief?: boolean; weight?: number; minAge?: number; maxAge?: number; sex?: string }
export interface Lay {
  id: string; label: string; cant: string; minPop: number; needs?: string[]; weight: number; size: [number, number];
  den: string[]; recruit: Record<string, number>; crimes: string[]; turf: string; names: string[]; ranks: Rank[];
  marks?: boolean; usury?: boolean; blackmail?: boolean; protection?: boolean; source: string;
  /** the oldest a working member, and a chief, is likely to be */
  maxAge?: number; chiefMaxAge?: number;
}
export interface CrimeKind { label: string; /** the crime as a charge: "for housebreaking" */ charge: string; /** "pockets picked" */ plural: string; offence: string; rate: number; catch: number; blocks: Block[]; doing: string; source: string }
interface Pick { id: string; text: string; weight: number }
interface Method { id: string; text: string; death: string; cover?: string[] }

export interface CrimeData {
  levels: Record<Level, { mult: number; catch: number; weight: number; label: string }>;
  gangsFrom: number;
  lays: Lay[];
  roles: Record<"boss" | "fence" | "knife" | "thiefTaker", { minPop?: number; minGangs?: number; cant: string; plain: string; source: string }>;
  fences: Record<string, number>;
  knifeCover: Record<string, number>;
  knifeMethods: Method[];
  crimes: Record<string, CrimeKind>;
  loot: Record<"poor" | "middling" | "rich", string[]>;
  petty: Pick[];
  cheating: string;
  vagrancy: string;
  assize: Pick[];
  clergy: string;
  sanctuary: string;
  marks: Record<string, { glyph: string; text: string }>;
  aliases: { feature: Record<string, string[]>; trait: Record<string, string[]>; any: string[] };
  words: string[];
  signs: string[];
  emblems: string[];
  customs: string[];
  cant: { w: string; m: string }[];
  openers: Record<string, string[]>;
  talk: Record<string, [string, string, string]>;
  topics: Record<string, { leak: number; tellings: [string, string, string] }>;
}
export const content = data<CrimeData>(crimeYaml);

/** Stands in for the module when asking the town for a stream (the module object imports us). */
export const self: Module = { id: "crime", version: "1.0.0" };
export const UNDERWORLD = "underworld";

/** A lay (a kind of crew's work: nips, crackers…) by id. */
export const layOf = (id: string): Lay => content.lays.find((l) => l.id === id)!;

export interface Member { p: Address; rank: Rank; gang: Gang }

export interface Gang {
  address: Address;
  lay: Lay;
  name: string;
  den?: Address;
  turf: number[];
  chief?: Address;
  members: Member[];
  fence?: Address;
  keeper?: Address;
  /** officers this crew pays to look away */
  paid: Address[];
  informers: Address[];
  /** other crews it is at odds with */
  rivals: Address[];
  word: string;
  sign: string;
  emblem: string;
  customs: string[];
  /** shopkeepers who won't pay (bullies only) */
  refusers: Address[];
}

export type Role = "boss" | "fence" | "knife" | "thiefTaker" | "keeper" | "informer";

export interface World {
  address: Address;
  level: Level;
  gangs: Gang[];
  byAddress: Map<Address, Gang>;
  /** every crew member */
  crew: Map<Address, Member>;
  /** the other parts people play */
  roles: Map<Address, Role[]>;
  boss?: Address;
  knives: Address[];
  thiefTaker?: Address;
  fences: Address[];
  edges: Record<"pays_off" | "protection" | "informs_on" | "blackmails" | "hired_knife" | "fence_for" | "harbours" | "tithe_to" | "in_league" | "usury" | "rival", Edge[]>;
}

const memo = new WeakMap<Town, World | null>();

/** The town's underworld, or undefined for a hamlet or a place too small for crews. */
export function world(town: Town): World | undefined {
  if (memo.has(town)) return memo.get(town) ?? undefined;
  const uw = town.peek(`${town.root}/institution:${UNDERWORLD}`);
  if (!uw) { memo.set(town, null); return undefined; }
  town.society();
  const w = build(town, town.get(uw.address));
  memo.set(town, w);
  return w;
}

function build(town: Town, uw: Entity): World {
  const gangs: Gang[] = [];
  for (const g of town.children(uw.address, "institution")) {
    if (g.get("kind") !== "gang") continue;
    gangs.push({
      address: g.address, lay: layOf(g.get<string>("lay")), name: g.get<string>("name") ?? "a crew", den: g.get<string | undefined>("den"),
      turf: g.get<number[]>("turf") ?? [], members: [], paid: [], informers: [], rivals: [],
      word: g.get<string>("word") ?? "", sign: g.get<string>("sign") ?? "", emblem: g.get<string>("emblem") ?? "", customs: g.get<string[]>("customs") ?? [],
      refusers: g.get<Address[]>("refusers") ?? [],
    });
  }
  const byAddress = new Map(gangs.map((g) => [g.address, g]));
  const crew = new Map<Address, Member>();
  const roles = new Map<Address, Role[]>();
  const role = (p: Address, r: Role) => { const l = roles.get(p); if (!l) roles.set(p, [r]); else if (!l.includes(r)) l.push(r); };
  const edges: World["edges"] = { pays_off: [], protection: [], informs_on: [], blackmails: [], hired_knife: [], fence_for: [], harbours: [], tithe_to: [], in_league: [], usury: [], rival: [] };
  const chiefOf = new Map<Address, Gang>();
  for (const e of town.edges()) {
    if (e.module !== "crime") continue;
    if (e.kind === "in_gang") {
      const g = byAddress.get(e.to);
      if (!g) continue;
      const rank = g.lay.ranks.find((r) => r.id === e.facts?.rank) ?? { id: "hanger", cant: "hanger-on", plain: "runs errands for the crew" };
      const m: Member = { p: e.from, rank, gang: g };
      g.members.push(m);
      crew.set(e.from, m);
      if (rank.chief) { g.chief = e.from; chiefOf.set(e.from, g); }
    } else if (e.kind === "debtor_of") edges.usury.push(e);
    else if (e.kind in edges) edges[e.kind as keyof World["edges"]].push(e);
  }
  // Chiefs first, then by rank order in the lay, then address.
  for (const g of gangs) g.members.sort((a, b) => g.lay.ranks.indexOf(a.rank) - g.lay.ranks.indexOf(b.rank) || (a.p < b.p ? -1 : 1));
  const fences: Address[] = [];
  for (const e of edges.fence_for) {
    const g = chiefOf.get(e.to);
    if (g) g.fence = e.from;
    if (!fences.includes(e.from)) fences.push(e.from);
    role(e.from, "fence");
  }
  for (const e of edges.harbours) { const g = chiefOf.get(e.to); if (g) g.keeper = e.from; role(e.from, "keeper"); }
  for (const e of edges.pays_off) { const g = chiefOf.get(e.from); if (g) g.paid.push(e.to); }
  for (const e of edges.informs_on) { const m = crew.get(e.from); if (m) m.gang.informers.push(e.from); role(e.from, "informer"); }
  for (const e of edges.rival) {
    const a = chiefOf.get(e.from), b = chiefOf.get(e.to);
    if (a && b) { a.rivals.push(b.address); b.rivals.push(a.address); }
  }
  const boss = uw.get<Address | undefined>("boss");
  const knives = uw.get<Address[] | undefined>("knives") ?? [];
  const thiefTaker = uw.get<Address | undefined>("thiefTaker");
  if (boss) role(boss, "boss");
  for (const k of knives) role(k, "knife");
  if (thiefTaker) role(thiefTaker, "thiefTaker");
  return {
    address: uw.address, level: (town.settlement().get<Level>("crime.level") ?? "usual"), gangs, byAddress, crew, roles, boss, knives, thiefTaker, fences, edges,
  };
}

/** The plain words for a role. */
export function roleText(r: Role): string {
  switch (r) {
    case "boss": return content.roles.boss.cant;
    case "fence": return content.roles.fence.cant;
    case "knife": return content.roles.knife.cant;
    case "thiefTaker": return content.roles.thiefTaker.cant;
    case "keeper": return "keeps a crew's den";
    case "informer": return "a nose: informs to the law";
  }
}
