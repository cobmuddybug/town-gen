import { addDays, describeDate, formatDate, jdn, parseDate } from "../../core/calendar";
import { data } from "../../core/content";
import type { Rng } from "../../core/rng";
import type { Town } from "../../core/town";
import type { Module, PanelRow } from "../../core/types";
import type { Row } from "../../core/registry";
import type { NameProvider } from "../names";
import visitorsYaml from "./content/visitors.yaml";

// Visitors to the hamlet (LF pp.76-77). Like routines, visits are pure
// functions of the settlement and the year: nothing is stored, and any year
// can be asked about.

interface VisitorData {
  decrees: string[];
  band_kinds: string[];
  troupe_kinds: string[];
  mountebank_wares: string[];
  tinker_wares: string[];
}
export const visitorContent = data<VisitorData>(visitorsYaml);

export type VisitKind = "tax" | "herald" | "players" | "mountebank" | "band" | "tinkers" | "thefts" | "friar" | "fair" | (string & {});

/** Other modules add visits by registering a source (e.g. the manor's bailiff). */
export interface VisitSource extends Row {
  label: Record<string, string>;
  visits(town: Town, year: number): Visit[];
}

export interface Visit {
  kind: VisitKind;
  start: string;
  days: number;
  who: string;
  note: string;
  /** the travelling band broke its own five-year rule */
  tooSoon?: { last: number };
  /** thefts: which tinker visit came before */
  after?: string;
  /** the fair is held here, not elsewhere */
  local?: boolean;
}

const STOLEN = ["a cloak", "a ham from the rafters", "a good knife", "two hens", "a copper pot", "a pair of shears", "linen off a hedge", "a spade", "a purse from under a mattress"];

const LABEL: Record<string, string> = {
  tax: "Tax collector", herald: "Herald", players: "Strolling players", mountebank: "Mountebank",
  band: "Travelling folk", tinkers: "Tinkers", thefts: "Thefts", friar: "Wandering friar", fair: "Fair day",
  assize: "Assizes",
};

const urban = (town: Town) => /town|city/.test(town.settlement().get<string>("sizeClass"));

/** The epoch the band history is walked from. Arbitrary; changing it changes every band. */
const EPOCH = 1100;

const rngFor = (town: Town, purpose: string) => town.rngFor(town.root, visitors, purpose);
const names = (town: Town) => town.registry<NameProvider>("nameProviders").get("anglo-norman");

function person(town: Town, r: Rng): string {
  const p = names(town);
  return `${p.given(r, { sex: "m" })} ${p.family(r, { settlement: "" }).name}`;
}

function dayIn(r: Rng, y: number, from: [number, number], to: [number, number]): string {
  const a = jdn({ y, m: from[0], d: from[1] }), b = jdn({ y, m: to[0], d: to[1] });
  return addDays(formatDate({ y, m: from[0], d: from[1] }), r.int(0, b - a));
}

/** The district's travelling bands, the same for every year. */
function bands(town: Town): string[] {
  const r = rngFor(town, "bands");
  const out: string[] = [];
  for (let i = 0; i < 6; i++) out.push(`${names(town).family(r, { settlement: "" }).name.replace(/^of /, "")}'s band of ${r.pick(visitorContent.band_kinds)}`);
  return out;
}

const bandMemo = new WeakMap<Town, Map<number, { band: number; tooSoon?: number } | null>>();

/** Which band (if any) comes in a year, honouring "no more than once in five years", mostly. */
function bandFor(town: Town, year: number): { band: number; tooSoon?: number } | null {
  let memo = bandMemo.get(town);
  if (!memo) bandMemo.set(town, (memo = new Map()));
  if (memo.has(year)) return memo.get(year)!;
  const last = new Map<number, number>();
  let result: { band: number; tooSoon?: number } | null = null;
  for (let y = EPOCH; y <= year; y++) {
    const cached = memo.get(y);
    let v: { band: number; tooSoon?: number } | null;
    if (cached !== undefined) v = cached;
    else {
      const r = rngFor(town, `band:${y}`);
      v = null;
      if (r.chance(0.55)) {
        const fresh = [0, 1, 2, 3, 4, 5].filter((b) => !last.has(b) || y - last.get(b)! >= 5);
        const recent = [0, 1, 2, 3, 4, 5].filter((b) => last.has(b) && y - last.get(b)! < 5);
        if (recent.length && r.chance(0.08)) {
          const b = r.pick(recent);
          v = { band: b, tooSoon: last.get(b)! };
        } else if (fresh.length) v = { band: r.pick(fresh) };
      }
      memo.set(y, v);
    }
    if (v) last.set(v.band, y);
    if (y === year) result = v;
  }
  return result;
}

