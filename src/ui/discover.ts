// Ways into the town besides clicking buildings: who knows a thing and where
// to find them, map lenses, search and lists, the almanac, and a person's day.
// Pure functions of the town and the clock, so tests and the UI share them.

import { HIRE_KINDS, hireRate } from "../modules/hire";
import { lifeBetween } from "../modules/lives";
import { patronalOn, patronOf } from "../modules/religion";
import type { Address } from "../core/address";
import { addDays, BLOCKS, describeDate, feastOn, parseDate, type Block, whenOf } from "../core/calendar";
import type { Entity, Town } from "../core/town";
import type { Edge, EdgeKind, PanelLink, PanelRow } from "../core/types";
import type { Tier } from "../modules/core";
import { allSecrets, describeHour, heardAt, hourOf, linked, rumoursIn, spread, type Rumour, whenHour } from "../modules/gossip";
import { lsd } from "../modules/households";
import { isStreetPlan, VALUE_CLASSES, type MapData } from "../modules/layout";
import { centroid, type Poly, type Pt } from "../modules/layout/geom";
import { PLACES, occupancy, whereabouts, type Whereabouts } from "../modules/routines";
import type { Occupation } from "../modules/uses";
import { visitLabel, visitsIn } from "../modules/visitors";
import { crimeContent, happened, incidentsBetween, prisoners, world } from "../modules/crime";

type Value = (string | PanelLink)[];
const L = (town: Town, a: Address): PanelLink => ({ text: town.label(a), address: a });
const isPerson = (a: Address) => /\/person:[^/]+$/.test(a);
const buildingOf = (a: Address): Address | undefined => /^(.*\/building:[^/]+)/.exec(a)?.[1];

// ---- 1. who knows, and where to find them --------------------------------

/** A fact is an edge (a debt, an affair, a feud...) or a rumour going round. */
export type Fact = `edge:${string}` | `rumour:${string}`;

export interface Knower {
  person: Address;
  how: "in it" | "kept it" | "heard";
  /** hour index they heard it, for those who heard */
  since?: number;
  telling?: 0 | 1 | 2;
  now: Whereabouts;
  later: { block: Block; date: string; w: Whereabouts }[];
}

export interface Knowing {
  title: Value;
  note: string;
  total: number;
  knowers: Knower[];
}

function edgeById(town: Town, id: string): Edge | undefined {
  return town.edges().find((e) => e.id === id);
}

function rumourById(town: Town, id: string, year: number): Rumour | undefined {
  return allSecrets(town).find((r) => r.id === id) ?? [year - 1, year, year + 1].flatMap((y) => rumoursIn(town, y)).find((r) => r.id === id);
}

/** Where someone is now, for the rest of today, and tomorrow forenoon. */
function itinerary(town: Town, person: Address, date: string, block: Block) {
  const i = BLOCKS.indexOf(block);
  const later = BLOCKS.slice(i + 1).filter((b) => b !== "late_night").map((b) => ({ block: b, date, w: whereabouts(town, person, date, b) }));
  const tomorrow = addDays(date, 1);
  later.push({ block: "forenoon", date: tomorrow, w: whereabouts(town, person, tomorrow, "forenoon") });
  return { now: whereabouts(town, person, date, block), later };
}

function edgeTitle(town: Town, e: Edge): Value {
  const kind = town.registry<EdgeKind>("edgeKinds").find(e.kind);
  const rel = (e.facts?.rel as string | undefined) ? `${e.facts!.rel} of` : kind?.label ?? e.kind;
  const tail = typeof e.facts?.amount === "number" ? ` ${lsd(e.facts.amount as number)}${e.facts.reason ? ` for ${e.facts.reason}` : ""}` : e.facts?.about ? `, over ${e.facts.about}` : "";
  return [L(town, e.from), ` ${rel} `, L(town, e.to), tail];
}

