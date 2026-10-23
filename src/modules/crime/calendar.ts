import { tidy } from "../../core/text";
// The crime calendar: what each crew does on each day, who is caught, and
// what the law does with them. Like visits and routines it is a pure function
// of the town and the date: nothing is stored. Because a man in gaol can't
// cut purses and a hanged man can't do anything, the years are worked forward
// in order from a fixed epoch, each once, the way the visitors module walks
// its travelling bands.
import type { Address } from "../../core/address";
import { addDays, BLOCKS, feastOn, formatDate, fromJdn, jdn, parseDate, weekday, WEEKDAYS, type Block } from "../../core/calendar";
import type { Rng } from "../../core/rng";
import type { Town } from "../../core/town";
import type { Tier } from "../core";
import { hourOf, neighbourOf, type Rumour } from "../gossip";
import { lsd } from "../households";
import { buildingsOfUse, nearestBuilding, type MapData } from "../layout";
import { centroid, dist, type Poly, type Pt } from "../layout/geom";
import { visitorsOn, visitsIn } from "../visitors";
import { content, self, world, type Gang, type World } from "./world";

/** No crimes before this year; the walk forward starts here. */
export const EPOCH = 1200;
/** Knives' contracts are dated from the start of this year (the clock's default year). */
export const REF_YEAR = 1203;

export interface Fate {
  felony: boolean;
  /** what happened to them, in a sentence */
  text: string;
  outcome: string;
  /** the day the sentence was carried out or the trial held */
  on: string;
}

export interface Incident {
  id: string;
  kind: string;
  date: string;
  block: Block;
  gang?: Address;
  culprits: Address[];
  victim?: Address;
  /** a building address or a place key */
  at: string;
  /** what it was worth, in pennies */
  loot: number;
  items: string;
  caught?: { date: string; who: Address; by?: Address };
  fate?: Fate;
  /** fled to sanctuary rather than be taken */
  sanctuary?: { church: Address; date: string };
  /** for a killing: how they died, as the town tells it */
  death?: string;
  notable: boolean;
}

interface Status { from: number; to: number; where: string; doing: string; blocks?: Block[]; kind: "gaol" | "pillory" | "whipped" | "dead" | "sanctuary" | "away" | "low" | "report" }

interface Ledger {
  last: number;
  years: Map<number, Incident[]>;
  /** the first day each person is free again (Infinity: dead or gone for good) */
  free: Map<Address, number>;
  status: Map<Address, Status[]>;
  /** person|date|block -> what they were doing at an incident */
  at: Map<string, { inc: Incident; role: "culprit" | "victim" }>;
  byPerson: Map<Address, Incident[]>;
  /** each crew's heat: how hard the watch is looking, after recent jobs; fades by the day */
  heat: Map<Address, number>;
  /** houses broken into, and the day: they bar the door and get a dog after */
  barred: Map<Address, number>;
}

const ledgers = new WeakMap<Town, Ledger>();

function ledger(town: Town): Ledger {
  let l = ledgers.get(town);
  if (!l) ledgers.set(town, (l = { last: EPOCH - 1, years: new Map(), free: new Map(), status: new Map(), at: new Map(), byPerson: new Map(), heat: new Map(), barred: new Map() }));
  return l;
}

/** Every crime committed in a year, in order. */
export function incidentsIn(town: Town, year: number): Incident[] {
  const W = world(town);
  if (!W || year < EPOCH) return [];
  const l = ledger(town);
  while (l.last < year) {
    l.last++;
    l.years.set(l.last, workYear(town, W, l, l.last));
  }
  return l.years.get(year) ?? [];
}

/** Crimes between two dates (inclusive), oldest first. */
export function incidentsBetween(town: Town, from: string, to: string): Incident[] {
  const out: Incident[] = [];
  for (let y = parseDate(from).y; y <= parseDate(to).y; y++) for (const i of incidentsIn(town, y)) if (i.date >= from && i.date <= to) out.push(i);
  return out;
}

/** Whether a crime has happened by a given block (a break-in "late night" comes after the evening of the same date). */
export function happened(i: Incident, date: string, block: Block): boolean {
  return hourOf(i.date, i.block) <= hourOf(date, block);
}

/** A person's dealings with crime: what they did and what was done to them (as far as the calendar has been worked). */
export function recordOf(town: Town, person: Address, upTo: string): Incident[] {
  incidentsIn(town, parseDate(upTo).y);
  return (ledger(town).byPerson.get(person) ?? []).filter((i) => i.date <= upTo);
}

/** Where the law (or the grave) has someone on a day, if anywhere. */
export function statusOf(town: Town, person: Address, date: string, block?: Block): { kind: Status["kind"]; where: string; doing: string } | undefined {
  if (!world(town)) return undefined;
  incidentsIn(town, parseDate(date).y);
  const j = jdn(parseDate(date));
  const s = ledger(town).status.get(person)?.find((x) => x.from <= j && j < x.to && (!block || !x.blocks || x.blocks.includes(block)));
  return s && { kind: s.kind, where: s.where, doing: s.doing };
}

