// The society phase for the underworld: who runs with which crew, where they
// meet, who fences for them, who they pay, who sells them out, and what the
// beggars have chalked by every door. Everything here reads the whole
// resolved town and draws from settlement-level streams (DESIGN §11a).
import type { Address } from "../../core/address";
import type { Rng } from "../../core/rng";
import type { Entity } from "../../core/town";
import type { Ctx, Edge, EntityLike } from "../../core/types";
import type { Tier } from "../core";
import { VALUE_CLASSES, wardId, type MapData } from "../layout";
import { centroid, dist, type Poly, type Pt } from "../layout/geom";
import type { Occupation } from "../uses";
import { content, layOf, type Lay, type Level, type Rank } from "./world";

interface P {
  p: Entity; hh: Entity; b: Entity; at: Pt; ward: number; value: number; age: number; sex: string; rank: number;
  occ: string; traits: string[]; role: string; head: boolean; i: number;
}

const ROGUISH = ["grasping", "sly", "quarrelsome", "hot_tempered", "idle", "drinker", "envious", "bold", "secretive", "boastful", "sullen"];
const STRAIGHT = ["honest", "pious", "timid", "gentle", "kindly", "loyal"];
const TIER_PULL: Record<number, number> = { 1: 7, 2: 3, 3: 1.6, 4: 1, 5: 0.6, 6: 0.25, 7: 0.08 };
const DRINK = ["tavern", "town_alehouse", "inn"];
const KEPT = [...DRINK, "sleeping_house", "hostel", "bathhouse", "warehouse", "livery_stable", "rooming_house"];
const HOUSING = new Set(["tenement", "poor_row", "journeyman_house", "townhouse", "noble_town_house", "cottage", "empty"]);
const PARISH = ["fane", "temple", "grand_temple", "chapel", "shrine", "chantry"];
// A working member's share of a year's take, in pence, before the cuts.
const YIELD: Record<string, number> = { nips: 260, crackers: 520, pads: 300, mumpers: 160, cheats: 700, stews: 400, owlers: 1100, clippers: 900, bullies: 380, prancers: 800 };

const LAWFUL = new Set(["constable", "beadle", "marshal", "deputy marshal", "officer of the watch", "sergeant of the watch", "magistrate", "justice of the peace", "coroner", "steward of the borough court", "mayor", "alderman", "the lord's bailiff of the town"]);

interface Office { p: Address; office: string; ward?: number; quarter?: number; gate?: number }