export function whoKnows(town: Town, fact: Fact, date: string, block: Block, limit = 40): Knowing | undefined {
  const now = hourOf(date, block);
  const year = parseDate(date).y;
  let rumour: Rumour | undefined, edge: Edge | undefined;
  if (fact.startsWith("edge:")) {
    edge = edgeById(town, fact.slice(5));
    if (!edge) return undefined;
    rumour = allSecrets(town).find((r) => r.edge === edge!.id);
  } else {
    rumour = rumourById(town, fact.slice(7), year);
    if (!rumour) return undefined;
    if (rumour.edge) edge = edgeById(town, rumour.edge);
  }
  const knowers: Knower[] = [];
  const seen = new Set<Address>();
  const add = (person: Address, how: Knower["how"], since?: number, telling?: 0 | 1 | 2) => {
    if (seen.has(person) || !isPerson(person) || !town.find(person)) return;
    seen.add(person);
    knowers.push({ person, how, since, telling, ...itinerary(town, person, date, block) });
  };
  const parties = edge ? [edge.from, edge.to] : rumour!.about;
  for (const p of parties) add(p, "in it");
  if (edge && edge.knownBy !== "public") for (const k of edge.knownBy) add(k, "kept it");
  let note: string;
  let total = knowers.length;
  if (edge?.knownBy === "public" && !rumour) {
    note = "common knowledge: anyone in the place could tell you";
    total = Infinity;
  } else if (rumour && rumour.start <= now) {
    // Everyone the talk has reached, earliest first.
    const heard: { p: Address; at: number; telling: 0 | 1 | 2 }[] = [];
    const sp = spread(town, rumour);
    for (const e of town.allEntities()) {
      if (e.type !== "person" || seen.has(e.address) || !e.address.includes("/building:")) continue;
      const at = heardAt(town, rumour, e.address);
      if (at === undefined || at > now || at === -Infinity) continue;
      heard.push({ p: e.address, at, telling: sp.get(buildingOf(e.address)!)?.telling ?? 0 });
    }
    heard.sort((a, b) => a.at - b.at || (a.p < b.p ? -1 : 1));
    total = knowers.length + heard.length;
    for (const h of heard.slice(0, Math.max(0, limit - knowers.length))) add(h.p, "heard", h.at, h.telling);
    note = `out since ${whenHour(rumour.start, hourOf(date, block))}${rumour.how ? `: ${rumour.how}` : ""}`;
  } else if (rumour) {
    note = `still a secret; it comes out ${whenHour(rumour.start, hourOf(date, block))}${rumour.how ? `, when ${rumour.how}` : ""}`;
  } else note = "a secret, and nothing says it will ever come out";
  const title: Value = rumour ? linked(town, rumour, 0) : edgeTitle(town, edge!);
  return { title, note, total, knowers };
}

// ---- 2. map lenses ------------------------------------------------------

export type Lens = "none" | "wealth" | "class" | "parish" | "value" | "guild" | "thread" | "crime";
export const LENSES: { id: Lens; label: string; streetOnly?: boolean }[] = [
  { id: "none", label: "Plain map" },
  { id: "wealth", label: "Wealth" },
  { id: "class", label: "Class" },
  { id: "parish", label: "Parishes", streetOnly: true },
  { id: "value", label: "Ward value", streetOnly: true },
  { id: "guild", label: "Guilds", streetOnly: true },
  { id: "thread", label: "Threads (who's tied to whom)" },
  { id: "crime", label: "Crime: turf, dens, fences", streetOnly: true },
];

export interface LensView {
  fills: Map<Address, string>;
  legend: { label: string; colour: string }[];
  lines: { from: Pt; to: Pt; colour: string; title: string }[];
  note?: string;
}

const PALETTE = ["#c0504d", "#4f81bd", "#9bbb59", "#8064a2", "#f79646", "#4bacc6", "#d4a017", "#a05a8c", "#2e8b57", "#cd853f", "#5f9ea0", "#b8860b", "#6b8e23", "#bc8f8f", "#708090", "#daa520"];
const SEQ = ["#f1e3c0", "#e2b97a", "#cf8a45", "#a85a2a", "#6e3315"];

