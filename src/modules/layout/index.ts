// Layout: the map. Picks the layout for the size (hamlet.ts up to 700 people,
// else the grown engine in grown.ts, whose organic form is the "radial" plan), lays out the plan, and makes
// the wards and buildings from it. Laying out is the slow part and a pure
// function of its inputs, so the result is cached by key: an edit that rebuilds
// the town reuses it. Also the lookups other modules use: nearest buildings of
// a use, footprints, how many a building holds.
import type { Module } from "../../core/types";
import type { BuildingUse } from "../uses";
import { layoutHamlet, type HamletLayout, type Terrain } from "./hamlet";
import { BANKED, BLOCKED, layoutGrown } from "./grown";
import type { FarBank, LayoutPlan } from "../../core/types";
import type { Enclosure, Scale, TownLayout } from "./streets";
import { STREET_PLAN_POP } from "../uses";

export type { HamletLayout, PlacedBuilding } from "./hamlet";
export type { TownLayout, WardGeo } from "./streets";
export { VALUE_CLASSES } from "./streets";

const cache = new Map<string, HamletLayout>();
/** Forget every cached layout, so the next town is laid out afresh (tests of determinism need this). */
export function clearLayoutCache(): void { cache.clear(); }

/** A ward's id in its address: 0 -> "w00". */
export function wardId(n: number): string {
  return `w${n.toString().padStart(2, "0")}`;
}

/** A building's id in its address: 17 -> "b017". */
export function buildingId(n: number): string {
  return `b${n.toString().padStart(3, "0")}`;
}

/** L1: the map. Places one building per planned use and creates them as stubs. */
export const layout: Module = {
  id: "layout",
  version: "2.1.0",
  requires: ["core", "uses"],
  hooks: {
    onSettlementGenerated(ctx, s) {
      const plan = s.get<string[]>("plan");
      const useReg = ctx.registry<BuildingUse>("buildingUses");
      const street = s.get<number>("targetPop") > STREET_PLAN_POP;
      const footprints = plan.map((u) => {
        const row = useReg.find(u);
        if (!street) return { size: row?.size ?? "cottage", site: row?.site };
        return {
          size: row?.size ?? "cottage", site: row?.site, kind: u,
          ...(row?.plots ? { plots: row.plots } : {}), ...(row?.value ? { value: row.value } : {}), ...(row?.cluster ? { cluster: true } : {}),
        };
      });
      // Layout is a pure function of its stream key and the plan, and it is the
      // slow part, so edits that rebuild the town reuse it.
      const terrain = s.get<Terrain>("terrain") ?? "farmland";
      const { shape, market, suburbs } = ctx.town.settings.design ?? {};
      const designed = street ? { ...(shape ? { shape } : {}), ...(market ? { market } : {}), ...(suburbs ? { suburbs } : {}) } : {};
      const layoutPlan = s.get<LayoutPlan | undefined>("layoutPlan") ?? "radial";
      const farBank = s.get<FarBank | undefined>("farBank") ?? "village";
      const farUses = s.get<number[] | undefined>("farUses") ?? [];
      const key = `${ctx.town.seed}|${s.address}|${layout.version}|${terrain}|${layoutPlan}|${farBank}|${JSON.stringify(farUses)}|${JSON.stringify(designed)}|${JSON.stringify(footprints)}`;
      let map = cache.get(key);
      if (!map && street) {
        const encl = s.get<string>("enclosure");
        const enclosure: Enclosure = /wall/.test(encl) ? "wall" : /palisade/.test(encl) ? "palisade" : /hedge|bank/.test(encl) ? "hedge" : "none";
        // The room estimate is rough. When it falls short, buildings find no plot and
        // would be lost, so lay the town out again, roomier, from the same stream.
        // A grown town grows its streets to fit, so a short one needs a bigger step to come right.
        // A town short of room grows by as much as it came up short: ground goes with the square of the radius.
        for (let room = 1, tries = 0; ; tries++) {
          const opts = { scale: s.get<Scale>("sizeClass"), enclosure, roads: s.get<number>("mainRoads"), terrain, ...designed, ...(room > 1 ? { room } : {}) };
          // The "radial" plan is the organic one now: blocks grown round the market.
          const form = layoutPlan === "radial" ? "organic" : layoutPlan;
          map = layoutGrown(ctx.rng(s, "river"), footprints, { ...opts, form, ...(BANKED.includes(form) ? { farBank } : {}), far: farUses, need: 0 });
          if (map.buildings.length >= footprints.length || room > 1.5 || (BLOCKED.includes(form) && tries >= 3)) break;
          // (Towns not yet on blocks keep their old steps, which their suburbs' overflow is tuned to.)
          room = BLOCKED.includes(form) ? Math.min(1.55, Math.max(room + 0.08, room * Math.sqrt(footprints.length / Math.max(1, map.buildings.length)) * 1.04)) : room + 0.15;
        }
        cache.set(key, map);
        if (cache.size > 16) cache.delete(cache.keys().next().value!);
      }
      if (!map) {
        map = layoutHamlet(ctx.rng(s, "hamlet"), footprints, terrain);
        cache.set(key, map);
        if (cache.size > 16) cache.delete(cache.keys().next().value!);
      }
      const { buildings, ...rest } = map;
      ctx.set(s, "map", rest);
      // Wards: one entity each, for panels, names and (later) gossip.
      const wards = (map as TownLayout).wards;
      if (wards) for (const w of wards) {
        ctx.create("ward", s.address, wardId(w.id), {
          index: w.id, kind: w.kind, valueClass: w.value, quarter: w.quarter, centre: w.centre, compass: w.compass,
          adjacent: w.adj.map((a) => `${s.address}/ward:${wardId(a)}`), near: w.near, ...(w.bank ? { bank: w.bank } : {}),
        });
      }
      // Number buildings in placement order, which is deterministic.
      buildings.forEach((b, n) => {
        ctx.create("building", s.address, buildingId(n), {
          planIndex: b.planIndex, poly: b.poly, parts: b.parts, plot: b.plot, plotKind: b.plotKind, front: b.front, road: b.road,
          ...(b.ward !== undefined ? { ward: b.ward, block: b.block } : {}),
        });
      });
    },
  },
};