export function found(ctx: Ctx, s: EntityLike): void {
  const town = ctx.town;
  const uwAddr = `${s.address}/institution:underworld`;
  const uw = town.peek(uwAddr);
  if (!uw) return;
  const level = s.get<Level>("crime.level") ?? "usual";
  const L = content.levels[level];
  const map = s.get<MapData>("map");
  const wards = map.wards ?? [];
  const pop = s.get<number>("targetPop");
  const r = (purpose: string) => ctx.rng(s, `crime:${purpose}`);

  // ---- everyone, once ----------------------------------------------------
  const tiers = town.registry<Tier>("tiers");
  const occs = town.registry<Occupation>("occupations");
  const people: P[] = [];
  const buildings: { b: Entity; at: Pt; ward: number; value: number; use: string; heads: P[] }[] = [];
  for (const b of town.children(town.root, "building")) {
    const at = centroid(b.get<Poly>("poly"));
    const ward = b.get<number>("ward") ?? 0;
    const value = wards[ward]?.value ?? 2;
    const entry = { b, at, ward, value, use: b.generated<string>("use"), heads: [] as P[] };
    buildings.push(entry);
    for (const hh of town.children(b.address, "household")) {
      // Generated values only: a DM's edit to one person must not reshuffle every crew in town.
      const rank = tiers.find(hh.generated<string>("tier"))?.rank ?? 3;
      town.children(hh.address, "person").forEach((p, k) => {
        const x: P = {
          p, hh, b, at, ward, value, rank, age: p.generated<number>("age"), sex: p.generated<string>("sex"),
          occ: p.generated<string>("occupation") ?? hh.generated<string>("occupation") ?? "", traits: p.generated<string[]>("traits") ?? [],
          role: p.generated<string>("role"), head: k === 0, i: people.length,
        };
        people.push(x);
        if (k === 0) entry.heads.push(x);
      });
    }
  }
  const byAddr = new Map(people.map((x) => [x.p.address, x]));
  const offices: Office[] = [];
  const officeOf = new Map<Address, string>();
  for (const e of town.edges({ kind: "office_in" })) {
    const f = e.facts ?? {};
    offices.push({ p: e.from, office: String(f.office), ward: f.ward as number | undefined, quarter: f.quarter as number | undefined, gate: f.gate as number | undefined });
    officeOf.set(e.from, String(f.office));
  }
  const taken = new Set<Address>();
  const free = (x: P) => !taken.has(x.p.address) && !officeOf.has(x.p.address) && x.role !== "cleric" && x.role !== "retainer" && x.role !== "inmate" && x.rank <= 7;
  const market = centroid(map.market ?? map.green);
  const wardName = (i: number) => town.find(`${town.root}/ward:${wardId(i)}`)?.generated<string>("name") ?? `ward ${i + 1}`;
  const label = (a: Address) => town.label(a).replace(/^The /, "");
  const quarterOfWard = (i: number) => wards[i]?.quarter ?? 0;
  const edge = (from: Address, to: Address, kind: string, facts: Record<string, unknown>, knownBy: Edge["knownBy"]) =>
    ctx.edge({ from, to, kind, weight: kind === "rival" ? -0.6 : 0.5, facts, knownBy });
  const pair = (a: Address, b: Address): Address[] => (a === b ? [a] : [a, b]);

  // ---- the crews ---------------------------------------------------------
  const gangEntities = town.children(uwAddr, "institution").filter((g) => g.get("kind") === "gang");
  const dens = new Set<Address>();
  const usedNames = new Set<string>();
  const usedPlaces = new Set<string>();
  const aliases = new Set<string>();
  // Street names are the person's own to reroll, but nobody shares one.
  const nameOf = (x: P) => ctx.gen(x.p, "crime.alias", (rr) => {
    let a = alias(rr, x);
    for (let k = 0; k < 30 && aliases.has(a); k++) a = alias(rr, x);
    // Two of a name: the town tells them apart by age.
    if (aliases.has(a)) a = `${a} the ${x.age >= 35 ? "Elder" : "Younger"}`;
    for (let k = 2; aliases.has(a); k++) a = `${a.replace(/ \d+$/, "")} ${k}`;
    aliases.add(a);
    return a;
  });
  interface Built { g: Entity; lay: Lay; den: (typeof buildings)[number]; turf: number[]; chief: P; members: { x: P; rank: Rank }[]; name: string }
  const built: Built[] = [];
  const nearest = (at: Pt, uses: string[]) => {
    let best: (typeof buildings)[number] | undefined, bd = Infinity;
    for (const y of buildings) if (uses.includes(y.use)) { const d = dist(at, y.at); if (d < bd) { bd = d; best = y; } }
    return best;
  };
  const rich = wards.filter((w) => w.value >= 5).map((w) => w.centre);
  const water = wards.filter((w) => w.near.includes("quay") || w.near.includes("river") || w.near.includes("bridge")).map((w) => w.centre);
  const minDist = (at: Pt, pts: Pt[]) => pts.reduce((m, p) => Math.min(m, dist(at, p)), Infinity);
  const scale = Math.sqrt(pop / 3000);
  const reach = Math.max(300, Math.sqrt(pop) * 4);

  for (const g of gangEntities) {
    const lay = layOf(g.get<string>("lay"));
    const rg = ctx.rng(g, "found");
    // The den: one of the uses the lay meets in, in a poor ward, near its work.
    const turfFit = (y: (typeof buildings)[number]) => {
      switch (lay.turf) {
        case "market": case "shops": return 1 / (1 + dist(y.at, market) / (lay.turf === "market" ? 150 : 250));
        case "rich": return rich.length ? 1 / (1 + minDist(y.at, rich) / 200) : 1;
        case "dark": return (y.value <= 1 ? 2 : 0.6) * (wards[y.ward]?.kind === "suburb" ? 1.5 : 1);
        case "church": { const c = nearest(y.at, PARISH); return c ? 1 / (1 + dist(y.at, c.at) / 120) : 1; }
        case "water": return water.length ? 1 / (1 + minDist(y.at, water) / 150) : 1;
        case "inns": { const c = nearest(y.at, ["inn", "livery_stable"]); return c ? 1 / (1 + dist(y.at, c.at) / 150) : 1; }
      }
      return 1;
    };
    let cands = buildings.filter((y) => lay.den.includes(y.use) && !dens.has(y.b.address));
    if (!cands.length) cands = buildings.filter((y) => y.heads.length && y.value <= 2 && !dens.has(y.b.address));
    if (!cands.length) cands = buildings.filter((y) => y.heads.length && !dens.has(y.b.address));
    if (!cands.length) continue;
    const den = rg.weighted(cands, (y) => {
      const pref = lay.den.length - Math.max(0, lay.den.indexOf(y.use));
      const special = lay.den.indexOf(y.use) === 0 && !["town_alehouse", "tavern", "sleeping_house", "hostel", "poor_row"].includes(y.use);
      const fit = special ? 1 : y.value <= 3 ? 4 - y.value : 0.15;
      return pref * fit * turfFit(y);
    });
    dens.add(den.b.address);
    // Turf: the den's ward and a poor neighbour or two; nips also work the market.
    const turf = [den.ward];
    for (const a of rg.shuffle(wards[den.ward]?.adj ?? [])) if (turf.length < 3 && (wards[a]?.value ?? 9) <= 4) turf.push(a);
    if (lay.turf === "market") {
      const mw = wards.reduce((best, w) => (dist(w.centre, market) < dist(wards[best].centre, market) ? w.id : best), wards[0]?.id ?? 0);
      if (!turf.includes(mw)) turf.push(mw);
    }
    // A name the streets know them by.
    const denName = DRINK.includes(den.use) ? label(den.b.address) : undefined;
    const gateNames = town.settlement().generated<string[]>("gateNames") ?? [];
    const gates = map.wall?.gates ?? [];
    let gate: string | undefined;
    if (gates.length && gateNames.length) {
      let bi = 0;
      gates.forEach((x, i) => { if (dist(x.p, den.at) < dist(gates[bi].p, den.at)) bi = i; });
      gate = gateNames[bi];
    }
    const church = nearest(den.at, PARISH);
    const saint = church ? /(St [A-Z][a-z]+|All Saints|Holy Trinity|Holy Cross|Our Lady|Holy Rood)/.exec(town.label(church.b.address))?.[1] : undefined;
    // "the {den} crew" reads badly when the den is somebody's: "Grove's alehouse crew".
    const fill = (t: string) => (denName?.includes("'") ? t.replace("the {den}", "{den}") : t).replace("{den}", denName ?? "").replace("{ward}", wardName(den.ward).replace(/^Without |^Beyond /, "")).replace("{gate}", gate ?? wardName(den.ward)).replace("{church}", saint ? (saint.endsWith("s") ? `${saint}'` : `${saint}'s`) : "the church");
    // A crew is known by its street, its gate, its church or its sign, not by
    // whose alehouse it drinks in: "{den}" only when the den has a sign.
    const signed = denName && !denName.includes("'");
    const gateOk = (t: string) => !t.includes("{gate}") || gate;
    // Two crews never share a place in their names: one "East End" crew to a town.
    const place = (t: string) => (t.includes("{ward}") ? wardName(den.ward) : t.includes("{gate}") ? gate : t.includes("{church}") ? saint : t.includes("{den}") ? denName : undefined);
    const fresh = (t: string) => !usedPlaces.has(place(t) ?? `#${t}`);
    const all = lay.names.filter((t) => (!t.includes("{den}") || signed) && gateOk(t) && !usedNames.has(fill(t)));
    const options = all.filter(fresh).length ? all.filter(fresh) : all;
    const chosen = options.length ? rg.pick(options) : lay.names[0];
    let name = options.length ? fill(chosen) : `${fill(lay.names[0])} (${built.length + 1})`;
    const pl = place(chosen);
    if (pl) usedPlaces.add(pl);
    if (usedNames.has(name)) name = `${name} (${built.length + 1})`;
    usedNames.add(name);

    // The chief, then the rest, drawn from the poor and hard nearby.
    const pull = (x: P) => {
      let w = (lay.recruit[x.occ] ?? (x.rank <= 5 ? 0.5 : 0.05)) * (TIER_PULL[x.rank] ?? 0.02);
      for (const t of x.traits) { if (ROGUISH.includes(t)) w *= 1.6; else if (STRAIGHT.includes(t)) w *= 0.3; }
      // Most crews were men's work; the stews and the beggars less so.
      if (x.sex === "m") w *= lay.id === "stews" ? 0.5 : lay.id === "mumpers" ? 1.2 : 2.2;
      return w / (1 + dist(x.at, den.at) / reach);
    };
    const fits = (x: P, rk: Rank) => x.age >= (rk.minAge ?? 14) && x.age <= (rk.maxAge ?? (rk.chief ? lay.chiefMaxAge ?? 66 : lay.maxAge ?? 55)) && (!rk.sex || rk.sex === x.sex);
    const chiefRank = lay.ranks.find((k) => k.chief)!;
    // A crew that meets in a trade's own house is run by its keeper: the bawd
    // keeps the bathhouse, the rum clipper is the goldsmith, the jingler the liveryman.
    const tradeDen = lay.den.includes(den.use) && !["town_alehouse", "tavern", "sleeping_house", "hostel", "poor_row", "tenement", "inn"].includes(den.use);
    let chief = tradeDen ? den.heads.find((x) => free(x) && fits(x, chiefRank)) : undefined;
    if (!chief) {
      const pool = people.filter((x) => free(x) && fits(x, chiefRank));
      if (!pool.length) continue;
      chief = rg.weighted(pool, (x) => pull(x) * (x.age >= 28 && x.age <= 55 ? 1.5 : 1) * (lay.id === "stews" ? (x.sex === "f" ? 3 : 0.5) : x.sex === "m" ? 2 : 0.6));
    }
    taken.add(chief.p.address);
    const members: { x: P; rank: Rank }[] = [{ x: chief, rank: chiefRank }];
    // The common trades grow with the town; the skilled ones barely do.
    const grow = ["nips", "mumpers", "pads", "crackers", "bullies"].includes(lay.id) ? scale : Math.sqrt(scale);
    const want = Math.max(3, Math.round(rg.int(lay.size[0], lay.size[1]) * grow * (1 + L.mult) / 2));
    const ranks = lay.ranks.filter((k) => !k.chief);
    const pool = people.filter((x) => free(x) && ranks.some((k) => fits(x, k)));
    const weights = pool.map(pull);
    for (let n = 1; n < want; n++) {
      let total = 0;
      for (let k = 0; k < pool.length; k++) if (!taken.has(pool[k].p.address)) total += weights[k];
      if (total <= 0) break;
      let pickAt = rg.range(0, total), k = 0;
      for (; k < pool.length; k++) {
        if (taken.has(pool[k].p.address)) continue;
        pickAt -= weights[k];
        if (pickAt <= 0) break;
      }
      const x = pool[Math.min(k, pool.length - 1)];
      if (taken.has(x.p.address)) break;
      taken.add(x.p.address);
      const ok = ranks.filter((k2) => fits(x, k2));
      members.push({ x, rank: rg.weighted(ok, (k2) => k2.weight ?? 1) });
    }
    built.push({ g, lay, den, turf, chief, members, name });
    ctx.set(g, "name", name);
    ctx.set(g, "den", den.b.address);
    ctx.set(g, "turf", turf);
    ctx.gen(g, "word", (rr) => rr.pick(content.words));
    ctx.gen(g, "sign", (rr) => rr.pick(content.signs));
    ctx.gen(g, "emblem", (rr) => rr.pick(content.emblems));
    ctx.gen(g, "customs", (rr) => rr.shuffle(content.customs).slice(0, rr.int(2, 3)));
    for (const m of members) {
      // Each member keeps their own secret; the chief knows it without needing a tie to say so.
      edge(m.x.p.address, g.address, "in_gang", { rank: m.rank.id, as: m.rank.cant, crew: name }, [m.x.p.address]);
      nameOf(m.x);
    }
  }
  if (!built.length) return;

  // ---- fences and the keepers of dens ------------------------------------
  const fenceList: P[] = [];
  const fenceLoad = new Map<P, number>();
  const rf = r("fences");
  for (const b of built) {
    const near = fenceList.filter((f) => dist(f.at, b.den.at) < 350 && (fenceLoad.get(f) ?? 0) < 3);
    let f: P | undefined = near.length && rf.chance(0.5) ? rf.pick(near) : undefined;
    if (!f) {
      const pool = people.filter((x) => x.head && free(x) && content.fences[x.occ]);
      if (pool.length) f = rf.weighted(pool, (x) => content.fences[x.occ] / (1 + dist(x.at, b.den.at) / 250));
    }
    if (!f) continue;
    if (!fenceList.includes(f)) { fenceList.push(f); taken.add(f.p.address); nameOf(f); }
    fenceLoad.set(f, (fenceLoad.get(f) ?? 0) + 1);
    edge(f.p.address, b.chief.p.address, "fence_for", { crew: b.name, as: "their fence", cut: "pays a third of what things are worth" }, pair(f.p.address, b.chief.p.address));
  }
  for (const b of built) {
    if (!KEPT.includes(b.den.use)) continue;
    const keeper = b.den.heads[0];
    if (!keeper || taken.has(keeper.p.address) && !fenceList.includes(keeper)) continue;
    if (b.members.some((m) => m.x === keeper)) continue;
    edge(keeper.p.address, b.chief.p.address, "harbours", { crew: b.name, as: "keeper of their den" }, pair(keeper.p.address, b.chief.p.address));
  }

  // ---- the boss: a tenth from every crew ---------------------------------
  const rb = r("boss");
  let boss: P | undefined;
  const R = content.roles;
  const bossFrom = (R.boss.minPop ?? 8000) * (level === "quiet" ? 1.4 : level === "rife" ? 0.7 : 1);
  if (pop >= bossFrom && built.length >= (R.boss.minGangs ?? 3)) {
    // The boss keeps a front: an inn, a tavern, an old-clothes shop, a counting-house.
    // Only where nobody fits does the biggest crew's chief take the chair.
    rb.chance(0.4);
    const pool = people.filter((x) => x.head && free(x) && x.rank >= 5 && x.rank <= 7 && x.age >= 35 && x.age <= 66 &&
      ["innkeeper", "tavern_keeper", "fripperer", "money_changer", "merchant", "alehouse_keeper", "sleeping_keeper", "rooming_keeper", "vintner", "woodmonger", "hay_merchant"].includes(x.occ));
    if (pool.length) boss = rb.weighted(pool, (x) => 1 + 2 * x.traits.filter((t) => ["shrewd", "sly", "ambitious", "grasping", "secretive"].includes(t)).length);
    else boss = [...built].sort((a, b) => b.members.length - a.members.length)[0].chief;
    if (boss) {
      taken.add(boss.p.address);
      ctx.set(uw, "boss", boss.p.address);
      if (!town.peek(boss.p.address)?.fields.has("crime.alias")) nameOf(boss);
      for (const b of built) if (b.chief !== boss) edge(b.chief.p.address, boss.p.address, "tithe_to", { crew: b.name, share: "a tenth of every take" }, pair(b.chief.p.address, boss.p.address));
    }
  }

  // ---- the money -----------------------------------------------------------
  // What the work brings in a year, in pence, shared out: the chief takes three
  // shares, the boss a tenth off the top, the fence his third before any of it.
  const take = new Map<Entity, number>();
  const give = (hh: Entity, n: number) => take.set(hh, (take.get(hh) ?? 0) + Math.round(n));
  const rm = r("money");
  for (const b of built) {
    const gross = (YIELD[b.lay.id] ?? 300) * b.members.length * L.mult * rm.range(0.7, 1.3);
    const fence = b.lay.id === "nips" || b.lay.id === "crackers" || b.lay.id === "pads" || b.lay.id === "prancers" ? gross / 3 : 0;
    const tenth = boss && boss !== b.chief ? (gross - fence) / 10 : 0;
    const net = gross - fence - tenth;
    const shares = b.members.length + 2;
    for (const m of b.members) give(m.x.hh, (net / shares) * (m.rank.chief ? 3 : 1));
    if (boss && tenth) give(boss.hh, tenth);
  }
  for (const [hh, n] of take) ctx.set(hh, "crime.take", n);

  // ---- the officers they pay, and the gaoler -----------------------------
  const ro = r("payoffs");
  const payChance = level === "quiet" ? 0.25 : level === "rife" ? 0.85 : 0.5;
  const gift = (lo: number, hi: number) => Math.round(ro.range(lo, hi) * L.mult);
  for (const b of built) {
    if (!offices.length || !ro.chance(payChance)) continue;
    const q = quarterOfWard(b.den.ward);
    const cover = offices.filter((o) => (o.office === "beadle" && b.turf.includes(o.ward ?? -1)) ||
      ((o.office === "constable" || o.office === "officer of the watch" || o.office === "sergeant of the watch") && o.quarter === q) ||
      (b.lay.id === "owlers" && o.office === "gate guard"));
    if (!cover.length) continue;
    for (const o of ro.shuffle(cover).slice(0, level === "rife" ? 2 : 1)) {
      edge(b.chief.p.address, o.p, "pays_off", { crew: b.name, amount: gift(8, 40), reason: `a quarter's "gift", to look the other way`, office: o.office }, pair(b.chief.p.address, o.p));
    }
  }
  const gaoler = people.find((x) => x.head && x.occ === "gaoler");
  const payer = boss ?? built[0].chief;
  if (gaoler && ro.chance(level === "quiet" ? 0.3 : 0.75)) {
    edge(payer.p.address, gaoler.p.address, "pays_off", { crew: "the gaol", amount: gift(20, 80), reason: "a cell for an alibi when one is needed, and a door left unbarred", office: "gaoler" }, pair(payer.p.address, gaoler.p.address));
  }

  // ---- the thief-taker, and the noses ------------------------------------
  const rt = r("thief-taker");
  let taker: Address | undefined;
  const takerFrom = (R.thiefTaker.minPop ?? 6000) * (level === "quiet" ? 1.3 : 1);
  if (offices.length && pop >= takerFrom) {
    const deputy = offices.filter((o) => o.office === "deputy marshal").map((o) => o.p);
    if (deputy.length && rt.chance(0.5)) taker = rt.pick(deputy);
    else {
      const pool = people.filter((x) => x.head && free(x) && x.sex === "m" && x.age >= 28 && x.age <= 58 && x.rank >= 4 && x.rank <= 6);
      if (pool.length) taker = rt.weighted(pool, (x) => 1 + 3 * x.traits.filter((t) => ["stern", "grasping", "shrewd", "bold", "sly"].includes(t)).length).p.address;
    }
  }
  if (taker) {
    ctx.set(uw, "thiefTaker", taker);
    if (fenceList.length && rt.chance(0.6)) {
      const f = rt.pick(fenceList);
      edge(taker, f.p.address, "in_league", { about: `splits the rewards for "recovered" goods`, as: "partner in the thief-taking" }, pair(taker, f.p.address));
    }
  }
  const rn = r("informers");
  for (const b of built) {
    if (!rn.chance(level === "rife" ? 0.4 : 0.3)) continue;
    const who = b.members.filter((m) => !m.rank.chief && m.x.age >= 14);
    if (!who.length) continue;
    const nose = rn.pick(who).x;
    const q = quarterOfWard(b.den.ward);
    const to = taker ?? offices.find((o) => o.office === "constable" && o.quarter === q)?.p ?? offices.find((o) => o.office === "marshal")?.p;
    if (!to) continue;
    edge(nose.p.address, to, "informs_on", { crew: b.name, as: "a nose" }, pair(nose.p.address, to));
  }

  // ---- protection, usury and blackmail ------------------------------------
  const rp = r("protection");
  for (const b of built) {
    const racket = b.lay.protection || (level === "rife" && pop >= 5000 && b === built[0] && !built.some((x) => x.lay.protection));
    if (!racket) continue;
    const collectors = b.members.filter((m) => m.rank.id === "collector" || m.rank.chief).map((m) => m.x);
    const zone = new Set(b.turf.flatMap((w) => [w, ...(wards[w]?.adj ?? [])]));
    const shops = buildings.filter((y) => zone.has(y.ward) && !HOUSING.has(y.use) && y.heads[0] && y.heads[0].rank >= 5 && y.heads[0].rank <= 7 && !officeOf.has(y.heads[0].p.address) && !taken.has(y.heads[0].p.address));
    const refusers: Address[] = [];
    let k = 0;
    for (const y of shops.slice(0, b.lay.protection ? 40 : 8)) {
      const head = y.heads[0];
      if (rp.chance(0.65)) {
        const c = collectors[k++ % collectors.length];
        const amount = Math.max(1, Math.round(head.hh.generated<number>("income") / 52 * 0.05));
        edge(head.p.address, c.p.address, "protection", { crew: b.name, amount, reason: `"protection", every Saturday` }, pair(head.p.address, c.p.address));
      } else if (rp.chance(0.3)) refusers.push(head.p.address);
    }
    ctx.set(b.g, "refusers", refusers);
  }
  const ru = r("usury");
  for (const b of built) {
    if (!b.lay.usury) continue;
    const usurer = b.chief;
    const marks = people.filter((x) => x.head && !taken.has(x.p.address) && x.rank >= 3 && x.rank <= 6 && x.traits.includes("drinker") && dist(x.at, b.den.at) < reach * 1.5);
    for (const x of ru.shuffle(marks).slice(0, Math.round(ru.int(3, 7) * L.mult))) {
      const amount = Math.max(12, Math.round(x.hh.generated<number>("income") * ru.range(0.05, 0.4)));
      edge(x.p.address, usurer.p.address, "debtor_of", { amount, reason: "dice debts, at a penny in the shilling a week", due: "every Saturday", usury: true }, pair(x.p.address, usurer.p.address));
    }
  }
  const rk = r("blackmail");
  const biters: P[] = [];
  for (const b of built) {
    if (b.lay.blackmail) biters.push(...b.members.filter((m) => m.rank.id === "crossbiter" || m.rank.chief).map((m) => m.x));
  }
  if (!biters.length && pop >= 5000 && built.length >= 2) biters.push(built.find((b) => b.lay.id === "cheats")?.chief ?? built[built.length - 1].chief);
  if (biters.length) {
    const secrets = town.edges().filter((e) => e.module !== "crime" && e.knownBy !== "public" && ["lover", "debtor_of", "skims", "grievance"].concat(e.facts?.clerical ? [e.kind] : []).includes(e.kind) &&
      byAddr.has(e.from) && byAddr.has(e.to));
    const victims = secrets.map((e) => {
      const a = byAddr.get(e.from)!, c = byAddr.get(e.to)!;
      const v = a.rank >= c.rank ? a : c;
      return { e, v, other: v === a ? c : a };
    }).filter((x) => x.v.rank >= 6 && !taken.has(x.v.p.address));
    // A spread of secrets, not five hidden debts; and no one bites more than two.
    const byKind = new Map<string, typeof victims>();
    for (const x of rk.shuffle(victims)) { const k = x.e.facts?.clerical ? "misdeed" : x.e.kind; const l = byKind.get(k); if (l) l.push(x); else byKind.set(k, [x]); }
    const spread: typeof victims = [];
    for (let k = 0; spread.length < victims.length; k++) {
      let added = false;
      for (const kind of [...byKind.keys()].sort()) { const x = byKind.get(kind)![k]; if (x) { spread.push(x); added = true; } }
      if (!added) break;
    }
    const bit = new Map<P, number>();
    for (const x of spread.slice(0, Math.round(rk.int(1, 3) * L.mult))) {
      const ok = biters.filter((b) => b !== x.v && (bit.get(b) ?? 0) < 2);
      if (!ok.length) continue;
      const biter = rk.pick(ok);
      bit.set(biter, (bit.get(biter) ?? 0) + 1);
      const what = x.e.kind === "lover" ? `the affair with ${town.label(x.other.p.address)}` : x.e.kind === "debtor_of" ? `the debt to ${town.label(x.other.p.address)}, which nobody knows about`
        : x.e.facts?.clerical ? String(x.e.facts.about ?? "what was done") : x.e.kind === "skims" ? "the skimming" : `the business with ${town.label(x.other.p.address)}`;
      const amount = Math.max(12, Math.round(x.v.hh.generated<number>("income") * rk.range(0.02, 0.06)));
      edge(biter.p.address, x.v.p.address, "blackmails", { about: what, amount, reason: "a quarter's silence", edge: x.e.id }, pair(biter.p.address, x.v.p.address));
    }
  }

  // ---- the knife for hire, and the work it has --------------------------
  const rkn = r("knife");
  const knifeFrom = (R.knife.minPop ?? 10000) * (level === "quiet" ? 1.4 : level === "rife" ? 0.8 : 1);
  const knives: P[] = [];
  if (pop >= knifeFrom) {
    for (let k = 0, n = pop >= knifeFrom * 2 ? 2 : 1; k < n; k++) {
      const pool = people.filter((x) => free(x) && x.age >= 24 && x.age <= 56 && content.knifeCover[x.occ]);
      if (!pool.length) break;
      const kx = rkn.weighted(pool, (x) => content.knifeCover[x.occ] * (1 + 2 * x.traits.filter((t) => ["quiet", "secretive", "cautious", "shrewd", "sullen"].includes(t)).length));
      knives.push(kx);
      taken.add(kx.p.address);
    }
    if (knives.length) ctx.set(uw, "knives", knives.map((x) => x.p.address));
    const grudges = town.edges().filter((e) => ["rival", "grievance", "dispute"].includes(e.kind) && e.module !== "crime" && byAddr.has(e.from) && byAddr.has(e.to) && byAddr.get(e.from)!.rank >= 6);
    const n = knives.length ? Math.min(3, Math.round(rkn.range(0.4, 2.4) * L.mult)) : 0;
    for (const e of rkn.shuffle(grudges).slice(0, n)) {
      const knife = rkn.pick(knives);
      if (knife.p.address === e.from || knife.p.address === e.to) continue;
      const client = byAddr.get(e.from)!;
      const ok = content.knifeMethods.filter((m) => !m.cover || m.cover.includes(knife.occ));
      const method = rkn.pick(ok);
      const day = rkn.int(0, 365 * 2 + 180);
      const price = Math.max(240, Math.round(client.hh.generated<number>("income") * rkn.range(0.2, 0.6)));
      edge(e.from, knife.p.address, "hired_knife", { about: "a death", target: e.to, method: method.id, day, price, grudge: e.id }, pair(e.from, knife.p.address));
    }
  }

  // ---- the marks by the doors -------------------------------------------
  const beggars = built.some((b) => b.lay.marks);
  for (const y of buildings) {
    const head = y.heads[0];
    if (!head || dens.has(y.b.address)) continue;
    const rr = ctx.rng(y.b, "marks");
    if (!rr.chance(beggars ? 0.6 : 0.3)) continue;
    const marks: string[] = [];
    const insideLaw = y.heads.some((x) => LAWFUL.has(officeOf.get(x.p.address) ?? ""));
    const adults = people.filter((x) => x.b === y.b && x.age >= 16);
    if (insideLaw) marks.push("law");
    if (rr.chance(0.12)) marks.push("dog");
    if (head.rank >= 7) marks.push("rich");
    else if (head.rank <= 3) marks.push("poor");
    if (head.traits.some((t) => ["quarrelsome", "stern", "grasping", "hot_tempered", "grudging"].includes(t))) marks.push("hard");
    else if (head.traits.some((t) => ["kindly", "generous", "gentle"].includes(t))) marks.push("kind");
    else if (head.traits.includes("pious")) marks.push("pious");
    else if (head.traits.includes("hardworking")) marks.push("work");
    const works = occs.find(head.occ)?.routine ?? "";
    if (head.rank >= 5 && adults.length <= 2 && ["town_labourer", "labourer", "carter", "clerk", "merchant", "laundress"].includes(works)) marks.push("empty");
    if (adults.length === 1 && head.age >= 62) marks.push("old");
    if (marks.length) ctx.set(y.b, "crime.marks", marks.slice(0, 2));
  }

  // ---- crews at odds ----------------------------------------------------
  const rr = r("rivals");
  const ABOUT = ["who works the market", "a member who went over to the other side", "an old killing nobody talks about", "a fence who paid one and cheated the other", "the takings from the last fair", "an insult in a tavern that wasn't forgotten"];
  for (let i = 0; i < built.length; i++) for (let j = i + 1; j < built.length; j++) {
    const a = built[i], b = built[j];
    if (a.chief === boss || b.chief === boss) continue;
    const overlap = a.turf.some((w) => b.turf.includes(w));
    if (!(a.lay.id === b.lay.id || overlap || a.lay.id === "bullies" || b.lay.id === "bullies") || !rr.chance(0.6)) continue;
    const about = overlap ? `${VALUE_CLASSES.length ? wardName(a.turf.find((w) => b.turf.includes(w))!) : "the ward"}: whose it is` : rr.pick(ABOUT);
    edge(a.chief.p.address, b.chief.p.address, "rival", { about, crews: [a.name, b.name] }, "public");
  }
}

// ---- street names ---------------------------------------------------------

function alias(r: Rng, x: P): string {
  // From generated values, so a DM's edit to a name doesn't move the alias.
  const g = x.p.generated<string | null>("called") ?? x.p.generated<string>("given");
  const A = content.aliases;
  const pool: string[] = [];
  const f = x.p.generated<string>("feature");
  if (f && A.feature[f]) pool.push(...A.feature[f], ...A.feature[f]);
  for (const t of x.traits) if (A.trait[t]) pool.push(...A.trait[t]);
  pool.push(...A.any);
  return r.pick(pool).replace("{given}", g || "Jack");
}