function heads(town: Town, b: Entity): Entity[] {
  return town.children(b.address, "household");
}

export function lensView(town: Town, lens: Lens, selected?: Address): LensView {
  const fills = new Map<Address, string>();
  const legend: LensView["legend"] = [];
  const lines: LensView["lines"] = [];
  const buildings = town.children(town.root, "building");
  if (lens === "wealth") {
    const w = buildings.map((b) => ({ b, v: heads(town, b).reduce((a, h) => a + h.get<number>("income") + h.get<number>("savings") * 0.25, 0) })).filter((x) => x.v > 0);
    const sorted = [...w].sort((a, b) => a.v - b.v);
    const cut = [0.2, 0.4, 0.6, 0.85].map((q) => sorted[Math.floor(q * (sorted.length - 1))]?.v ?? 0);
    for (const x of w) fills.set(x.b.address, SEQ[cut.filter((c) => x.v > c).length]);
    ["poorest fifth", "poor", "middling", "comfortable", "richest sixth"].forEach((l, i) => legend.push({ label: l, colour: SEQ[i] }));
  } else if (lens === "class") {
    const CLS: [string, (r: number) => boolean, string][] = [
      ["upper", (r) => r >= 9, "#6a3d9a"], ["upper and middle middle", (r) => r >= 7 && r <= 8, "#1f78b4"], ["lower middle", (r) => r === 6, "#33a02c"],
      ["upper lower", (r) => r === 5, "#e3b448"], ["middle and lower lower", (r) => r >= 3 && r <= 4, "#d07a3a"], ["underclass", (r) => r <= 2, "#7a7a7a"],
    ];
    const tiers = town.registry<Tier>("tiers");
    for (const b of buildings) {
      const h = heads(town, b)[0];
      if (!h) continue;
      const rank = tiers.find(h.get("tier"))?.rank ?? 3;
      fills.set(b.address, CLS.find(([, f]) => f(rank))![2]);
    }
    for (const [label, , colour] of CLS) legend.push({ label, colour });
  } else if (lens === "parish") {
    const churches = new Map<Address, string>();
    for (const b of buildings) for (const h of heads(town, b)) {
      const p = h.get<string | null>("parish");
      if (!p) continue;
      if (!churches.has(p)) churches.set(p, PALETTE[churches.size % PALETTE.length]);
      fills.set(b.address, churches.get(p)!);
    }
    for (const [c, colour] of churches) { legend.push({ label: town.label(c), colour }); fills.set(c, colour); }
  } else if (lens === "value") {
    const V = ["#5b4636", "#8d6e57", "#a88b5a", "#b9a577", "#c9b46a", "#a9c48a", "#7fb27f", "#8fa9d6", "#6a7fc2"];
    const map = town.settlement().get<MapData>("map");
    for (const b of buildings) {
      const v = map.wards?.[b.get<number>("ward")]?.value;
      if (v !== undefined) fills.set(b.address, V[v]);
    }
    VALUE_CLASSES.forEach((l, i) => legend.push({ label: l, colour: V[i] }));
  } else if (lens === "guild") {
    const occs = town.registry<Occupation>("occupations");
    const colours = new Map<string, string>();
    for (const b of buildings) {
      const h = heads(town, b)[0];
      if (!h) continue;
      const g = occs.find(h.get("occupation"))?.guild ?? h.get<string | undefined>("guild.craft");
      if (!g) continue;
      if (!colours.has(g)) colours.set(g, PALETTE[colours.size % PALETTE.length]);
      fills.set(b.address, colours.get(g)!);
    }
    for (const [g, colour] of [...colours].sort()) legend.push({ label: g, colour });
  } else if (lens === "thread") {
    return threads(town, selected);
  } else if (lens === "crime") {
    return crimeLens(town);
  }
  return { fills, legend, lines };
}

