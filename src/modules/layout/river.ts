// River towns (L1): a town grown at a bridge, lopsided across its river. Our
// own generator, written from scratch.
//
// The model: the town proper sits on the higher bank. A high street climbs
// from the bridge to a market where the roads in meet, a triangle or a
// widened street, never a central square. Main roads wander out from it along
// the easy ground; back lanes run behind the plots and water lanes drop to the
// river. Over the bridge lies a smaller, older place with a character of its
// own: an old village, a bridge-end, an abbey's side or a wharf side.

import { PI, TAU, atan2, cos, hypot, sin } from "../../core/dmath";
import type { Rng } from "../../core/rng";
import type { FarBank } from "../../core/types";
import { add, dot, mul, perp, pointInPoly, segPointDist, sub, type Pt } from "./geom";
import { marketSize } from "./streets";
import { heightField } from "./height";
import type { TownOpts } from "./radial";

export interface RiverOpts extends TownOpts {
  farBank: FarBank;
  /** plots the dominant bank needs */
  need: number;
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
  const plotArea = urbanOf(o) ? 6.75 * 20 : o.scale === "village" ? 12.5 * 35 : 13.5 * 35;
  // Streets and lanes take about as much ground again as the plots.
  return Math.sqrt((Math.max(need, 30) * plotArea * 2) / PI) * (o.room ?? 1);
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

export type StreetKind = "high" | "main" | "street" | "back" | "cross" | "water" | "far";
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
  const depth = urban ? r.range(26, 36) : r.range(32, 44);
  const mainW = urban ? 7 : 6, laneW = urban ? 3 : 3.5;
  const streets: Street[] = [];
  const bank = (p: Pt) => sideOf(site.river, p);
  const wet = (p: Pt, margin = 2) => bank(p) !== site.near || lineDist(site.river, p) < site.width / 2 + margin;
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
  const reach = R * (walled ? 1.75 : 1.6);
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
  const plotW = urban ? 6.75 : 12.5;
  const frontage = () => streets.filter((x) => x.kind !== "far").reduce((t, x) => t + polyLen(x.points.filter((p) => d2(p, centre) < R * R)), 0) * 2;
  const wantFront = o.need * plotW * 1.25;
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
  for (let tries = 0; frontage() < wantFront && tries < 150 + o.need / 2; tries++) {
    // Mostly off the main streets; now and then off a side street, for a second row.
    const parents = streets.filter((x) => x.kind === "main" || x.kind === "high" || (x.kind === "street" && r.chance(0.25)));
    const par = r.pick(parents);
    if (par.points.length < 4) continue;
    const i = r.int(1, par.points.length - 2);
    const at = par.points[i];
    if (!at || d2(at, centre) > (R * 0.92) ** 2 || pointInPoly(at, market) || lineDist(market, at) < S * 0.5) continue;
    // Not too close to another side street leaving the same street.
    if (streets.some((x) => x.kind === "street" && d2(x.points[0], at) < block * block)) continue;
    const t = norm2(sub(par.points[i + 1], par.points[i - 1]));
    // Most side streets run along the slope; some go straight down it, which ties the rows together.
    const level = r.chance(0.85);
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
      for (const x of streets) {
        if (x === par && step < 3) continue;
        if (x.kind === "far" || x.kind === "back") continue;
        if (lineDist(x.points, p) < block) { hit = nearestOn(x.points, p); break; }
      }
      if (hit) { if (step >= 2 && dry(cur, hit)) { pts.push(hit); joined = true; } break; }
      pts.push(p);
    }
    const len = polyLen(pts);
    if (len >= depth * 2.5 && (joined || len >= depth * 4)) streets.push({ id: `street${sn++}`, kind: "street", width: streetW, points: pts, bank: "near" });
  }

  // 4. The wall: round the town proper at about its radius, wobbled, its ends on the river.
  let wallLine: Pt[] | undefined;
  const gates: StreetNet["gates"] = [];
  // The wall goes round what was built, close about it, not round the room the town might have had.
  const built = streets.filter((x) => x.kind !== "far").flatMap((x) => x.points).filter((p) => d2(p, centre) < R * R);
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
  for (const st of streets) if (st.kind === "main") { const g = crossing(st.points); if (g) gates.push({ ...g, road: st.id }); }
  gates.push({ p: foot, t: into, road: "high" });

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
        && fronts.every((f) => f === st || lineDist(f.points, p) > depth + f.width / 2);
      if (clear) run.push(p); else flush();
    }
    flush();
  }
  streets.push(...backs);

  // 6. Cross lanes: every so often, from a back lane straight to the street its plots face.
  let cn = 0;
  const toFront = (p: Pt): Pt | undefined => {
    let best: Pt | undefined, bd = Infinity;
    for (const f of fronts) {
      const q = nearestOn(f.points, p);
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
  for (let i = 0; i < 40; i++) {
    const at = farPts[farPts.length - 1];
    fh = norm2(rot(fh, r.range(-0.08, 0.08)));
    const p = add(at, mul(fh, 22));
    if (bank(p) === site.near || lineDist(site.river, p) < site.width / 2 + 3) break;
    farPts.push(p);
    if (d2(p, farFoot) > (R * 1.2) ** 2) break;
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
  return { streets, market, gates, wallLine, farPlace, marketAt: M, plotDepth: depth };
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
