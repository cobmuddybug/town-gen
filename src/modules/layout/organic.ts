// The organic plan's streets: the town is cut into blocks by the edges of cells grown from seeds,
// small near the market and larger towards the edge, so the streets meet at odd angles and the
// blocks come in every shape. The main roads run between pairs of seeds, so they lie along cell
// edges and the blocks either side front them. A cell edge that runs straight up a slope is a lane.
// (Voronoi cells are a textbook construction; written fresh here and in geom.ts.)

import { TAU, cos, sin } from "../../core/dmath";
import type { Rng } from "../../core/rng";
import { add, dist, mul, norm, perp, pointInPoly, segPointDist, sub, voronoiCells, type Poly, type Pt } from "./geom";

export interface OrganicIn {
  /** the market's middle, and the market itself (no street crosses it) */
  centre: Pt;
  market: Poly;
  /** how far the town reaches */
  radius: number;
  /** the main roads already laid, which the cells must flank */
  roads: Pt[][];
  height: (p: Pt) => number;
  /** water, or anywhere else no street may go */
  wet: (p: Pt) => boolean;
  /** "long" and "oval" stretch the town along an axis */
  shape?: "round" | "oval" | "long" | "street";
  /** the bearing an oval or long town stretches along; at random when absent */
  axis?: number;
  streetW: number;
  laneW: number;
}

export interface OrganicStreet { points: Pt[]; lane: boolean }

/** How far apart block seeds are at a distance from the market: 35-60 m at the core, 70-110 at the edge. */
function spacing(r: Rng, t: number): number {
  const core = r.range(35, 60), edge = r.range(70, 110);
  return core + (edge - core) * Math.min(1, Math.max(0, t));
}