const THREAD: [string, string[], string][] = [
  ["family", ["kin"], "#2e8b57"],
  ["love", ["spouse", "lover", "courting", "betrothed"], "#d1477a"],
  ["money", ["debtor_of", "tenant_of", "tithes_to"], "#c0392b"],
  ["bad blood", ["rival", "grievance", "dispute"], "#e67e22"],
  ["friends", ["friend"], "#2c7fb8"],
  ["work", ["employer", "serves", "apprentice_of", "skims", "answers_to"], "#7f6a4f"],
  ["crime", ["fence_for", "harbours", "pays_off", "protection", "informs_on", "blackmails", "tithe_to", "hired_knife", "in_league"], "#3b3b3b"],
];

function threads(town: Town, selected?: Address): LensView {
  const fills = new Map<Address, string>();
  const lines: LensView["lines"] = [];
  const legend = THREAD.map(([label, , colour]) => ({ label, colour }));
  if (!selected || !buildingOf(selected)) return { fills, legend, lines, note: "Select a person, household or building to see their threads." };
  const b = buildingOf(selected)!;
  const people = isPerson(selected) ? [selected] : town.allEntities().filter((e) => e.type === "person" && e.address.startsWith(selected + "/")).map((e) => e.address);
  const pos = (a: Address) => centroid(town.get(a).get<Poly>("poly"));
  const from = pos(b);
  fills.set(b, "#f0c419");
  const seen = new Set<string>();
  for (const p of people) for (const e of town.edges({ touching: p })) {
    const other = e.from === p ? e.to : e.from;
    const ob = buildingOf(other);
    if (!ob || ob === b || seen.has(e.id)) continue;
    seen.add(e.id);
    const t = THREAD.find(([, kinds]) => kinds.includes(e.kind));
    if (!t) continue;
    lines.push({ from, to: pos(ob), colour: t[2], title: `${town.label(e.from)} — ${e.kind.replace(/_/g, " ")} — ${town.label(e.to)}` });
    if (!fills.has(ob)) fills.set(ob, t[2]);
  }
  return { fills, legend, lines, note: lines.length ? undefined : "No threads to other houses." };
}

/** Whose turf is where, the dens, the fences, and the houses robbed in the last fortnight. */
function crimeLens(town: Town): LensView {
  const fills = new Map<Address, string>();
  const legend: LensView["legend"] = [];
  const W = world(town);
  if (!W) return { fills, legend, lines: [], note: "Too small a place for crews: a few rogues, no underworld." };
  const TURF = ["#e8b4b8", "#b8d4e8", "#c8e0b0", "#e8d4a8", "#d4c0e4", "#b0e0d8", "#f0c8a0", "#d0d0a0"];
  const turfOf = new Map<number, string>();
  W.gangs.forEach((g, i) => { for (const w of g.turf) if (!turfOf.has(w)) turfOf.set(w, TURF[i % TURF.length]); legend.push({ label: g.name, colour: TURF[i % TURF.length] }); });
  for (const b of town.children(town.root, "building")) {
    const c = turfOf.get(b.get<number>("ward"));
    if (c) fills.set(b.address, c);
  }
  const date = town.clock.date;
  for (const i of incidentsBetween(town, addDays(date, -14), date)) if (!i.at.startsWith("place:") && happened(i, date, town.clock.block as Block)) fills.set(i.at, "#d62828");
  for (const f of W.fences) { const b = buildingOf(f); if (b) fills.set(b, "#6a3d9a"); }
  for (const g of W.gangs) if (g.den) fills.set(g.den, "#1d1d1d");
  legend.push({ label: "a crew's den", colour: "#1d1d1d" }, { label: "a fence", colour: "#6a3d9a" }, { label: "robbed in the last fortnight", colour: "#d62828" });
  return { fills, legend, lines: [], note: `${W.gangs.length} crews; ${crimeContent.levels[W.level].label}` };
}

// ---- 3. search and lists ------------------------------------------------

export type SearchKind = "person" | "building" | "ward" | "institution";
/** One searchable thing. `detail` is what the DM sees; `plain` leaves out the underworld (a crew alias). */
export interface SearchEntry { address: Address; kind: SearchKind; text: string; plainText: string; label: string; detail: string; plain: string }
const indexMemo = new WeakMap<Town, SearchEntry[]>();

