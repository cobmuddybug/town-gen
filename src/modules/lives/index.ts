// Life goes on: from the day the town is made (Michaelmas 1203), the years
// bring births, deaths, weddings and funerals, and now and then a fire, a
// flood or a sickness. Like the crime calendar, a pure function of the seed,
// worked forward year by year and remembered, so the clock moves freely.
import { addDays, feastOn, fromJdn, formatDate, jdn, parseDate, weekday, type Block } from "../../core/calendar";
import type { Address } from "../../core/address";
import type { Town } from "../../core/town";
import type { Module, PanelRow } from "../../core/types";
import { isUrban } from "../core";
import type { NameProvider } from "../names";
import { capacityOf, isStreetPlan, nearestBuilding, type MapData } from "../layout";
import { centroid, dist, type Poly, type Pt } from "../layout/geom";
import { hourOf, type Rumour, type RumourSource } from "../gossip";
import type { RoutineHook } from "../routines";

/** The day the town was made: nothing happens to its people before it. */
export const START = "1203-10-01";
const startJ = jdn(parseDate(START));

export type LifeKind = "death" | "birth" | "wedding" | "fire" | "flood" | "sickness";
export interface LifeEvent {
  id: string;
  kind: LifeKind;
  date: string;
  /** the dead, the mother, the bride and groom */
  who: Address[];
  /** a birth: the child's name and sex */
  child?: { name: string; sex: "m" | "f" };
  cause?: string;
  /** a fire or flood: the buildings it took */
  buildings?: Address[];
  /** where it happened, for talk */
  at?: Address;
}

interface Ledger { last: number; events: Map<number, LifeEvent[]>; dead: Map<Address, number>; married: Set<Address>; burnt: Map<Address, number> }
const ledgers = new WeakMap<Town, Ledger>();

// The chance of dying in a year, by age; the sickly and the drinkers worse.
function mortality(age: number): number {
  return age < 1 ? 0.15 : age < 5 ? 0.04 : age < 15 ? 0.01 : age < 40 ? 0.012 : age < 60 ? 0.025 : age < 70 ? 0.06 : 0.15;
}
const CAUSES: [number, string][] = [[0, "a fever that took the child in three days"], [5, "the bloody flux"], [15, "a fall from a ladder"], [15, "a fever"],
  [15, "childbed"], [30, "a wound that festered"], [40, "a growth in the belly"], [50, "a seizure, sudden, at table"], [60, "old age, in bed, with the priest"], [60, "the winter cough"]];

function people(town: Town) {
  const out: { a: Address; age: number; sex: string; role: string; health: string; hh: Address; home: Address; marital: string }[] = [];
  for (const b of town.children(town.root, "building")) for (const h of town.children(b.address, "household")) for (const p of town.children(h.address, "person")) {
    out.push({ a: p.address, age: p.generated<number>("age"), sex: p.generated<string>("sex"), role: p.generated<string>("role"), health: p.generated<string>("character.health") ?? "", hh: h.address, home: b.address, marital: p.generated<string>("marital") });
  }
  return out;
}

function ledger(town: Town): Ledger {
  let l = ledgers.get(town);
  if (!l) ledgers.set(town, (l = { last: 1202, events: new Map(), dead: new Map(), married: new Set(), burnt: new Map() }));
  return l;
}

/** Every life event in a year (from Michaelmas 1203 on). */
export function lifeIn(town: Town, year: number): LifeEvent[] {
  if (year < 1203) return [];
  town.society();
  const l = ledger(town);
  while (l.last < year) { l.last++; l.events.set(l.last, workYear(town, l, l.last)); }
  return l.events.get(year) ?? [];
}

