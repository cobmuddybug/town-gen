import { BLOCKS, fromJdn, formatDate, jdn, parseDate, type Block } from "../../core/calendar";
import { data } from "../../core/content";
import type { Address } from "../../core/address";
import type { Edge, Module, PanelLink, PanelRow, Sifter } from "../../core/types";
import type { Town } from "../../core/town";
import { lsd } from "../households";
import { buildingsOfUse, isStreetPlan, type MapData } from "../layout";
import { centroid, dist, type Poly, type Pt } from "../layout/geom";
import { visitsIn } from "../visitors";
import gossipYaml from "./content/gossip.yaml";

// How news travels (LF pp.76, 93). Rumours are a pure function of the town
// and the clock, like routines: nothing is stored, so time moves freely and
// saves stay small.
//
// A rumour starts somewhere at some hour and spreads at about one block an
// hour, but only while people are awake to talk. Taverns and inns relay it
// faster across the town; criers carry official news everywhere at once.
// It grows in the telling, and far enough from where it started it has the
// wrong person in it. The people it is about hear it last.

interface GossipData {
  leak: Record<string, number>;
  fade: { secret: number; news: number; official: number };
  how: string[];
  topics: Record<string, [string, string, string]>;
  news: Record<string, string>;
  ballads: string[];
  chatter: Record<string, string>;
}
const content = data<GossipData>(gossipYaml);

export interface Rumour {
  id: string;
  kind: "secret" | "news" | "official";
  topic: string;
  /** hour index: day number * 24 + hour */
  start: number;
  origin: Address;
  /** the three tellings: truth, grown, wrong person (plain text) */
  texts: [string, string, string];
  /** the same, with {a} {b} {c} left in for links */
  tpl?: [string, string, string];
  who?: Partial<Record<"a" | "b" | "c", Address>>;
  about: Address[];
  /** the edge it lets out, for secrets */
  edge?: string;
  how?: string;
  /** people who hear it last */
  lastToKnow: Address[];
  /** the innocent who ends up in the third telling */
  wrong?: Address;
}

/** Secrets come out, if they ever do, in the five years from this one: the clock's default year. */
const REF_YEAR = 1203;
const SPEED = 90; // metres an hour: about a block
const HUB_JUMP = 4; // talk crosses town between taverns this much faster
const DRINK = ["tavern", "town_alehouse", "alehouse", "inn"];

const BLOCK_HOUR: Record<Block, number> = { morning: 6, forenoon: 10, afternoon: 14, evening: 18, night: 22, late_night: 26 };

export function hourOf(date: string, block: Block): number {
  return jdn(parseDate(date)) * 24 + BLOCK_HOUR[block];
}

export function describeHour(h: number): string {
  const d = formatDate(fromJdn(Math.floor(h / 24)));
  const hh = h % 24;
  const block = hh < 5 ? "late night" : hh < 9 ? "morning" : hh < 13 ? "forenoon" : hh < 17 ? "afternoon" : hh < 21 ? "evening" : "night";
  return `${d}, ${block}`;
}

/** Talk moves only while people are up: from 5 in the morning to 10 at night. */
function talkAdvance(start: number, hours: number): number {
  let t = start, left = hours;
  for (let guard = 0; left > 1e-9 && guard < 400; guard++) {
    const h = ((t % 24) + 24) % 24;
    if (h < 5) { t += 5 - h; continue; }
    if (h >= 22) { t += 24 - h + 5; continue; }
    const awake = 22 - h;
    if (left <= awake) return t + left;
    t += awake;
    left -= awake;
  }
  return t;
}

// ---- where things are --------------------------------------------------

const posMemo = new WeakMap<Town, Map<Address, Pt>>();
function positions(town: Town): Map<Address, Pt> {
  let m = posMemo.get(town);
  if (!m) {
    m = new Map();
    for (const b of town.children(town.root, "building")) m.set(b.address, centroid(b.get<Poly>("poly")));
    posMemo.set(town, m);
  }
  return m;
}

const buildingOf = (town: Town, a: Address) => {
  let x: Address | undefined = a;
  while (x && !/\/building:[^/]+$/.test(x)) x = town.parentOf(x);
  return x;
};

function originPoint(town: Town, origin: Address): Pt {
  const p = positions(town).get(origin);
  if (p) return p;
  const m = town.settlement().get<MapData>("map");
  return centroid(m.green);
}

