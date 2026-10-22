// Street-plan pieces both layouts share: the types they hand to the rest of
// the generator, and the helpers that cut plots and set buildings on them.
// Moved verbatim from the radial plan; the river plan builds on them too.

import { TAU, cos, sin } from "../../core/dmath";
import type { Rng } from "../../core/rng";
import type { FarBank } from "../../core/types";
import { add, centroid, dist, dot, len, mul, norm, perp, qp, qpoly, sub, type Poly, type Pt } from "./geom";
import type { Footprint, HamletLayout, PlacedBuilding } from "./hamlet";

export type Scale = "thorp" | "village" | "town" | "city";
export type Enclosure = "wall" | "palisade" | "hedge" | "none";
/** What a street front is like. Commercial uses want the first few. */
export type FrontKind = "market" | "main" | "quay" | "street" | "lane" | "wall" | "suburb";
export const PRIORITY: Record<FrontKind, number> = { market: 6, main: 5, quay: 4, street: 3, lane: 2, wall: 1, suburb: 0 };
export interface WardGeo {
  id: number;
  kind: "intramural" | "suburb";
  /** index into VALUE_CLASSES */
  value: number;
  quarter: number;
  centre: Pt;
  /** compass point of the ward from the market, "N", "NE", ... */
  compass: string;
  sector: number;
  ring: number;
  adj: number[];
  /** features the namer can use */
  near: string[];
  /** a river town: which bank the ward is on */
  bank?: "near" | "far";
}
export const VALUE_CLASSES = [
  "slum", "low residential", "low commercial", "moderate residential", "moderate commercial",
  "high residential", "high commercial", "prestige residential", "prestige commercial",
];
export interface TownLayout extends HamletLayout {
  kind: "town";
  scale: Scale;
  enclosure: Enclosure;
  wall: { line: Pt[]; closed: boolean; towers: Pt[]; gates: { p: Pt; t: Pt; road: string }[] };
  market: Poly;
  gardens: Poly[];
  wards: WardGeo[];
  bridges: Pt[];
  quay?: Pt[];
  castle?: Poly;
  /** how the streets were laid out */
  plan?: "radial" | "river";
  /** a river town: what lies over the bridge */
  farBank?: FarBank;
  /** a river town: the high ground, for shading */
  high?: Poly[];
  /** river towns: the old village's green over the bridge */
  farGreen?: Poly;
}

/** A plot: front-left, front-right, back-right, back-left. */
export interface Plot {
  id: number;
  /** front-left, front-right, back-right, back-left */
  poly: Poly;
  kind: FrontKind;
  ward: number;
  run: number;
  idx: number;
  block: string;
  ring: number;
  used: boolean;
  /** sort key: lower is taken first */
  order: number;
}

export const COMPASS = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];

export function compassOf(v: Pt): string {
  // Screen y runs south. Bin by comparing against the eight directions.
  let best = 0, bestDot = -Infinity;
  for (let k = 0; k < 8; k++) {
    const d = dot(norm(v), [cos((k / 8) * TAU), sin((k / 8) * TAU)]);
    if (d > bestDot) { bestDot = d; best = k; }
  }
  return COMPASS[best];
}

export const dirOf = (a: number): Pt => [cos(a), sin(a)];

export function plotsFor(fp: Footprint): number {
  if (fp.plots) return fp.plots;
  switch (fp.size) {
    case "inn": case "yard": case "farm": case "merchant": case "warehouse": return 2;
    case "manor": case "hall": return 3;
    default: return 1;
  }
}

export function isSuburbFp(p: Footprint, coast: boolean): boolean {
  return p.site === "suburb" || p.site === "edge" || (p.site === "shore" && !coast);
}

export function nearestWard(wards: WardGeo[], p: Pt): number {
  let best = 0, bd = Infinity;
  for (const w of wards) { const d = dist(p, w.centre); if (d < bd) { bd = d; best = w.id; } }
  return best;
}

