import { data } from "../../core/content";
import type { Rng } from "../../core/rng";
import type { Entity, Town } from "../../core/town";
import type { Ctx, EdgeKind, Module } from "../../core/types";
import type { Tier } from "../core";
import { COUNCIL } from "../council";
import { centroid, dist, type Poly, type Pt } from "../layout/geom";
import type { Occupation } from "../uses";
import societyYaml from "./content/society.yaml";

// The settlement-wide phase: links between households. Everything here reads
// the whole resolved hamlet and draws from settlement-level streams, so no
// result depends on what anyone looked at first (DESIGN §11a).

interface SocietyData {
  debts: { id: string; text: string; weight: number }[];
  rivalries: string[];
}
const content = data<SocietyData>(societyYaml);

interface Hh {
  h: Entity;
  head: Entity;
  members: Entity[];
  rank: number;
  occ: string;
  use: string;
  building: Entity;
  at: Pt;
}

const CRAFTS = new Set(["smith", "carpenter", "baker", "cooper", "weaver", "thatcher", "chandler", "miller"]);
const WORKERS = new Set(["labourer", "ploughman"]);
const SOCIABLE = ["drinker", "pious", "gossip", "cheerful", "kindly", "hardworking", "musical", "storyteller", "loyal"];
const PRICKLY = ["envious", "proud", "quarrelsome", "grasping", "sharp_tongued", "hot_tempered", "grudging", "litigious", "stubborn"];

function gather(town: Town): Hh[] {
  const tiers = town.registry<Tier>("tiers");
  const out: Hh[] = [];
  for (const b of town.children(town.root, "building")) {
    for (const h of town.children(b.address, "household")) {
      const members = town.children(h.address, "person");
      if (!members.length) continue;
      out.push({
        h, head: members[0], members, building: b,
        rank: tiers.find(h.get("tier"))?.rank ?? 3,
        occ: h.get("occupation"), use: b.get("use"),
        at: centroid(b.get<Poly>("poly")),
      });
    }
  }
  return out;
}

const age = (p: Entity) => p.get<number>("age");
const sex = (p: Entity) => p.get<string>("sex");
const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const pair = (a: number, b: number) => (a < b ? a * 1e6 + b : b * 1e6 + a);

export const society: Module = {
  id: "society",
  version: "1.0.0",
  requires: ["core", "households", "names", "people", "council"],
  register(add) {
    add<EdgeKind>("edgeKinds", [{ id: "courting", label: "courting", symmetric: true }]);
  },
  hooks: {
    onSocietyResolved(ctx, s) {
      const town = ctx.town;
      const all = gather(town);
      const rng = (purpose: string) => ctx.rng(s, purpose);
      const kin = new Set<string>();
      for (const e of town.edges({ kind: "kin" })) kin.add(key(e.from, e.to));
      for (const e of town.edges({ kind: "spouse" })) kin.add(key(e.from, e.to));
      natalKin(ctx, all, rng("natal"), kin);
      brothers(ctx, all, rng("brothers"), kin);
      // From here on kinship only grows by marriage plans, so number everyone
      // and keep the pairs as numbers: towns have tens of thousands of people.
      const pid = new Map<Entity, number>(), hid = new Map<Entity, number>(), byAddr = new Map<string, number>();
      all.forEach((x, hi) => x.members.forEach((p) => { const i = pid.size; pid.set(p, i); hid.set(p, hi); byAddr.set(p.address, i); }));
      const pairs = new Set<number>();
      for (const k of kin) {
        const [a, b] = k.split("|");
        const ia = byAddr.get(a), ib = byAddr.get(b);
        if (ia !== undefined && ib !== undefined) pairs.add(pair(ia, ib));
      }
      const related = (a: Entity, b: Entity) => hid.get(a) === hid.get(b) || pairs.has(pair(pid.get(a)!, pid.get(b)!));
      employment(ctx, all, rng("employment"));
      apprentices(ctx, all, rng("apprentices"));
      debts(ctx, all, rng("debts"));
      friendsAndRivals(ctx, all, rng("friends"), related, pid);
      courtship(ctx, all, rng("courtship"), related);
    },
  },
};

function bySurname(all: Hh[], male: boolean): Map<string, Hh[]> {
  const out = new Map<string, Hh[]>();
  for (const y of all) {
    if (male && sex(y.head) !== "m") continue;
    const n = y.h.get<{ name: string }>("surname").name;
    const l = out.get(n);
    if (l) l.push(y); else out.set(n, [y]);
  }
  return out;
}