// ---- making rumours ----------------------------------------------------

const yearMemo = new WeakMap<Town, Map<number, Rumour[]>>();

/** Every rumour that starts in a year. */
export function rumoursIn(town: Town, year: number): Rumour[] {
  let memo = yearMemo.get(town);
  if (!memo) yearMemo.set(town, (memo = new Map()));
  const hit = memo.get(year);
  if (hit) return hit;
  const out = [...secretsIn(town, year), ...newsIn(town, year), ...chatterIn(town, year)].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  memo.set(year, out);
  return out;
}

const secretMemo = new WeakMap<Town, Rumour[]>();

/** All the secrets that will ever come out, each at its own moment. */
export function allSecrets(town: Town): Rumour[] {
  const hit = secretMemo.get(town);
  if (hit) return hit;
  const out: Rumour[] = [];
  const day0 = jdn({ y: REF_YEAR, m: 1, d: 1 });
  for (const e of town.edges()) {
    if (e.knownBy === "public") continue;
    const r = town.rngFor(town.root, gossip, `leak:${e.id}`);
    if (!r.chance(content.leak[e.kind] ?? content.leak.default)) continue;
    // Two in five in the first year; the rest over the following four.
    const day = day0 + (r.chance(0.4) ? r.int(0, 364) : r.int(365, 365 * 5));
    const start = day * 24 + r.int(7, 20);
    const knowers = e.knownBy.length ? e.knownBy : [e.from];
    const leaker = r.pick(knowers);
    const origin = buildingOf(town, leaker) ?? "place:green";
    const topic = e.facts?.clerical ? "misdeed" : content.topics[e.kind] ? e.kind : "default";
    out.push(makeRumour(town, r, {
      id: `secret/${e.id}`, kind: "secret", topic, start, origin, edge: e.id, how: r.pick(content.how),
      a: topic === "misdeed" ? e.to : e.from, b: topic === "misdeed" ? e.from : e.to, edgeRow: e,
    }));
  }
  secretMemo.set(town, out);
  return out;
}

function secretsIn(town: Town, year: number): Rumour[] {
  return allSecrets(town).filter((x) => fromJdn(Math.floor(x.start / 24)).y === year);
}

function newsIn(town: Town, year: number): Rumour[] {
  const out: Rumour[] = [];
  const pick = (uses: string[], key: string) => {
    const l = buildingsOfUse(town, uses);
    return l.length ? l[town.rngFor(town.root, gossip, key).int(0, l.length - 1)].a : undefined;
  };
  for (const v of visitsIn(town, year)) {
    const r = town.rngFor(town.root, gossip, `news:${v.kind}:${v.start}`);
    const official = v.kind === "herald" || v.kind === "tax" || v.kind === "assize";
    // Visitors come in by the road and stop at the inn or alehouse; heralds go to the market.
    const origin = v.kind === "thefts" ? pick(["cottage", "tenement", "farmhouse", "fisher_house", "townhouse", "herder_house", "miner_house", "logger_house"], `theft:${v.start}`)
      : v.kind === "herald" ? undefined : pick(DRINK, `inn:${v.kind}:${v.start}`);
    const tpl = content.news[v.kind] ?? content.news.default;
    const text = tpl.replace("{who}", v.who).replace("{note}", v.note);
    out.push({
      id: `news/${v.kind}/${v.start}`, kind: official ? "official" : "news", topic: `visit:${v.kind}`,
      start: jdn(parseDate(v.start)) * 24 + r.int(8, 12), origin: origin ?? "place:green",
      texts: [text, text, text], about: [], lastToKnow: [],
    });
  }
  return out;
}

const CHATTER_DAYS = 4;