/** A building on one plot or a run of them: on the street front, yard behind. */
export function building(r: Rng, i: number, fp: Footprint, ps: Plot[], urban: boolean): PlacedBuilding {
  const first = ps[0], last = ps[ps.length - 1];
  const fl = first.poly[0], fr = last.poly[1], br = last.poly[2], bl = first.poly[3];
  const plot = qpoly([fl, fr, br, bl]);
  const plotD = (dist(fl, bl) + dist(fr, br)) / 2;
  const plotW = (dist(fl, fr) + dist(bl, br)) / 2;
  const at = (a: Pt, b: Pt, t: number): Pt => add(a, mul(sub(b, a), t));
  let poly: Poly;
  const parts: { kind: string; poly: Poly }[] = [];
  if (urban) {
    // Walls abutting, fronts on the street, yard behind (LF pp.10-11).
    const k = Math.min(0.8, Math.max(0.3, r.range(9, 13) / plotD));
    poly = [fl, fr, at(fr, br, k), at(fl, bl, k)];
    if (fp.size === "inn" || fp.size === "merchant" || fp.size === "warehouse" || fp.size === "yard") {
      // A back range down one side of the yard: stables, a warehouse, a workshop.
      const side = r.chance(0.5);
      const a0 = side ? fl : at(fl, fr, 0.65), a1 = side ? at(fl, fr, 0.35) : fr;
      const b0 = side ? bl : at(bl, br, 0.65), b1 = side ? at(bl, br, 0.35) : br;
      parts.push({ kind: "range", poly: qpoly([at(a0, b0, k + 0.08), at(a1, b1, k + 0.08), at(a1, b1, 0.92), at(a0, b0, 0.92)]) });
    }
  } else {
    // Village crofts: a house set back a little, narrower than its plot.
    const inset = Math.min(0.25, 2.5 / Math.max(plotW, 1));
    const k0 = Math.min(0.2, r.range(1, 3) / plotD), k1 = Math.min(0.5, k0 + r.range(5, 7) / plotD);
    const L = at(fl, fr, inset), R = at(fl, fr, 1 - inset), LB = at(bl, br, inset), RB = at(bl, br, 1 - inset);
    poly = [at(L, LB, k0), at(R, RB, k0), at(R, RB, k1), at(L, LB, k1)];
    if (fp.size === "farm" || fp.size === "manor" || fp.size === "yard") {
      const k2 = Math.min(0.85, k1 + r.range(8, 12) / plotD), k3 = Math.min(0.95, k2 + r.range(5, 7) / plotD);
      parts.push({ kind: "barn", poly: qpoly([at(L, LB, k2), at(R, RB, k2), at(R, RB, k3), at(L, LB, k3)]) });
    }
  }
  return {
    planIndex: i, poly: qpoly(poly), parts, plot, plotKind: urban ? "yard" : "croft",
    front: qp(at(fl, fr, 0.5)), road: first.kind, ward: first.ward, block: first.block,
  };
}

/** Shrink a block outline toward its centre by roughly `d` metres. */
export function insetOutline(p: Poly, d: number): Poly {
  const c = centroid(p);
  return qpoly(p.map((v) => {
    const u = sub(v, c);
    const l = len(u);
    return l < d * 2 ? v : add(c, mul(u, (l - d) / l));
  }));
}

export function blob(r: Rng, c: Pt, rad: number): Poly {
  const n = 14;
  const out: Poly = [];
  const ph = r.range(0, TAU), ph2 = r.range(0, TAU);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const kk = 1 + 0.22 * sin(2 * a + ph) + 0.12 * sin(5 * a + ph2) + r.range(-0.08, 0.08);
    out.push(qp(add(c, mul(dirOf(a), rad * kk))));
  }
  return out;
}

export function boatPoly(c: Pt, u: Pt, l: number): Poly {
  const v = perp(u);
  return [add(c, mul(u, l / 2)), add(add(c, mul(u, l * 0.2)), mul(v, l * 0.18)), add(add(c, mul(u, -l / 2)), mul(v, l * 0.14)),
    add(add(c, mul(u, -l / 2)), mul(v, -l * 0.14)), add(add(c, mul(u, l * 0.2)), mul(v, -l * 0.18))];
}


/** How wide the market is (as a radius): it grows with the town, and on market day a fifth of the place is in it.
 *  The radial plan's own formula, shared. */
export function marketSize(o: { scale: Scale; market?: "small" | "large" }, need: number): number {
  const urban = o.scale === "town" || o.scale === "city";
  const base = urban ? 20 + 0.55 * Math.sqrt(need * 6) : o.scale === "village" ? 20 + 0.42 * Math.sqrt(need * 6) : 18 + 0.3 * Math.sqrt(need * 6);
  return base * (o.market === "small" ? 0.7 : o.market === "large" ? 1.5 : 1);
}

/** A church's nave length and width, by kind. */
export const CHURCH_SIZE: Record<string, [number, number]> = {
  grand_temple: [64, 20], temple: [38, 13], fane: [26, 10], chapel: [16, 7.5], chantry: [11, 6], shrine: [5, 4],
};