function natalKin(ctx: Ctx, all: Hh[], r: Rng, kin: Set<string>) {
  const families = bySurname(all, true);
  for (const x of all) for (const w of x.members) {
    if (w.get("role") !== "spouse" || sex(w) !== "f") continue;
    const born = w.get<string | undefined>("birthname");
    const homes = (born === undefined ? [] : families.get(born) ?? []).filter((y) => y !== x);
    const parents = homes.filter((y) => age(y.head) - age(w) >= 17 && age(y.head) - age(w) <= 45);
    if (parents.length) {
      const y = r.pick(parents);
      ctx.edge({ from: w.address, to: y.head.address, kind: "kin", weight: 0.6, facts: { rel: "daughter", inv: "father" } });
      kin.add(key(w.address, y.head.address));
      const mother = y.members.find((m) => m.get("role") === "spouse");
      if (mother) ctx.edge({ from: w.address, to: mother.address, kind: "kin", weight: 0.6, facts: { rel: "daughter", inv: "mother" } });
      continue;
    }
    const sibs = homes.filter((y) => Math.abs(age(y.head) - age(w)) <= 14);
    if (sibs.length) {
      const y = r.pick(sibs);
      ctx.edge({ from: w.address, to: y.head.address, kind: "kin", weight: 0.5, facts: { rel: "sister", inv: "brother" } });
      kin.add(key(w.address, y.head.address));
    }
  }
}

function brothers(ctx: Ctx, all: Hh[], r: Rng, kin: Set<string>) {
  const heads = all.filter((x) => sex(x.head) === "m");
  // Same-surname pairs only, in the same (i, j) order as a full double loop.
  const at = new Map(heads.map((x, i) => [x, i]));
  const pairs: [number, number][] = [];
  for (const group of bySurname(heads, false).values()) {
    for (let p = 0; p < group.length; p++) for (let q = p + 1; q < group.length; q++) pairs.push([at.get(group[p])!, at.get(group[q])!]);
  }
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // In a town a trade name says nothing about kinship (there are Smiths
  // everywhere), and nobody has a dozen brothers.
  const street = ctx.town.settlement().get<{ kind?: string }>("map")?.kind === "town";
  const kinCount = new Map<Hh, number>();
  for (const [i, j] of pairs) {
    const a = heads[i], b = heads[j];
    if (street) {
      if (/^trade/.test(a.h.get<{ kind: string }>("surname").kind)) continue;
      if ((kinCount.get(a) ?? 0) >= 3 || (kinCount.get(b) ?? 0) >= 3) continue;
    }
    if (kin.has(key(a.head.address, b.head.address))) continue;
    const gap = Math.abs(age(a.head) - age(b.head));
    if (gap <= 16 && r.chance(0.6)) {
      ctx.edge({ from: a.head.address, to: b.head.address, kind: "kin", weight: r.range(-0.3, 0.7), facts: { rel: "brother", inv: "brother" } });
    } else if (gap <= 25) {
      ctx.edge({ from: a.head.address, to: b.head.address, kind: "kin", weight: 0.2, facts: { rel: "cousin", inv: "cousin" } });
    } else continue;
    kin.add(key(a.head.address, b.head.address));
    if (street) { kinCount.set(a, (kinCount.get(a) ?? 0) + 1); kinCount.set(b, (kinCount.get(b) ?? 0) + 1); }
  }
}

function employment(ctx: Ctx, all: Hh[], r: Rng) {
  const town = ctx.town;
  const occs = ctx.registry<Occupation>("occupations");
  if (/town|city/.test(town.settlement().get<string>("sizeClass"))) return townEmployment(ctx, all, r);
  const farms = all.filter((x) => x.h.get<number>("land") >= 12);
  const keeper = town.peek(`${town.root}/institution:${COUNCIL}`) ? `${town.root}/institution:${COUNCIL}` : undefined;
  for (const x of all) {
    if (WORKERS.has(x.occ) && farms.length) {
      const f = r.weighted(farms, (y) => y.h.get<number>("land") / (1 + dist(x.at, y.at) / 120));
      ctx.edge({ from: f.head.address, to: x.head.address, kind: "employer", weight: r.range(-0.2, 0.5), facts: { as: occs.find(x.occ)?.label ?? x.occ } });
    }
    if (x.occ === "herdsman" && keeper) {
      ctx.edge({ from: keeper, to: x.head.address, kind: "employer", weight: 0.2, facts: { as: "the common herdsman" } });
    }
  }
}

// In a town, day labourers and porters work for masters and merchants nearby;
// the bigger the business, the more hands it takes on.
const TOWN_WORKERS = new Set(["labourer", "porter", "water_carrier", "laundress", "ploughman"]);

