// Hamlet and village layout (L1). Our own generator, written from scratch.
//
// The model is the English street village: one main road with a side road
// meeting it at a green, a stream crossed by a ford, house plots ("tofts")
// fronting the roads with long gardens ("crofts") behind, a hedge round the
// whole, and three great open fields beyond, cut into furlongs of strips.
//
// Other terrains change the country around that core: a coast with a beach
// and boats, moorland with folds, hills with mine workings, or forest with
// charcoal clamps. Outside farmland there is only a small infield.

import { PI, TAU, cos, sin, q } from "../../core/dmath";
import type { Rng } from "../../core/rng";
import {
  add, along, len, area, centroid, convexHull, convexOverlap, dot, mul, norm, perp, pointInPoly,
  nearLine, project, qp, qpoly, rayExit, rect, sub, type Poly, type Pt,
} from "./geom";

export interface Footprint {
  size: string;
  site?: string;
  /** street-plan layouts: how many plots of frontage it takes */
  plots?: number;
  /** street-plan layouts: the ward value classes it suits (0 slum .. 8 prestige commercial) */
  value?: [number, number];
  /** street-plan layouts: which use this is, so copies can be spread out or kept together */
  kind?: string;
  /** keep copies together (a shambles of butchers, a row of goldsmiths) instead of spread out */
  cluster?: boolean;
}

export interface PlacedBuilding {
  planIndex: number;
  poly: Poly;
  parts: { kind: string; poly: Poly }[];
  plot?: Poly;
  plotKind?: "croft" | "churchyard" | "yard" | "bailey" | "precinct";
  front: Pt;
  road?: string;
  /** street-plan layouts: index into the layout's wards */
  ward?: number;
  block?: string;
}

export type Terrain = "farmland" | "coast" | "moor" | "hills" | "forest";

export interface Feature {
  kind: string;
  p: Pt;
  poly?: Poly;
}

export interface Road {
  id: string;
  kind: "road" | "lane" | "track";
  width: number;
  points: Pt[];
}

export interface FieldPiece {
  field: number;
  poly: Poly;
  stripes: number;
  /** the lord's own strips, worked by his villeins */
  demesne?: boolean;
}

export interface HamletLayout {
  bounds: [number, number, number, number];
  roads: Road[];
  stream: { width: number; points: Pt[] };
  ford: Pt;
  green: Poly;
  hedge: Poly;
  fields: FieldPiece[];
  greatFields: { crop: string; label: Pt }[];
  meadow: Pt[];
  woods: Poly[];
  features: Feature[];
  terrain: Terrain;
  /** the coastline, sea on its `coastSide` side */
  coast?: Pt[];
  sea?: Poly;
  contours?: Poly[];
  buildings: PlacedBuilding[];
}

interface Spec { w: number; d: number; plotDepth: number; gap: number }

function spec(r: Rng, size: string): Spec {
  switch (size) {
    case "farm": return { w: r.range(13, 16), d: r.range(5.5, 6.5), plotDepth: r.range(38, 52), gap: r.range(9, 14) };
    case "shop": return { w: r.range(9, 11), d: r.range(6.5, 7.5), plotDepth: r.range(18, 26), gap: r.range(2, 4) };
    case "inn": return { w: r.range(12, 14), d: r.range(6.5, 7.5), plotDepth: r.range(20, 28), gap: r.range(4, 7) };
    case "workshop": return { w: r.range(7.5, 9), d: r.range(5.5, 6.5), plotDepth: r.range(16, 24), gap: r.range(2, 5) };
    case "yard": return { w: r.range(11, 14), d: r.range(5.5, 6.5), plotDepth: r.range(22, 30), gap: r.range(5, 8) };
    case "ropewalk": return { w: r.range(36, 44), d: 4, plotDepth: 10, gap: 3 };
    case "manor": return { w: r.range(17, 20), d: r.range(7.5, 9), plotDepth: r.range(55, 70), gap: r.range(14, 20) };
    default: return { w: r.range(7.5, 10), d: r.range(4.5, 5.5), plotDepth: r.range(20, 32), gap: r.range(2, 6) };
  }
}

