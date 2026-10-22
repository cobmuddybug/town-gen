// River towns (L1): a town grown at a bridge, lopsided across its river. Our
// own generator, written from scratch.
//
// The model: the town proper sits on the higher bank. A high street climbs
// from the bridge to a market where the roads in meet, a triangle or a
// widened street, never a central square. Main roads wander out from it along
// the easy ground; back lanes run behind the plots and water lanes drop to the
// river. Over the bridge lies a smaller, older place with a character of its
// own: an old village, a bridge-end, an abbey's side or a wharf side.

import { PI, TAU, atan2, cos, hypot, q, sin } from "../../core/dmath";
import type { Rng } from "../../core/rng";
import type { FarBank } from "../../core/types";
import { add, centroid, convexHull, convexOverlap, dot, mul, perp, pointInPoly, polylinePolyDist, qp, qpoly, rect, segPointDist, sub, type Poly, type Pt } from "./geom";
import type { Feature, FieldPiece, Footprint, PlacedBuilding, Road } from "./hamlet";
import { CHURCH_SIZE, blob, building, compassOf, insetOutline, marketSize, nearestWard, plotsFor, type FrontKind, type Plot, type TownLayout, type WardGeo } from "./streets";
import { heightField } from "./height";
import type { TownOpts } from "./radial";

export interface RiverOpts extends TownOpts {
  farBank: FarBank;
  /** plots the dominant bank needs */
  need: number;
  /** plots the far bank needs */
  farNeed?: number;
}

export interface RiverSite {
  height: (p: Pt) => number;
  /** the river's centreline, upstream to downstream */
  river: Pt[];
  width: number;
  /** which side of the river (sideOf) the town proper stands on */
  near: 1 | -1;
  bridge: { p: Pt; t: Pt };
  /** the town proper's high point, near the river: castle or chief church */
  high: Pt;
  /** half-width of the whole map */
  extent: number;
  /** the town proper's radius */
  radius: number;
  /** on the coast: the sea is everything with p·n > d */
  sea?: { n: Pt; d: number };
}

const dirOf = (a: number): Pt => [cos(a), sin(a)];
const urbanOf = (o: TownOpts) => o.scale === "town" || o.scale === "city";

/** How far the town proper reaches from its market, for this many plots. */
export function townRadius(o: TownOpts, need: number): number {
  const plotArea = urbanOf(o) ? 6.75 * 28 : o.scale === "village" ? 8.75 * 28 : 13.5 * 32;
  // Streets and lanes take about as much ground again as the plots.
  return Math.sqrt((Math.max(need, 30) * plotArea * 3.4) / PI) * (o.room ?? 1);
}

/** Which side of a polyline a point is on: the sign of the cross product with its nearest segment. */
export function sideOf(line: Pt[], p: Pt): 1 | -1 {
  let best = Infinity, sign: 1 | -1 = 1;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1], ab = sub(b, a), ap = sub(p, a);
    const t = Math.max(0, Math.min(1, dot(ap, ab) / Math.max(1e-9, dot(ab, ab))));
    const q = add(a, mul(ab, t)), d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
    if (d < best) { best = d; sign = ab[0] * ap[1] - ab[1] * ap[0] >= 0 ? 1 : -1; }
  }
  return sign;
}

/** The river, the lie of the land, the bridge and the high point. */
export function riverSite(r: Rng, o: RiverOpts): RiverSite {
  const R = townRadius(o, o.need);
  const extent = R * 2.6 + 200;
  const width = urbanOf(o) ? r.range(12, 18) : r.range(7, 10);
  const theta = r.range(0, TAU);
  const u = dirOf(theta), n = perp(u);
  // Meanders: three sine terms along the river's course.
  const amp = extent * r.range(0.08, 0.15);
  const waves = [0.55, 0.3, 0.15].map((w) => ({ a: amp * w, l: extent * r.range(0.25, 0.6) * (w + 0.5), p: r.range(0, TAU) }));
  const wob = (t: number) => waves.reduce((s, w) => s + w.a * sin(t / w.l + w.p), 0);
  // The river passes the town proper at a little distance: the town is on the -n side of the line.
  const off = Math.max(R * r.range(0.3, 0.42), amp * 1.4 + width * 3);
  const river: Pt[] = [];
  const step = extent / 40;
  for (let t = -extent * 1.1; t <= extent * 1.1 + 1e-6; t += step) river.push(add(mul(u, t), mul(n, off + wob(t) - wob(0))));
  if (r.chance(0.5)) river.reverse(); // which way it flows
  // Rises and hollows about the size of the town itself, so the streets that follow them bend.
  const base = heightField(r, R * 1.4);
  // The land rises from the river towards the town and falls away beyond it.
  const tilt = r.range(0.18, 0.3);
  const height = (p: Pt) => base(p) * 0.6 + tilt * Math.max(-1, Math.min(1, -dot(p, n) / (extent * 0.6)));
  const near = sideOf(river, [0, 0]);
  // The high point: the highest ground on the near bank within reach of the river and the market.
  let high: Pt = mul(n, off * 0.5), hBest = -Infinity;
  for (let i = 0; i < 64; i++) {
    const p: Pt = add(mul(u, r.range(-0.6, 0.6) * R), mul(n, off - r.range(0.25, 0.9) * off));
    if (sideOf(river, p) !== near) continue;
    const h = height(p);
    if (h > hBest) { hBest = h; high = p; }
  }
  // The bridge: where the river comes closest to the town, nudged up or down stream.
  const along = r.range(-0.2, 0.2) * R;
  let bi = 0, bd = Infinity;
  const aim = add(mul(u, along), mul(n, off));
  river.forEach((p, i) => { const d = (p[0] - aim[0]) ** 2 + (p[1] - aim[1]) ** 2; if (d < bd) { bd = d; bi = i; } });
  const i0 = Math.max(0, bi - 1), i1 = Math.min(river.length - 1, bi + 1);
  const t = sub(river[i1], river[i0]);
  const tl = hypot(t[0], t[1]) || 1;
  const bridge = { p: river[bi], t: [t[0] / tl, t[1] / tl] as Pt };
  let sea: RiverSite["sea"];
  let line = river;
  if (o.terrain === "coast") {
    // The sea beyond the river's mouth, downstream.
    const down = sub(river[river.length - 1], river[0]);
    const dl = hypot(down[0], down[1]) || 1;
    const sn: Pt = [down[0] / dl, down[1] / dl];
    sea = { n: sn, d: Math.max(R * 1.3, dot(bridge.p, sn) + R * 0.9) };
    line = river.filter((p) => dot(p, sn) <= sea!.d);
  }
  return { height, river: line, width, near, bridge, high, extent, radius: R, sea };
}

// ---- streets ------------------------------------------------------------------

export type StreetKind = "high" | "main" | "street" | "back" | "cross" | "water" | "far" | "quay";
export interface Street { id: string; kind: StreetKind; width: number; points: Pt[]; bank: "near" | "far" }
export interface StreetNet {
  streets: Street[];
  market: Pt[];
  gates: { p: Pt; t: Pt; road: string }[];
  /** the town wall, an open line whose ends meet the river; absent when unwalled */
  wallLine?: Pt[];
  /** the far bank's own place: the old village's green or the abbey's precinct */
  farPlace?: Pt[];
  /** where the market's streets come in: the high street's end, and its heading */
  marketAt: Pt;
  plotDepth: number;
  /** river crossings: the first is the town's bridge */
  bridges: Pt[];
}

const norm2 = (v: Pt): Pt => { const l = hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const rot = (v: Pt, a: number): Pt => { const c = cos(a), s = sin(a); return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]; };
const angleOf = (v: Pt) => atan2(v[1], v[0]);
const d2 = (a: Pt, b: Pt) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** Distance from a point to a polyline. */
function lineDist(line: Pt[], p: Pt): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) best = Math.min(best, segPointDist(p, line[i], line[i + 1]));
  return best;
}

/** A polyline pushed sideways by `d` (positive: to its left). */
function offsetLine(line: Pt[], d: number): Pt[] {
  return line.map((p, i) => {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    const t = norm2(sub(b, a));
    return add(p, mul([-t[1], t[0]], d));
  });
}