/** Everyone held in gaol (or awaiting the assizes in the county gaol) on a day. */
export function prisoners(town: Town, date: string): { p: Address; where: string; doing: string; inc?: Incident }[] {
  if (!world(town)) return [];
  incidentsIn(town, parseDate(date).y);
  const j = jdn(parseDate(date));
  const out: { p: Address; where: string; doing: string; inc?: Incident }[] = [];
  const l = ledger(town);
  for (const [p, ss] of l.status) for (const s of ss) {
    if (s.kind !== "gaol" || s.from > j || j >= s.to) continue;
    const inc = (l.byPerson.get(p) ?? []).find((i) => i.caught?.who === p && jdn(parseDate(i.caught.date)) <= j && (!i.fate || jdn(parseDate(i.fate.on)) >= j));
    out.push({ p, where: s.where, doing: s.doing, inc });
  }
  return out.sort((a, b) => (a.p < b.p ? -1 : 1));
}

/** The chalk marks on a door as of a date: what the beggars left, and after a
 *  break-in, the marks for a dog and a barred door. */
export function marksOn(town: Town, b: Address, date: string): string[] {
  const base = town.get(b).get<string[] | undefined>("crime.marks") ?? [];
  const hit = incidentsBetween(town, addDays(date, -365), date).some((i) => i.kind === "burglary" && i.at === b && i.date < date);
  return hit ? [...new Set([...base.filter((m) => m !== "rich" && m !== "empty"), "dog", "barred"])] : base;
}

const hangMemo = new WeakMap<Town, Map<string, Incident[]>>();
/** Felons hanged on a date (the afternoon of their assize). */
export function hangingsOn(town: Town, date: string): Incident[] {
  let m = hangMemo.get(town);
  if (!m) hangMemo.set(town, (m = new Map()));
  const hit = m.get(date);
  if (hit) return hit;
  const y = parseDate(date).y;
  const out = [...incidentsIn(town, y - 1), ...incidentsIn(town, y)].filter((i) => i.fate?.outcome === "hanged" && i.fate.on === date && i.caught);
  m.set(date, out);
  return out;
}

/** The routine hook: put people where the crime calendar has them. Never calls whereabouts(). */
export function crimeAt(town: Town, person: Address, date: string, block: Block): { where: string; doing: string } | undefined {
  const W = world(town);
  if (!W) return undefined;
  const y = parseDate(date).y;
  if (y < EPOCH) return undefined;
  incidentsIn(town, y);
  const l = ledger(town);
  const j = jdn(parseDate(date));
  // A hanging day: the condemned go out to the gallows, and half the town follows.
  if (block === "afternoon") {
    const hangings = hangingsOn(town, date);
    if (hangings.length) {
      const h = hangings.find((i) => i.caught?.who === person);
      if (h) return { where: "place:gallows", doing: `carted out to the gallows for ${content.crimes[h.kind].charge}, and hanged before the crowd` };
      const p = town.get(person);
      if (p.get<number>("age") >= 12 && p.get("role") !== "cleric" && town.rngFor(person, self, `hanging:${date}`).chance(0.3)) {
        return { where: "place:gallows", doing: `in the crowd at the gallows to see ${town.label(hangings[0].caught!.who)} hanged, and buying a hot pie off a tray` };
      }
    }
  }
  const st = (l.status.get(person) ?? []).filter((s) => s.from <= j && j < s.to && (!s.blocks || s.blocks.includes(block)));
  // Gaol, the pillory and the grave come first; lying low or reporting a theft give way to a job.
  const hard = st.find((s) => s.kind !== "low" && s.kind !== "report");
  if (hard) return { where: hard.where, doing: hard.doing };
  const hit = l.at.get(`${person}|${date}|${block}`);
  if (hit) {
    if (hit.role === "victim") return { where: "place:streets", doing: "walking home after dark, and set upon in a lane" };
    return { where: hit.inc.at, doing: content.crimes[hit.inc.kind].doing };
  }
  if (st.length) return { where: st[0].where, doing: st[0].doing };
  // Ordinary nights for the crew.
  const m = W.crew.get(person);
  const roles = W.roles.get(person);
  if (!m && !roles) return undefined;
  const r = town.rngFor(person, self, `habit:${date}:${block}`);
  const home = town.parentOf(town.parentOf(person)!)!;
  if (m) {
    const den = m.gang.den;
    if (block === "evening" && den && den !== home && r.chance(m.rank.chief ? 0.6 : 0.3)) {
      const young = town.get(person).get<number>("age") < 15;
      return { where: den, doing: m.rank.chief ? "holding court in the back room, over the crew's business" : young ? "underfoot at the den, running errands for the crew" : "drinking with the crew in the back, and talking low" };
    }
    if (block === "night" && ["crackers", "pads", "owlers", "prancers"].includes(m.gang.lay.id) && !m.rank.chief && r.chance(0.12)) {
      return { where: "place:streets", doing: "out in the dark, looking over likely houses" };
    }
    if (block === "forenoon" && m.gang.lay.protection && (m.rank.id === "collector" || m.rank.chief) && WEEKDAYS[weekday(date) % 7] === "Saturday") {
      return { where: "place:streets", doing: `going round the shops for the week's "protection"` };
    }
  }
  if (roles?.includes("fence") && block === "evening" && r.chance(0.35)) return { where: home, doing: "taking in goods at the back door, after dark, and asking no questions" };
  if (roles?.includes("boss") && block === "evening" && r.chance(0.3)) {
    const gang = W.gangs[r.int(0, W.gangs.length - 1)];
    if (gang.den && gang.den !== home) return { where: gang.den, doing: `taking the tenth from ${gang.name}` };
  }
  return undefined;
}