/** A gently wandering polyline through `c` along `u`, from -l0 to +l1. */
function wander(r: Rng, c: Pt, u: Pt, l0: number, l1: number, amp: number, step = 8): Pt[] {
  const v = perp(u);
  const w1 = r.range(60, 120), w2 = r.range(25, 45), p1 = r.range(0, TAU), p2 = r.range(0, TAU);
  const a1 = amp * r.range(0.6, 1), a2 = amp * r.range(0.15, 0.35);
  const off = (s: number) => a1 * (sin(s / w1 + p1) - sin(p1)) + a2 * (sin(s / w2 + p2) - sin(p2));
  const pts: Pt[] = [];
  for (let s = -l0; s <= l1 + 1e-9; s += step) pts.push(qp(add(add(c, mul(u, s)), mul(v, off(s)))));
  return pts;
}

function dir(a: number): Pt {
  return [cos(a), sin(a)];
}

/** A rough blob, for woods. */
function blob(r: Rng, c: Pt, rad: number): Poly {
  const n = 14;
  const out: Poly = [];
  const ph = r.range(0, TAU), ph2 = r.range(0, TAU);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const k = 1 + 0.22 * sin(2 * a + ph) + 0.12 * sin(5 * a + ph2) + r.range(-0.08, 0.08);
    out.push(qp(add(c, mul(dir(a), rad * k))));
  }
  return out;
}

function chaikin(poly: Poly, rounds: number): Poly {
  let p = poly;
  for (let k = 0; k < rounds; k++) {
    const out: Poly = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      out.push(add(mul(a, 0.75), mul(b, 0.25)), add(mul(a, 0.25), mul(b, 0.75)));
    }
    p = out;
  }
  return qpoly(p);
}

interface Frontier {
  road: Road;
  /** +1 walks toward the road's end, -1 toward its start */
  sign: 1 | -1;
  /** which side of the road: +1 is the left of the road's direction */
  side: 1 | -1;
  origin: number;
  cursor: number;
  facesGreen: boolean;
  exhausted: boolean;
}

/** A small boat hauled up, pointing along `u`. */
function boat(c: Pt, u: Pt, len: number): Poly {
  const v = perp(u), h = len / 2, w = len * 0.17;
  return qpoly([add(c, mul(u, h)), add(add(c, mul(u, h * 0.3)), mul(v, w)), add(add(c, mul(u, -h)), mul(v, w * 0.8)),
    add(add(c, mul(u, -h)), mul(v, -w * 0.8)), add(add(c, mul(u, h * 0.3)), mul(v, -w))]);
}