function townEmployment(ctx: Ctx, all: Hh[], r: Rng) {
  const occs = ctx.registry<Occupation>("occupations");
  const hirers = all.filter((x) => x.rank >= 6 && x.h.get<number>("income") > 0 && !TOWN_WORKERS.has(x.occ));
  if (!hirers.length) return;
  const CELL = 120;
  const grid = new Map<string, Hh[]>();
  const keyOf = (p: Pt, dx = 0, dy = 0) => `${Math.floor(p[0] / CELL) + dx},${Math.floor(p[1] / CELL) + dy}`;
  for (const h of hirers) { const k = keyOf(h.at); const l = grid.get(k); if (l) l.push(h); else grid.set(k, [h]); }
  for (const x of all) {
    if (!TOWN_WORKERS.has(x.occ) || r.chance(0.3)) continue; // some take whatever comes, day by day
    let pool: Hh[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) pool.push(...(grid.get(keyOf(x.at, dx, dy)) ?? []));
    if (!pool.length) pool = hirers;
    const f = r.weighted(pool, (y) => y.h.get<number>("income") / (1 + dist(x.at, y.at) / 80));
    if (f === x) continue;
    ctx.edge({ from: f.head.address, to: x.head.address, kind: "employer", weight: r.range(-0.3, 0.4), facts: { as: occs.find(x.occ)?.label ?? x.occ } });
  }
}

function apprentices(ctx: Ctx, all: Hh[], r: Rng) {
  const taken = new Set<string>();
  // Every boy of the right age, in household order, with his household's rank.
  const lads: { p: Entity; x: Hh }[] = [];
  for (const x of all) for (const p of x.members) if (p.get("role") === "child" && sex(p) === "m" && age(p) >= 12 && age(p) <= 19) lads.push({ p, x });
  for (const m of all) {
    if (!CRAFTS.has(m.occ) || !r.chance(m.occ === "miller" ? 0.35 : 0.6)) continue;
    const boys: Entity[] = [];
    for (const l of lads) if (l.x !== m && l.x.rank <= m.rank && !taken.has(l.p.address)) boys.push(l.p);
    if (!boys.length) continue;
    const boy = r.pick(boys);
    taken.add(boy.address);
    ctx.edge({ from: boy.address, to: m.head.address, kind: "apprentice_of", weight: r.range(-0.3, 0.6), facts: { years: r.int(1, 6) } });
  }
}

const DEBT_CHANCE: Record<number, number> = { 3: 0.45, 4: 0.4, 5: 0.35, 6: 0.2, 7: 0.1 };

function debts(ctx: Ctx, all: Hh[], r: Rng) {
  const lenders = [...all].sort((a, b) => b.h.get<number>("savings") - a.h.get<number>("savings")).slice(0, Math.max(3, Math.round(all.length / 8)));
  const alehouse = all.find((x) => x.use === "alehouse");
  for (const x of all) {
    if (lenders.includes(x)) continue;
    if (!r.chance(DEBT_CHANCE[x.rank] ?? 0.05)) continue;
    const income = x.h.get<number>("income");
    if (alehouse && alehouse !== x && x.members.some((p) => p.get<string[]>("traits").includes("drinker")) && r.chance(0.6)) {
      const amount = Math.round(r.range(6, 40));
      ctx.edge({ from: x.head.address, to: alehouse.head.address, kind: "debtor_of", weight: amount, facts: { amount, reason: "the ale slate" }, knownBy: [x.head.address, alehouse.head.address] });
      continue;
    }
    const able = lenders.filter((l) => l.rank >= x.rank && l !== x);
    if (!able.length) continue;
    const c = r.weighted(able, (l) => l.h.get<number>("savings"));
    const reason = r.weighted(content.debts, (d) => d.weight);
    const amount = Math.round(income * r.range(0.1, 0.9));
    ctx.edge({
      from: x.head.address, to: c.head.address, kind: "debtor_of", weight: amount,
      facts: { amount, reason: reason.text, due: r.pick(["Lady Day", "Midsummer", "Michaelmas", "Christmas"]) },
      knownBy: r.chance(0.4) ? "public" : [x.head.address, c.head.address],
    });
  }
}