/** Grow the town's streets from its bridge, over its ground. */
export function riverStreets(r: Rng, site: RiverSite, o: RiverOpts): StreetNet {
  const urban = urbanOf(o);
  const walled = o.enclosure === "wall" || o.enclosure === "palisade";
  const R = site.radius;
  // Burgage plots: long and narrow, longer than in the crowded radial towns.
  const depth = urban || o.scale === "village" ? r.range(24, 32) : r.range(28, 36);
  const mainW = urban ? 7 : 6, laneW = urban ? 3 : 3.5;
  const streets: Street[] = [];
  const pushStreet = streets.push.bind(streets);
  streets.push = (...xs: Street[]) => { for (const x of xs) sGrid.addLine(x.points, x); return pushStreet(...xs); };
  const bank = (p: Pt) => sideOf(site.river, p);
  const riverGrid = new SegGrid<0>(60);
  riverGrid.addLine(site.river, 0);
  const riverDist = (p: Pt, within: number) => riverGrid.dist(p, within);
  // The sea, on the coast: everything beyond the river's mouth.
  const inSea = (p: Pt, margin = 0) => !!site.sea && dot(p, site.sea.n) > site.sea.d - margin;
  const wet = (p: Pt, margin = 2) => inSea(p, margin) || riverDist(p, site.width / 2 + margin + 1) < site.width / 2 + margin || bank(p) !== site.near;
  // Every street, as it is laid, in a grid: the growing streets ask what is near.
  const sGrid = new SegGrid<Street>(40);
  // A lane between two points that stays out of the water.
  const dry = (a: Pt, b: Pt) => !wet(b, 0) && !wet(mul(add(a, b), 0.5), 0) && bank(a) === bank(b);
  // Which way is "into town" from the bridge: away from the river, on the near side.
  const into = norm2(sub([0, 0], site.bridge.p));
  const foot = add(site.bridge.p, mul(into, site.width / 2 + 3));

  // 1. The high street climbs from the bridge foot, by the easiest rise that still heads into town.
  const high: Pt[] = [site.bridge.p, foot];
  let h = into;
  const want = hypot(foot[0], foot[1]) * r.range(0.8, 1.05);
  for (let walked = 0; walked < want; walked += 18) {
    const at = high[high.length - 1];
    let best = h, bs = -Infinity;
    for (let k = -3; k <= 3; k++) {
      const c = rot(h, (k * 35 * PI) / 180 / 3);
      const p = add(at, mul(c, 18));
      if (wet(p, 4)) continue;
      const s = site.height(p) * 4 + dot(c, into) * 0.6 + r.range(-0.15, 0.15);
      if (s > bs) { bs = s; best = c; }
    }
    h = norm2(add(mul(h, 0.5), mul(best, 0.5)));
    high.push(add(at, mul(h, 18)));
  }
  const M = high[high.length - 1];
  const d = norm2(sub(M, high[Math.max(0, high.length - 4)]));
  const side = perp(d);
  streets.push({ id: "high", kind: "high", width: mainW + 1, points: high, bank: "near" });

  // 2. The market: a long triangle opening from the high street, or the street itself widened.
  const S = marketSize(o, o.need) * 1.35;
  let market: Pt[];
  let exits: Pt[];
  if (r.chance(0.5)) {
    const L = S * r.range(1.9, 2.4), Wd = S * r.range(0.55, 0.75), skew = r.range(-0.25, 0.25);
    const a = M, b = add(add(M, mul(d, L)), mul(side, Wd * (1 + skew))), c = add(add(M, mul(d, L * r.range(0.85, 1))), mul(side, -Wd * (1 - skew)));
    market = [a, b, c];
    exits = [b, c, add(mul(add(b, c), 0.5), mul(d, 2))];
  } else {
    const L = S * r.range(2.4, 3), w0 = S * 0.35, w1 = S * r.range(0.55, 0.8);
    const e = add(M, mul(d, L));
    market = [add(M, mul(side, w0)), add(add(M, mul(d, L * 0.5)), mul(side, w1)), add(e, mul(side, w0 * 0.9)), add(e, mul(side, -w0 * 0.9)), add(add(M, mul(d, L * 0.5)), mul(side, -w1)), add(M, mul(side, -w0))];
    exits = [e, market[1], market[4]];
  }
  const centre = mul(market.reduce((s, p) => add(s, p), [0, 0] as Pt), 1 / market.length);

  // 3. Main roads: unevenly spaced bearings in the arc away from the bridge, wandering along the easy ground.
  const k = Math.max(1, o.roads - 1);
  const back = angleOf(mul(d, -1));
  const free = TAU - (80 * PI) / 180, minGap = (35 * PI) / 180;
  const w = Array.from({ length: k + 1 }, () => r.range(0.3, 1.7));
  const wt = w.reduce((a, b) => a + b, 0);
  const spare = Math.max(0, free - (k + 1) * minGap);
  const bearings: number[] = [];
  let acc = back + (40 * PI) / 180;
  for (let i = 0; i < k; i++) { acc += minGap + (spare * w[i]) / wt; bearings.push(acc); }
  // The roads run out as far as the suburbs along them: the DM's "many" sends them further.
  const reach = R * (walled ? 1.75 : 1.6) * (o.suburbs === "many" ? 1.45 : o.suburbs === "few" ? 0.85 : 1);
  bearings.forEach((b, i) => {
    const dir0 = rot([1, 0], b);
    // Leave from the market exit nearest this bearing.
    let start = exits[0], sb = -Infinity;
    for (const x of exits) { const s = dot(norm2(sub(x, centre)), dir0); if (s > sb) { sb = s; start = x; } }
    const pts: Pt[] = [start];
    let hd = dir0, bend = r.range(-0.05, 0.05);
    while (d2(pts[pts.length - 1], centre) < reach * reach && pts.length < 200) {
      const at = pts[pts.length - 1];
      bend = Math.max(-0.12, Math.min(0.12, bend + r.range(-0.04, 0.04)));
      // Of three headings, the one that climbs least.
      let next = rot(hd, bend), nb = Infinity;
      for (const t of [-0.15, 0, 0.15]) {
        const c = rot(hd, bend + t);
        const p = add(at, mul(c, 22));
        const cost = Math.abs(site.height(p) - site.height(at)) * 40 + Math.abs(t) * 0.5 + (wet(p, 6) ? 100 : 0);
        if (cost < nb) { nb = cost; next = c; }
      }
      let p = add(at, mul(next, 22));
      // Never into the river: turn along the bank instead.
      for (let tries = 0; wet(p, 6) && tries < 8; tries++) {
        next = rot(next, (tries % 2 ? -1 : 1) * 0.25 * (tries + 1));
        p = add(at, mul(next, 22));
      }
      if (wet(p, 6)) break;
      hd = norm2(add(mul(hd, 0.6), mul(next, 0.4)));
      pts.push(p);
    }
    if (pts.length > 2) streets.push({ id: `main${i}`, kind: "main", width: mainW, points: pts, bank: "near" });
  });

  // 3b. Side streets: branch off the streets already there, bend a little, and
  // join the next street they meet, until there is frontage enough for the town.
  const streetW = urban ? 4.5 : 5;
  const plotW = urban ? 6.75 : o.scale === "village" ? 8.75 : 13.5;
  // Only the inner reach of a main road counts: its outer length becomes ribbons along the road,
  // and a town that counted it would be three spokes from a market with nothing between.
  const inner2 = (R * 0.55) ** 2;
  let frontSum = streets.filter((x) => x.kind !== "far").reduce((t, x) => t + polyLen(x.points.filter((p) => d2(p, centre) < inner2)), 0) * 2;
  const frontage = () => frontSum;
  // Junctions, lanes and corners lose plots: only about two-fifths of a street's frontage ends up built on.
  const wantFront = o.need * plotW * 2.6 * (o.room ?? 1) ** 2;
  const block = depth * 2 + laneW + 4;
  let sn = 0;
  // Which way the ground runs level here: side streets follow it, as streets on a slope do.
  const contour = (p: Pt, prefer: Pt): Pt => {
    const e = 4;
    const g: Pt = [site.height([p[0] + e, p[1]]) - site.height([p[0] - e, p[1]]), site.height([p[0], p[1] + e]) - site.height([p[0], p[1] - e])];
    if (hypot(g[0], g[1]) < 1e-9) return prefer;
    const c = norm2(perp(g));
    return dot(c, prefer) >= 0 ? c : mul(c, -1);
  };
  for (let tries = 0; frontage() < wantFront && tries < 300 + o.need * 2; tries++) {
    // Mostly off the main streets; now and then off a side street, for a second row.
    const parents = streets.filter((x) => x.kind === "main" || x.kind === "high" || (x.kind === "street" && r.chance(0.25)));
    const par = r.pick(parents);
    if (par.points.length < 4) continue;
    const i = r.int(1, par.points.length - 2);
    const at = par.points[i];
    if (!at || d2(at, centre) > (R * 0.92) ** 2 || pointInPoly(at, market) || lineDist(market, at) < S * 0.5) continue;
    // Not too close to another side street leaving the same street.
    if (streets.some((x) => x.kind === "street" && d2(x.points[0], at) < (block * 0.7) ** 2)) continue;
    const t = norm2(sub(par.points[i + 1], par.points[i - 1]));
    // Most side streets run along the slope; some go straight down it, which ties the rows together.
    // Off a road that itself runs along the slope, a level street would only shadow it: go down the slope instead.
    const t0 = norm2(sub(par.points[Math.min(par.points.length - 1, i + 1)], par.points[i - 1]));
    let level = r.chance(0.85);
    if (level && Math.abs(dot(contour(at, t0), t0)) > 0.8) level = false;
    const along = (p: Pt, prefer: Pt) => (level ? contour(p, prefer) : (() => { const c = contour(p, prefer); const d0 = perp(c); return dot(d0, prefer) >= 0 ? d0 : mul(d0, -1); })());
    let hd = along(at, rot(perp(t), r.chance(0.5) ? 0 : PI));
    // A street that would run along its parent is no side street.
    if (Math.abs(dot(hd, t)) > 0.8) continue;
    const pts: Pt[] = [at];
    let joined = false;
    for (let step = 0; step < 60; step++) {
      const cur = pts[pts.length - 1];
      hd = norm2(add(mul(hd, 0.6), mul(along(cur, hd), 0.4)));
      hd = rot(hd, r.range(-0.03, 0.03));
      const p = add(cur, mul(hd, 18));
      if (wet(p, depth) || d2(p, centre) > (R * 0.98) ** 2 || pointInPoly(p, market)) break;
      // Close enough to another street to make one block between: join it.
      let hit: Pt | undefined;
      for (const sg of sGrid.near(p, block)) {
        const x = sg.tag;
        if ((x === par && step < 3) || x.kind === "far" || x.kind === "back") continue;
        if (segPointDist(p, sg.a, sg.b) < block) { hit = nearestOn(x.points, p); break; }
      }
      if (hit) { if (step >= 2 && dry(cur, hit)) { pts.push(hit); joined = true; } break; }
      pts.push(p);
    }
    const len = polyLen(pts);
    if (len >= depth * 1.5 && (joined || len >= depth * 3)) {
      streets.push({ id: `street${sn++}`, kind: "street", width: streetW, points: pts, bank: "near" });
      frontSum += polyLen(pts.filter((p) => d2(p, centre) < R * R)) * 2;
    }
  }

  // 4. The wall: round the town proper at about its radius, wobbled, its ends on the river.
  let wallLine: Pt[] | undefined;
  const gates: StreetNet["gates"] = [];
  // The wall goes round what was built, close about it, not round the room the town might have had.
  // What was built: the side streets, and only the inner reach of the main roads (their outer stretches are ribbons outside the gates).
  const built = streets.filter((x) => x.kind !== "far").flatMap((x) => x.kind === "main" || x.kind === "high" ? x.points.filter((p) => d2(p, centre) < inner2) : x.points.filter((p) => d2(p, centre) < R * R));
  const reachAt = Array.from({ length: 72 }, () => 0);
  for (const p of built) {
    const k = Math.round(((atan2(p[1] - centre[1], p[0] - centre[0]) + TAU) % TAU) / TAU * 72) % 72;
    reachAt[k] = Math.max(reachAt[k], hypot(p[0] - centre[0], p[1] - centre[1]));
  }
  // Smooth over neighbours, so the wall swings round rather than zigzagging.
  const hull = reachAt.map((_, i) => Math.max(...Array.from({ length: 13 }, (_, j) => reachAt[(i + j - 6 + 72) % 72] * (1 - Math.abs(j - 6) * 0.035))));
  const meanR = hull.reduce((a, b) => a + b, 0) / 72 || R;
  const lifted = hull.map((v) => Math.max(v, meanR * 0.7));
  const wallAt = lifted.map((_, i) => {
    let t = 0;
    for (let j = -4; j <= 4; j++) t += lifted[(i + j + 72) % 72];
    return Math.max(lifted[i], t / 9) + depth + 8;
  });
  const wallR = Math.max(...wallAt);
  if (walled) {
    const ring: (Pt | undefined)[] = [];
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * TAU;
      const p = add(centre, mul([cos(a), sin(a)], wallAt[i]));
      ring.push(wet(p, depth * 0.5) ? undefined : p);
    }
    // The longest dry run of the ring: the wall runs bank to bank, and the river closes it.
    let line: Pt[] = [];
    if (ring.every(Boolean)) line = [...(ring as Pt[]), ring[0]!];
    else for (let s0 = 0; s0 < 72; s0++) {
      if (!ring[s0] || ring[(s0 + 71) % 72]) continue;
      const run: Pt[] = [];
      for (let i = 0; i < 72; i++) { const p = ring[(s0 + i) % 72]; if (!p) break; run.push(p); }
      if (run.length > line.length) line = run;
    }
    if (line.length > 5) wallLine = line;
  }
  // Gates where the main roads cross the wall (or reach the town's edge), and at the bridge foot.
  const crossing = (pts: Pt[]): { p: Pt; t: Pt } | undefined => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (wallLine) {
        for (let j = 0; j + 1 < wallLine.length; j++) {
          const x = segX(a, b, wallLine[j], wallLine[j + 1]);
          if (x) return { p: x, t: norm2(sub(b, a)) };
        }
      } else if (d2(a, centre) < wallR * wallR && d2(b, centre) >= wallR * wallR) return { p: b, t: norm2(sub(b, a)) };
    }
    return undefined;
  };
  // An open town has roads in, not gates.
  if (walled && wallLine) for (const st of streets) if (st.kind === "main") { const g = crossing(st.points); if (g) gates.push({ ...g, road: st.id }); }
  // The bridge gate stands back from the water, at the head of the bridge.
  if (walled && wallLine) gates.push({ p: add(foot, mul(into, 6)), t: into, road: "high" });

  // 5. Back lanes: a plot's depth behind every street front in town, both sides.
  const inTown = (p: Pt) => d2(p, centre) < (R * 1.02) ** 2;
  const fronts = streets.filter((s) => s.kind === "high" || s.kind === "main" || s.kind === "street");
  const backs: Street[] = [];
  for (const st of fronts) for (const sd of [1, -1]) {
    const off = offsetLine(st.points, sd * (depth + st.width / 2 + laneW / 2));
    let run: Pt[] = [];
    const flush = () => { if (run.length >= 3) backs.push({ id: `back${backs.length}`, kind: "back", width: laneW, points: run, bank: "near" }); run = []; };
    for (const p of off) {
      const clear = inTown(p) && !wet(p, 3) && !pointInPoly(p, market) && lineDist(market, p) > depth * 0.6
        && sGrid.near(p, depth + 6).every((sg) => sg.tag === st || !fronts.includes(sg.tag) || segPointDist(p, sg.a, sg.b) > depth + sg.tag.width / 2);
      if (clear) run.push(p); else flush();
    }
    flush();
  }
  streets.push(...backs);

  // 6. Cross lanes: every so often, from a back lane straight to the street its plots face.
  let cn = 0;
  const frontSet = new Set(fronts);
  const toFront = (p: Pt): Pt | undefined => {
    let best: Pt | undefined, bd = Infinity;
    for (const sg of sGrid.near(p, depth * 2 + 12)) {
      if (!frontSet.has(sg.tag)) continue;
      const q = nearestOn([sg.a, sg.b], p);
      const dd = d2(p, q);
      if (dd < bd && dry(p, q)) { bd = dd; best = q; }
    }
    return best && bd < (depth * 2 + 12) ** 2 ? best : undefined;
  };
  // Both ends of a back lane come out on a street, when one is close.
  for (const b of backs) for (const p of [b.points[0], b.points[b.points.length - 1]]) {
    const q = toFront(p);
    if (q && d2(p, q) > (depth * 1.4 + 6) ** 2) continue;
    if (q) streets.push({ id: `cross${cn++}`, kind: "cross", width: laneW, points: [p, q], bank: "near" });
  }
  for (const b of backs) {
    let next = r.range(60, 110), walked = 0;
    for (let i = 1; i < b.points.length; i++) {
      walked += hypot(b.points[i][0] - b.points[i - 1][0], b.points[i][1] - b.points[i - 1][1]);
      if (walked < next) continue;
      walked = 0; next = r.range(60, 110);
      const p = b.points[i];
      const best = toFront(p);
      if (best) streets.push({ id: `cross${cn++}`, kind: "cross", width: laneW, points: [p, best], bank: "near" });
    }
  }

  // 7. Water lanes: down to the river from the streets nearest it.
  let wn = 0;
  for (const st of [...fronts, ...backs]) {
    let since = Infinity, gap = r.range(70, 130);
    for (let i = 1; i < st.points.length; i++) {
      since += hypot(st.points[i][0] - st.points[i - 1][0], st.points[i][1] - st.points[i - 1][1]);
      const p = st.points[i];
      const rd = lineDist(site.river, p);
      if (since < gap || rd > depth * 3 || rd < site.width * 1.2) continue;
      const q = nearestOn(site.river, p);
      const dir = norm2(sub(q, p));
      const end = add(q, mul(dir, -(site.width / 2 + 1)));
      if (d2(end, site.bridge.p) < (site.width * 3) ** 2) continue;
      since = 0; gap = r.range(70, 130);
      streets.push({ id: `water${wn++}`, kind: "water", width: laneW, points: [p, end], bank: "near" });
    }
  }

  // 8. The far bank: the road over the bridge, and the far side's own pattern.
  const out = mul(into, -1);
  const farFoot = add(site.bridge.p, mul(out, site.width / 2 + 3));
  const farPts: Pt[] = [foot, site.bridge.p, farFoot];
  let fh = out;
  const farNeed = o.farNeed ?? 0;
  // The road over the bridge runs on far enough to carry its share; a bridge-end is all road.
  const farLen = o.farBank === "bridgend" ? Math.max(R * 1.2, farNeed * plotW * 0.7) : Math.max(R * 1.2, farNeed * plotW * 0.35);
  for (let i = 0; i < 200; i++) {
    const at = farPts[farPts.length - 1];
    fh = norm2(rot(fh, r.range(-0.08, 0.08)));
    const p = add(at, mul(fh, 22));
    if (bank(p) === site.near || lineDist(site.river, p) < site.width / 2 + 3) break;
    farPts.push(p);
    if (d2(p, farFoot) > farLen ** 2) break;
  }
  streets.push({ id: "far", kind: "far", width: mainW, points: farPts, bank: "far" });
  let farPlace: Pt[] | undefined;
  const onFar = (t: number) => {
    const L = Math.min(t, farPts.length - 1);
    return farPts[Math.max(3, Math.floor(L))] ?? farFoot;
  };
  if (o.farBank === "village" && farPts.length > 4) {
    // A green beside the road, a lane round it.
    const c = add(onFar(farPts.length * 0.45), mul(perp(fh), r.chance(0.5) ? 28 : -28));
    const a = r.range(30, 50), b = r.range(18, 30), rotA = r.range(0, TAU);
    farPlace = Array.from({ length: 16 }, (_, i) => add(c, rot([cos((i / 16) * TAU) * a, sin((i / 16) * TAU) * b], rotA)));
    const loop = farPlace.map((p) => add(c, mul(sub(p, c), 1 + (laneW + 2) / Math.min(a, b))));
    const join = nearestOn(farPts, loop[0]);
    streets.push({ id: "far-green", kind: "far", width: laneW, points: [join, ...loop, loop[0]], bank: "far" });
  } else if (o.farBank === "abbey" && farPts.length > 4) {
    // The precinct: a walled block beside the road.
    const c = add(onFar(farPts.length * 0.4), mul(perp(fh), 40 + depth));
    const u = fh, v = perp(fh), A = r.range(50, 80), B = r.range(40, 60);
    farPlace = [add(add(c, mul(u, -A / 2)), mul(v, -B / 2)), add(add(c, mul(u, A / 2)), mul(v, -B / 2)), add(add(c, mul(u, A / 2)), mul(v, B / 2)), add(add(c, mul(u, -A / 2)), mul(v, B / 2))];
  } else if (o.farBank === "wharf") {
    // A strand along the far bank, both ways from the bridge.
    const s1 = offsetLine(site.river, (site.near === 1 ? -1 : 1) * (site.width / 2 + 8));
    const bi = s1.reduce((bi, p, i) => (d2(p, farFoot) < d2(s1[bi], farFoot) ? i : bi), 0);
    const span = Math.max(3, Math.round(R / 2 / (site.extent / 40)));
    const strand = s1.slice(Math.max(0, bi - span), bi + span + 1).filter((p) => bank(p) !== site.near);
    if (strand.length >= 3) streets.push({ id: "far-strand", kind: "far", width: laneW + 1, points: [farFoot, ...strand.slice(strand.length >> 1)], bank: "far" },
      { id: "far-strand2", kind: "far", width: laneW + 1, points: [farFoot, ...strand.slice(0, (strand.length >> 1) + 1).reverse()], bank: "far" });
  }
  // The far bank grows side streets of its own until it has frontage for its share.
  const farWet = (p: Pt, margin = 2) => inSea(p, margin) || riverDist(p, site.width / 2 + margin + 1) < site.width / 2 + margin || bank(p) === site.near;
  let farSum = streets.filter((x) => x.bank === "far").reduce((t, x) => t + polyLen(x.points), 0) * 2;
  const farFront = () => farSum;
  const farWant = farNeed * plotW * 3.4 * (o.room ?? 1) ** 2;
  let fn = 0;
  for (let tries = 0; farFront() < farWant && tries < 400 + farNeed * 4; tries++) {
    const parents = streets.filter((x) => x.bank === "far" && x.points.length >= 4);
    if (!parents.length) break;
    const par = r.pick(parents);
    const i = r.int(2, par.points.length - 2);
    const at = par.points[i];
    if (!at || farWet(at, depth) || (farPlace && pointInPoly(at, farPlace))) continue;
    if (streets.some((x) => x.id.startsWith("farside") && d2(x.points[0], at) < block * block)) continue;
    const t = norm2(sub(par.points[Math.min(par.points.length - 1, i + 1)], par.points[i - 1]));
    let hd = contour(at, rot(perp(t), r.chance(0.5) ? 0 : PI));
    if (Math.abs(dot(hd, t)) > 0.8) hd = rot(perp(t), r.chance(0.5) ? 0 : PI);
    const pts: Pt[] = [at];
    for (let step = 0; step < 40; step++) {
      const cur = pts[pts.length - 1];
      hd = norm2(rot(add(mul(hd, 0.7), mul(contour(cur, hd), 0.3)), r.range(-0.04, 0.04)));
      const p = add(cur, mul(hd, 18));
      if (farWet(p, depth) || d2(p, farFoot) > (R * 1.9) ** 2 || (farPlace && pointInPoly(p, farPlace))) break;
      let hit: Pt | undefined;
      for (const sg of sGrid.near(p, block)) {
        const x = sg.tag;
        if (x.bank !== "far" || (x === par && step < 3)) continue;
        if (segPointDist(p, sg.a, sg.b) < block) { hit = nearestOn(x.points, p); break; }
      }
      if (hit) { if (step >= 2) pts.push(hit); break; }
      pts.push(p);
    }
    if (polyLen(pts) >= depth * 2.5) { streets.push({ id: `farside${fn++}`, kind: "far", width: streetW, points: pts, bank: "far" }); farSum += polyLen(pts) * 2; }
  }

  // On the coast, a quay along the near bank, from the bridge down to the sea.
  if (site.sea) {
    const sideSign = site.near === 1 ? 1 : -1;
    const qline = offsetLine(site.river, sideSign * (site.width / 2 + 6));
    const bi = qline.reduce((bi, p, i) => (d2(p, foot) < d2(qline[bi], foot) ? i : bi), 0);
    const down = qline.slice(bi).filter((p) => bank(p) === site.near && !(wallLine && false));
    if (down.length >= 3) streets.push({ id: "quay", kind: "quay", width: laneW + 2, points: [foot, ...down.slice(1)], bank: "near" });
  }

  // A city needs a second crossing, downstream or up.
  const bridges: Pt[] = [site.bridge.p];
  if (o.scale === "city") {
    const ri = site.river.reduce((bi, p, i) => (d2(p, site.bridge.p) < d2(site.river[bi], site.bridge.p) ? i : bi), 0);
    const span = Math.max(4, Math.round((R * 0.7) / (site.extent / 40)));
    for (const j of [ri + span, ri - span, ri + span * 1.4, ri - span * 1.4].map(Math.round)) {
      const bp = site.river[j];
      if (!bp || !site.river[j + 1] || !site.river[j - 1]) continue;
      const tt = norm2(sub(site.river[j + 1], site.river[j - 1]));
      const toNear = mul(perp(tt), dot(perp(tt), sub(centre, bp)) >= 0 ? 1 : -1);
      const nf = add(bp, mul(toNear, site.width / 2 + 3)), ff = add(bp, mul(toNear, -(site.width / 2 + 3)));
      if (bank(nf) !== site.near || bank(ff) === site.near) continue;
      let q: Pt | undefined, qd = Infinity;
      for (const f of fronts) { const c = nearestOn(f.points, nf); const dd = d2(c, nf); if (dd < qd && dry(nf, c)) { qd = dd; q = c; } }
      if (!q || qd > (R * 0.5) ** 2) continue;
      bridges.push(bp);
      streets.push({ id: "bridge2", kind: "main", width: mainW, points: [q, nf, bp], bank: "near" });
      let fq: Pt | undefined, fd = Infinity;
      for (const f of streets.filter((x) => x.bank === "far")) { const c = nearestOn(f.points, ff); const dd = d2(c, ff); if (dd < fd) { fd = dd; fq = c; } }
      streets.push({ id: "far-bridge2", kind: "far", width: mainW, points: fq && fd < (R * 0.6) ** 2 ? [bp, ff, fq] : [bp, ff, add(ff, mul(toNear, -R * 0.3))], bank: "far" });
      break;
    }
  }
  return { streets, market, gates, wallLine, farPlace, marketAt: M, plotDepth: depth, bridges };
}