// ---- working a year -------------------------------------------------------

interface Adult { p: Address; home: Address; at: Pt; ward: number; rank: number; male: boolean; drinker: boolean; married: boolean }
interface Prep {
  adults: Adult[];
  maxRank: number;
  byHome: Map<Address, Adult[]>;
  pos: Map<Address, Pt>;
  wardOf: Map<Address, number>;
  value: number[];
  market: Pt;
  hasWatch: boolean;
  officers: { p: Address; office: string; quarter?: number; ward?: number }[];
  marketDays: string[];
  /** per gang: houses worth breaking into, drinkers to fleece, people to rob */
  targets: Map<Address, { houses: { b: Address; w: number }[]; drinkers: Adult[]; walkers: Adult[]; homes: Adult[] }>;
}

const prepMemo = new WeakMap<Town, Prep>();

function prep(town: Town, W: World): Prep {
  const hit = prepMemo.get(town);
  if (hit) return hit;
  const tiers = town.registry<Tier>("tiers");
  const map = town.settlement().get<MapData>("map");
  const value = (map.wards ?? []).map((w) => w.value);
  const adults: Adult[] = [];
  const byHome = new Map<Address, Adult[]>();
  const pos = new Map<Address, Pt>();
  const wardOf = new Map<Address, number>();
  for (const b of town.children(town.root, "building")) {
    const at = centroid(b.get<Poly>("poly"));
    pos.set(b.address, at);
    const ward = b.get<number>("ward") ?? 0;
    wardOf.set(b.address, ward);
    for (const hh of town.children(b.address, "household")) {
      const rank = tiers.find(hh.get<string>("tier"))?.rank ?? 3;
      for (const p of town.children(hh.address, "person")) {
        if (p.get<number>("age") < 16 || W.crew.has(p.address)) continue;
        const a: Adult = { p: p.address, home: b.address, at, ward, rank, male: p.get("sex") === "m", drinker: (p.get<string[]>("traits") ?? []).includes("drinker"), married: p.get("marital") === "married" };
        adults.push(a);
        const l = byHome.get(b.address);
        if (l) l.push(a); else byHome.set(b.address, [a]);
      }
    }
  }
  const officers: Prep["officers"] = [];
  for (const e of town.edges({ kind: "office_in" })) officers.push({ p: e.from, office: String(e.facts?.office), quarter: e.facts?.quarter as number | undefined, ward: e.facts?.ward as number | undefined });
  const targets: Prep["targets"] = new Map();
  const reach = Math.max(350, Math.sqrt(town.settlement().get<number>("targetPop")) * 5);
  for (const g of W.gangs) {
    const den = g.den ? pos.get(g.den)! : centroid(map.market ?? map.green);
    const houses: { b: Address; w: number }[] = [];
    for (const [b, at] of pos) {
      const hs = byHome.get(b);
      if (!hs?.length || b === g.den) continue;
      const d = dist(at, den);
      if (d > reach * 1.6) continue;
      const marks = town.get(b).get<string[] | undefined>("crime.marks") ?? [];
      const rank = Math.max(...hs.map((x) => x.rank));
      if (rank < 5 && !marks.includes("rich")) continue;
      let w = (rank - 3) * (marks.includes("rich") ? 3 : 1) * (marks.includes("empty") ? 2 : 1) * (marks.includes("old") ? 1.5 : 1) * (marks.includes("law") ? 0.08 : 1) * (marks.includes("dog") ? 0.3 : 1);
      w /= 1 + d / reach;
      houses.push({ b, w });
    }
    const near = adults.filter((a) => dist(a.at, den) < reach);
    targets.set(g.address, {
      houses,
      drinkers: near.filter((a) => a.drinker && a.rank >= 3 && a.rank <= 8),
      walkers: near.filter((a) => a.male && a.rank >= 4),
      homes: near.filter((a) => a.rank >= 3 && a.rank <= 6),
    });
  }
  const p: Prep = {
    adults, maxRank: Math.max(1, ...adults.map((a) => a.rank)), byHome, pos, wardOf, value, market: centroid(map.market ?? map.green),
    hasWatch: officers.some((o) => o.office === "officer of the watch" || o.office === "constable"), officers,
    marketDays: town.settlement().get<string[]>("marketDays") ?? [], targets,
  };
  prepMemo.set(town, p);
  return p;
}