export type MapData = Omit<HamletLayout, "buildings"> & Partial<Omit<TownLayout, keyof HamletLayout>>;

// ---- where things are -------------------------------------------------------

import type { Town } from "../../core/town";
import { centroid, dist, type Poly, type Pt } from "./geom";

const byUse = new WeakMap<Town, Map<string, { a: string; p: Pt }[]>>();
const nearMemo = new WeakMap<Town, Map<string, string | undefined>>();

/** Is this settlement laid out as streets (a big village, town or city)? */
export function isStreetPlan(town: Town): boolean {
  return town.settlement().get<MapData>("map")?.kind === "town";
}

/** Every building with one of these uses, and where it stands. */
export function buildingsOfUse(town: Town, uses: string[]): { a: string; p: Pt }[] {
  let m = byUse.get(town);
  if (!m) byUse.set(town, (m = new Map()));
  const k = uses.join(",");
  let l = m.get(k);
  if (!l) {
    l = [];
    for (const b of town.children(town.root, "building")) if (uses.includes(b.get<string>("use"))) l.push({ a: b.address, p: centroid(b.get<Poly>("poly")) });
    m.set(k, l);
  }
  return l;
}

/** The `k` nearest buildings of these uses to a building, nearest first. */
export function nearestBuildings(town: Town, from: string, uses: string[], k: number): string[] {
  const at = centroid(town.get(from).get<Poly>("poly"));
  const best: { a: string; d: number }[] = [];
  for (const x of buildingsOfUse(town, uses)) {
    const d = dist(at, x.p);
    if (best.length < k || d < best[best.length - 1].d) {
      best.push({ a: x.a, d });
      best.sort((p, q) => p.d - q.d || (p.a < q.a ? -1 : 1));
      if (best.length > k) best.pop();
    }
  }
  return best.map((x) => x.a);
}

/** Floor area of a building's footprint, in square yards (near enough). */
export function footprint(poly: Poly): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s / 2);
}

// People per square yard of ground floor, standing or sitting, by use.
const DENSITY: Record<string, number> = {
  grand_temple: 1.6, temple: 1.6, fane: 1.6, chapel: 1.6, chantry: 0.6, shrine: 0.3, friary: 1, priory: 0.8, cell: 0.4, abbey: 1, nunnery: 0.5,
  tavern: 0.9, town_alehouse: 0.9, alehouse: 0.9, inn: 0.7, cookshop: 0.6, bathhouse: 0.4, market_hall: 1.5, guildhall: 1.2, courthouse: 1.4,
};

/** How many people a building holds before they spill out of the door. */
export function capacityOf(town: Town, b: string): number {
  const e = town.get(b);
  const storeys = e.get<number>("storeys") ?? 1;
  const d = DENSITY[e.get<string>("use")] ?? 0.4;
  return Math.max(6, Math.round(footprint(e.get<Poly>("poly")) * d * (1 + 0.4 * (storeys - 1))));
}

/** The nearest building of one of these uses to a building. */
export function nearestBuilding(town: Town, from: string, uses: string[]): string | undefined {
  let m = nearMemo.get(town);
  if (!m) nearMemo.set(town, (m = new Map()));
  const k = `${from}|${uses.join(",")}`;
  if (m.has(k)) return m.get(k);
  const at = centroid(town.get(from).get<Poly>("poly"));
  let best: string | undefined, bd = Infinity;
  for (const x of buildingsOfUse(town, uses)) { const d = dist(at, x.p); if (d < bd) { bd = d; best = x.a; } }
  m.set(k, best);
  return best;
}