/** Line segments in a grid of square cells, so "what passes near here" looks at a few cells, not the whole town. */
class SegGrid<T> {
  private cells = new Map<string, { a: Pt; b: Pt; tag: T }[]>();
  constructor(private cell: number) {}
  private key(x: number, y: number) { return `${x},${y}`; }
  add(a: Pt, b: Pt, tag: T, pad = 0): void {
    const c = this.cell;
    for (let x = Math.floor((Math.min(a[0], b[0]) - pad) / c); x <= Math.floor((Math.max(a[0], b[0]) + pad) / c); x++)
      for (let y = Math.floor((Math.min(a[1], b[1]) - pad) / c); y <= Math.floor((Math.max(a[1], b[1]) + pad) / c); y++) {
        const k = this.key(x, y);
        const l = this.cells.get(k);
        if (l) l.push({ a, b, tag }); else this.cells.set(k, [{ a, b, tag }]);
      }
  }
  addLine(pts: Pt[], tag: T, pad = 0): void { for (let i = 0; i + 1 < pts.length; i++) this.add(pts[i], pts[i + 1], tag, pad); }
  /** Segments whose cells lie within `r` of p. */
  near(p: Pt, r: number): { a: Pt; b: Pt; tag: T }[] {
    const c = this.cell, out: { a: Pt; b: Pt; tag: T }[] = [];
    const seen = new Set<{ a: Pt; b: Pt; tag: T }>();
    for (let x = Math.floor((p[0] - r) / c); x <= Math.floor((p[0] + r) / c); x++)
      for (let y = Math.floor((p[1] - r) / c); y <= Math.floor((p[1] + r) / c); y++)
        for (const sg of this.cells.get(this.key(x, y)) ?? []) if (!seen.has(sg)) { seen.add(sg); out.push(sg); }
    return out;
  }
  /** Distance to the nearest segment (Infinity beyond `r`), optionally skipping some. */
  dist(p: Pt, r: number, skip?: (t: T) => boolean): number {
    let best = Infinity;
    for (const sg of this.near(p, r)) if (!skip?.(sg.tag)) best = Math.min(best, segPointDist(p, sg.a, sg.b));
    return best;
  }
}