// Who in a crew does which job.
const HANDS: Record<string, string[]> = {
  cutpurse: ["nip", "stall", "kinchin"], pickpocket: ["foist", "kinchin", "stall"], burglary: ["dubber", "budge", "snakesman", "lookout"],
  robbery: ["pad", "hedge", "ruffler"], dice: ["setter", "verser", "barnard", "rutter"], crossbite: ["doxy", "crossbiter", "bully"],
  smuggle: ["boatman", "carrier", "lookout"], coin: ["smasher", "clipper"], smash: ["ding", "collector"], horse: ["prigger", "queer_bird"],
  linen: ["palliard", "mort", "kinchin", "abram", "crank"], killing: [],
};
const HOW_MANY: Record<string, [number, number]> = { cutpurse: [1, 2], pickpocket: [1, 2], burglary: [2, 3], robbery: [2, 3], dice: [2, 3], crossbite: [2, 2], smuggle: [3, 4], coin: [1, 1], smash: [2, 2], horse: [1, 2], linen: [1, 1] };
const FELONY = new Set(["burglary", "robbery", "horse_theft", "coining", "murder"]);
const DRINK = ["tavern", "town_alehouse", "inn"];
const PARISH = ["fane", "temple", "grand_temple", "chapel", "shrine"];

function workYear(town: Town, W: World, l: Ledger, year: number): Incident[] {
  const P = prep(town, W);
  const L = content.levels[W.level];
  const out: Incident[] = [];
  const j0 = jdn({ y: year, m: 1, d: 1 }), j1 = jdn({ y: year, m: 12, d: 31 });
  const isFree = (p: Address, j: number) => (l.free.get(p) ?? -Infinity) <= j;
  const addStatus = (p: Address, s: Status) => { const x = l.status.get(p); if (x) x.push(s); else l.status.set(p, [s]); };
  const note = (p: Address, inc: Incident) => { const x = l.byPerson.get(p); if (x) { if (!x.includes(inc)) x.push(inc); } else l.byPerson.set(p, [inc]); };
  const contracts = W.edges.hired_knife;
  const ref = jdn({ y: REF_YEAR, m: 1, d: 1 });
  const watchHouses = buildingsOfUse(town, ["watch_house"]);
  const gaol = buildingsOfUse(town, ["gaol"])[0]?.a ?? watchHouses[0]?.a;
  const quay = !!town.settlement().get<MapData>("map").quay;

  for (let j = j0; j <= j1; j++) {
    const date = formatDate(fromJdn(j));
    // Heat fades: a week's quiet halves it.
    for (const [g, h] of l.heat) l.heat.set(g, h * 0.9);
    const wd = WEEKDAYS[weekday(date) % 7];
    const feast = feastOn(date);
    const market = P.marketDays.includes(wd);
    const visits = visitorsOn(town, date);
    const fair = visits.some((v) => v.kind === "fair" && v.local);
    const month = parseDate(date).m;
    const winter = month >= 10 || month <= 2;
    for (const g of W.gangs) {
      const hands = g.members.filter((m) => isFree(m.p, j));
      if (!hands.length) continue;
      for (const kind of g.lay.crimes) {
        const C = content.crimes[kind];
        // Twice the hands is not twice the work: they share the same crowds and the same streets.
        let rate = C.rate * Math.sqrt(hands.length / 6) * L.mult;
        if (kind === "cutpurse" || kind === "pickpocket") rate *= fair ? 5 : market ? 2.5 : feast?.holy ? 0.6 : 0.5;
        if ((kind === "burglary" || kind === "robbery") && winter) rate *= 1.4;
        if (kind === "dice" && (wd === "Saturday" || fair)) rate *= 2;
        if (kind === "linen" && wd === "Monday") rate *= 3;
        if (kind === "coin" && market) rate *= 2;
        if (kind === "horse" && fair) rate *= 3;
        if (kind === "smash" && !g.refusers.length) rate = 0;
        // A crew the watch is hunting lies low for a while.
        rate /= 1 + 0.35 * (l.heat.get(g.address) ?? 0);
        if (rate <= 0) continue;
        const r = town.rngFor(g.address, self, `day:${date}:${kind}`);
        if (!r.chance(Math.min(0.9, rate))) continue;
        const inc = commit(town, W, P, l, g, kind, date, j, r, { market, fair, holy: !!feast?.holy, quay });
        if (inc) { out.push(inc); l.heat.set(g.address, (l.heat.get(g.address) ?? 0) + (inc.notable ? 2 : 1)); }
      }
    }
    for (const e of contracts) {
      if (ref + (e.facts?.day as number) !== j) continue;
      const knife = e.to, target = e.facts?.target as Address;
      if (!isFree(knife, j) || !isFree(target, j)) continue;
      const r = town.rngFor(W.address, self, `killing:${e.id}`);
      const method = content.knifeMethods.find((m) => m.id === e.facts?.method) ?? content.knifeMethods[0];
      const home = town.parentOf(town.parentOf(target)!)!;
      const at = method.id === "blade" ? nearestBuilding(town, home, DRINK) ?? home : method.id === "river" ? "place:river" : method.id === "footpads" ? "place:streets" : home;
      const inc: Incident = { id: `knife/${e.id}`, kind: "killing", date, block: "night", culprits: [knife], victim: target, at, loot: 0, items: "", death: method.death, notable: true };
      l.free.set(target, Infinity);
      addStatus(target, { from: j + 1, to: Infinity, where: "place:grave", doing: `${method.death}, on ${date}; buried at the parish church` , kind: "dead" });
      l.at.set(`${knife}|${date}|night`, { inc, role: "culprit" });
      judge(town, P, l, inc, r, j, gaol, addStatus);
      note(knife, inc); note(target, inc);
      out.push(inc);
    }
  }
  return out;

  function commit(town: Town, _W: World, P: Prep, l: Ledger, g: Gang, kind: string, date: string, j: number, r: Rng, day: { market: boolean; fair: boolean; holy: boolean; quay: boolean }): Incident | undefined {
    const C = content.crimes[kind];
    const T = P.targets.get(g.address)!;
    const block = r.pick(C.blocks);
    const freeHands = g.members.filter((m) => isFree(m.p, j) && !m.rank.chief);
    const chief = g.members.find((m) => m.rank.chief && isFree(m.p, j));
    let victim: Address | undefined, at: string, loot = 0, items = "";
    const crowd = (): Adult | undefined => {
      for (let k = 0; k < 24; k++) {
        const a = P.adults[r.int(0, P.adults.length - 1)];
        if (a && isFree(a.p, j) && r.chance(a.rank / P.maxRank)) return a;
      }
      return undefined;
    };
    const purse = (a: Address) => town.get(a).get<number>("character.purse") ?? 0;
    const tier = (rank: number) => (rank >= 8 ? "rich" : rank >= 5 ? "middling" : "poor");
    switch (kind) {
      case "cutpurse": case "pickpocket": {
        const a = crowd();
        if (!a) return undefined;
        victim = a.p;
        at = day.holy && block !== "evening" ? nearestBuilding(town, g.den ?? a.home, PARISH) ?? "place:market" : block === "evening" ? nearestBuilding(town, g.den ?? a.home, DRINK) ?? "place:market" : "place:market";
        loot = Math.round(purse(a.p) * r.range(0.6, 1));
        items = loot ? `a purse with ${lsd(loot)} in it` : "a purse with nothing in it but a key";
        break;
      }
      case "burglary": {
        if (!T.houses.length) return undefined;
        // A house broken into this past year has a new bar and a dog: try elsewhere.
        const h = r.weighted(T.houses, (x) => x.w * (j - (l.barred.get(x.b) ?? -9999) < 365 ? 0.15 : 1));
        const hs = P.byHome.get(h.b)!.filter((x) => isFree(x.p, j));
        if (!hs.length) return undefined;
        victim = hs[0].p;
        at = h.b;
        const hh = town.get(town.parentOf(victim)!);
        loot = Math.max(6, Math.round((hh.get<number>("savings") ?? 0) * r.range(0.02, 0.12) + (hh.get<number>("income") ?? 0) * r.range(0.01, 0.04)));
        items = r.shuffle(content.loot[tier(hs[0].rank)]).slice(0, r.int(1, 2)).join(" and ");
        l.barred.set(h.b, j);
        break;
      }
      case "robbery": {
        const pool = T.walkers.filter((a) => isFree(a.p, j));
        if (!pool.length) return undefined;
        const a = r.weighted(pool, (x) => (x.drinker ? 4 : 1) * x.rank);
        victim = a.p;
        at = a.home;
        loot = purse(a.p) + (r.chance(0.5) ? r.int(12, 60) : 0);
        items = `${lsd(Math.max(1, purse(a.p)))}${loot > purse(a.p) ? " and a good cloak" : ""}`;
        break;
      }
      case "dice": {
        const pool = T.drinkers.filter((a) => isFree(a.p, j));
        if (!pool.length) return undefined;
        const a = r.weighted(pool, (x) => x.rank);
        victim = a.p;
        at = g.den && DRINK.includes(town.get(g.den).get<string>("use")) ? g.den : nearestBuilding(town, g.den ?? a.home, DRINK) ?? a.home;
        const hh = town.get(town.parentOf(victim)!);
        loot = Math.max(4, Math.round((hh.get<number>("savings") ?? 0) * r.range(0.01, 0.06) + purse(a.p)));
        items = lsd(loot);
        break;
      }
      case "crossbite": {
        const pool = T.walkers.filter((a) => isFree(a.p, j) && a.rank >= 5);
        if (!pool.length) return undefined;
        const a = r.weighted(pool, (x) => (x.married ? 3 : 1));
        victim = a.p;
        at = g.den ?? "place:streets";
        loot = purse(a.p) + r.int(12, 120);
        items = lsd(loot);
        break;
      }
      case "smuggle": {
        at = day.quay ? "place:quay" : "place:river";
        const bales = r.int(4, 20);
        loot = bales * 120;
        items = `${bales} bales of wool`;
        break;
      }
      case "coin": {
        at = "place:market";
        loot = r.int(20, 240);
        items = `${loot} clipped pennies`;
        break;
      }
      case "smash": {
        const ok = g.refusers.filter((p) => isFree(p, j));
        if (!ok.length) return undefined;
        victim = r.pick(ok);
        at = town.parentOf(town.parentOf(victim)!)!;
        items = "the shutters, the counter and half the stock";
        break;
      }
      case "horse": {
        const stables = buildingsOfUse(town, ["inn", "livery_stable"]);
        if (!stables.length) return undefined;
        at = r.pick(stables).a;
        victim = P.byHome.get(at)?.[0]?.p;
        loot = r.int(120, 480);
        items = r.pick(["a bay gelding", "a grey mare", "a merchant's packhorse", "a knight's palfrey", "two carthorses"]);
        break;
      }
      case "linen": {
        const pool = T.homes.filter((a) => isFree(a.p, j));
        if (!pool.length) return undefined;
        const a = r.pick(pool);
        victim = a.p;
        at = a.home;
        loot = r.int(2, 10);
        items = r.pick(["a shirt and two shifts", "the week's washing", "a good linen sheet", "a child's smocks"]);
        break;
      }
      default: return undefined;
    }
    // The hands for the job.
    const [lo, hi] = HOW_MANY[kind] ?? [1, 2];
    const want = r.int(lo, hi);
    const fit = freeHands.filter((m) => HANDS[kind]?.includes(m.rank.id));
    const others = freeHands.filter((m) => !fit.includes(m));
    const team: Address[] = [];
    for (const m of [...r.shuffle(fit), ...r.shuffle(others)]) { if (team.length >= want) break; team.push(m.p); }
    if (chief && (kind === "burglary" || kind === "smuggle" || !team.length) && r.chance(team.length ? 0.25 : 1)) team.unshift(chief.p);
    if (!team.length) return undefined;
    if (victim && team.includes(victim)) return undefined;
    const notable = notableOf(kind, loot, victim ? rankOf(victim) : 0, r);
    const inc: Incident = { id: `${g.address.slice(g.address.lastIndexOf(":") + 1)}/${date}/${kind}`, kind, date, block, gang: g.address, culprits: team, victim, at, loot, items, notable };
    for (const p of team) { l.at.set(`${p}|${date}|${block}`, { inc, role: "culprit" }); note(p, inc); }
    if (kind === "robbery" && victim) l.at.set(`${victim}|${date}|${block}`, { inc, role: "victim" });
    if (victim) note(victim, inc);
    judge(town, P, l, inc, r, j, gaol, addStatus, g);
    // The morning after a break-in or a robbery, the victim goes to the watch.
    if (victim && ["burglary", "robbery", "horse", "smash"].includes(kind) && watchHouses.length && r.chance(0.7)) {
      const home = town.parentOf(town.parentOf(victim)!)!;
      const wh = nearestBuilding(town, home, ["watch_house"]);
      if (wh) addStatus(victim, { from: j + 1, to: j + 2, blocks: ["forenoon"], where: wh, doing: `at the watch house, telling the watch what was taken, and describing the culprits, badly`, kind: "report" });
    }
    // And for a night or two after, they stay in with the door barred.
    if (victim && ["burglary", "robbery", "smash"].includes(kind)) {
      const home = town.parentOf(town.parentOf(victim)!)!;
      addStatus(victim, { from: j + 1, to: j + 3, blocks: ["evening"], where: home, doing: kind === "robbery" ? "at home, still shaken from the lane; not going out after dark again soon" : "at home with the door barred and a cudgel by the bed", kind: "report" });
    }
    return inc;
  }

  function rankOf(p: Address): number {
    return town.registry<Tier>("tiers").find(town.get(town.parentOf(p)!).get<string>("tier"))?.rank ?? 3;
  }
}