/** Where segment p0-p1 meets q0-q1, as a fraction along p0-p1; undefined if they don't. */
function segHit(p0: Pt, p1: Pt, q0: Pt, q1: Pt): number | undefined {
  const r = sub(p1, p0), s = sub(q1, q0), den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return undefined;
  const w = sub(q0, p0), t = (w[0] * s[1] - w[1] * s[0]) / den, u = (w[0] * r[1] - w[1] * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : undefined;
}

export function organicStreets(r: Rng, o: OrganicIn): { streets: OrganicStreet[]; seeds: Pt[]; outline: Poly } {
  const { centre, radius: R } = o;
  // The town's outline: a disc, or stretched along an axis for an oval or a long town.
  const axis0 = r.range(0, TAU), axis = o.axis ?? axis0;
  // (A street town is one street: long, and only a block or two deep either side of it.)
  const [sx, sy] = o.shape === "street" ? [1.2, 0.6] : o.shape === "long" ? [1.7, 0.6] : o.shape === "oval" ? [1.25, 0.8] : [1, 1];
  const u: Pt = [cos(axis), sin(axis)], v = perp(u);
  const fromLocal = (x: number, y: number): Pt => add(centre, add(mul(u, x * sx), mul(v, y * sy)));
  const clip: Poly = [];
  for (let i = 0; i < 48; i++) clip.push(fromLocal(cos((i / 48) * TAU) * R * 1.05, sin((i / 48) * TAU) * R * 1.05));
  const inTown = (p: Pt) => pointInPoly(p, clip);
  const nearRoad = (p: Pt, d: number) => o.roads.some((rd) => rd.some((q, i) => i + 1 < rd.length && segPointDist(p, q, rd[i + 1]) < d));

  // Seeds in pairs either side of each road, a block length apart.
  const seeds: Pt[] = [];
  for (const rd of o.roads) {
    let walked = 0, next = 0;
    for (let i = 0; i + 1 < rd.length; i++) {
      const a = rd[i], b = rd[i + 1], L = dist(a, b);
      while (next <= walked + L) {
        const p = add(a, mul(sub(b, a), (next - walked) / L));
        const t = dist(p, centre) / R;
        if (t > 1.05) break;
        const s = spacing(r, t);
        const n = norm(perp(sub(b, a)));
        if (!pointInPoly(p, o.market)) for (const sg of [1, -1]) {
          const q = add(p, mul(n, (sg * s) / 2));
          if (inTown(q)) seeds.push(q);
        }
        next += s;
      }
      walked += L;
    }
  }
  // A street town's blocks front its great street: seeds along it, half a block out, a block apart.
  const nearMarket = (p: Pt, d: number) => o.market.some((q, k) => segPointDist(p, q, o.market[(k + 1) % o.market.length]) < d);
  if (o.shape === "street") {
    const ring = [...o.market, o.market[0]];
    let walked = 0, next = r.range(10, 30);
    for (let i = 0; i + 1 < ring.length; i++) {
      const a = ring[i], b = ring[i + 1], L = dist(a, b);
      while (next <= walked + L) {
        const p = add(a, mul(sub(b, a), (next - walked) / L));
        // Wide along the street and shallow behind it, so the street front is the block's long side.
        const s = spacing(r, dist(p, centre) / R);
        const n = norm(perp(sub(b, a)));
        for (const sg of [1, -1]) {
          const q = add(p, mul(n, sg * s * 0.4));
          if (!pointInPoly(q, o.market) && inTown(q) && !o.wet(q) && !nearMarket(q, s * 0.25) && !seeds.some((x) => dist(x, q) < s * 0.6)) seeds.push(q);
        }
        next += s * 1.7;
      }
      walked += L;
    }
  }
  // The rest in jittered rings from the market outward: from its nearest side, as a long market
  // (a street town's) reaches nearly to the town's ends; seeds in the market itself are skipped.
  const marketR = Math.min(...o.market.map((p, i) => segPointDist(centre, p, o.market[(i + 1) % o.market.length])));
  for (let rho = marketR + 25; rho < R * 1.05;) {
    const s = spacing(r, rho / R);
    const k = Math.max(5, Math.round((TAU * rho) / s));
    const a0 = r.range(0, TAU);
    for (let i = 0; i < k; i++) {
      const a = a0 + ((i + r.range(-0.3, 0.3)) / k) * TAU;
      const rr = rho + r.range(-0.25, 0.25) * s;
      const p = fromLocal(cos(a) * rr, sin(a) * rr);
      if (!inTown(p) || pointInPoly(p, o.market) || o.wet(p)) continue;
      // Leave the roads to their pairs.
      if (nearRoad(p, s * 0.45) || seeds.some((q) => dist(q, p) < s * 0.55) || (o.shape === "street" && nearMarket(p, s * 0.7))) continue;
      seeds.push(p);
    }
    rho += s * r.range(0.8, 1);
  }

  // Cell edges, each once.
  const cells = voronoiCells(seeds, clip);
  const key = (p: Pt) => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;
  const seen = new Set<string>();
  const out: OrganicStreet[] = [];
  const onRim = (p: Pt) => clip.some((c, i) => segPointDist(p, c, clip[(i + 1) % clip.length]) < 0.5);
  for (const c of cells) for (let i = 0; i < c.length; i++) {
    let a = c[i], b = c[(i + 1) % c.length];
    if (dist(a, b) < 3) continue;
    const k = [key(a), key(b)].sort().join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    // The town's edge is no street, nor is a stub running out to it: the outer blocks back onto fields.
    if (onRim(a) || onRim(b)) continue;
    const mid = mul(add(a, b), 0.5);
    if (pointInPoly(mid, o.market) || o.wet(mid) || o.wet(a) || o.wet(b)) continue;
    // An edge along a road is the road itself.
    const s = spacing(r, dist(mid, centre) / R);
    if (nearRoad(mid, s * 0.3)) continue;
    // Ends near a road meet it.
    const snap = (p: Pt): Pt => {
      let best = p, bd = s * 0.3;
      for (const rd of o.roads) for (let j = 0; j + 1 < rd.length; j++) {
        const d = segPointDist(p, rd[j], rd[j + 1]);
        if (d < bd) {
          const e = sub(rd[j + 1], rd[j]);
          const t = Math.max(0, Math.min(1, ((p[0] - rd[j][0]) * e[0] + (p[1] - rd[j][1]) * e[1]) / (e[0] * e[0] + e[1] * e[1])));
          bd = d; best = add(rd[j], mul(e, t));
        }
      }
      return best;
    };
    a = snap(a); b = snap(b);
    // An end inside the market stops at its edge: the market's own edge is the street there.
    const ain = pointInPoly(a, o.market), bin = pointInPoly(b, o.market);
    if (ain && bin) continue;
    if (ain || bin) {
      const [p0, p1] = ain ? [b, a] : [a, b];
      let t = 1;
      o.market.forEach((q, k) => { const x = segHit(p0, p1, q, o.market[(k + 1) % o.market.length]); if (x !== undefined && x < t) t = x; });
      const cut = add(p0, mul(sub(p1, p0), t));
      if (dist(p0, cut) < 6) continue;
      if (ain) a = cut; else b = cut;
    }
    out.push({ points: [a, b], lane: false });
  }
  // Straight up the slope, much steeper than the town's streets mostly run: a lane, or steps.
  const slope = (e: OrganicStreet) => Math.abs(o.height(e.points[0]) - o.height(e.points[1])) / Math.max(1, dist(e.points[0], e.points[1]));
  const sorted = out.map(slope).sort((x, y) => x - y);
  const median = sorted[sorted.length >> 1] ?? 0;
  const steep = sorted[Math.floor(sorted.length * 0.92)] ?? Infinity;
  for (const e of out) e.lane = median > 0 && slope(e) >= steep && slope(e) > median * 1.5;
  return { streets: out, seeds, outline: clip };
}