const polyLen = (pts: Pt[]) => pts.slice(1).reduce((t, b, i) => t + hypot(b[0] - pts[i][0], b[1] - pts[i][1]), 0);

/** The nearest point on a polyline. */
function nearestOn(line: Pt[], p: Pt): Pt {
  let best: Pt = line[0], bd = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1], ab = sub(b, a);
    const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / Math.max(1e-9, dot(ab, ab))));
    const q = add(a, mul(ab, t));
    const dd = d2(p, q);
    if (dd < bd) { bd = dd; best = q; }
  }
  return best;
}

/** Where two segments cross, if they do. */
function segX(a: Pt, b: Pt, c: Pt, e: Pt): Pt | undefined {
  const r1 = sub(b, a), s1 = sub(e, c);
  const den = r1[0] * s1[1] - r1[1] * s1[0];
  if (Math.abs(den) < 1e-9) return undefined;
  const ca = sub(c, a);
  const t = (ca[0] * s1[1] - ca[1] * s1[0]) / den, u = (ca[0] * r1[1] - ca[1] * r1[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? add(a, mul(r1, t)) : undefined;
}

// ---- the whole town ------------------------------------------------------------

/** Uses that are ordinary housing: they fill in order, and some cross to the far bank to make up its share. */
const HOUSING = new Set(["tenement", "poor_row", "journeyman_house", "townhouse", "cottage", "farmhouse", "fisher_house", "empty"]);
/** Sites with places of their own, not a plot on a street. */
const GEO = new Set(["church", "green", "precinct", "castle", "gate", "stream", "downstream", "river", "market_place"]);
const FRONTS: Record<string, FrontKind[]> = {
  market: ["market", "main", "street", "quay"],
  main_road: ["main", "market", "street", "quay"],
  junction: ["main", "street", "market"],
  street: ["street", "main", "quay"],
  lane: ["street", "main"],
  quay: ["quay", "main", "street"],
  shore: ["quay", "street", "main"],
  housing: ["street", "main", "quay", "market"],
  suburb: ["suburb"],
};
const FAMILY: Record<string, string> = { tavern: "drink", town_alehouse: "drink", alehouse: "drink", inn: "drink", cookshop: "food", bakehouse: "food" };
const CHURCH_PLOTS: Record<string, number> = { grand_temple: 8, temple: 6, fane: 4, chapel: 3, chantry: 2, shrine: 1 };

interface RPlot extends Plot { far: boolean; suburb: boolean; street: string }

/** A river town: the town proper on its higher bank, a far bank over the bridge. */
export function layoutRiver(r: Rng, plan: Footprint[], o: RiverOpts & { far: number[] }): TownLayout {
  const urban = urbanOf(o);
  const walled = o.enclosure === "wall" || o.enclosure === "palisade";
  const coastTerrain = o.terrain === "coast";

  // ---- who stands where ------------------------------------------------------
  // The far bank's signature buildings, and enough ordinary housing beside them for its share.
  const farSet = new Set(o.far);
  const n = plan.length;
  const want = Math.round(n * r.range(0.17, 0.22));
  const homesFirst = o.farBank === "village" ? ["cottage", "farmhouse", "fisher_house", "tenement", "poor_row"] : o.farBank === "bridgend" ? ["poor_row", "tenement", "cottage"] : ["tenement", "cottage", "poor_row", "journeyman_house", "farmhouse", "fisher_house"];
  for (const kind of [...homesFirst, ...HOUSING]) {
    for (let i = n - 1; i >= 0 && farSet.size < want; i--) if (!farSet.has(i) && plan[i].kind === kind) farSet.add(i);
  }
  // Never more than a quarter: the town proper keeps the rest.
  const cap = Math.floor(n * 0.23);
  if (farSet.size > cap) {
    // Drop ordinary housing first, the far bank's own signature buildings never.
    const extra = [...farSet].filter((i) => HOUSING.has(plan[i].kind ?? "")).sort((a, b) => (o.far.includes(a) ? 1 : 0) - (o.far.includes(b) ? 1 : 0) || b - a);
    extra.reverse();
    while (farSet.size > cap && extra.length) farSet.delete(extra.pop()!);
  }
  const siteOf = (p: Footprint) => (p.site === "edge" ? "suburb" : p.site);
  let needNear = 0, needFar = 0;
  plan.forEach((p, i) => {
    if (GEO.has(siteOf(p) ?? "") && !(siteOf(p) === "gate" && !walled)) return;
    if (farSet.has(i)) needFar += plotsFor(p); else needNear += plotsFor(p);
  });

  // ---- the site and its streets ---------------------------------------------------
  const ro: RiverOpts = { ...o, need: Math.ceil(needNear * 1.08), farNeed: Math.ceil(needFar * 1.15) };
  const site = riverSite(r, ro);
  const net = riverStreets(r, site, ro);
  const R = site.radius;
  const depth = net.plotDepth;
  // Burgage plots: a market town's are narrower than a village's crofts.
  const plotW: [number, number] = urban ? [5.5, 8] : o.scale === "village" ? [7, 10.5] : [11, 16];
  const market = net.market;
  const mc = mul(market.reduce((s, p) => add(s, p), [0, 0] as Pt), 1 / market.length);
  const S = marketSize(o, needNear);
  const bank = (p: Pt) => sideOf(site.river, p);
  const riverGrid = new SegGrid<0>(60);
  riverGrid.addLine(site.river, 0);
  const inSea = (p: Pt, margin = 0) => !!site.sea && dot(p, site.sea.n) > site.sea.d - margin;
  const riverClear = (p: Pt, margin: number) => !inSea(p, margin) && riverGrid.dist(p, site.width / 2 + margin + 1) > site.width / 2 + margin;

  // The wall's reach, by bearing from the market: what lies within it is the town proper.
  const wallBin = Array.from({ length: 36 }, () => 0);
  for (const p of net.wallLine ?? []) {
    const k = Math.round(((atan2(p[1] - mc[1], p[0] - mc[0]) + TAU) % TAU) / TAU * 36) % 36;
    wallBin[k] = Math.max(wallBin[k], hypot(p[0] - mc[0], p[1] - mc[1]));
  }
  const innerR = (p: Pt) => {
    const k = Math.round(((atan2(p[1] - mc[1], p[0] - mc[0]) + TAU) % TAU) / TAU * 36) % 36;
    return wallBin[k] || Infinity; // no wall that way: the river bounds it
  };
  const inside = (p: Pt) => (net.wallLine ? hypot(p[0] - mc[0], p[1] - mc[1]) < innerR(p) - 4 : hypot(p[0] - mc[0], p[1] - mc[1]) < R * 1.05);

  // ---- the castle, on the high ground ------------------------------------------------
  const castleIdx = plan.findIndex((p) => p.site === "castle");
  let castle: Poly | undefined, castleAt: Pt | undefined;
  const cr = urban ? r.range(38, 55) : 28;
  if (castleIdx >= 0) {
    let best: Pt | undefined, bs = -Infinity;
    for (let relax = 0; relax < 3 && !best; relax++) for (let k = 0; k < 60; k++) {
      const c = add(site.high, [r.range(-0.5, 0.5) * R, r.range(-0.5, 0.5) * R]);
      if (bank(c) !== site.near || lineDist(site.river, c) < site.width / 2 + cr * 0.6) continue;
      if (hypot(c[0] - mc[0], c[1] - mc[1]) < S + cr) continue;
      const clear = net.streets.every((st) => st.kind === "back" || st.kind === "cross" || st.kind === "water" || lineDist(st.points, c) > cr * (1 - relax * 0.3) + st.width / 2);
      if (!clear) continue;
      const sc = site.height(c) * 5 - hypot(c[0] - mc[0], c[1] - mc[1]) / R;
      if (sc > bs) { bs = sc; best = c; }
    }
    if (best) {
      castleAt = best;
      castle = qpoly(Array.from({ length: 9 }, (_, s) => add(best!, mul(dirOf((s / 9) * TAU + r.range(-0.1, 0.1)), cr * r.range(0.85, 1.1)))));
      // The castle's bailey was there first: lanes that would run through it are not made.
      const bailey = castle;
      net.streets = net.streets.filter((st) => !((st.kind === "back" || st.kind === "cross" || st.kind === "water") && polylinePolyDist(st.points, bailey, st.width + 2) < st.width / 2 + 2));
    }
  }

  // ---- plots along every street front ------------------------------------------------
  const obstacles: Poly[] = [market, ...(castle ? [castle] : []), ...(net.farPlace ? [net.farPlace] : [])];
  const plots: RPlot[] = [];
  const CELL = 40;
  const pgrid = new Map<string, number[]>();
  const keysOf = (poly: Poly, pad = 0) => {
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const out: string[] = [];
    for (let x = Math.floor((Math.min(...xs) - pad) / CELL); x <= Math.floor((Math.max(...xs) + pad) / CELL); x++)
      for (let y = Math.floor((Math.min(...ys) - pad) / CELL); y <= Math.floor((Math.max(...ys) + pad) / CELL); y++) out.push(`${x},${y}`);
    return out;
  };
  // Street segments in a grid too, so a plot can check what passes near it.
  const sgrid = new Map<string, { a: Pt; b: Pt; w: number; id: string }[]>();
  // The wall is in the grid too, as a street no plot may cross.
  const segLines: { points: Pt[]; width: number; id: string }[] = [...net.streets, ...(net.wallLine ? [{ points: net.wallLine, width: 5, id: "wall" }] : [])];
  for (const st of segLines) for (let i = 0; i + 1 < st.points.length; i++) {
    const seg = { a: st.points[i], b: st.points[i + 1], w: st.width, id: st.id };
    for (const k of keysOf([seg.a, seg.b], st.width)) { const l = sgrid.get(k); if (l) l.push(seg); else sgrid.set(k, [seg]); }
  }
  /** Why a plot can't go here (a street through it, another plot, a market or castle), or undefined if it can. */
  const boxes: [number, number, number, number][] = [];
  const boxOf = (poly: Poly): [number, number, number, number] => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of poly) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    return [x0, y0, x1, y1];
  };
  const clearWhy = (poly: Poly, own: string): string | undefined => {
    // Cheap tests first: how far a segment is from the plot's middle, whether two boxes meet at all.
    const c = centroid(poly);
    let rad = 0;
    for (const p of poly) rad = Math.max(rad, hypot(p[0] - c[0], p[1] - c[1]));
    const seen = new Set<{ a: Pt; b: Pt; w: number; id: string }>();
    for (const k of keysOf(poly, 8)) for (const sg of sgrid.get(k) ?? []) {
      if (seen.has(sg)) continue;
      seen.add(sg);
      const lim = sg.w / 2 - (sg.id === own ? 0.4 : -0.3);
      if (segPointDist(c, sg.a, sg.b) > rad + lim) continue;
      if (polylinePolyDist([sg.a, sg.b], poly, lim + 1) < lim) return "street:" + sg.id.replace(/\d+/g, "");
    }
    const bb = boxOf(poly);
    for (const k of keysOf(poly)) for (const j of pgrid.get(k) ?? []) {
      const o2 = boxes[j];
      if (o2[0] > bb[2] + 0.2 || o2[2] < bb[0] - 0.2 || o2[1] > bb[3] + 0.2 || o2[3] < bb[1] - 0.2) continue;
      if (convexOverlap(poly, plots[j].poly, 0.15)) return "plot";
    }
    return obstacles.some((ob) => convexOverlap(poly, ob, 1) || poly.some((p) => pointInPoly(p, ob)) || ob.some((p) => pointInPoly(p, poly))) ? "obstacle" : undefined;
  };
  let runs = 0;
  const cutAlong = (line: Pt[], side: 1 | -1, half: number, own: string, kindOf: (mid: Pt) => FrontKind | undefined, far: boolean, d: number) => {
    // Walk the line, laying plots of jittered width; a gap starts a new run.
    const segs = line.slice(1).map((b, i) => ({ a: line[i], b, l: hypot(b[0] - line[i][0], b[1] - line[i][1]) }));
    const total = segs.reduce((t, x) => t + x.l, 0);
    // Distances only grow along the walk, so a cursor finds each point without starting over.
    let ci = 0, cacc = 0;
    const at = (s: number): { p: Pt; t: Pt } => {
      if (s < cacc) { ci = 0; cacc = 0; }
      while (ci < segs.length - 1 && cacc + segs[ci].l < s) { cacc += segs[ci].l; ci++; }
      const sg = segs[ci];
      const k = Math.min(1, (s - cacc) / Math.max(1e-9, sg.l));
      return { p: add(sg.a, mul(sub(sg.b, sg.a), k)), t: norm2(sub(sg.b, sg.a)) };
    };
    let run = runs++, idx = 0;
    for (let s = 2; s < total - 2;) {
      const w = r.range(plotW[0], plotW[1]);
      if (s + w > total - 1) break;
      const A = at(s), B = at(s + w);
      const nA = mul([-A.t[1], A.t[0]], side), nB = mul([-B.t[1], B.t[0]], side);
      const fl = add(A.p, mul(nA, half)), fr = add(B.p, mul(nB, half));
      const nrm = norm2(add(nA, nB));
      // Stop a little short of the back lane, which runs a plot's depth behind the street.
      const bl = add(fl, mul(nrm, d - 2)), br = add(fr, mul(nrm, d - 2));
      const poly: Poly = side === 1 ? qpoly([fl, fr, br, bl]) : qpoly([fr, fl, bl, br]);
      const mid = mul(add(fl, fr), 0.5);
      const kind = kindOf(mid);
      const dry = poly.every((p) => riverClear(p, 1) && bank(p) === (far ? -site.near : site.near));
      if (!kind || !dry || clearWhy(poly, own)) { s += w * 0.5; if (idx) { run = runs++; idx = 0; } continue; }
      const c = centroid(poly);
      const sub_ = !far && kind === "suburb";
      const order = far ? hypot(c[0] - site.bridge.p[0], c[1] - site.bridge.p[1]) : hypot(c[0] - mc[0], c[1] - mc[1]);
      const id = plots.length;
      plots.push({ id, poly, kind, ward: -1, run, idx: idx++, block: `rv-${run}`, ring: 0, used: false, order, far, suburb: sub_, street: own });
      boxes.push(boxOf(poly));
      for (const k of keysOf(poly)) { const l = pgrid.get(k); if (l) l.push(id); else pgrid.set(k, [id]); }
      s += w;
    }
  };
  // The market's own frontage first: the best addresses in town.
  const mClosed = [...market, market[0]];
  for (let i = 0; i + 1 < mClosed.length; i++) {
    const a = mClosed[i], b = mClosed[i + 1];
    const nrm: Pt = [-(b[1] - a[1]), b[0] - a[0]];
    const side: 1 | -1 = dot(nrm, sub(mul(add(a, b), 0.5), mc)) >= 0 ? 1 : -1;
    cutAlong([a, b], side, 1, "market", () => "market", false, depth);
  }
  const frontOf = (st: Street) => (mid: Pt): FrontKind | undefined => {
    if (st.bank === "far") return st.kind === "far" && st.id.includes("strand") ? "quay" : st.id === "far" ? "main" : "street";
    if (!inside(mid)) return st.kind === "main" || st.kind === "high" ? "suburb" : undefined;
    if (lineDist(mClosed, mid) < depth * 0.6) return "market";
    return st.kind === "street" ? "street" : st.kind === "quay" ? "quay" : "main";
  };
  const order: Street[] = [
    ...net.streets.filter((s) => s.kind === "high"), ...net.streets.filter((s) => s.kind === "main"), ...net.streets.filter((s) => s.kind === "quay"),
    ...net.streets.filter((s) => s.kind === "street"), ...net.streets.filter((s) => s.kind === "far"),
  ];
  for (const st of order) for (const side of [1, -1] as const) cutAlong(st.points, side, st.width / 2, st.id, frontOf(st), st.bank === "far", st.bank === "far" ? depth * 0.9 : depth);

  // ---- wards -----------------------------------------------------------------------
  const wards: WardGeo[] = [];
  const mkWard = (kind: "intramural" | "suburb", wbank: "near" | "far", members: RPlot[], near: string[]) => {
    const id = wards.length;
    const c = mul(members.reduce((s, p) => add(s, centroid(p.poly)), [0, 0] as Pt), 1 / Math.max(1, members.length));
    const v = sub(c, mc);
    const sector = Math.round(((atan2(v[1], v[0]) + TAU) % TAU) / TAU * 8) % 8;
    const dd = hypot(v[0], v[1]);
    wards.push({ id, kind, value: 0, quarter: 0, centre: qp(c), compass: compassOf(hypot(v[0], v[1]) < 1 ? [0, -1] : v), sector, ring: dd < R * 0.35 ? 0 : dd < R * 0.7 ? 1 : 2, adj: [], near: [...near], bank: wbank });
    for (const p of members) p.ward = id;
    return id;
  };
  // Inside the walls: clusters of plots, by k-means from evenly spread seeds.
  const intra = plots.filter((p) => !p.far && !p.suburb);
  const quarters = urban ? Math.min(4, Math.max(1, o.roads)) : 1;
  // At least a ward to each quarter: the watch and the constables are found by quarter.
  const k = intra.length < 20 ? 1 : Math.max(2, quarters, Math.min(8, Math.round(intra.length / 120)));
  const byAngle = [...intra].sort((a, b) => {
    const ca = centroid(a.poly), cb = centroid(b.poly);
    return atan2(ca[1] - mc[1], ca[0] - mc[0]) - atan2(cb[1] - mc[1], cb[0] - mc[0]) || a.id - b.id;
  });
  let cents: Pt[] = Array.from({ length: k }, (_, i) => centroid(byAngle[Math.floor(((i + 0.5) * byAngle.length) / k)]?.poly ?? market));
  const assign = new Map<number, number>();
  for (let it = 0; it < 8; it++) {
    const sums = cents.map(() => ({ x: 0, y: 0, n: 0 }));
    for (const p of intra) {
      const c = centroid(p.poly);
      let bi = 0, bd = Infinity;
      cents.forEach((q2, i) => { const dd = d2(c, q2); if (dd < bd) { bd = dd; bi = i; } });
      assign.set(p.id, bi);
      sums[bi].x += c[0]; sums[bi].y += c[1]; sums[bi].n++;
    }
    cents = cents.map((q2, i) => (sums[i].n ? [sums[i].x / sums[i].n, sums[i].y / sums[i].n] : q2));
  }
  for (let i = 0; i < k; i++) {
    const members = intra.filter((p) => assign.get(p.id) === i);
    if (members.length) mkWard("intramural", "near", members, []);
  }
  // Beyond the gates: a ward to each road's ribbon.
  const subBy = new Map<string, RPlot[]>();
  for (const p of plots) if (p.suburb) { const l = subBy.get(p.street) ?? []; l.push(p); subBy.set(p.street, l); }
  for (const [, members] of [...subBy].sort((a, b) => (a[0] < b[0] ? -1 : 1))) mkWard("suburb", "near", members, []);
  // Over the bridge: one ward, or two in a city.
  const farPlots = plots.filter((p) => p.far);
  const farNear = ["bridge", "river", o.farBank];
  if (farPlots.length) {
    if (o.scale === "city" && farPlots.length > 60) {
      const farRoad = net.streets.find((s) => s.id === "far")!.points;
      const a = farPlots.filter((p) => sideOf(farRoad, centroid(p.poly)) === 1), b = farPlots.filter((p) => sideOf(farRoad, centroid(p.poly)) !== 1);
      for (const g of [a, b]) if (g.length) mkWard("suburb", "far", g, farNear);
    } else mkWard("suburb", "far", farPlots, farNear);
  }
  // Neighbours: wards whose plots come within a couple of plot depths of each other.
  // Neighbours: wards whose plots come within a couple of plot depths of each other (found cell by cell).
  const reachN = depth * 2.5;
  const wcell = new Map<string, Set<number>>();
  for (const p of plots) {
    if (p.ward < 0) continue;
    const c = centroid(p.poly);
    const k = `${Math.floor(c[0] / reachN)},${Math.floor(c[1] / reachN)}`;
    const set = wcell.get(k) ?? new Set<number>();
    set.add(p.ward);
    wcell.set(k, set);
  }
  const pairsSeen = new Set<string>();
  for (const [k, set] of wcell) {
    const [x, y] = k.split(",").map(Number);
    const here = [...set];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const b of wcell.get(`${x + dx},${y + dy}`) ?? []) for (const a of here) {
      if (a === b) continue;
      const [i, j] = a < b ? [a, b] : [b, a];
      if (wards[i].bank !== wards[j].bank && !(wards[i].near.includes("bridge") || wards[j].near.includes("bridge"))) continue;
      const key = `${i}-${j}`;
      if (pairsSeen.has(key)) continue;
      pairsSeen.add(key);
      wards[i].adj.push(j); wards[j].adj.push(i);
    }
  }
  for (const w of wards) w.adj.sort((a, b) => a - b);
  // Quarters: the inner wards dealt out by bearing round the market, so none is left without one;
  // the rest go with their nearest inner ward.
  const inner = wards.filter((w) => w.kind === "intramural").sort((a, b) => atan2(a.centre[1] - mc[1], a.centre[0] - mc[0]) - atan2(b.centre[1] - mc[1], b.centre[0] - mc[0]) || a.id - b.id);
  inner.forEach((w, i) => { w.quarter = Math.floor((i * quarters) / inner.length); });
  for (const w of wards) if (w.kind !== "intramural" && inner.length) w.quarter = inner[nearestWard(inner.map((x, i) => ({ ...x, id: i })), w.centre)].quarter;

  // ---- reserved places: gates, churches, precincts, the market hall, by the river ---------------
  const result: (PlacedBuilding | undefined)[] = [];
  const free = (p: RPlot) => !p.used;
  const runIx = new Map<number, RPlot[]>();
  for (const p of plots) { const l = runIx.get(p.run); if (l) l.push(p); else runIx.set(p.run, [p]); }
  /** A run of `m` free plots starting at `p`, if there is one. */
  const runFrom = (p: RPlot, m: number): RPlot[] | undefined => {
    const run = runIx.get(p.run)!;
    const i = run.indexOf(p);
    const seq = run.slice(i, i + m);
    return seq.length === m && seq.every(free) ? seq : undefined;
  };
  // Gatehouses on the gates.
  const gateParts = (g: { p: Pt; t: Pt }) => {
    const across = perp(g.t), mw = urban ? 7 : 6;
    return { body: rect(g.p, across, mw + 6, 8), towers: [rect(add(g.p, mul(across, (mw + 6) / 2 + 2.5)), across, 5, 7), rect(add(g.p, mul(across, -(mw + 6) / 2 - 2.5)), across, 5, 7)] };
  };
  const gateQueue = walled ? [...net.gates] : [];
  const gatesUsed: Pt[] = [];
  plan.forEach((p, i) => {
    if (p.site !== "gate" || !walled) return;
    let g = gateQueue.shift();
    // More gatehouses than roads through the wall: a postern, as far from the other gates as the wall allows.
    if (!g && net.wallLine && net.wallLine.length > 4) {
      let best = 1, bd = -Infinity;
      for (let j = 1; j + 1 < net.wallLine.length; j++) {
        const d = Math.min(...[...net.gates.map((x) => x.p), ...gatesUsed].map((q2) => hypot(q2[0] - net.wallLine![j][0], q2[1] - net.wallLine![j][1])));
        if (d > bd) { bd = d; best = j; }
      }
      const a = net.wallLine[best - 1], b = net.wallLine[best + 1];
      g = { p: net.wallLine[best], t: perp(norm2(sub(b, a))), road: "postern" };
    }
    if (!g) return;
    gatesUsed.push(g.p);
    const { body, towers: [tA, tB] } = gateParts(g);
    for (const x of plots) if (!x.used && [body, tA, tB].some((pl) => convexOverlap(x.poly, pl, 0.3))) x.used = true;
    result[i] = { planIndex: i, poly: qpoly(body), parts: [{ kind: "tower", poly: qpoly(tA) }, { kind: "tower", poly: qpoly(tB) }], front: qp(g.p), road: g.road, ward: nearestWard(wards.filter((w) => w.bank === "near"), g.p) };
  });
  // The castle.
  if (castleIdx >= 0 && castle && castleAt) {
    const keepU = norm2(sub(castleAt, mc));
    result[castleIdx] = {
      planIndex: castleIdx, poly: qpoly(rect(add(castleAt, mul(keepU, cr * 0.25)), perp(keepU), 16, 16)), parts: [{ kind: "hall", poly: qpoly(rect(add(castleAt, mul(keepU, -cr * 0.35)), perp(keepU), 20, 8)) }],
      plot: castle, plotKind: "bailey", front: qp(castleAt), road: "castle", ward: nearestWard(wards.filter((w) => w.bank === "near"), castleAt), block: "castle",
    };
    wards[result[castleIdx]!.ward!].near.push("castle");
  }
  // Churches: the chief one on the high ground near the market, the rest spread out; the far bank's own on its side.
  const churchAt: Pt[] = [];
  const SIZE_ORDER = ["grand_temple", "temple", "fane", "chapel", "chantry"];
  const churches = plan.map((p, i) => ({ p, i })).filter(({ p }) => (p.site === "church" || p.site === "green") && p.size !== "shrine")
    .sort((a, b) => SIZE_ORDER.indexOf(a.p.size) - SIZE_ORDER.indexOf(b.p.size) || a.i - b.i);
  // A church too big for its yard even when shrunk takes the plots it leans over, so nothing is built on top of it.
  const claim = (b: PlacedBuilding | undefined) => {
    if (!b) return;
    for (const pl of [b.poly, ...b.parts.map((x) => x.poly)]) for (const k of keysOf(pl)) for (const j of pgrid.get(k) ?? []) if (!plots[j].used && convexOverlap(plots[j].poly, pl, 0.2)) plots[j].used = true;
  };
  const placeYard = (i: number, seq: RPlot[], kind: "church" | "precinct") => {
    placeYardBody(i, seq, kind);
    claim(result[i]);
  };
  const placeYardBody = (i: number, seq: RPlot[], kind: "church" | "precinct") => {
    for (const x of seq) x.used = true;
    const first = seq[0], last = seq[seq.length - 1];
    const yard = insetOutline(qpoly([first.poly[0], last.poly[1], last.poly[2], first.poly[3]]), 1.2);
    const c = centroid(yard);
    const p = plan[i];
    const fits = (polys: Poly[]) => polys.every((pl) => pl.every((pt) => pointInPoly(pt, yard)));
    let kk = 1;
    if (kind === "church") {
      const [cw0, cd0] = CHURCH_SIZE[p.size] ?? [16, 7.5];
      // Shrink to fit the yard: a church never stands over the street.
      for (; kk > 0.12; kk -= 0.04) if (fits([rect(add(c, [-cw0 * kk * 0.12, 0]), [1, 0], cw0 * kk * 0.76, cd0 * kk), rect(add(c, [cw0 * kk * 0.38, 0]), [1, 0], cw0 * kk * 0.24, cd0 * kk * 0.72)])) break;
      const cw = cw0 * kk, cd = cd0 * kk;
      const parts = [{ kind: "chancel", poly: qpoly(rect(add(c, [cw * 0.38, 0]), [1, 0], cw * 0.24, cd * 0.72)) }];
      if (p.size === "grand_temple" || p.size === "temple") {
        parts.push({ kind: "transept", poly: qpoly(rect(add(c, [cw * 0.14, 0]), [1, 0], cd * 0.9, cd * 2.3)) });
        parts.push({ kind: "tower", poly: qpoly(rect(add(c, [-cw * 0.47, 0]), [1, 0], cd * 0.8, cd * 0.8)) });
      }
      result[i] = { planIndex: i, poly: qpoly(rect(add(c, [-cw * 0.12, 0]), [1, 0], cw * 0.76, cd)), parts, plot: yard, plotKind: "churchyard", front: qp(c), road: first.street, ward: first.ward, block: first.block };
      if (!wards[first.ward].near.includes(p.size)) wards[first.ward].near.push(p.size);
      churchAt.push(c);
    } else {
      for (; kk > 0.12; kk -= 0.04) if (fits([rect(add(c, [0, -9 * kk]), [1, 0], 30 * kk, 9 * kk), rect(add(c, [0, 8 * kk]), [1, 0], 20 * kk, 16 * kk)])) break;
      result[i] = { planIndex: i, poly: qpoly(rect(add(c, [0, -9 * kk]), [1, 0], 30 * kk, 9 * kk)), parts: [{ kind: "cloister", poly: qpoly(rect(add(c, [0, 8 * kk]), [1, 0], 20 * kk, 16 * kk)) }], plot: yard, plotKind: "precinct", front: qp(c), road: first.street, ward: first.ward, block: first.block };
    }
  };
  for (const { p, i } of churches) {
    const onFar = farSet.has(i);
    let best: RPlot[] | undefined, bs = -Infinity;
    // The longest run there is, up to what the church wants: it shrinks to fit its yard.
    const cands = plots.filter((x) => !x.used && x.far === onFar && (onFar || !x.suburb) && x.kind !== "market");
    const stride = Math.max(1, Math.floor(cands.length / 600));
    for (let m = CHURCH_PLOTS[p.size] ?? 3; m >= 1 && !best; m--) for (let ci2 = 0; ci2 < cands.length; ci2 += stride) {
      const x = cands[ci2];
      if (x.used) continue;
      const seq = runFrom(x, m);
      if (!seq) continue;
      const c = centroid(x.poly);
      let sc: number;
      if (onFar && net.farPlace) sc = -hypot(c[0] - centroid(net.farPlace)[0], c[1] - centroid(net.farPlace)[1]);
      else if (!churchAt.length && !onFar) sc = site.height(c) * 6 - hypot(c[0] - mc[0], c[1] - mc[1]) / R;
      else sc = Math.min(300, ...churchAt.map((q2) => hypot(c[0] - q2[0], c[1] - q2[1]))) + r.range(0, 20);
      if (sc > bs) { bs = sc; best = seq; }
    }
    if (best) placeYard(i, best, "church");
  }
  // Religious houses: the abbey's precinct over the bridge, others on a long run of plots.
  plan.forEach((p, i) => {
    if (p.site !== "precinct" || result[i]) return;
    if (farSet.has(i) && net.farPlace && o.farBank === "abbey") {
      const yard = qpoly(net.farPlace);
      const c = centroid(yard);
      const w = wards.find((x) => x.bank === "far");
      result[i] = { planIndex: i, poly: qpoly(rect(add(c, [0, -9]), [1, 0], 30, 9)), parts: [{ kind: "cloister", poly: qpoly(rect(add(c, [0, 8]), [1, 0], 20, 16)) }], plot: yard, plotKind: "precinct", front: qp(c), road: "far", ward: w?.id, block: "precinct" };
      return;
    }
    const onFar = farSet.has(i);
    for (const m of [8, 6, 5, 4, 3, 2, 1]) {
      const x = plots.filter((q2) => !q2.used && q2.far === onFar && q2.kind !== "market").sort((a, b) => b.order - a.order || a.id - b.id).find((q2) => runFrom(q2, m));
      if (x) { placeYard(i, runFrom(x, m)!, "precinct"); break; }
    }
  });
  // The market hall, in the market.
  plan.forEach((p, i) => {
    if (p.site !== "market_place") return;
    const u = norm2(sub(market[1] ?? mc, mc));
    const at = add(mc, mul(u, S * 0.15));
    result[i] = { planIndex: i, poly: qpoly(rect(at, perp(u), p.size === "hall" ? 18 : 12, p.size === "hall" ? 9 : 7)), parts: [], front: qp(at), road: "market", ward: nearestWard(wards, at), block: "market" };
  });
  // Mills, tanneries and dyehouses on the river: upstream for mills, downstream for the stink.
  const downDir = norm2(sub(site.river[site.river.length - 1], site.river[0]));
  const riverObstacles: Poly[] = [];
  const byRiver = (i: number, downstream: boolean, wheel: boolean, onFarWanted: boolean): PlacedBuilding | undefined => {
    let onFar = onFarWanted;
    const bi = site.river.reduce((bi, p, j) => (d2(p, site.bridge.p) < d2(site.river[bi], site.bridge.p) ? j : bi), 0);
    for (let tries = 0; tries < 120; tries++) {
      // Downstream first for the smelly trades; if the river runs out (into the sea), upstream; then over the bridge.
      const k = tries % 60, side = downstream && tries < 30 ? 1 : k % 2 ? -1 : 1;
      if (tries === 60) onFar = !onFar;
      const off = side * (2 + (tries < 30 ? tries : k)) * (dot(sub(site.river[Math.min(site.river.length - 1, bi + 1)], site.river[bi]), downDir) >= 0 ? 1 : -1);
      const j = bi + off;
      const a = site.river[j], b = site.river[j + 1];
      if (!a || !b) continue;
      const t = norm2(sub(b, a));
      let nn = perp(t);
      const sideWant = onFar ? -site.near : site.near;
      if (bank(add(a, mul(nn, site.width))) !== sideWant) nn = mul(nn, -1);
      const w = r.range(10, 13), dd = r.range(7.5, 9);
      const c = add(a, mul(nn, site.width / 2 + 2 + dd / 2));
      const body = rect(c, t, w, dd);
      const yard = rect(add(c, mul(nn, 5)), t, w + 10, dd + 14);
      if (clearAllWhy(body, true) ?? clearAllWhy(yard, false)) continue;
      riverObstacles.push(yard);
      for (const k of keysOf(yard)) for (const j of pgrid.get(k) ?? []) if (!plots[j].used && convexOverlap(plots[j].poly, yard, 0.3)) plots[j].used = true;
      const parts = wheel ? [{ kind: "wheel", poly: qpoly(rect(add(a, mul(nn, site.width / 2 - 0.4)), t, 4.5, 1.6)) }] : [{ kind: "vats", poly: qpoly(rect(add(c, mul(nn, dd / 2 + 3)), t, w * 0.6, 3)) }];
      const ward = onFar ? wards.find((x) => x.bank === "far")?.id : nearestWard(wards.filter((x) => x.bank === "near"), c);
      return { planIndex: i, poly: qpoly(body), parts, plot: qpoly(yard), plotKind: "yard", front: qp(a), road: "river", ward };
    }
    return undefined;
  };
  const clearAllWhy = (poly: Poly, river = true): string | undefined => {
    if (poly.some((p) => inSea(p, 1))) return "sea";
    if (river && poly.some((p) => !riverClear(p, 0.5))) return "wet";
    if (!river && poly.some((p) => bank(p) !== bank(centroid(poly)))) return "across";
    for (const k of keysOf(poly, 8)) for (const sg of sgrid.get(k) ?? []) if (polylinePolyDist([sg.a, sg.b], poly, sg.w) < sg.w / 2) return "street";
    for (const k of keysOf(poly)) for (const j of pgrid.get(k) ?? []) if (plots[j].used && convexOverlap(plots[j].poly, poly, 0.2)) return "plot";
    return [...obstacles, ...riverObstacles].some((ob) => convexOverlap(poly, ob, 1)) ? "obstacle" : undefined;
  };

  plan.forEach((p, i) => {
    if (p.site === "stream" || p.site === "river" || p.site === "downstream") {
      result[i] = byRiver(i, p.site === "downstream", p.site === "stream", farSet.has(i));
    }
  });

  // ---- ward values (LF Table 2:20) ----------------------------------------------------------
  const tanAt = add(site.bridge.p, mul(downDir, R * 0.8));
  const chief = churchAt[0];
  const wardPlots = wards.map(() => 0);
  for (const p of plots) if (!p.used && p.ward >= 0) wardPlots[p.ward]++;
  const score = (w: WardGeo) => {
    let sc = -w.ring + r.range(-0.6, 0.6);
    if (chief && hypot(w.centre[0] - chief[0], w.centre[1] - chief[1]) < R * 0.45) sc += 0.7;
    if (w.near.includes("castle")) sc += 0.6;
    if (hypot(w.centre[0] - tanAt[0], w.centre[1] - tanAt[1]) < R * 0.7) sc -= 0.9;
    return sc;
  };
  const intraW = wards.filter((w) => w.kind === "intramural");
  const scored = intraW.map((w) => ({ w, s: score(w) })).sort((a, b) => b.s - a.s || a.w.id - b.w.id);
  const demand: number[] = [];
  plan.forEach((p, i) => {
    if (result[i] || farSet.has(i) || siteOf(p) === "suburb" || GEO.has(p.site ?? "")) return;
    const mid = p.value ? (p.value[0] + p.value[1]) / 2 : 4;
    for (let kk = 0; kk < plotsFor(p); kk++) demand.push(mid);
  });
  demand.sort((a, b) => b - a);
  const total = scored.reduce((a, x) => a + wardPlots[x.w.id], 0) || 1;
  let acc = 0;
  for (const { w } of scored) {
    const at = Math.min(demand.length - 1, Math.floor(((acc + wardPlots[w.id] / 2) / total) * demand.length));
    acc += wardPlots[w.id];
    let v = Math.round(demand[Math.max(0, at)] ?? 3);
    const commercial = w.ring === 0;
    if (commercial && v % 2 === 1) v = Math.min(8, v + 1);
    if (!commercial && v % 2 === 0 && v > 0) v = v - 1;
    w.value = Math.max(0, Math.min(urban ? 8 : 4, v));
  }
  const FAR_VALUES: Record<FarBank, [number, number]> = { village: [1, 3], bridgend: [0, 2], abbey: [1, 3], wharf: [2, 4] };
  for (const w of wards) {
    if (w.bank === "far") w.value = r.pick(FAR_VALUES[o.farBank]);
    else if (w.kind === "suburb") w.value = r.chance(0.55) ? 0 : 1;
    if (w.bank === "near") {
      if (hypot(w.centre[0] - mc[0], w.centre[1] - mc[1]) < S + depth * 3 && w.kind === "intramural") w.near.push("market");
      if (net.bridges.some((b) => hypot(b[0] - w.centre[0], b[1] - w.centre[1]) < R * 0.6)) w.near.push("bridge");
      if (lineDist(site.river, w.centre) < R * 0.45) w.near.push("river");
      if (chief && hypot(w.centre[0] - chief[0], w.centre[1] - chief[1]) < depth * 4) w.near.push("church");
      if (net.streets.some((s) => s.kind === "quay") && lineDist(net.streets.find((s) => s.kind === "quay")!.points, w.centre) < R * 0.4) w.near.push("quay");
    }
    if (w.bank === "far" && o.farBank === "wharf") w.near.push("quay");
  }

  // ---- everyone else onto the plots --------------------------------------------------------
  const placedAt = new Map<string, Pt[]>();
  const familyOf = (kk: string) => FAMILY[kk] ?? kk;
  // Free plots by bank, front and ward value, nearest the middle first.
  const buckets = new Map<string, RPlot[]>();
  for (const p of plots) {
    if (p.used) continue;
    const key = `${p.far ? 1 : 0}:${p.kind}:${p.far ? 0 : wards[p.ward]?.value ?? 0}`;
    const l = buckets.get(key); if (l) l.push(p); else buckets.set(key, [p]);
  }
  for (const l of buckets.values()) l.sort((a, b) => a.order - b.order || a.id - b.id);
  const ptr = new Map<string, number>();
  const peek = (key: string): RPlot | undefined => {
    const l = buckets.get(key);
    if (!l) return undefined;
    let i = ptr.get(key) ?? 0;
    while (i < l.length && l[i].used) i++;
    ptr.set(key, i);
    return l[i];
  };
  const orderIx = plan.map((_, i) => i).filter((i) => result[i] === undefined && !GEO.has(plan[i].site ?? "") || (plan[i].site === "gate" && !walled && result[i] === undefined));
  const isSub = (p: Footprint) => siteOf(p) === "suburb" || (p.site === "shore" && !coastTerrain);
  const rank = (p: Footprint) => (p.site && !isSub(p) ? 0 : 1);
  const widthOf = (p: Footprint) => (p.value ? p.value[1] - p.value[0] : 9);
  orderIx.sort((a, b) => (farSet.has(a) ? 1 : 0) - (farSet.has(b) ? 1 : 0) || rank(plan[a]) - rank(plan[b]) || plotsFor(plan[b]) - plotsFor(plan[a]) || widthOf(plan[a]) - widthOf(plan[b]) || a - b);
  // The poorest housing spills out beyond the gates (LF p.84): the DM's Suburbs choice says how much.
  const spillShare = (urban ? 0.12 : 0.06) * (o.suburbs === "few" ? 0.25 : o.suburbs === "many" ? 2.5 : 1);
  const spillOut = new Set(orderIx.filter((i) => !farSet.has(i) && !plan[i].site && plotsFor(plan[i]) === 1 && (plan[i].value?.[0] ?? 9) <= 1 && r.chance(Math.min(0.9, spillShare * 2))));
  const spill: number[] = [];
  for (const i of orderIx) {
    const p = plan[i];
    const far = farSet.has(i);
    const m = plotsFor(p);
    const housing = !p.site && m === 1 && !spillOut.has(i);
    const fronts: FrontKind[] = far ? (p.site === "quay" || p.site === "shore" ? ["quay", "main", "street"] : ["main", "street", "quay"]) : isSub(p) || spillOut.has(i) ? ["suburb", "street", "main"] : FRONTS[p.site ?? "housing"] ?? FRONTS.housing;
    const lo = far ? 0 : p.value?.[0] ?? 0, hi = far ? 8 : p.value?.[1] ?? 8;
    let got: RPlot[] | undefined;
    if (housing) {
      // Ordinary houses fill from the middle out, trading distance against a class of value.
      let best: RPlot | undefined, bc = Infinity;
      for (const fr of [...fronts, "suburb" as FrontKind]) for (let v = 0; v <= 8; v++) {
        const c = peek(`${far ? 1 : 0}:${fr}:${far ? 0 : v}`);
        if (!c) continue;
        const cost = c.order + 10 * (v < lo ? lo - v : v > hi ? v - hi : 0) + (fr === "suburb" ? R : 0);
        if (cost < bc) { bc = cost; best = c; }
        if (far) break;
      }
      if (best) got = [best];
    } else {
      // Trades: spread from their own kind (or kept together), within the classes they suit, widening if need be.
      const prior = p.kind ? placedAt.get(familyOf(p.kind)) : undefined;
      for (let widen = 0; !got && widen <= 8; widen++) {
        let best: RPlot[] | undefined, bs = -Infinity;
        for (const fr of fronts) {
          for (let v = far ? 0 : Math.max(0, lo - widen); v <= (far ? 0 : Math.min(8, hi + widen)); v++) {
            const l = buckets.get(`${far ? 1 : 0}:${fr}:${v}`);
            if (!l) continue;
            const stride = Math.max(1, Math.floor(l.length / 32));
            for (let j = 0; j < l.length; j += stride) {
              const c = l[j];
              if (c.used) continue;
              const seq = runFrom(c, m);
              if (!seq) continue;
              const cc = centroid(c.poly);
              let nearest = Infinity;
              // The latest few of its kind are enough to keep apart from (or close to).
              for (const q2 of (prior ?? []).slice(-40)) nearest = Math.min(nearest, hypot(cc[0] - q2[0], cc[1] - q2[1]));
              const sc = (prior?.length ? (p.cluster ? -nearest : Math.min(nearest, 500)) : 0) - c.order * 0.5 - fronts.indexOf(fr) * 40;
              if (sc > bs) { bs = sc; best = seq; }
            }
          }
          if (best) break;
        }
        got = best;
      }
      if (!got && m > 1) for (const fr of fronts) { const c = peek(`${far ? 1 : 0}:${fr}:0`) ?? [...plots].find((x) => !x.used && x.far === far); if (c) { got = [c]; break; } }
    }
    // Out of room on this bank: say so (the layout is tried again roomier), unless this is the last try.
    if (!got) { const c = plots.find((x) => !x.used && x.far === far) ?? ((o.room ?? 1) > 1.45 ? plots.find((x) => !x.used) : undefined); if (c) got = [c]; }
    if (!got) { spill.push(i); continue; }
    for (const x of got) x.used = true;
    if (p.kind) { const kk = familyOf(p.kind); const l = placedAt.get(kk) ?? []; l.push(centroid(got[0].poly)); placedAt.set(kk, l); }
    result[i] = building(r, i, p, got, urban);
  }
  // Shrines and anything without a plot: at the street side or on the market.
  plan.forEach((p, i) => {
    if (result[i]) return;
    if (p.size !== "shrine" && !spill.includes(i)) return;
    if (p.size !== "shrine") return;
    // Round the market's edge, clear of the hall and each other.
    let at = mc;
    for (let tries = 0; tries < 24; tries++) {
      at = add(mc, mul(dirOf(r.range(0, TAU)), S * r.range(0.35, 0.75)));
      const box = rect(at, [1, 0], 4.5, 4.5);
      if (pointInPoly(at, market) && !result.some((b) => b && convexOverlap(b.poly, box, 0.5))) break;
    }
    result[i] = { planIndex: i, poly: qpoly(rect(at, [1, 0], 3.5, 3.5)), parts: [], front: qp(at), road: "market", ward: nearestWard(wards, at), block: "market" };
  });
  const buildings = result.filter((b): b is PlacedBuilding => !!b);
  for (const b of buildings) if (b.ward === undefined) b.ward = nearestWard(wards, b.front);
  const gardens: Poly[] = plots.filter((p) => !p.used && !p.far && !p.suburb).map((p) => p.poly);

  // ---- the country round about -----------------------------------------------------------
  // The town's ground: the walled town and its streets (the ribbons along the roads lie outside it).
  const coreCorners = plots.filter((p) => !p.suburb && !p.far).flatMap((p) => p.poly);
  const hull = convexHull(coreCorners.length ? coreCorners : market);
  // Fields start beyond most of what was built; ribbons along the roads run out among them.
  const dists = plots.filter((p) => p.used).map((p) => hypot(centroid(p.poly)[0] - mc[0], centroid(p.poly)[1] - mc[1])).sort((a, b) => a - b);
  // Fields begin just beyond the town's core; the ribbons along the roads run out among them.
  let coreReach = 0;
  for (const p of hull) coreReach = Math.max(coreReach, hypot(p[0] - mc[0], p[1] - mc[1]));
  const reach = Math.min(dists[Math.floor(dists.length * 0.9)] ?? R, coreReach);
  const fieldIn = reach + 30;
  const open = o.terrain === "farmland";
  const nFields = open ? 3 : 2;
  const crops = open ? r.shuffle(["wheat", "barley and oats", "fallow"]) : r.shuffle(["oats", "barley"]);
  const cuts = [r.range(0, TAU)];
  for (let fi = 1; fi < nFields; fi++) cuts.push(cuts[fi - 1] + r.range(0.85, 1.15) * (TAU / nFields));
  const band = (open ? r.range(120, 170) : r.range(70, 100)) * (urban ? 1.2 : 1);
  const fields: FieldPiece[] = [];
  const greatFields: { crop: string; label: Pt }[] = [];
  const lerpA = (a: number, b: number, t2: number) => a + (b - a) * t2;
  for (let fi = 0; fi < nFields; fi++) {
    const a0 = cuts[fi], a1 = fi === nFields - 1 ? cuts[0] + TAU : cuts[fi + 1];
    const nf = Math.max(3, Math.round(((a1 - a0) * (fieldIn + band)) / 140));
    for (let j = 0; j < nf; j++) {
      const s0 = a0 + ((a1 - a0) * j) / nf + 0.006, s1 = a0 + ((a1 - a0) * (j + 1)) / nf - 0.006;
      for (let ring = 0; ring < 2; ring++) {
        const rIn = fieldIn + ring * band * 0.55, rOut = fieldIn + (ring + 1) * band * 0.55 - 3;
        const poly: Poly = [];
        for (let s = 0; s <= 5; s++) poly.push(add(mc, mul(dirOf(lerpA(s0, s1, s / 5)), rIn)));
        for (let s = 5; s >= 0; s--) poly.push(add(mc, mul(dirOf(lerpA(s0, s1, s / 5)), rOut)));
        if (poly.some(inSea) || poly.some((p) => !riverClear(p, 3))) continue;
        if (poly.some((p) => pointInPoly(p, hull)) || keysOf(poly).some((k) => (pgrid.get(k) ?? []).some((j) => plots[j].used && plots[j].poly.some((c) => pointInPoly(c, poly))))) continue;
        if (net.streets.some((st) => (st.kind === "main" || st.kind === "far" || st.kind === "high") && polylinePolyDist(st.points, poly, st.width) < st.width / 2 + 1)) continue;
        const mida = (s0 + s1) / 2;
        fields.push({ field: fi, poly: qpoly(poly), stripes: q(((r.chance(0.5) ? mida : mida + PI / 2) * 180) / PI + r.range(-12, 12)) });
      }
    }
    greatFields.push({ crop: crops[fi], label: qp(add(mc, mul(dirOf((a0 + a1) / 2), fieldIn + band * 0.55))) });
  }
  const outerR = fieldIn + band * 1.1;
  const woods: Poly[] = [];
  const features: Feature[] = [];
  for (let j = 0, nw = o.terrain === "forest" ? 14 : r.int(2, 4); j < nw; j++) {
    const c = add(mc, mul(dirOf(r.range(0, TAU)), outerR + r.range(30, 80)));
    if (inSea(c) || lineDist(site.river, c) < 90) continue;
    woods.push(blob(r, c, r.range(50, 85)));
  }
  // The market's furniture, the bridges, and the law's.
  const marketTown = urban || o.scale === "village";
  const inMarket = (k2: number, l2: number): Pt => qp(add(mc, add(mul(norm2(sub(market[1] ?? mc, mc)), S * k2), mul(perp(norm2(sub(market[1] ?? mc, mc))), S * l2))));
  features.push({ kind: marketTown ? "cross" : "well", p: inMarket(0.1, -0.2) });
  features.push({ kind: "well", p: inMarket(-0.3, 0.2) });
  features.push({ kind: "stocks", p: inMarket(0.35, 0.2) });
  for (const b of net.bridges) features.push({ kind: "bridge", p: qp(b) });
  if (r.chance(0.6)) features.push({ kind: "bridge_chapel", p: qp(site.bridge.p) });
  if (marketTown) {
    features.push({ kind: "pillory", p: inMarket(-0.1, -0.4) });
    if (urban) features.push({ kind: "conduit", p: inMarket(0.3, -0.35) });
    const road = net.streets.find((s) => s.kind === "main");
    if (road) {
      const end = road.points[road.points.length - 1], prev = road.points[Math.max(0, road.points.length - 3)];
      features.push({ kind: "gallows", p: qp(add(end, mul(perp(norm2(sub(end, prev))), (urban ? 7 : 6) + 14))) });
    }
  }
  // The map reaches past the fields and past everything built: ribbons and the far bank can run further out.
  let builtReach = 0;
  for (const p of plots) if (p.used) for (const v of p.poly) builtReach = Math.max(builtReach, hypot(v[0] - mc[0], v[1] - mc[1]));
  const extent = Math.max(outerR + 140, builtReach + 80);
  let coastLine: Pt[] | undefined, sea: Poly | undefined;
  if (site.sea) {
    const u = perp(site.sea.n), b0 = mul(site.sea.n, site.sea.d);
    coastLine = [qp(add(b0, mul(u, -extent * 1.5))), qp(add(b0, mul(u, extent * 1.5)))];
    sea = qpoly([coastLine[0], coastLine[1], add(coastLine[1], mul(site.sea.n, extent * 3)), add(coastLine[0], mul(site.sea.n, extent * 3))]);
  }
  const quayLine = net.streets.find((s) => s.kind === "quay")?.points;
  const high = contourLines(site.height, mc, R * 1.3, 28);
  const towers: Pt[] = [];
  if (net.wallLine) for (let i = 0; i < net.wallLine.length; i += 4) towers.push(qp(net.wallLine[i]));
  const roads: Road[] = net.streets.map((st) => ({
    id: st.id, kind: st.kind === "back" || st.kind === "cross" || st.kind === "water" ? "lane" as const : "road" as const, width: q(st.width), points: st.points.map(qp),
  }));

  return {
    kind: "town",
    plan: "river",
    farBank: o.farBank,
    scale: o.scale,
    enclosure: o.enclosure,
    bounds: [q(mc[0] - extent), q(mc[1] - extent), q(extent * 2), q(extent * 2)],
    roads,
    stream: { width: q(site.width), points: site.river.map(qp) },
    ford: qp(site.bridge.p),
    green: qpoly(market),
    hedge: qpoly(hull),
    fields,
    greatFields,
    meadow: site.river.map(qp),
    woods,
    features,
    terrain: o.terrain,
    ...(coastLine ? { coast: coastLine, sea } : {}),
    buildings,
    wall: { line: (net.wallLine ?? []).map(qp), closed: false, towers, gates: net.gates.map((g) => ({ p: qp(g.p), t: qp(g.t), road: g.road })) },
    market: qpoly(market),
    gardens,
    wards,
    bridges: net.bridges.map(qp),
    ...(quayLine ? { quay: quayLine.map(qp) } : {}),
    ...(castle ? { castle } : {}),
    ...(high.length ? { high } : {}),
  };
}