function notableOf(kind: string, loot: number, rank: number, r: Rng): boolean {
  switch (kind) {
    case "burglary": case "robbery": case "horse": case "smash": case "killing": return true;
    case "cutpurse": case "pickpocket": return loot >= 60 || rank >= 8;
    case "dice": return loot >= 240;
    case "crossbite": return r.chance(0.15);
    case "smuggle": return r.chance(0.2);
    case "coin": return r.chance(0.25);
    case "linen": return rank >= 7;
  }
  return false;
}

/** Catch the culprit, or not, and see what the law does with them. */
function judge(town: Town, P: Prep, l: Ledger, inc: Incident, r: Rng, j: number, gaol: Address | undefined,
  addStatus: (p: Address, s: Status) => void, g?: Gang): void {
  const W = world(town)!;
  const C = content.crimes[inc.kind];
  const L = content.levels[W.level];
  const ward = inc.at.startsWith("place:") ? undefined : P.wardOf.get(inc.at);
  const v = ward === undefined ? 3 : P.value[ward] ?? 3;
  let p = C.catch * L.catch * (P.hasWatch ? 1 : 0.7) * (v <= 1 ? 0.7 : v >= 5 ? 1.3 : 1);
  if (g?.paid.length) p *= 0.5;
  if (g?.informers.length) p *= 1.3;
  // The hotter the crew, the more the watch is out looking; but a nose's own
  // jobs are let go, because he's worth more free.
  if (g) p *= 1 + 0.12 * (l.heat.get(g.address) ?? 0);
  if (g && inc.culprits.every((c) => g.informers.includes(c))) p *= 0.25;
  const felony = FELONY.has(C.offence) || (C.offence === "theft" && inc.loot >= 12);
  const who = inc.culprits[inc.culprits.length - 1];
  const dateOf = (k: number) => formatDate(fromJdn(k));
  const lowAt = g?.den;
  if (!r.chance(p)) {
    // Not caught. After a felony they lie low at the den a few nights.
    if (felony && lowAt) for (const c of inc.culprits) addStatus(c, { from: j + 1, to: j + 3, blocks: ["evening", "night"], where: lowAt, doing: "lying low upstairs at the den till the hue and cry dies down", kind: "low" });
    // A few run for the church before the hue and cry can take them.
    if (felony && r.chance(0.015)) {
      const home = town.parentOf(town.parentOf(who)!)!;
      const church = nearestBuilding(town, home, PARISH);
      if (church) {
        inc.sanctuary = { church, date: dateOf(j + 1) };
        addStatus(who, { from: j + 1, to: j + 41, where: church, doing: "in sanctuary, sleeping in the church porch; the watch waits outside the door", kind: "sanctuary" });
        addStatus(who, { from: j + 41, to: Infinity, where: "place:away", doing: "abjured the realm: walked to the coast in sackcloth, never to come back", kind: "away" });
        l.free.set(who, Infinity);
      }
    }
    return;
  }
  const caughtJ = j + (r.chance(0.5) ? 1 : r.int(1, 12));
  const q = (() => {
    const t = W.thiefTaker;
    if (t && r.chance(0.4)) return t;
    const quarter = ward === undefined ? undefined : town.settlement().get<MapData>("map").wards?.[ward]?.quarter;
    const o = P.officers.find((x) => x.office === "constable" && x.quarter === quarter) ?? P.officers.find((x) => x.office === "beadle" && x.ward === ward) ?? P.officers.find((x) => x.office === "marshal");
    return o?.p;
  })();
  inc.caught = { date: dateOf(caughtJ), who, ...(q ? { by: q } : {}) };
  const held = gaol ?? "place:away";
  const can = (town.get(who).get<string | null>("character.letters") ?? "").match(/cannot|too young/) === null;
  const male = town.get(who).get("sex") === "m";
  if (!felony) {
    const outcome = C.offence === "cheating" ? { id: "pillory", text: content.cheating } : r.weighted(content.petty, (x) => x.weight);
    addStatus(who, { from: caughtJ, to: caughtJ + 1, where: held, doing: `held overnight for ${C.charge}`, kind: "gaol" });
    if (outcome.id === "pillory" || outcome.id === "stocks") addStatus(who, { from: caughtJ + 1, to: caughtJ + 2, blocks: ["forenoon", "afternoon"], where: "place:market", doing: `${outcome.text}, for ${C.charge}`, kind: "pillory" });
    if (outcome.id === "whipped") addStatus(who, { from: caughtJ + 1, to: caughtJ + 2, blocks: ["forenoon"], where: "place:streets", doing: `${outcome.text}, for ${C.charge}`, kind: "whipped" });
    inc.fate = { felony: false, text: outcome.text, outcome: outcome.id, on: dateOf(caughtJ + 1) };
    l.free.set(who, Math.max(l.free.get(who) ?? -Infinity, caughtJ + 2));
    return;
  }
  // A felony waits for the king's justices; a place without assizes sends its felons to the county gaol.
  const y = fromJdn(caughtJ).y;
  const assizes = [...visitsIn(town, y), ...visitsIn(town, y + 1)].filter((x) => x.kind === "assize" && jdn(parseDate(x.start)) >= caughtJ + 3).map((x) => jdn(parseDate(x.start)));
  const trial = assizes.length ? assizes[0] + 1 : caughtJ + r.int(30, 120);
  const where = assizes.length ? held : "place:away";
  addStatus(who, { from: caughtJ, to: trial + 1, where, doing: assizes.length ? `in irons in the gaol, awaiting the assizes for ${C.charge}` : `taken to the county gaol, to await the king's justices, for ${C.charge}`, kind: "gaol" });
  let out: { id: string; text: string };
  if (C.offence === "murder" || C.offence === "coining") out = r.chance(0.7) ? content.assize.find((x) => x.id === "hanged")! : content.assize.find((x) => x.id === "acquitted")!;
  else if (male && can && r.chance(0.8)) out = { id: "clergy", text: content.clergy };
  else out = r.weighted(content.assize.filter((x) => x.id !== "elevenpence" || C.offence === "theft"), (x) => x.weight);
  inc.fate = { felony: true, text: out.text, outcome: out.id, on: dateOf(trial) };
  if (out.id === "hanged") {
    addStatus(who, { from: trial + 1, to: Infinity, where: "place:grave", doing: `hanged at the assizes on ${dateOf(trial)} for ${C.charge}; buried outside the churchyard wall`, kind: "dead" });
    l.free.set(who, Infinity);
  } else {
    if (out.id === "elevenpence") addStatus(who, { from: trial, to: trial + 1, blocks: ["afternoon"], where: "place:streets", doing: "whipped at the cart's tail through the town", kind: "whipped" });
    l.free.set(who, Math.max(l.free.get(who) ?? -Infinity, trial + 2));
  }
}