/** Every few days, one or two things everybody already knows come up again. */
function chatterIn(town: Town, year: number): Rumour[] {
  const known = town.edges().filter((e) => e.knownBy === "public" && content.chatter[e.kind] && e.from.includes("/building:") && e.to.includes("/building:"));
  if (!known.length) return [];
  const out: Rumour[] = [];
  const first = jdn({ y: year, m: 1, d: 1 }), last = jdn({ y: year, m: 12, d: 31 });
  const name = (a: Address) => town.label(a);
  for (let p = Math.ceil(first / CHATTER_DAYS); p * CHATTER_DAYS <= last; p++) {
    const r = town.rngFor(town.root, gossip, `chatter:${p}`);
    for (let k = 0, n = r.int(1, 2); k < n; k++) {
      const e = r.pick(known);
      const amount = typeof e.facts?.amount === "number" ? lsd(e.facts.amount as number) : "money";
      const tpl = content.chatter[e.kind].replace(/\{about\}/g, String(e.facts?.about ?? "the old business")).replace(/\{amount\}/g, amount);
      const text = tpl.replace(/\{a\}/g, name(e.from)).replace(/\{b\}/g, name(e.to));
      const hubs = buildingsOfUse(town, DRINK);
      const origin = hubs.length ? hubs[r.int(0, hubs.length - 1)].a : buildingOf(town, e.from) ?? "place:green";
      out.push({
        id: `chatter/${p}/${k}`, kind: "news", topic: `chatter:${e.kind}`, start: (p * CHATTER_DAYS + r.int(0, CHATTER_DAYS - 1)) * 24 + r.int(10, 19),
        origin, texts: [text, text, text], tpl: [tpl, tpl, tpl], who: { a: e.from, b: e.to }, about: [e.from, e.to], lastToKnow: [],
      });
    }
  }
  return out;
}

function makeRumour(town: Town, r: import("../../core/rng").Rng, o: {
  id: string; kind: Rumour["kind"]; topic: string; start: number; origin: Address; edge: string; how: string; a: Address; b: Address; edgeRow: Edge;
}): Rumour {
  const [t0, t1, t2] = content.topics[o.topic];
  const wrong = neighbourOf(town, o.a, r);
  const name = (a: Address | undefined) => (a ? town.label(a) : "someone");
  const amount = typeof o.edgeRow.facts?.amount === "number" ? lsd(o.edgeRow.facts.amount as number) : "money";
  const about = String(o.edgeRow.facts?.about ?? o.edgeRow.facts?.how ?? "an old quarrel");
  const facts = (t: string) => t.replace(/\{amount\}/g, amount).replace(/\{about\}/g, about);
  const fill = (t: string) => facts(t).replace(/\{a\}/g, name(o.a)).replace(/\{b\}/g, name(o.b)).replace(/\{c\}/g, name(wrong));
  // The ones it's about hear last: for lovers, their own husbands and wives.
  const last: Address[] = [];
  if (o.topic === "lover") for (const p of [o.a, o.b]) for (const s of town.edges({ touching: p, kind: "spouse" })) last.push(s.from === p ? s.to : s.from);
  else last.push(o.a, o.b);
  return {
    id: o.id, kind: o.kind, topic: o.topic, start: o.start, origin: o.origin, edge: o.edge, how: o.how,
    texts: [fill(t0), fill(t1), fill(t2)], tpl: [facts(t0), facts(t1), facts(t2)], who: { a: o.a, b: o.b, ...(wrong ? { c: wrong } : {}) },
    about: [o.a, o.b], lastToKnow: last, wrong,
  };
}

const gridMemo = new WeakMap<Town, Map<string, Address[]>>();
const CELL = 120;
const cellKey = (p: Pt, dx = 0, dy = 0) => `${Math.floor(p[0] / CELL) + dx},${Math.floor(p[1] / CELL) + dy}`;

/** Someone who lives near `a`, of the same sex, who had nothing to do with it. */
function neighbourOf(town: Town, a: Address, r: import("../../core/rng").Rng): Address | undefined {
  const home = buildingOf(town, a);
  if (!home) return undefined;
  let grid = gridMemo.get(town);
  if (!grid) {
    grid = new Map();
    for (const [b, p] of positions(town)) { const k = cellKey(p); const l = grid.get(k); if (l) l.push(b); else grid.set(k, [b]); }
    gridMemo.set(town, grid);
  }
  const at = positions(town).get(home)!;
  const sex = town.get(a).get("sex");
  const near: Address[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const b of grid.get(cellKey(at, dx, dy)) ?? []) {
    if (b === home || dist(positions(town).get(b)!, at) > 120) continue;
    for (const h of town.children(b, "household")) {
      const head = town.children(h.address, "person")[0];
      if (head && head.get("sex") === sex && head.get<number>("age") >= 16 && head.address !== a) near.push(head.address);
    }
  }
  near.sort();
  return near.length ? r.pick(near) : undefined;
}

// ---- spreading --------------------------------------------------------

const spreadMemo = new WeakMap<Town, Map<string, Map<Address, { at: number; telling: 0 | 1 | 2 }>>>();