/** Lines of equal height round the town, at its higher levels: marching squares, chained into polylines. */
function contourLines(height: (p: Pt) => number, c: Pt, half: number, n: number): Pt[][] {
  const step = (half * 2) / n;
  const at = (i: number, j: number): Pt => [c[0] - half + i * step, c[1] - half + j * step];
  const h: number[][] = [];
  const all: number[] = [];
  for (let i = 0; i <= n; i++) { h.push([]); for (let j = 0; j <= n; j++) { const v = height(at(i, j)); h[i].push(v); all.push(v); } }
  all.sort((a, b) => a - b);
  const out: Pt[][] = [];
  for (const lev of [all[Math.floor(all.length * 0.62)], all[Math.floor(all.length * 0.8)]]) {
    const segs: [Pt, Pt][] = [];
    const cross = (a: Pt, va: number, b: Pt, vb: number): Pt => { const t = (lev - va) / (vb - va || 1e-9); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const p = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)], v = [h[i][j], h[i + 1][j], h[i + 1][j + 1], h[i][j + 1]];
      const pts: Pt[] = [];
      for (let k = 0; k < 4; k++) { const a = k, b = (k + 1) % 4; if ((v[a] >= lev) !== (v[b] >= lev)) pts.push(cross(p[a], v[a], p[b], v[b])); }
      if (pts.length === 2) segs.push([pts[0], pts[1]]);
      else if (pts.length === 4) { segs.push([pts[0], pts[1]]); segs.push([pts[2], pts[3]]); }
    }
    // Chain the pieces end to end.
    const key = (p: Pt) => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;
    const ends = new Map<string, number[]>();
    segs.forEach((sg, i) => { for (const e of sg) { const k = key(e); const l = ends.get(k); if (l) l.push(i); else ends.set(k, [i]); } });
    const used = new Set<number>();
    for (let i = 0; i < segs.length; i++) {
      if (used.has(i)) continue;
      used.add(i);
      const line: Pt[] = [segs[i][0], segs[i][1]];
      for (const dir of [1, -1]) {
        for (;;) {
          const tip = dir === 1 ? line[line.length - 1] : line[0];
          const next = (ends.get(key(tip)) ?? []).find((x) => !used.has(x));
          if (next === undefined) break;
          used.add(next);
          const sg = segs[next];
          const other = key(sg[0]) === key(tip) ? sg[1] : sg[0];
          if (dir === 1) line.push(other); else line.unshift(other);
        }
      }
      if (line.length >= 6) out.push(line.map(qp));
    }
  }
  return out;
}