// ---- talk -----------------------------------------------------------------

const BLOCK_ORDER = Object.fromEntries(BLOCKS.map((b, i) => [b, i]));

/** Rumours from the crime calendar: notable crimes, arrests and sentences. For gossip's rumourSources. */
export function crimeRumours(town: Town, year: number): Rumour[] {
  const W = world(town);
  if (!W) return [];
  const out: Rumour[] = [];
  const name = (a: Address | undefined) => (a ? town.label(a) : "someone");
  const gangName = (a: Address | undefined) => (a ? W.byAddress.get(a)?.name ?? "a crew" : "someone");
  // Arrests and sentences can land in this year from last year's crimes.
  const pool = [...incidentsIn(town, year - 1), ...incidentsIn(town, year)];
  for (const inc of pool) {
    const r = town.rngFor(town.root, self, `talk:${inc.id}`);
    const C = content.crimes[inc.kind];
    const where = inc.at.startsWith("place:") ? (inc.at === "place:market" ? "the market" : "the waterside") : town.label(inc.at).replace(/^The /, "the ");
    const fill = (t: string, extra: Record<string, string> = {}) => t
      .replace(/\{items\}/g, inc.items).replace(/\{loot\}/g, lsd(inc.loot)).replace(/\{more\}/g, lsd(Math.max(inc.loot * 4, inc.loot + 24))).replace(/\{where\}/g, where).replace(/\{crew\}/g, gangName(inc.gang))
      .replace(/\{death\}/g, inc.death ?? "found dead").replace(/\{crime\}/g, C.charge).replace(/\{who\}/g, "{b}").replace(/\{fate\}/g, extra.fate ?? "");
    const wrong = inc.victim ? neighbourOf(town, inc.victim, r) : undefined;
    const origin = inc.at.startsWith("place:") ? "place:green" : inc.at;
    const late = inc.block === "night" || inc.block === "late_night";
    const found = hourOf(inc.date, inc.block) + (inc.block === "night" ? 9 : inc.block === "late_night" ? 5 : 1);
    const make = (id: string, kind: Rumour["kind"], topic: string, start: number, tpl: [string, string, string], who: Rumour["who"], about: Address[], extra?: Record<string, string>) => {
      if (fromJdn(Math.floor(start / 24)).y !== year) return;
      const t = tpl.map((x) => fill(x, extra)) as [string, string, string];
      const txt = t.map((x) => tidy(x.replace(/\{a\}/g, name(who?.a)).replace(/\{b\}/g, name(who?.b)).replace(/\{c\}/g, name(who?.c)))) as [string, string, string];
      out.push({ id, kind, topic, start, origin, texts: txt, tpl: t, who, about, lastToKnow: [], ...(kind === "news" ? { how: late ? "found in the morning" : "seen and shouted about" } : {}) });
    };
    if (inc.notable && content.talk[inc.kind]) {
      make(`crime/${inc.id}`, "news", `crime:${inc.kind}`, found, content.talk[inc.kind], { ...(inc.victim ? { a: inc.victim } : {}), ...(wrong ? { c: wrong } : {}) }, inc.victim ? [inc.victim] : []);
    }
    if (inc.caught && (inc.fate?.felony || inc.notable)) {
      const at = hourOf(inc.caught.date, "forenoon");
      make(`arrest/${inc.id}`, "news", "crime:arrest", at, content.talk.arrest, { b: inc.caught.who, ...(wrong ? { c: wrong } : {}) }, [inc.caught.who]);
    }
    if (inc.fate && (inc.fate.felony || inc.fate.outcome === "pillory")) {
      make(`sentence/${inc.id}`, inc.fate.felony ? "official" : "news", "crime:sentence", hourOf(inc.fate.on, "afternoon"), content.talk.sentence, { b: inc.caught!.who }, [inc.caught!.who], { fate: inc.fate.text });
    }
  }
  return out.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
}

export { BLOCK_ORDER };