/** When the rumour reaches each building, and which telling arrives there. */
export function spread(town: Town, r: Rumour): Map<Address, { at: number; telling: 0 | 1 | 2 }> {
  let memo = spreadMemo.get(town);
  if (!memo) spreadMemo.set(town, (memo = new Map()));
  const hit = memo.get(r.id);
  if (hit) return hit;
  const pos = positions(town);
  const o = originPoint(town, r.origin);
  const speed = r.kind === "official" ? SPEED * 6 : SPEED;
  // Taverns relay: once one has it, the others get it faster.
  const hubs = buildingsOfUse(town, DRINK).map((h) => ({ a: h.a, p: h.p, t: dist(o, h.p) / speed }));
  const done = new Set<number>();
  for (let k = 0; k < hubs.length; k++) {
    let best = -1;
    for (let i = 0; i < hubs.length; i++) if (!done.has(i) && (best < 0 || hubs[i].t < hubs[best].t)) best = i;
    done.add(best);
    const h = hubs[best];
    for (let i = 0; i < hubs.length; i++) if (!done.has(i)) hubs[i].t = Math.min(hubs[i].t, h.t + 1 + dist(h.p, hubs[i].p) / (speed * HUB_JUMP));
  }
  const street = isStreetPlan(town);
  const near = street ? 160 : 120, far = street ? 420 : 260;
  const out = new Map<Address, { at: number; telling: 0 | 1 | 2 }>();
  for (const [b, p] of pos) {
    let hours = dist(o, p) / speed;
    for (const h of hubs) hours = Math.min(hours, h.t + dist(h.p, p) / speed);
    const d = dist(o, p);
    const telling = r.kind !== "secret" ? 0 : d < near ? 0 : d < far ? 1 : 2;
    out.set(b, { at: talkAdvance(r.start, hours), telling });
  }
  memo.set(r.id, out);
  return out;
}

/** When a person hears a rumour (hour index), or undefined if it never reaches them. */
export function heardAt(town: Town, r: Rumour, person: Address): number | undefined {
  const p = town.get(person);
  if (p.get<number>("age") < 12) return undefined;
  // Those who held the secret knew all along.
  if (r.edge) {
    const e = town.edges({ touching: person }).find((x) => x.id === r.edge);
    if (e && (e.knownBy === "public" || e.knownBy.includes(person))) return -Infinity;
  }
  const b = buildingOf(town, person);
  const s = b ? spread(town, r).get(b) : undefined;
  if (!s) return undefined;
  let at = s.at;
  const traits = p.get<string[]>("traits") ?? [];
  if (traits.includes("gossip")) at -= 2;
  if (traits.includes("quiet") || traits.includes("pious")) at += 4;
  if (r.lastToKnow.includes(person)) at += 72;
  return Math.max(r.start, at);
}

export function knows(town: Town, r: Rumour, person: Address, now: number): boolean {
  const h = heardAt(town, r, person);
  return h !== undefined && h <= now;
}

const fadeOf = (r: Rumour) => content.fade[r.kind];

/** Rumours that are the talk of the place at this hour. */
export function talkAt(town: Town, now: number): Rumour[] {
  const y = fromJdn(Math.floor(now / 24)).y;
  return [...rumoursIn(town, y - 1), ...rumoursIn(town, y)].filter((r) => r.start <= now && now < r.start + fadeOf(r));
}

/** Rumours that have come out before now (talk or old news). */
export function outBy(town: Town, now: number): Rumour[] {
  return allSecrets(town).filter((r) => r.start <= now);
}

/** Of the households, how many have heard by now. */
export function reach(town: Town, r: Rumour, now: number): { heard: number; total: number; buildings: Address[] } {
  let heard = 0, total = 0;
  const buildings: Address[] = [];
  for (const [b, s] of spread(town, r)) {
    const n = town.children(b, "household").length;
    total += n;
    if (s.at <= now) { heard += n; if (n) buildings.push(b); }
  }
  return { heard, total, buildings };
}

/** Who knows about an edge right now: its own knownBy, plus everyone the talk has reached. */
export function knownByAt(town: Town, edge: Edge, date: string, block: Block): Address[] | "public" {
  if (edge.knownBy === "public") return "public";
  const r = allSecrets(town).find((x) => x.edge === edge.id);
  const now = hourOf(date, block);
  if (!r || r.start > now) return edge.knownBy;
  if (now >= r.start + fadeOf(r) * 3) return "public";
  const out = new Set(edge.knownBy);
  for (const e of town.allEntities()) if (e.type === "person" && e.address.includes("/building:") && knows(town, r, e.address, now)) out.add(e.address);
  return [...out];
}