function workYear(town: Town, l: Ledger, year: number): LifeEvent[] {
  const out: LifeEvent[] = [];
  const all = people(town);
  const names = town.registry<NameProvider>("nameProviders").get("anglo-norman");
  const first = Math.max(startJ, jdn({ y: year, m: 1, d: 1 })), last = jdn({ y: year, m: 12, d: 31 });
  if (first > last) return out;
  const frac = (last - first + 1) / 365;
  const alive = (a: Address, j: number) => (l.dead.get(a) ?? Infinity) > j;
  // A sickness year: deaths among the young and the old run three times over for two months.
  const rs = town.rngFor(town.root, lives, `sickness:${year}`);
  const sickness = rs.chance(0.06) ? { from: rs.int(first, Math.max(first, last - 60)), cause: rs.pick(["the sweating sickness", "the bloody flux", "a spotted fever", "the throat sickness"]) } : undefined;
  if (sickness) out.push({ id: `sickness/${year}`, kind: "sickness", date: formatDate(fromJdn(sickness.from)), who: [], cause: sickness.cause });

  for (const p of all) {
    const r = town.rngFor(p.a, lives, `year:${year}`);
    const age = p.age + (year - 1203);
    if (!alive(p.a, first)) continue;
    let q = mortality(age) * frac;
    if (/sickly|frail|fits/.test(p.health)) q *= 2;
    if (/drinks/.test(p.health)) q *= 1.3;
    if (r.chance(q)) {
      let j = r.int(first, last);
      let cause = [...CAUSES].reverse().find(([min, c]) => age >= min && (c !== "childbed" || p.sex === "f"))?.[1] ?? "a fever";
      if (sickness && (age < 10 || age >= 55) && r.chance(0.5)) { j = sickness.from + r.int(0, 60); cause = sickness.cause; }
      if (j > last) j = last;
      l.dead.set(p.a, j);
      out.push({ id: `death/${p.a}/${year}`, kind: "death", date: formatDate(fromJdn(j)), who: [p.a], cause, at: p.home });
      continue;
    }
    // A wife under forty-three gives birth about one year in three.
    if (p.sex === "f" && p.role === "spouse" && age >= 16 && age <= 42 && r.chance(0.3 * frac)) {
      const j = r.int(first, last);
      const sex = r.chance(0.5) ? "m" : "f";
      out.push({ id: `birth/${p.a}/${year}`, kind: "birth", date: formatDate(fromJdn(j)), who: [p.a], child: { name: names.given(r, { sex }), sex }, at: p.home });
    }
  }
  // Weddings: the betrothed within the year, and some of the couples courting openly.
  for (const e of town.edges().filter((x) => (x.kind === "betrothed" || (x.kind === "courting" && x.knownBy === "public")) && x.from.includes("/building:"))) {
    if (l.married.has(e.from) || l.married.has(e.to)) continue;
    const r = town.rngFor(e.from, lives, `wedding:${year}`);
    if (!r.chance(e.kind === "betrothed" ? 0.8 : 0.3)) continue;
    // Not in Lent or Advent, not on a Friday: the church won't have it.
    let j = r.int(first, last);
    for (let k = 0; k < 40; k++, j++) {
      const d = formatDate(fromJdn(j));
      const md = d.slice(5);
      const lent = feastOn(d)?.name === "Ash Wednesday" || (md >= "02-15" && md <= "04-10");
      if (!lent && !(md >= "11-27") && weekday(d) !== 5 && j <= last) break;
    }
    if (j > last || !alive(e.from, j) || !alive(e.to, j)) continue;
    l.married.add(e.from); l.married.add(e.to);
    out.push({ id: `wedding/${e.id}/${year}`, kind: "wedding", date: formatDate(fromJdn(j)), who: [e.from, e.to], at: town.parentOf(town.parentOf(e.to)!)! });
  }
  // Fire: a town burns now and then; a village less, being further apart.
  const rf = town.rngFor(town.root, lives, `fire:${year}`);
  if (isStreetPlan(town) && rf.chance(isUrban(town) ? 0.1 : 0.05)) {
    const bs = town.children(town.root, "building");
    const origin = bs[rf.int(0, bs.length - 1)];
    const at = centroid(origin.get<Poly>("poly"));
    const reach = rf.range(18, isUrban(town) ? 45 : 30);
    const took = bs.filter((b) => dist(centroid(b.get<Poly>("poly")), at) < reach && !/fane|temple|chapel|castle|gatehouse/.test(b.get<string>("use"))).slice(0, 24).map((b) => b.address);
    const j = rf.int(first, last);
    for (const b of took) l.burnt.set(b, j);
    out.push({ id: `fire/${year}`, kind: "fire", date: formatDate(fromJdn(j)), who: [], buildings: took, at: origin.address, cause: rf.pick(["a cookshop oven", "a candle in a thatched loft", "a smith's sparks", "a drunk with a lantern", "nobody knows; some say it was set"]) });
  }
  // Flood: where the river runs under the walls.
  const rv = town.rngFor(town.root, lives, `flood:${year}`);
  const map = town.settlement().get<MapData>("map");
  if (map.stream && map.terrain !== "coast" && rv.chance(0.05)) {
    const low = town.children(town.root, "building").filter((b) => {
      const c = centroid(b.get<Poly>("poly"));
      return map.stream!.points.some((pt: Pt) => dist(pt, c) < 40);
    }).slice(0, 30).map((b) => b.address);
    if (low.length) out.push({ id: `flood/${year}`, kind: "flood", date: formatDate(fromJdn(rv.int(first, last))), who: [], buildings: low, cause: "the river over its banks after a week of rain" });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
}

const dateJ = (d: string) => jdn(parseDate(d));

/** When a person died, if they have (by this date). */
export function diedOn(town: Town, p: Address, date: string): string | undefined {
  lifeIn(town, parseDate(date).y);
  const j = ledger(town).dead.get(p);
  return j !== undefined && j <= dateJ(date) ? formatDate(fromJdn(j)) : undefined;
}

/** When a building burnt, if it has and isn't rebuilt yet (rebuilding takes nine months). */
export function burntSince(town: Town, b: Address, date: string): string | undefined {
  lifeIn(town, parseDate(date).y);
  const j = ledger(town).burnt.get(b);
  return j !== undefined && j <= dateJ(date) && dateJ(date) - j < 270 ? formatDate(fromJdn(j)) : undefined;
}

/** Events between two dates. */
export function lifeBetween(town: Town, from: string, to: string): LifeEvent[] {
  const out: LifeEvent[] = [];
  for (let y = parseDate(from).y; y <= parseDate(to).y; y++) out.push(...lifeIn(town, y).filter((e) => e.date >= from && e.date <= to));
  return out;
}

// ---- where people are -----------------------------------------------------

interface DayIndex { births: Map<Address, LifeEvent>; weddings: Map<Address, LifeEvent>; funerals: Map<Address, LifeEvent> }
const dayMemo = new WeakMap<Town, Map<string, DayIndex>>();
/** Who is lying in, being married or burying someone on a date: an index, made once a day. */
function dayIndex(town: Town, date: string): DayIndex {
  let m = dayMemo.get(town);
  if (!m) dayMemo.set(town, (m = new Map()));
  const hit = m.get(date);
  if (hit) return hit;
  const ix: DayIndex = { births: new Map(), weddings: new Map(), funerals: new Map() };
  for (const e of lifeBetween(town, addDays(date, -14), date)) {
    if (e.kind === "birth") ix.births.set(e.who[0], e);
    if (e.kind === "wedding" && e.date === date) for (const w of e.who) ix.weddings.set(w, e);
    // The day after a death, the household follows the coffin to church.
    if (e.kind === "death" && dateJ(date) - dateJ(e.date) === 1) ix.funerals.set(town.parentOf(e.who[0])!, e);
  }
  m.set(date, ix);
  if (m.size > 30) m.delete(m.keys().next().value!);
  return ix;
}

function lifeAt(town: Town, person: Address, date: string, block: Block): { where: string; doing: string } | undefined {
  if (date < START) return undefined;
  const died = diedOn(town, person, date);
  if (died) return { where: "place:grave", doing: died === date ? "dead this day; laid out at home, the women sitting with the body" : `dead since ${died}, and buried in the churchyard` };
  const home = town.parentOf(town.parentOf(person)!)!;
  const ix = dayIndex(town, date);
  const church = () => nearestBuilding(town, home, ["fane", "temple", "chapel", "grand_temple"]) ?? home;
  const b = ix.births.get(person);
  if (b) return { where: home, doing: `lying in after the birth of ${b.child!.sex === "m" ? "a son" : "a daughter"}, ${b.child!.name}` };
  const w = ix.weddings.get(person);
  if (w) {
    if (block === "forenoon") return { where: church(), doing: "being married at the church door, then the nuptial mass" };
    if (block === "afternoon" || block === "evening") return { where: w.at!, doing: "at the wedding feast, being toasted and teased" };
  }
  const f = ix.funerals.get(town.parentOf(person)!);
  if (f && block === "forenoon") return { where: church(), doing: `at the funeral of ${town.label(f.who[0])}` };
  // Burnt out: the family lodges with kin, or wherever will take them.
  const burnt = burntSince(town, home, date);
  if (burnt && (block === "evening" || block === "night" || block === "late_night" || block === "morning")) {
    const kin = town.edges({ touching: person, kind: "kin" }).map((x) => (x.from === person ? x.to : x.from)).find((x) => x.includes("/building:") && !burntSince(town, town.parentOf(town.parentOf(x)!)!, date));
    const where = kin ? town.parentOf(town.parentOf(kin)!)! : "place:streets";
    return { where, doing: kin ? `lodging with ${town.label(kin)} since the fire took the house` : "sleeping where they can since the fire took the house" };
  }
  return undefined;
}

// ---- talk -------------------------------------------------------------------

function rankOf(town: Town, p: Address): number {
  const hh = town.find(town.parentOf(p) ?? "");
  return hh?.type === "household" ? town.registry<{ id: string; rank: number }>("tiers").find(hh.get<string>("tier"))?.rank ?? 3 : 3;
}
function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function lifeTalk(town: Town, year: number): Rumour[] {
  const out: Rumour[] = [];
  for (const e of lifeIn(town, year)) {
    const name = (a: Address) => town.label(a);
    let t: [string, string, string] | undefined, topic = `life:${e.kind}`;
    if (e.kind === "death" && town.get(e.who[0]).get<number>("age") >= 14) t = [`${name(e.who[0])} is dead: ${e.cause}`, `${name(e.who[0])} is dead, and the will is going to cause trouble`, `${name(e.who[0])} is dead, and some say it wasn't ${e.cause} at all`];
    // A birth is news in its own street; only a family of some standing has the whole town talking.
    if (e.kind === "birth" && rankOf(town, e.who[0]) < 6 && Math.abs(hashOf(e.id)) % 3 !== 0) continue;
    if (e.kind === "birth") t = [`${name(e.who[0])} has had ${e.child!.sex === "m" ? "a son" : "a daughter"}, ${e.child!.name}`, `${name(e.who[0])} has had ${e.child!.sex === "m" ? "a fine son" : "a fine daughter"}, and the christening ale is to be a big one`, `${name(e.who[0])} has had a child, and the neighbours are counting the months`];
    if (e.kind === "wedding") t = [`${name(e.who[0])} and ${name(e.who[1])} are married`, `${name(e.who[0])} and ${name(e.who[1])} are married, and the feast went on till dawn`, `${name(e.who[0])} and ${name(e.who[1])} are married, and not before time, they say`];
    if (e.kind === "fire") { t = [`a fire took ${e.buildings!.length} houses in the night, started by ${e.cause}`, `half a street burnt to the ground, and they say it was set`, `a fire took ${e.buildings!.length} houses; ${e.cause}, or so they say`]; topic = "life:fire"; }
    if (e.kind === "flood") t = [`the river is over its banks: ${e.buildings!.length} houses flooded`, "the river came up in the night and took the bridge, nearly", `the river is up, and the cellars by the water are full`];
    if (e.kind === "sickness") t = [`${e.cause} is in the town`, `${e.cause} is in the town, and they're burying them two a day`, `${e.cause} is in the town, brought in by strangers`];
    if (!t) continue;
    // The same tellings with the names as slots, so the panels can link the people in them.
    const a = e.who[0], b = e.who[1];
    const slots = (x: string) => (b ? x.split(name(b)).join("{b}") : x).split(a ? name(a) : "\u0000").join("{a}");
    const named = a && t.some((x) => x.includes(name(a)));
    out.push({ id: `life/${e.id}`, kind: "news", topic, start: hourOf(e.date, "evening"), origin: e.at ?? town.root, texts: t, ...(named ? { tpl: t.map(slots) as [string, string, string], who: { a, ...(b ? { b } : {}) } } : {}), about: e.who, lastToKnow: [], how: e.kind === "death" ? "the passing bell" : e.kind === "fire" ? "the whole town saw the glow" : "the neighbours" });
  }
  return out;
}

export const lives: Module = {
  id: "lives",
  version: "1.0.0",
  requires: ["core", "households", "people", "society", "layout", "names", "gossip", "routines"],
  register(add) {
    add<RoutineHook>("routineHooks", [{ id: "lives", at: lifeAt, source: "our own" }]);
    add<RumourSource>("rumourSources", [{ id: "lives", rumours: lifeTalk, source: "our own" }]);
  },
  panels: [
    {
      id: "register",
      title: "The parish register",
      for: "building",
      order: 1.2,
      rows(town, b) {
        if (!/fane|temple|chapel/.test(b.get<string>("use"))) return [];
        const date = town.clock.date;
        const rows: PanelRow[] = [];
        const ev = lifeBetween(town, START, date).slice(-60);
        const near = (a: Address | undefined) => !!a && (nearestBuilding(town, a, ["fane", "temple", "chapel", "grand_temple"]) ?? b.address) === b.address;
        for (const e of ev.reverse()) {
          if (rows.length >= 10) break;
          if (e.kind === "death" && near(e.at)) rows.push({ label: `buried ${e.date}`, value: [{ text: town.label(e.who[0]), address: e.who[0] }, `, of ${e.cause}`] });
          if (e.kind === "birth" && near(e.at)) rows.push({ label: `christened ${e.date}`, value: [`${e.child!.name}, ${e.child!.sex === "m" ? "son" : "daughter"} of `, { text: town.label(e.who[0]), address: e.who[0] }] });
          if (e.kind === "wedding" && near(e.at)) rows.push({ label: `married ${e.date}`, value: [{ text: town.label(e.who[0]), address: e.who[0] }, " and ", { text: town.label(e.who[1]), address: e.who[1] }] });
        }
        return rows;
      },
    },
    {
      id: "life-person",
      title: "Since Michaelmas 1203",
      for: "person",
      order: 1.1,
      rows(town, p) {
        const date = town.clock.date;
        if (date < START) return [];
        const rows: PanelRow[] = [];
        const years = Math.floor((dateJ(date) - dateJ("1203-09-29")) / 365.25);
        if (years >= 1) rows.push({ label: "Age now", value: `${p.get<number>("age") + years}`, hint: `${p.get<number>("age")} at Michaelmas 1203` });
        const died = diedOn(town, p.address, date);
        for (const e of lifeBetween(town, START, date)) {
          if (!e.who.includes(p.address)) continue;
          if (e.kind === "death") rows.push({ label: "Died", value: `${e.date}, of ${e.cause}` });
          if (e.kind === "birth") rows.push({ label: "Gave birth", value: `${e.date}: ${e.child!.sex === "m" ? "a son" : "a daughter"}, ${e.child!.name}` });
          if (e.kind === "wedding") { const o = e.who.find((x) => x !== p.address)!; rows.push({ label: "Married", value: [`${e.date}, to `, { text: town.label(o), address: o }] }); }
        }
        if (!died) {
          const home = town.parentOf(town.parentOf(p.address)!)!;
          const burnt = burntSince(town, home, date);
          if (burnt) rows.push({ label: "Burnt out", value: `the house burnt on ${burnt}` });
        }
        return rows;
      },
    },
    {
      id: "life-building",
      title: "Since",
      for: "building",
      order: 0.5,
      rows(town, b) {
        const burnt = burntSince(town, b.address, town.clock.date);
        return burnt ? [{ label: "Burnt", value: `on ${burnt}: a blackened shell, the family lodging with kin; rebuilding has started at the back`, hint: `room for about ${capacityOf(town, b.address)} when it stood` }] : [];
      },
    },
  ],
};