function friendsAndRivals(ctx: Ctx, all: Hh[], r: Rng, related: (a: Entity, b: Entity) => boolean, pid: Map<Entity, number>) {
  interface Ad { p: Entity; x: Hh; age: number; sex: string; traits: string[]; i: number }
  const adults: Ad[] = [];
  for (const x of all) for (const p of x.members) {
    if (age(p) >= 16 && p.get("role") !== "servant") adults.push({ p, x, age: age(p), sex: sex(p), traits: p.get<string[]>("traits"), i: adults.length });
  }
  const done = new Set<number>();
  const dk = (a: Entity, b: Entity) => pair(pid.get(a)!, pid.get(b)!);
  // In a town, friends and rivals come from the neighbourhood: a grid of cells.
  // (A hamlet is small enough for everyone to know everyone.)
  const big = adults.length > 1500;
  const CELL = 40;
  const cellKey = (pt: Pt, dx = 0, dy = 0) => `${Math.floor(pt[0] / CELL) + dx},${Math.floor(pt[1] / CELL) + dy}`;
  const gridOf = <T>(items: T[], at: (t: T) => Pt) => {
    const g = new Map<string, T[]>();
    for (const it of items) { const k = cellKey(at(it)); const l = g.get(k); if (l) l.push(it); else g.set(k, [it]); }
    return g;
  };
  const near = <T>(g: Map<string, T[]>, pt: Pt): T[] => {
    const out: T[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const l = g.get(cellKey(pt, dx, dy)); if (l) out.push(...l); }
    return out;
  };
  const grid = big ? gridOf(adults, (a) => a.x.at) : undefined;
  for (const a of adults) {
    if (!r.chance(0.45)) continue;
    const ta = a.traits;
    const pool = grid ? near(grid, a.x.at) : adults;
    const cands = pool.filter((b) => b.x !== a.x && Math.abs(b.age - a.age) <= 14 && !related(a.p, b.p) && !done.has(dk(a.p, b.p)));
    if (!cands.length) continue;
    const b = r.weighted(cands, (c) => {
      const shared = c.traits.filter((t) => ta.includes(t) && SOCIABLE.includes(t)).length;
      return (1 + 3 * shared) * (c.sex === a.sex ? 3 : 1) / (1 + dist(a.x.at, c.x.at) / 60);
    });
    done.add(dk(a.p, b.p));
    ctx.edge({ from: a.p.address, to: b.p.address, kind: "friend", weight: r.range(0.3, 0.9) });
  }
  const heads = all;
  const hix = new Map(heads.map((x, i) => [x, i]));
  const hgrid = big ? gridOf(heads, (x) => x.at) : undefined;
  const byOcc = new Map<string, Hh[]>();
  if (big) for (const x of heads) { const l = byOcc.get(x.occ); if (l) l.push(x); else byOcc.set(x.occ, [x]); }
  for (const a of heads) {
    const prickly = a.head.get<string[]>("traits").some((t) => PRICKLY.includes(t));
    if (!r.chance(prickly ? 0.45 : 0.08)) continue;
    // In a town: the neighbours, and anyone else in the same trade.
    const pool = hgrid ? [...new Set([...near(hgrid, a.at), ...(byOcc.get(a.occ) ?? [])])].sort((p, q) => hix.get(p)! - hix.get(q)!) : heads;
    const cands = pool.filter((b) => b !== a && !related(a.head, b.head) && !done.has(dk(a.head, b.head)));
    if (!cands.length) continue;
    const b = r.weighted(cands, (c) => (c.occ === a.occ ? 3 : 1) / (1 + dist(a.at, c.at) / 40));
    done.add(dk(a.head, b.head));
    ctx.edge({ from: a.head.address, to: b.head.address, kind: "rival", weight: -r.range(0.3, 0.9), facts: { about: r.pick(content.rivalries) } });
  }
}

function courtship(ctx: Ctx, all: Hh[], r: Rng, related: (a: Entity, b: Entity) => boolean) {
  const single = (p: Entity) => p.get("marital") === "single" && age(p) >= 16 && age(p) <= 28;
  const men: Entity[] = [], women: Entity[] = [];
  for (const x of all) for (const p of x.members) {
    if (!single(p) || x.occ === "chaplain" || x.occ === "shrine_keeper") continue;
    (sex(p) === "m" ? men : women).push(p);
  }
  const used = new Set<string>();
  const n = Math.round(Math.min(men.length, women.length) * 0.5);
  let made = 0;
  for (let tries = 0; made < n && tries < n * 8; tries++) {
    const m = r.pick(men), w = r.pick(women);
    if (used.has(m.address) || used.has(w.address) || related(m, w) || Math.abs(age(m) - age(w)) > 8) continue;
    made++;
    used.add(m.address); used.add(w.address);
    const betrothed = r.chance(0.35);
    ctx.edge({
      from: m.address, to: w.address, kind: betrothed ? "betrothed" : "courting", weight: r.range(0.4, 1),
      knownBy: betrothed || r.chance(0.5) ? "public" : [m.address, w.address],
    });
  }
  // A married pair who should not be: rare, and secret.
  const married: Entity[] = [];
  for (const x of all) for (const p of x.members) if (p.get("marital") === "married" && age(p) <= 50) married.push(p);
  const affairs = r.chance(0.6) ? 1 : 0;
  for (let i = 0; i < affairs && married.length > 3; i++) {
    const a = r.pick(married);
    const others = married.filter((b) => sex(b) !== sex(a) && !related(a, b) && Math.abs(age(a) - age(b)) <= 15);
    if (!others.length) continue;
    const b = r.pick(others);
    ctx.edge({ from: a.address, to: b.address, kind: "lover", weight: 0.8, knownBy: [a.address, b.address] });
  }
}
