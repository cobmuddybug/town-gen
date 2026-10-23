import type { Address } from "../core/address";
import type { Block } from "../core/calendar";
import type { Town } from "../core/town";
import type { Edge, PanelLink, PanelRow, PanelSpec } from "../core/types";
import { world } from "../modules/crime";
import { crimeAt, statusOf } from "../modules/crime/calendar";
import type { Occupation } from "../modules/uses";
import { whereabouts } from "../modules/routines";
import type { Job } from "./party";

// Player view: what can be on a screen the players see. Secrets, the
// underworld, debts and the DM's tools stay behind it.

export const HIDDEN_PANELS = (id: string) => id === "secrets" || id.startsWith("crime-");
// "richest" is here because its notes give away money from the crews and what each house has put by.
export const HIDDEN_LISTS = new Set(["debts", "secrets", "feuds", "underworld", "crimes", "gaol", "richest"]);
export const HIDDEN_ALMANAC = new Set(["secret", "crime", "life"]);
/** Jobs that are secrets, debts or crime by nature. */
const HIDDEN_JOBS = /^(debt|racket|blackmail)\//;
/** A thief's trade, as the neighbours would give it. */
export const COVER_TRADE = "labourer";
/** What a crew member is doing, when what they're really doing is crime. */
export const COVER_DOING = "about their own business";

/** The panels players may see. */
export const playerPanels = (panels: PanelSpec[]): PanelSpec[] => panels.filter((p) => !HIDDEN_PANELS(p.id));

/** A row with no "who knows?" and no edit, reroll or star tools. */
export const playerRow = (r: PanelRow): PanelRow => ({ ...r, key: undefined, fact: undefined, rerollable: undefined });

const edgeMemo = new WeakMap<Town, Map<string, Edge>>();
function edgeById(town: Town, id: string): Edge | undefined {
  let m = edgeMemo.get(town);
  if (!m) edgeMemo.set(town, (m = new Map(town.edges().map((e) => [e.id, e]))));
  return m.get(id);
}

const underMemo = new WeakMap<Town, Set<Address>>();
/** The underworld and its crews: never named to players. */
export function underworldOf(town: Town): Set<Address> {
  let s = underMemo.get(town);
  if (!s) {
    const W = world(town);
    s = new Set(W ? [W.address, ...W.gangs.map((g) => g.address)] : []);
    underMemo.set(town, s);
  }
  return s;
}

const crewMemo = new WeakMap<Town, Set<Address>>();
function crewOf(town: Town): Set<Address> {
  let s = crewMemo.get(town);
  if (!s) crewMemo.set(town, (s = new Set(world(town)?.gangs.flatMap((g) => g.members.map((m) => m.p)) ?? [])));
  return s;
}

/** Is this trade one nobody owns to? (A thief's, not a vagrant's: a vagrant is plain to see.) */
const covert = (o: Occupation | undefined) => o?.tier === "criminal" && (o as { routine?: string }).routine === "thief";

/** A trade's name as players may hear it. */
export function coverTrade(town: Town, id: unknown): string {
  const o = id ? town.registry<Occupation>("occupations").find(String(id)) : undefined;
  return covert(o) ? COVER_TRADE : o?.label ?? (id ? String(id) : "");
}

// Gaol, the stocks, a whipping, a death and sanctuary happen in front of everyone.
const PUBLIC_STATUS = new Set(["gaol", "pillory", "whipped", "dead", "sanctuary", "away"]);

/** What players see someone doing: a crew member at crime is just about their business. Gaol, the pillory and the gallows are public. */
export function maskDoing(town: Town, p: Address, date: string, block: Block, doing: string): string {
  // A thief's whole working day is the trade: away from home, it reads as a labourer's.
  if (covertLabel(town, p)) {
    const home = town.parentOf(town.parentOf(p)!);
    return whereabouts(town, p, date, block).where === home ? doing : COVER_DOING;
  }
  if (!crewOf(town).has(p)) return doing;
  const st = statusOf(town, p, date, block);
  if (st && PUBLIC_STATUS.has(st.kind)) return doing;
  const c = crimeAt(town, p, date, block);
  return c && c.doing === doing && !c.where.startsWith("place:gallows") ? COVER_DOING : doing;
}

const textOf = (v: PanelRow["value"]) => (Array.isArray(v) ? v : [v]).map((x) => (typeof x === "object" ? (x as PanelLink).text : String(x))).join("");
const links = (v: PanelRow["value"]) => (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === "object" ? [(x as PanelLink).address] : []));

/** The person's or household's own trade, if it's one to hide. */
function covertLabel(town: Town, a: Address): string | undefined {
  const e = town.find(a);
  if (!e || (e.type !== "person" && e.type !== "household")) return undefined;
  const id = e.get<string | undefined>("occupation") ?? (e.type === "person" ? town.get(town.parentOf(a)!).get<string | undefined>("occupation") : undefined);
  const o = id ? town.registry<Occupation>("occupations").find(id) : undefined;
  return covert(o) ? o!.label : undefined;
}

/** The rows players may see. Left out: ties the town doesn't know about, debts, leverage, anything naming a crew.
 *  A thief's trade reads as a cover, and a crew member at crime is "about their own business". The rest lose their tools. */
export function playerRows(town: Town, rows: PanelRow[], ctx: { entity?: Address; panel?: string } = {}): PanelRow[] {
  const under = underworldOf(town);
  const hideTrade = ctx.entity ? covertLabel(town, ctx.entity) : undefined;
  const crew = ctx.entity ? crewOf(town).has(ctx.entity) : false;
  return rows.filter((r) => {
    if (r.label === "Can be leaned on") return false;
    if (links(r.value).some((a) => under.has(a))) return false;
    if (r.fact?.startsWith("edge:")) {
      const e = edgeById(town, r.fact.slice(5));
      if (e && (e.knownBy !== "public" || e.kind === "debtor_of")) return false;
    }
    if (/\bowes\b/.test(textOf(r.value))) return false;
    return true;
  }).map((r) => {
    let value = r.value;
    if (hideTrade) value = mapText(value, (t) => t.split(hideTrade).join(COVER_TRADE));
    if ((crew || hideTrade) && ctx.panel === "today") {
      const block = r.label.replace("▸ ", "").replace(" ", "_") as Block;
      value = mapText(value, (t) => t.replace(/: (.*)$/, (_m, d: string) => `: ${maskDoing(town, ctx.entity!, town.clock.date, block, d)}`));
    }
    return playerRow({ ...r, value });
  });
}

function mapText(v: PanelRow["value"], f: (t: string) => string): PanelRow["value"] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? f(x) : x));
  return typeof v === "string" ? f(v) : v;
}

/** The work players may hear of: no secrets, debts, rackets or blackmail, and nothing that names a crew. */
export function playerJobs(town: Town, jobs: Job[]): Job[] {
  const under = underworldOf(town);
  return jobs.filter((j) => {
    if (HIDDEN_JOBS.test(j.id)) return false;
    if (j.fact?.startsWith("edge:")) { const e = edgeById(town, j.fact.slice(5)); if (e && e.knownBy !== "public") return false; }
    const parts = [...j.detail, ...j.risk];
    return !parts.some((x) => typeof x === "object" && under.has(x.address));
  });
}