function index(town: Town): SearchEntry[] {
  const hit = indexMemo.get(town);
  if (hit) return hit;
  const occs = town.registry<Occupation>("occupations");
  const out: SearchEntry[] = [];
  const push = (address: Address, kind: SearchKind, label: string, plain: string, detail = plain) =>
    out.push({ address, kind, label, detail, plain, text: `${label} ${detail}`.toLowerCase(), plainText: `${label} ${plain}`.toLowerCase() });
  for (const e of town.allEntities()) {
    if (e.type === "person") {
      const hh = town.get(town.parentOf(e.address)!);
      const occ = occs.find(e.get("occupation"))?.label ?? occs.find(hh.get("occupation"))?.label ?? "";
      const alias = e.get<string | undefined>("crime.alias");
      const plain = `${occ}, ${e.get<number>("age")}`;
      push(e.address, "person", town.label(e.address), plain, alias ? `${plain}, "${alias}"` : plain);
    } else if (e.type === "building") push(e.address, "building", town.label(e.address), String(e.get("use")).replace(/_/g, " "));
    else if (e.type === "ward" || e.type === "institution") push(e.address, e.type, town.label(e.address), e.type);
  }
  indexMemo.set(town, out);
  return out;
}

/** Build the search index now (when the box gets focus), so the first key typed doesn't wait for it. */
export function warmSearch(town: Town): void {
  index(town);
}

/** Everything whose name or trade matches all the words of the query. In player view, aliases neither match nor show. */
export function search(town: Town, query: string, limit = 60, opts: { player?: boolean; hide?: Set<Address> } = {}): { results: SearchEntry[]; total: number } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { results: [], total: 0 };
  const key = opts.player ? "plainText" : "text";
  let hits = index(town).filter((x) => words.every((w) => x[key].includes(w)) && !opts.hide?.has(x.address));
  if (opts.player) hits = hits.map((x) => ({ ...x, detail: x.plain }));
  // Places first, then people.
  const rank = (x: SearchEntry) => (x.kind === "person" ? 1 : 0);
  hits.sort((a, b) => rank(a) - rank(b) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return { results: hits.slice(0, limit), total: hits.length };
}

