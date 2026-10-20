import type { Module } from "../../core/types";
import type { BuildingUse } from "../uses";
import { layoutHamlet, type HamletLayout, type Terrain } from "./hamlet";
import { layoutTown, type Enclosure, type Scale, type TownLayout } from "./town";
import { STREET_PLAN_POP } from "../uses";

export type { HamletLayout, PlacedBuilding } from "./hamlet";
export type { TownLayout, WardGeo } from "./town";
export { VALUE_CLASSES } from "./town";

const cache = new Map<string, HamletLayout>();

export function wardId(n: number): string {
  return `w${n.toString().padStart(2, "0")}`;
}

export function buildingId(n: number): string {
  return `b${n.toString().padStart(3, "0")}`;
}

/** L1: the map. Places one building per planned use and creates them as stubs. */
export const layout: Module = {
  id: "layout",
  version: "1.0.0",
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
      const key = `${ctx.town.seed}|${s.address}|${layout.version}|${terrain}|${JSON.stringify(footprints)}`;
      let map = cache.get(key);
      if (!map && street) {
        const encl = s.get<string>("enclosure");
        const enclosure: Enclosure = /wall/.test(encl) ? "wall" : /palisade/.test(encl) ? "palisade" : /hedge|bank/.test(encl) ? "hedge" : "none";
        map = layoutTown(ctx.rng(s, "town"), footprints, {
          scale: s.get<Scale>("sizeClass"), enclosure, roads: s.get<number>("mainRoads"), terrain,
        });
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
          adjacent: w.adj.map((a) => `${s.address}/ward:${wardId(a)}`), near: w.near,
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