export function visitsIn(town: Town, year: number): Visit[] {
  const out = coreVisits(town, year);
  for (const src of town.registry<VisitSource>("visitSources").list()) out.push(...src.visits(town, year));
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

function coreVisits(town: Town, year: number): Visit[] {
  const out: Visit[] = [];
  const c = visitorContent;
  // The sheriff's man: the same man for seven years or so.
  const term = Math.floor((year - EPOCH) / 7);
  const collector = person(town, rngFor(town, `collector:${term}`));
  const rt = rngFor(town, `tax:${year}`);
  const town_ = urban(town);
  out.push({ kind: "tax", start: dayIn(rt, year, [9, 25], [10, 20]), days: 2, who: `${collector}, the sheriff's man`, note: town_ ? "takes the town's farm, its yearly due to the king, from the chamberlain" : "collects what is owed, and hears the cases that waited for him" });
  if (rt.chance(0.5)) out.push({ kind: "tax", start: dayIn(rt, year, [4, 10], [5, 10]), days: 1, who: `${collector}, the sheriff's man`, note: town_ ? "the half-year's farm, and complaints about it" : "the half-year's dues" });
  if (town_) {
    // The king's justices come twice a year for what the town's courts may not hear (LF p.86).
    const ra = rngFor(town, `assize:${year}`);
    const justice = person(town, rngFor(town, `justice:${Math.floor((year - EPOCH) / 4)}`));
    out.push({ kind: "assize", start: dayIn(ra, year, [3, 1], [3, 25]), days: ra.int(3, 6), who: `Sir ${justice}, the king's justice`, note: "the Lent assizes at the court house: felonies, and the gaol emptied one way or the other" });
    out.push({ kind: "assize", start: dayIn(ra, year, [7, 10], [8, 5]), days: ra.int(3, 6), who: `Sir ${justice}, the king's justice`, note: "the summer assizes at the court house" });
  }

  const rh = rngFor(town, `herald:${year}`);
  if (rh.chance(0.35)) out.push({ kind: "herald", start: dayIn(rh, year, [1, 15], [11, 30]), days: 1, who: `a herald from ${names(town).place(rh)}`, note: `proclaiming ${rh.pick(c.decrees)}` });

  const rp = rngFor(town, `players:${year}`);
  if (rp.chance(0.75)) out.push({ kind: "players", start: dayIn(rp, year, [5, 1], [9, 15]), days: rp.int(2, 4), who: `${person(town, rp)}'s company`, note: rp.pick(c.troupe_kinds) + (urban(town) ? ", in the inn yards" : "") });

  const rm = rngFor(town, `mountebank:${year}`);
  if (rm.chance(0.6)) {
    const doctor = person(town, rm);
    out.push({ kind: "mountebank", start: dayIn(rm, year, [4, 1], [9, 30]), days: rm.int(2, 3), who: `"Doctor" ${doctor}, with ${rm.int(3, 6)} wagons`, note: `${rm.pick(c.mountebank_wares)}; a fortune-teller, tumblers, shills and hangers-on` });
  }

  const b = bandFor(town, year);
  if (b) {
    const rb = rngFor(town, `band-date:${year}`);
    out.push({ kind: "band", start: dayIn(rb, year, [4, 15], [10, 15]), days: rb.int(3, 7), who: bands(town)[b.band], note: urban(town) ? "camped outside the gates" : "camped on the common", ...(b.tooSoon ? { tooSoon: { last: b.tooSoon } } : {}) });
  }

  const rk = rngFor(town, `tinkers:${year}`);
  const nt = rk.int(2, 4);
  for (let i = 0; i < nt; i++) {
    const start = dayIn(rk, year, [1, 1], [12, 20]);
    const family = names(town).family(rk, { settlement: "" }).name.replace(/^of /, "");
    out.push({ kind: "tinkers", start, days: rk.int(1, 2), who: `the ${family} tinkers`, note: rk.pick(c.tinker_wares) });
    // They keep their hands clean while they're here, and come back later (LF p.77).
    if (rk.chance(0.4)) out.push({ kind: "thefts", start: addDays(start, rk.int(14, 45)), days: 1, who: "someone, at night", note: `things missing from ${rk.int(2, 5)} houses: ${rk.shuffle(STOLEN).slice(0, 3).join(", ")}`, after: start });
  }

  const shrineOnly = !town.children(town.root, "building").some((x) => x.get("use") === "chapel");
  if (shrineOnly) {
    const rf = rngFor(town, `friar:${year}`);
    for (let d = rf.int(0, 30); d < 365; d += rf.int(30, 50)) {
      out.push({ kind: "friar", start: addDays(formatDate({ y: year, m: 1, d: 1 }), d), days: 1, who: `Brother ${names(town).given(rf, { sex: "m" })}`, note: "says mass at the shrine, hears confessions, begs a meal" });
    }
  }

  const rfair = rngFor(town, "fair");
  const fairTown = names(town).place(rfair);
  const fairDay = dayIn(rfair, year, [7, 20], [9, 10]);
  if (urban(town)) {
    // A town holds its own fair, by charter, on its saint's day.
    const ded = Object.values(town.settlement().get<Record<number, string> | undefined>("dedications") ?? {})[0] ?? "St Giles";
    out.push({ kind: "fair", start: fairDay, days: 3, who: `${ded}'s fair`, note: "booths in the market and outside the gates, merchants from far off, and pickpockets from further", local: true });
  } else out.push({ kind: "fair", start: fairDay, days: 1, who: `the fair at ${fairTown}`, note: "half the hamlet walks there and back" });
  return out;
}

const onMemo = new WeakMap<Town, Map<string, Visit[]>>();

export function visitorsOn(town: Town, date: string): Visit[] {
  let memo = onMemo.get(town);
  if (!memo) onMemo.set(town, (memo = new Map()));
  const hit = memo.get(date);
  if (hit) return hit;
  const found = computeVisitorsOn(town, date);
  memo.set(date, found);
  return found;
}

function computeVisitorsOn(town: Town, date: string): Visit[] {
  const y = parseDate(date).y;
  const j = jdn(parseDate(date));
  return [...visitsIn(town, y - 1), ...visitsIn(town, y)].filter((v) => {
    const s = jdn(parseDate(v.start));
    return j >= s && j < s + v.days;
  });
}

export function visitLabel(town: Town, v: Visit): string {
  if (LABEL[v.kind]) return LABEL[v.kind];
  for (const src of town.registry<VisitSource>("visitSources").list()) if (src.label[v.kind]) return src.label[v.kind];
  return v.kind;
}

export const visitors: Module = {
  id: "visitors",
  version: "1.0.0",
  requires: ["core", "names", "uses"],
  provides: ["visitSources"],
  panels: [
    {
      id: "visitors",
      title: "Visitors this year",
      for: "settlement",
      order: 3,
      rows(town) {
        const date = town.clock.date;
        const y = parseDate(date).y;
        const now = visitorsOn(town, date);
        return visitsIn(town, y).map((v): PanelRow => ({
          label: v.start.slice(5).replace("-", "/"),
          value: `${now.some((x) => x.start === v.start && x.kind === v.kind) ? "▸ here now — " : ""}${visitLabel(town, v)}: ${v.who} — ${v.note}`,
          hint: v.tooSoon ? `back after only ${y - v.tooSoon.last} years` : describeDate(v.start),
        }));
      },
    },
  ],
};