export interface ListSpec { id: string; title: string; rows(town: Town, date: string, block: Block): (PanelRow & { fact?: Fact })[] }

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export const LISTS: ListSpec[] = [
  {
    id: "hire", title: "For hire",
    rows(town) {
      town.society();
      const out: (PanelRow & { fact?: Fact })[] = [];
      for (const e of town.allEntities()) {
        if (e.type !== "person") continue;
        const as = e.get<string | undefined>("hire.as"), past = e.get<string | undefined>("hire.past");
        if (as) out.push({ label: HIRE_KINDS.find((k) => k.id === as)?.label.replace(/^an? /, "") ?? as, value: [L(town, e.address)], hint: `${hireRate(e.get<number>("hire.rate"))} a day` });
        if (past) out.push({ label: "has seen the world", value: [L(town, e.address), `: ${past}`] });
      }
      return out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    },
  },
  {
    id: "richest", title: "The richest households",
    rows(town) {
      const hs = town.allEntities().filter((e) => e.type === "household");
      hs.sort((a, b) => b.get<number>("income") - a.get<number>("income") || (a.address < b.address ? -1 : 1));
      const occs = town.registry<Occupation>("occupations");
      return hs.slice(0, 40).map((h) => {
        const take = h.get<number | undefined>("crime.take");
        return { label: `${lsd(h.get<number>("income"))} a year`, value: [L(town, h.address), ` — ${occs.find(h.get("occupation"))?.label ?? h.get("occupation")}`], hint: `${lsd(h.get<number>("savings"))} put by${take ? `; and ${lsd(take)} a year from the crews, which nobody sees` : ""}` };
      });
    },
  },
  {
    id: "debts", title: "Debts, largest first",
    rows(town) {
      const ds = town.edges({ kind: "debtor_of" }).sort((a, b) => (b.facts?.amount as number) - (a.facts?.amount as number) || (a.id < b.id ? -1 : 1));
      return ds.slice(0, 60).map((e) => ({
        label: lsd(e.facts?.amount as number), value: [L(town, e.from), " owes ", L(town, e.to), e.facts?.reason ? `, for ${e.facts.reason}` : ""],
        hint: e.knownBy === "public" ? "common knowledge" : "a secret", fact: `edge:${e.id}` as Fact,
      }));
    },
  },
  {
    id: "secrets", title: "Secrets, and when they come out",
    rows(town, date, block) {
      const now = hourOf(date, block);
      const when = new Map(allSecrets(town).map((r) => [r.edge!, r.start]));
      const es = town.edges().filter((e) => e.knownBy !== "public" && isPerson(e.from) && isPerson(e.to));
      es.sort((a, b) => (when.get(a.id) ?? Infinity) - (when.get(b.id) ?? Infinity) || (a.id < b.id ? -1 : 1));
      return es.slice(0, 80).map((e) => {
        const t = when.get(e.id);
        return { label: t === undefined ? "stays hidden" : t <= now ? "out already" : `out ${whenHour(t, now)}`, value: edgeTitle(town, e), fact: `edge:${e.id}` as Fact };
      });
    },
  },
  {
    id: "feuds", title: "Feuds and grudges",
    rows(town) {
      return town.edges().filter((e) => ["rival", "grievance", "dispute"].includes(e.kind) && isPerson(e.from) && isPerson(e.to))
        .slice(0, 80).map((e) => ({ label: e.kind, value: edgeTitle(town, e), fact: `edge:${e.id}` as Fact }));
    },
  },
  {
    id: "offices", title: "Who holds office",
    rows(town) {
      return town.edges({ kind: "office_in" }).map((e) => ({ label: String(e.facts?.office ?? "office"), value: [L(town, e.from), " in ", L(town, e.to)] }));
    },
  },
  {
    id: "underworld", title: "The underworld",
    rows(town) {
      const W = world(town);
      if (!W) return [{ label: "—", value: "no crews here" }];
      const rows: (PanelRow & { fact?: Fact })[] = [];
      for (const g of W.gangs) {
        rows.push({ label: g.lay.label, value: [L(town, g.address), ` — ${g.members.length}`, ...(g.chief ? [", led by ", L(town, g.chief)] : []), ...(g.den ? [", at ", L(town, g.den)] : [])], highlight: g.members.map((m) => m.p) });
      }
      for (const [p, roles] of W.roles) for (const r of roles) if (r !== "keeper") rows.push({ label: r === "thiefTaker" ? "thief-taker" : r, value: [L(town, p)] });
      return rows;
    },
  },
  {
    id: "crimes", title: "Crimes in the last month",
    rows(town, date, block) {
      return incidentsBetween(town, addDays(date, -30), date).filter((i) => happened(i, date, block)).reverse().slice(0, 80).map((i) => ({
        label: whenOf(i.date, date, i.block),
        value: [`${crimeContent.crimes[i.kind].label}${i.victim ? ": " : ""}`, ...(i.victim ? [L(town, i.victim)] : []), `${i.items ? ` — ${i.items}` : ""}; by `, ...i.culprits.flatMap((c, k) => [...(k ? [", "] : []), L(town, c)]), i.caught && i.caught.date <= date ? " (taken)" : ""],
        highlight: [i.at, ...i.culprits],
      }));
    },
  },
  {
    id: "gaol", title: "In gaol now",
    rows(town, date) {
      const held = prisoners(town, date);
      return held.length ? held.map((x) => ({ label: "held", value: [L(town, x.p), `: ${x.doing}`] })) : [{ label: "—", value: "the gaol is empty" }];
    },
  },
  {
    id: "old", title: "The oldest folk",
    rows(town) {
      const ps = town.allEntities().filter((e) => e.type === "person" && e.address.includes("/building:") && e.get<number>("age") >= 60);
      ps.sort((a, b) => b.get<number>("age") - a.get<number>("age") || (a.address < b.address ? -1 : 1));
      return ps.slice(0, 40).map((p) => ({ label: String(p.get<number>("age")), value: [L(town, p.address)] }));
    },
  },
  {
    id: "trades", title: "Trades, by how many",
    rows(town) {
      const occs = town.registry<Occupation>("occupations");
      const n = new Map<string, number>();
      for (const h of town.allEntities()) if (h.type === "household") n.set(h.get("occupation"), (n.get(h.get("occupation")) ?? 0) + 1);
      return [...n].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([o, c]) => ({ label: String(c), value: cap(occs.find(o)?.label ?? o) }));
    },
  },
];