export function layoutHamlet(r: Rng, plan: Footprint[], terrain: Terrain = "farmland"): HamletLayout {
  const specs = plan.map((p) => spec(r, p.size));
  const frontage = specs.reduce((s, x) => s + x.w + x.gap, 0);
  const L = Math.max(70, frontage / (0.55 * 5.6));

  // Roads and stream. J, the junction, is the origin.
  const J: Pt = [0, 0];
  const a0 = r.range(-0.5, 0.5);
  const uMain = dir(a0);
  const far = L * 2.6 + 120;
  const main: Road = { id: "main", kind: "road", width: 6, points: wander(r, J, uMain, far, far, L * 0.12) };
  const mainJ = far; // arc length of J along main.points (wander starts at -far)

  const sideSign = r.chance(0.5) ? 1 : -1;
  const sideAngle = a0 + sideSign * r.range(PI * 0.36, PI * 0.62);
  const uSide = dir(sideAngle);
  const side: Road = { id: "side", kind: "lane", width: 4.5, points: wander(r, J, uSide, 0, far, L * 0.08) };

  const crossAt = (r.chance(0.5) ? 1 : -1) * r.range(0.45, 0.7) * L;
  const X = along(main.points, mainJ + crossAt).p;
  const streamAngle = a0 + PI / 2 + r.range(-0.35, 0.35);
  const stream = { width: 3.5, points: wander(r, X, dir(streamAngle), far, far, L * 0.25, 6) };

  // The coast runs alongside the main road, on the far side from the lane.
  let coast: Pt[] | undefined;
  const coastSide = -sideSign;
  if (terrain === "coast") {
    // Follow the road's own bends at a wandering distance, so the road never gets wet.
    const off = r.range(30, 40), w = r.range(40, 70), ph = r.range(0, TAU);
    coast = main.points.map((p, i) => {
      const a = main.points[Math.max(0, i - 1)], b = main.points[Math.min(main.points.length - 1, i + 1)];
      const n = mul(norm(perp(sub(b, a))), coastSide);
      return qp(add(p, mul(n, off + 6 * sin(i * 8 / w + ph))));
    });
  }
  const seaward = (at: number): Pt => mul(perp(along(coast!, at).t), coastSide);
  const inSea = (p: Pt): boolean => {
    if (!coast) return false;
    const a = along(coast, project(coast, p));
    return dot(sub(p, a.p), mul(perp(a.t), coastSide)) > 0;
  };

  // The green sits in one of the two angles the side road makes with the main road.
  // The wider of the two angles, so the green has room.
  const greenToward = dot(uSide, uMain) > 0 ? -1 : 1;
  const g = r.range(26, 38);
  const gm = along(main.points, mainJ + greenToward * g).p;
  const gs = along(side.points, g * 0.95).p;
  const bis = norm(add(norm(sub(gm, J)), norm(sub(gs, J))));
  const offRoad = (rd: Road, s: number): Pt => {
    const a = along(rd.points, s);
    let n = perp(a.t);
    if (dot(n, bis) < 0) n = mul(n, -1);
    return add(a.p, mul(n, rd.width / 2 + 2.5));
  };
  const green: Poly = qpoly(convexHull([
    add(J, mul(bis, 7)),
    offRoad(main, mainJ + greenToward * g * 0.45),
    offRoad(main, mainJ + greenToward * g),
    add(J, mul(bis, g * 1.25)),
    offRoad(side, g * 0.95),
    offRoad(side, g * 0.45),
  ]));
  const greenFar = add(J, mul(bis, g * 1.25));

  const solids: Poly[] = [];
  const plots: Poly[] = [];

  const clearOf = (p: Poly, extra = 0): boolean => {
    if (coast && (p.some(inSea) || nearLine(coast, p, 7 + extra))) return false;
    for (const rd of [main, side]) if (nearLine(rd.points, p, rd.width / 2 + 0.6 + extra)) return false;
    if (nearLine(stream.points, p, stream.width / 2 + 1.5 + extra)) return false;
    if (convexOverlap(p, green, 0.5)) return false;
    for (const s of solids) if (convexOverlap(p, s, 1)) return false;
    return true;
  };
  const plotOk = (p: Poly): boolean => {
    if (coast && (p.some(inSea) || nearLine(coast, p, 3))) return false;
    for (const rd of [main, side]) if (nearLine(rd.points, p, rd.width / 2 + 0.3)) return false;
    if (nearLine(stream.points, p, stream.width / 2 + 0.5)) return false;
    if (convexOverlap(p, green, 0)) return false;
    for (const s of solids) if (convexOverlap(p, s, 0.5)) return false;
    for (const s of plots) if (convexOverlap(p, s, -0.3)) return false;
    return true;
  };

  // Frontiers walk outward from the junction along each side of each road.
  const sideOfGreen = (rd: Road, sign: number, s: 1 | -1): boolean => {
    const t = along(rd.points, rd === main ? mainJ + sign * 10 : 10);
    const n = mul(perp(t.t), s);
    return dot(n, bis) > 0 && (rd === side || sign === greenToward);
  };
  const frontiers: Frontier[] = [];
  for (const sign of [1, -1] as const) for (const s of [1, -1] as const) {
    frontiers.push({ road: main, sign, side: s, origin: mainJ, cursor: side.width / 2 + 2, facesGreen: sideOfGreen(main, sign, s), exhausted: false });
  }
  for (const s of [1, -1] as const) {
    frontiers.push({ road: side, sign: 1, side: s, origin: 0, cursor: main.width / 2 + 2, facesGreen: sideOfGreen(side, 1, s), exhausted: false });
  }
  let builtLength = L;

  const tryFrontier = (f: Frontier, i: number, sp: Spec, size: string): PlacedBuilding | undefined => {
    while (f.cursor < builtLength) {
      if (r.chance(0.08)) f.cursor += r.range(4, 14);
      const s0 = f.origin + f.sign * f.cursor;
      const s1 = f.origin + f.sign * (f.cursor + sp.w + sp.gap);
      const mid = along(f.road.points, (s0 + s1) / 2);
      const t = f.sign === 1 ? mid.t : mul(mid.t, -1);
      const n = norm(mul(perp(mid.t), f.side));
      const setback = f.road.width / 2 + r.range(1.2, 3.5);
      const front = add(mid.p, mul(n, setback));
      const along0 = r.range(-sp.gap / 3, sp.gap / 3);
      const hc = add(add(front, mul(n, sp.d / 2)), mul(t, along0));
      const house = rect(hc, t, sp.w, sp.d);
      const parts: { kind: string; poly: Poly }[] = [];
      if (size === "farm") {
        const bw = r.range(10, 14), bd = r.range(5.5, 6.5);
        const back = r.range(9, 14);
        const shift = r.range(-2, 2);
        parts.push({ kind: "barn", poly: rect(add(add(front, mul(n, sp.d + back + bd / 2)), mul(t, shift)), t, bw, bd) });
        if (r.chance(0.5)) parts.push({ kind: "byre", poly: rect(add(add(front, mul(n, sp.d + 5)), mul(t, (sp.w / 2 + 2.5) * (r.chance(0.5) ? 1 : -1))), perp(t), 7, 4.5) });
      } else if (size === "manor") {
        // The great barn behind the hall, and a dovecote, which only a lord may keep.
        parts.push({ kind: "barn", poly: rect(add(front, mul(n, sp.d + r.range(14, 20) + 4.5)), t, r.range(20, 26), 9) });
        parts.push({ kind: "dovecote", poly: rect(add(add(front, mul(n, sp.d + 6)), mul(t, sp.w / 2 + 3)), t, 4, 4) });
      } else if (size === "inn") {
        parts.push({ kind: "brewhouse", poly: rect(add(front, mul(n, sp.d + 6)), t, 6, 4.5) });
      }
      const all = [house, ...parts.map((p) => p.poly)];
      const plotW = sp.w + sp.gap;
      const plotC = (depth: number) => add(add(front, mul(n, depth / 2)), mul(t, 0));
      if (all.every((p) => clearOf(p))) {
        let plot: Poly | undefined;
        for (const depth of [sp.plotDepth, sp.plotDepth * 0.7, Math.max(sp.d + 4, sp.plotDepth * 0.45)]) {
          const cand = rect(plotC(depth), t, plotW, depth);
          if (plotOk(cand) && parts.every((p) => pointInPoly(centroid(p.poly), cand))) { plot = cand; break; }
        }
        if (plot) {
          solids.push(...all);
          plots.push(plot);
          f.cursor += plotW;
          return {
            planIndex: i, poly: qpoly(house), parts: parts.map((p) => ({ kind: p.kind, poly: qpoly(p.poly) })),
            plot: qpoly(plot), plotKind: size === "farm" || size === "manor" ? "yard" : "croft", front: qp(front), road: f.road.id,
          };
        }
      }
      f.cursor += 3;
    }
    f.exhausted = true;
    return undefined;
  };

  const placeByStream = (i: number, startOff: number, wheel: boolean): PlacedBuilding | undefined => {
    const sx = project(stream.points, X);
    for (let k = 0; k < 40; k++) {
      const off = (k % 2 ? -1 : 1) * (startOff + 4 * Math.floor(k / 2));
      const sideK = Math.floor(k / 4) % 2 ? 1 : -1;
      const a = along(stream.points, sx + off);
      const n = mul(perp(a.t), sideK);
      const w = r.range(9, 11), d = r.range(7, 8.5);
      const c = add(a.p, mul(n, stream.width / 2 + 2 + d / 2));
      const mill = rect(c, a.t, w, d);
      if (!clearOf(mill, 0)) continue;
      const yard = rect(add(c, mul(n, 4)), a.t, w + 10, d + 14);
      if (!wheel && !plotOk(yard)) continue;
      solids.push(mill);
      plots.push(yard);
      const parts = wheel ? [{ kind: "wheel", poly: qpoly(rect(add(a.p, mul(n, stream.width / 2 - 0.4)), a.t, 4, 1.4)) }] : [{ kind: "vats", poly: qpoly(rect(add(c, mul(n, d / 2 + 3)), a.t, w * 0.6, 3)) }];
      return { planIndex: i, poly: qpoly(mill), parts, plot: qpoly(yard), plotKind: "yard", front: qp(a.p) };
    }
    return undefined;
  };

  const placeChurch = (i: number, small: boolean): PlacedBuilding | undefined => {
    const gc = centroid(green);
    if (small) {
      // A shrine stands on the green itself, at its far corner.
      const p = add(greenFar, mul(norm(sub(gc, greenFar)), 6));
      const shrine = rect(p, [1, 0], 3.5, 3.5);
      solids.push(shrine);
      return { planIndex: i, poly: qpoly(shrine), parts: [], front: qp(p) };
    }
    const dirs: Pt[] = [];
    for (let k = 0; k < 24; k++) dirs.push(dir((k / 24) * TAU));
    dirs.sort((a, b) => dot(b, bis) - dot(a, bis));
    for (const d of dirs) for (let k = 0; k < 6; k++) {
      const c = add(gc, mul(d, g * 0.55 + 14 + k * 4));
      const yard = rect(c, [1, 0], 28, 20);
      if (!plotOk(yard) || !clearOf(yard, 0.5)) continue;
      // Chapels face east whatever the road does: chancel on the +x end.
      const nave = rect(add(c, [-2, 0]), [1, 0], 13, 6.5);
      const chancel = rect(add(c, [7, 0]), [1, 0], 5, 4.5);
      solids.push(nave, chancel);
      plots.push(yard);
      return { planIndex: i, poly: qpoly(nave), parts: [{ kind: "chancel", poly: qpoly(chancel) }], plot: qpoly(yard), plotKind: "churchyard", front: qp(c) };
    }
    return undefined;
  };

  // A boatwright's yard sits on the beach, a slipway running down into the water.
  const placeShore = (i: number): PlacedBuilding | undefined => {
    if (!coast) return undefined;
    const s0 = project(coast, J);
    for (let k = 0; k < 40; k++) {
      const at = s0 + (k % 2 ? -1 : 1) * (10 + 5 * Math.floor(k / 2));
      const a = along(coast, at), n = seaward(at);
      const w = r.range(11, 14), d = r.range(6, 7);
      const c = add(a.p, mul(n, -(5 + d / 2)));
      const shed = rect(c, a.t, w, d);
      if (shed.some(inSea) || [main, side].some((rd) => nearLine(rd.points, shed, rd.width / 2 + 1)) || solids.some((x) => convexOverlap(shed, x, 1))) continue;
      const slip = rect(add(a.p, mul(n, 3)), n, 12, 3.5);
      const yard = rect(add(c, mul(n, -2)), a.t, w + 8, d + 8);
      solids.push(shed);
      plots.push(yard);
      return { planIndex: i, poly: qpoly(shed), parts: [{ kind: "slipway", poly: qpoly(slip) }], plot: qpoly(yard), plotKind: "yard", front: qp(a.p) };
    }
    return undefined;
  };

  // Specials with a site go first, so they get the good spots.
  const order = plan.map((_, i) => i).sort((a, b) => (plan[a].site ? 0 : 1) - (plan[b].site ? 0 : 1) || a - b);
  const result: (PlacedBuilding | undefined)[] = [];
  for (const i of order) {
    const p = plan[i];
    let b: PlacedBuilding | undefined;
    if (p.site === "stream") b = placeByStream(i, 14, true);
    else if (p.site === "downstream") b = placeByStream(i, L * 0.75, false);
    else if (p.site === "shore") b = placeShore(i);
    else if (p.site === "green") b = placeChurch(i, p.size === "shrine");
    for (let tries = 0; !b && tries < 12; tries++) {
      let cands = frontiers.filter((f) => !f.exhausted);
      if (p.site === "junction") cands = cands.filter((f) => f.road === side && !f.facesGreen);
      else if (p.site === "main_road") cands = cands.filter((f) => f.road === main && !f.facesGreen);
      else if (p.site === "green") cands = cands.filter((f) => f.facesGreen);
      if (!cands.length) cands = frontiers.filter((f) => !f.exhausted);
      if (!cands.length) {
        builtLength += 30;
        for (const f of frontiers) f.exhausted = false;
        continue;
      }
      // Grow evenly: the frontier with the least built so far, with a little noise.
      // Edge trades (sawpits, colliers) go to whichever end is furthest out.
      cands.sort((a, b) => a.cursor * (a.road === side ? 1.25 : 1) - b.cursor * (b.road === side ? 1.25 : 1));
      if (p.site === "edge") cands.reverse();
      const f = cands.length > 1 && r.chance(0.3) ? cands[1] : cands[0];
      b = tryFrontier(f, i, specs[i], p.size);
    }
    result[i] = b;
  }
  const buildings = result.filter((b): b is PlacedBuilding => !!b);

  // Hedge round everything built.
  const pts: Pt[] = [];
  for (const b of buildings) {
    pts.push(...b.poly, ...(b.plot ?? []));
    for (const p of b.parts) pts.push(...p.poly);
  }
  pts.push(...green);
  // A star-shaped outline that follows the crofts: the furthest point in each
  // angular bin around the centre, smoothed, plus a margin for the hedge bank.
  const hc = centroid(convexHull(pts));
  const bins = 40;
  const radius: number[] = new Array(bins).fill(0);
  for (const p of pts) {
    const v = sub(p, hc);
    // atan2 without Math.atan2: bin by comparing against bin directions.
    let best = 0, bestDot = -Infinity;
    for (let k = 0; k < bins; k++) {
      const dd = dot(norm(v), dir((k / bins) * TAU));
      if (dd > bestDot) { bestDot = dd; best = k; }
    }
    radius[best] = Math.max(radius[best], dot(v, dir((best / bins) * TAU)));
  }
  const filled = radius.map((_, k) => Math.max(radius[(k + bins - 1) % bins], radius[k], radius[(k + 1) % bins]));
  const smooth = filled.map((_, k) => (filled[(k + bins - 1) % bins] + 2 * filled[k] + filled[(k + 1) % bins]) / 4);
  const outline: Poly = smooth.map((rad, k) => add(hc, mul(dir((k / bins) * TAU), Math.max(rad, 12) + 6)));
  const hedge = chaikin(outline, 2);

  // Fields start a little beyond the hedge, following a smoother, fuller line,
  // which leaves closes and rough pasture in the hollows.
  const fieldHull = convexHull(hedge);
  const fieldEdge = (a: number): number => rayExit(hc, dir(a), fieldHull) + 16;

  // Farmland: three great fields in rotation, cut into furlongs of strips.
  // Elsewhere: a small infield of two, cropped every year.
  const open = terrain === "farmland";
  const manorial = plan.some((p) => p.size === "manor");
  const nFields = open ? 3 : 2;
  const rings = open ? 2 : 1;
  const crops = open ? r.shuffle(["wheat", "barley and oats", "fallow"]) : r.shuffle(["oats", "barley"]);
  const cuts = [r.range(0, TAU)];
  if (open) {
    cuts.push(cuts[0] + r.range(0.28, 0.38) * TAU);
    cuts.push(cuts[1] + r.range(0.28, 0.38) * TAU);
  } else cuts.push(cuts[0] + r.range(0.4, 0.6) * TAU);
  const band = (open ? r.range(70, 95) : r.range(40, 55)) * Math.max(1, Math.sqrt(plan.length / 45));
  const fields: FieldPiece[] = [];
  const greatFields: { crop: string; label: Pt }[] = [];
  let outer = 0;
  for (let fi = 0; fi < nFields; fi++) {
    const a0f = cuts[fi], a1f = fi === nFields - 1 ? cuts[0] + TAU : cuts[fi + 1];
    const nf = Math.max(2, Math.round((a1f - a0f) / 0.5));
    for (let k = 0; k < nf; k++) {
      const s0 = a0f + ((a1f - a0f) * k) / nf + 0.012, s1 = a0f + ((a1f - a0f) * (k + 1)) / nf - 0.012;
      for (let ring = 0; ring < rings; ring++) {
        const poly: Poly = [];
        const steps = 5;
        const rIn = (a: number) => fieldEdge(a) + ring * band;
        const rOut = (a: number) => fieldEdge(a) + (ring + 1) * band - 3;
        for (let j = 0; j <= steps; j++) { const a = s0 + ((s1 - s0) * j) / steps; poly.push(add(hc, mul(dir(a), rIn(a)))); }
        for (let j = steps; j >= 0; j--) { const a = s0 + ((s1 - s0) * j) / steps; const ro = rOut(a); outer = Math.max(outer, ro); poly.push(add(hc, mul(dir(a), ro))); }
        if (area(poly) < 200 || (coast && (poly.some(inSea) || nearLine(coast, poly, 6)))) continue;
        const mida = (s0 + s1) / 2;
        const stripes = r.chance(0.5) ? mida : mida + PI / 2;
        // A lord's demesne lay scattered in strips among his tenants'.
        const demesne = manorial && open && (k + ring) % 3 === 0;
        fields.push({ field: fi, poly: qpoly(poly), stripes: q((stripes * 180) / PI + r.range(-12, 12)), ...(demesne ? { demesne } : {}) });
      }
    }
    const la = (a0f + a1f) / 2;
    greatFields.push({ crop: crops[fi], label: qp(add(hc, mul(dir(la), fieldEdge(la) + band))) });
  }

  // Woods beyond the fields, and the common waste.
  const woods: Poly[] = [];
  const nw = r.int(2, 4);
  for (let k = 0; k < nw; k++) {
    const a = r.range(0, TAU);
    woods.push(blob(r, add(hc, mul(dir(a), outer + r.range(40, 90))), r.range(45, 80)));
  }
  const extraFeatures: Feature[] = [];
  const tracks: Road[] = [];
  let contours: Poly[] | undefined;
  const t = r; // farmland never reaches the branches below, so its draws are unchanged
  if (terrain === "coast") {
    // Drop woods that fell in the sea; boats hauled up on the beach.
    for (let k = woods.length - 1; k >= 0; k--) if (inSea(centroid(woods[k]))) woods.splice(k, 1);
    const s0 = project(coast!, J);
    const nb = t.int(4, 9);
    for (let k = 0; k < nb; k++) {
      const at = s0 + t.range(-L * 0.6, L * 0.6);
      const a = along(coast!, at), n = seaward(at);
      const c = add(a.p, mul(n, t.range(-3.5, -1.5)));
      if (solids.some((x) => pointInPoly(c, x))) continue;
      extraFeatures.push({ kind: "boat", p: qp(c), poly: boat(c, norm(add(n, mul(a.t, t.range(-0.3, 0.3)))), t.range(5, 7)) });
    }
    const nr = t.int(2, 4);
    for (let k = 0; k < nr; k++) {
      const at = s0 + t.range(-L * 0.5, L * 0.5);
      const a = along(coast!, at), n = seaward(at);
      extraFeatures.push({ kind: "racks", p: qp(add(a.p, mul(n, -9))), poly: qpoly(rect(add(a.p, mul(n, -9)), a.t, 8, 1.2)) });
    }
  } else if (terrain === "moor") {
    woods.splice(t.int(0, 1));
    const nf = t.int(4, 7);
    for (let k = 0; k < nf; k++) extraFeatures.push({ kind: "fold", p: qp(add(hc, mul(dir(t.range(0, TAU)), outer + t.range(25, 160)))) });
  } else if (terrain === "hills") {
    woods.splice(t.int(1, 2));
    const ah = t.range(0, TAU);
    const hill = add(hc, mul(dir(ah), outer + 110));
    const shape = blob(t, [0, 0], 1);
    contours = [50, 95, 140, 185].map((rad) => qpoly(shape.map((p) => add(hill, mul(p, rad)))));
    const na = t.int(2, 4);
    for (let k = 0; k < na; k++) {
      const p = add(hill, mul(dir(ah + PI + t.range(-0.9, 0.9)), t.range(70, 130)));
      extraFeatures.push({ kind: "adit", p: qp(p) });
      extraFeatures.push({ kind: "spoil", p: qp(p), poly: blob(t, add(p, mul(dir(t.range(0, TAU)), 9)), t.range(7, 12)) });
      const start = add(hc, mul(norm(sub(p, hc)), rayExit(hc, norm(sub(p, hc)), convexHull(hedge))));
      tracks.push({ id: `track${k}`, kind: "track", width: 2.2, points: wander(t, mul(add(start, p), 0.5), norm(sub(p, start)), len(sub(p, start)) / 2, len(sub(p, start)) / 2, 6, 6) });
    }
  } else if (terrain === "forest") {
    woods.length = 0;
    const n = 16;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU + t.range(-0.1, 0.1);
      woods.push(blob(t, add(hc, mul(dir(a), outer + t.range(30, 70))), t.range(55, 85)));
    }
    for (let k = 0; k < 6; k++) {
      const w = t.pick(woods);
      extraFeatures.push({ kind: "clamp", p: qp(add(centroid(w), mul(dir(t.range(0, TAU)), t.range(0, 25)))) });
    }
  }

  // The meadow is the stream's flood strip through the fields.
  const meadow = stream.points;

  const gc = centroid(green);
  const features = [
    { kind: "well", p: qp(add(gc, mul(bis, -3))) },
    { kind: "stocks", p: qp(add(gc, mul(perp(bis), 5))) },
  ];
  if (pointInPoly(features[1].p, green) === false) features[1].p = qp(gc);
  features.push(...extraFeatures);

  const extent = outer + 160;
  return {
    bounds: [q(hc[0] - extent), q(hc[1] - extent), q(extent * 2), q(extent * 2)],
    roads: [main, side, ...tracks],
    stream,
    ford: qp(X),
    green,
    hedge,
    fields,
    greatFields,
    meadow,
    woods,
    features,
    terrain,
    ...(coast ? { coast, sea: seaPoly(coast, coastSide, extent * 3) } : {}),
    ...(contours ? { contours } : {}),
    buildings,
  };
}

function seaPoly(coast: Pt[], side: number, reach: number): Poly {
  const a = coast[0], b = coast[coast.length - 1];
  const n0 = mul(norm(perp(sub(coast[1], a))), side * reach);
  const n1 = mul(norm(perp(sub(b, coast[coast.length - 2]))), side * reach);
  return qpoly([...coast, add(b, n1), add(a, n0)]);
}