/** A telling as text with the people in it as links. */
export function linked(town: Town, r: Rumour, telling: 0 | 1 | 2, suffix = ""): (string | PanelLink)[] {
  if (!r.tpl || !r.who) return [cap(r.texts[telling]) + suffix];
  const out: (string | PanelLink)[] = [];
  for (const part of r.tpl[telling].split(/(\{[abc]\})/)) {
    if (!part) continue;
    const m = /^\{([abc])\}$/.exec(part);
    const a = m ? r.who[m[1] as "a" | "b" | "c"] : undefined;
    if (m) out.push(a ? { text: town.label(a), address: a } : "someone");
    else out.push(out.length ? part : cap(part));
  }
  if (suffix) out.push(suffix);
  return out;
}

function tellingAt(town: Town, r: Rumour, b: Address | undefined, now: number, suffix = ""): (string | PanelLink)[] {
  const s = b ? spread(town, r).get(b) : undefined;
  let tail = "";
  // A big enough story gets a song in a town's taverns after a few days.
  if (r.kind === "secret" && isStreetPlan(town) && now - r.start > 120 && b && DRINK.includes(town.get(b).get("use"))) {
    tail = `; ${content.ballads[Math.abs(hash(r.id)) % content.ballads.length]}`;
  }
  return linked(town, r, s?.telling ?? 0, tail + suffix);
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

// ---- the module ---------------------------------------------------------

export const gossip: Module = {
  id: "gossip",
  version: "1.0.0",
  requires: ["core", "layout", "households", "names", "people", "society", "visitors", "routines"],
  register(add) {
    add<Sifter>("sifters", [lastToKnow, wrongName, beforeItGetsOut]);
  },
  panels: [
    {
      id: "talk-of-the-town",
      title: "Talk of the place",
      for: "settlement",
      order: 1.5,
      rows(town) {
        const now = hourOf(town.clock.date, town.clock.block as Block);
        const talk = talkAt(town, now);
        if (!talk.length) return [{ label: "Quiet", value: "nothing much being said; the usual complaints about the weather and the price of bread" }];
        return talk.map((r): PanelRow => {
          const { heard, total, buildings } = reach(town, r, now);
          return {
            label: r.kind === "official" ? "Proclaimed" : r.topic.startsWith("chatter:") ? "Talk" : r.kind === "news" ? "News" : "Rumour",
            value: linked(town, r, 0, ` — heard in ${pct(heard, total)}% of households`),
            hint: `since ${describeHour(r.start)}${r.how ? `; ${r.how}` : ""}. Hover to see where it has got to.`,
            highlight: buildings, fact: `rumour:${r.id}`,
          };
        });
      },
    },
    {
      id: "talk-here",
      title: "Talk here",
      for: "building",
      order: 3,
      rows(town, b) {
        if (!DRINK.includes(b.get<string>("use")) && b.get("use") !== "market_hall") return [];
        const now = hourOf(town.clock.date, town.clock.block as Block);
        const rows: PanelRow[] = [];
        for (const r of talkAt(town, now)) {
          const s = spread(town, r).get(b.address);
          if (!s || s.at > now) continue;
          rows.push({ label: r.kind === "secret" ? ["they say", "they say", "some say"][s.telling] : "news", value: tellingAt(town, r, b.address, now), fact: `rumour:${r.id}`, hint: s.telling === 2 ? "this telling has the wrong person in it" : s.telling === 1 ? "grown in the telling" : undefined });
        }
        return rows.length ? rows : [{ label: "Talk", value: "nothing new: the weather, the price of bread, who drank too much last night" }];
      },
    },
    {
      id: "talk-ward",
      title: "Talk in the ward",
      for: "ward",
      order: 2,
      rows(town, w) {
        const now = hourOf(town.clock.date, town.clock.block as Block);
        const idx = w.get<number>("index");
        const mine = town.children(town.root, "building").filter((b) => b.get("ward") === idx).map((b) => b.address);
        const rows: PanelRow[] = [];
        for (const r of talkAt(town, now)) {
          const sp = spread(town, r);
          const got = mine.filter((b) => sp.get(b)!.at <= now);
          if (!got.length) continue;
          const t = Math.max(...got.map((b) => sp.get(b)!.telling)) as 0 | 1 | 2;
          rows.push({ label: `${pct(got.length, mine.length)}% have heard`, value: linked(town, r, t), fact: `rumour:${r.id}`, hint: t === 2 ? "the telling here has the wrong person in it" : undefined, highlight: got });
        }
        return rows;
      },
    },
    {
      id: "has-heard",
      title: "Has heard",
      for: "person",
      order: 6,
      rows(town, p) {
        const now = hourOf(town.clock.date, town.clock.block as Block);
        const rows: PanelRow[] = [];
        const home = buildingOf(town, p.address);
        for (const r of talkAt(town, now)) {
          const h = heardAt(town, r, p.address);
          if (h === undefined || h > now) continue;
          const mine = r.about.includes(p.address);
          const about = mine ? " (it's about them)" : "";
          // Those who were in it, or knew all along, know the true story whatever the street says.
          const value = mine || h === -Infinity ? linked(town, r, 0, about) : tellingAt(town, r, home, now, about);
          rows.push({ label: h === -Infinity ? "knew all along" : `since ${describeHour(h).replace(/^\d+-/, "")}`, value, fact: `rumour:${r.id}` });
        }
        // Secrets they keep, that haven't come out.
        for (const e of town.edges({ touching: p.address })) {
          if (e.knownBy === "public" || !e.knownBy.includes(p.address)) continue;
          const r = allSecrets(town).find((x) => x.edge === e.id);
          if (r && r.start <= now) continue;
          const other = e.from === p.address ? e.to : e.from;
          rows.push({ label: "keeps quiet about", value: [{ text: town.label(other), address: other }, `: ${e.kind.replace(/_/g, " ")}`], fact: `edge:${e.id}`, hint: r ? `it will come out ${describeHour(r.start)}` : "it may never come out" });
        }
        return rows;
      },
    },
  ],
};

// ---- hooks ---------------------------------------------------------------

const clockNow = (town: Town) => hourOf(town.clock.date, town.clock.block as Block);

export const lastToKnow: Sifter = {
  id: "last-to-know",
  title: "The last to know",
  source: "LF p.93 (news spreads by the hour); our own",
  match(town) {
    const now = clockNow(town);
    const out = [];
    for (const r of outBy(town, now)) {
      if (r.topic !== "lover") continue;
      const { heard, total } = reach(town, r, now);
      if (heard / total < 0.4) continue;
      for (const s of r.lastToKnow) {
        if (knows(town, r, s, now)) continue;
        out.push({
          title: this.title,
          summary: `Half of ${town.label(town.root)} is talking about ${r.texts[0].replace(/ have been meeting in secret$/, "")}. ${town.label(s)} hasn't heard yet, and whoever tells them will matter.`,
          involves: [s, ...r.about],
        });
      }
    }
    return out;
  },
};

export const wrongName: Sifter = {
  id: "wrong-name",
  title: "The wrong name",
  source: "LF p.93 (talk grows as it travels); our own",
  match(town) {
    const now = clockNow(town);
    const out = [];
    for (const r of talkAt(town, now)) {
      if (r.kind !== "secret" || !r.wrong) continue;
      const all = [...spread(town, r)];
      const garbled = all.filter(([, s]) => s.telling === 2 && s.at <= now);
      if (garbled.length < all.length / 4) continue;
      out.push({
        title: this.title,
        summary: `Across ${town.label(town.root)} the story is that ${r.texts[2]}. It's ${town.label(r.about[0])}, not ${town.label(r.wrong)}, and ${town.label(r.wrong)} is about to find that out the hard way.`,
        involves: [r.wrong, ...r.about],
      });
    }
    return out;
  },
};

export const beforeItGetsOut: Sifter = {
  id: "before-it-gets-out",
  title: "Before it gets out",
  source: "our own (secrets come out at their own time)",
  match(town) {
    const now = clockNow(town);
    return allSecrets(town).filter((r) => r.start > now && r.start - now < 24 * 21 && r.topic !== "courting").map((r) => ({
      title: this.title,
      summary: `Within three weeks it will be all over ${town.label(town.root)} that ${r.texts[0]}: ${r.how}. Anyone who acts first has the advantage.`,
      involves: r.about,
    }));
  },
};

export { BLOCKS };