// ---- 5. the almanac -----------------------------------------------------

export interface AlmanacEntry { date: string; kind: "feast" | "rent" | "visit" | "secret" | "market" | "crime" | "life"; text: Value; fact?: Fact }

export function almanac(town: Town, from: string, days = 60): AlmanacEntry[] {
  const out: AlmanacEntry[] = [];
  const end = addDays(from, days);
  const inWindow = (d: string) => d >= from && d < end;
  const y0 = parseDate(from).y, y1 = parseDate(end).y;
  for (let d = from; d < end; d = addDays(d, 1)) {
    const f = feastOn(d);
    if (f && f.name !== "Sunday") out.push({ date: d, kind: f.quarter ? "rent" : "feast", text: [f.quarter ? `${f.name}: a quarter-day, when rents fall due` : f.festival ? `${f.name}: a festival${f.custom ? `: ${f.custom}` : ""}` : f.holy ? `${f.name}: a holy day, no work${f.custom ? `; ${f.custom}` : ""}` : `${f.name}${f.custom ? `: ${f.custom}` : ""}`] });
    for (const c of patronalOn(town, d)) out.push({ date: d, kind: "feast", text: [L(town, c), `: the patronal feast of ${patronOf(town, c)}, with a procession round the parish and a church-ale`] });
  }
  // Weddings, burials and fires to come: the DM's foreknowledge.
  for (const e of lifeBetween(town, from, addDays(end, -1))) {
    if (e.kind === "wedding") out.push({ date: e.date, kind: "life", text: ["Wedding: ", L(town, e.who[0]), " and ", L(town, e.who[1])] });
    if (e.kind === "death" && town.get(e.who[0]).get<number>("age") >= 16) out.push({ date: e.date, kind: "life", text: ["Death: ", L(town, e.who[0]), `, of ${e.cause}; the funeral next day`] });
    if (e.kind === "fire") out.push({ date: e.date, kind: "life", text: [`Fire: ${e.buildings!.length} houses burn, from ${e.cause}, starting at `, L(town, e.at!)] });
    if (e.kind === "flood") out.push({ date: e.date, kind: "life", text: [`Flood: ${e.cause}; ${e.buildings!.length} houses by the water flooded`] });
    if (e.kind === "sickness") out.push({ date: e.date, kind: "life", text: [`Sickness: ${e.cause} comes to the town, for two months`] });
  }
  const marketDays = town.settlement().get<string[] | undefined>("marketDays");
  if (marketDays?.length) out.push({ date: from, kind: "market", text: [`Market every ${marketDays.join(" and ")}`] });
  for (let y = y0; y <= y1; y++) for (const v of visitsIn(town, y)) {
    if (!inWindow(v.start)) continue;
    out.push({ date: v.start, kind: "visit", text: [`${visitLabel(town, v)}: ${v.who} — ${v.note}${v.days > 1 ? ` (${v.days} days)` : ""}`] });
  }
  const startH = hourOf(from, "morning"), endH = hourOf(end, "morning");
  const edges = new Map(town.edges().map((e) => [e.id, e]));
  for (const r of allSecrets(town)) {
    if (r.start < startH || r.start >= endH || r.topic === "courting") continue;
    // Small debts coming out are not worth a line in the almanac.
    const amount = r.edge ? edges.get(r.edge)?.facts?.amount : undefined;
    if (r.topic === "debtor_of" && typeof amount === "number" && amount < 240) continue;
    out.push({ date: describeHour(r.start).slice(0, 10), kind: "secret", text: ["It comes out that ", ...linked(town, r, 0).map((x, i) => (i === 0 && typeof x === "string" ? x[0].toLowerCase() + x.slice(1) : x)), ` (${r.how})`], fact: `rumour:${r.id}` as Fact });
  }
  // The crimes to come, for the DM's eyes only: break-ins, robberies, killings, arrests and sentences.
  for (const i of incidentsBetween(town, from, addDays(end, -1))) {
    if (i.notable && ["burglary", "robbery", "horse", "smash", "killing"].includes(i.kind)) {
      out.push({ date: i.date, kind: "crime", text: [`${cap(crimeContent.crimes[i.kind].label)}${i.victim ? ": " : ""}`, ...(i.victim ? [L(town, i.victim)] : []), ` (${i.block.replace("_", " ")}), by `, ...i.culprits.flatMap((c, k) => [...(k ? [", " ] : []), L(town, c)])] });
    }
  }
  for (const i of incidentsBetween(town, addDays(from, -200), addDays(end, -1))) {
    if (i.fate && i.fate.felony && inWindow(i.fate.on)) out.push({ date: i.fate.on, kind: "crime", text: i.fate.outcome === "hanged"
      ? ["Hanging: ", L(town, i.caught!.who), `, for ${crimeContent.crimes[i.kind].charge}, on the gallows outside the gates in the afternoon; a third of the town will turn out to watch`]
      : ["Sentence: ", L(town, i.caught!.who), `, for ${crimeContent.crimes[i.kind].charge}: ${i.fate.text}`] });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export { describeDate };

// ---- 6. a person's day --------------------------------------------------

export interface Stop { block: Block; w: Whereabouts; at?: Pt; others: Address[]; othersTotal: number }

/** Where a place key or building sits on the map, if it sits anywhere. */
export function placePoint(town: Town, where: string, person: Address): Pt | undefined {
  if (!where.startsWith("place:")) return centroid(town.get(where).get<Poly>("poly"));
  const m = town.settlement().get<MapData>("map");
  const home = buildingOf(person);
  switch (where) {
    case "place:green": case "place:market": return centroid(m.green);
    case "place:gallows": return m.features.find((x) => x.kind === "gallows")?.p;
    case "place:streets": case "place:walls": return home ? centroid(town.get(home).get<Poly>("poly")) : undefined;
    case "place:fields": case "place:demesne": return m.greatFields[0]?.label;
    case "place:pasture": return m.features.find((f) => f.kind === "fold")?.p ?? m.greatFields[1]?.label;
    case "place:river": case "place:quay": return m.quay?.[0] ?? m.ford;
    case "place:shore": case "place:sea": return m.coast?.[Math.floor((m.coast?.length ?? 1) / 2)];
    case "place:mine": return m.features.find((f) => f.kind === "adit")?.p;
    case "place:woods": return m.woods[0] ? centroid(m.woods[0]) : undefined;
  }
  return undefined;
}

export function dayOf(town: Town, person: Address, date: string): Stop[] {
  return BLOCKS.map((block) => {
    const w = whereabouts(town, person, date, block);
    const here = occupancy(town, date, block).get(w.where) ?? [];
    const others = here.filter((a) => a !== person && town.get(a).get<number>("age") >= 12);
    // At home, the family doesn't count as company.
    const company = w.where === buildingOf(person) ? others.filter((a) => buildingOf(a) !== w.where) : others;
    return { block, w, at: placePoint(town, w.where, person), others: company.slice(0, 12), othersTotal: company.length };
  });
}

export function placeName(town: Town, where: string): string {
  return where.startsWith("place:") ? PLACES[where] ?? where : town.label(where);
}

export const streetPlan = isStreetPlan;
