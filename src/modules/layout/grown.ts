// Grown towns (L1): every street plan, the organic one ("radial") included. Our own generator,
// written from scratch. One engine: a site, a spine of streets laid on it, side
// streets grown until there is frontage enough, then plots, wards and buildings.
// Each `form` changes the site and the spine; the rest is shared.
//
// The river town, the first form: the town proper sits on the higher bank. A high street climbs
// from the bridge to a market where the roads in meet, a triangle or a
// widened street, never a central square. Main roads wander out from it along
// the easy ground; back lanes run behind the plots and water lanes drop to the
// river. Over the bridge lies a smaller, older place with a character of its
// own: an old village, a bridge-end, an abbey's side or a wharf side.

import { PI, TAU, atan2, cos, hypot, q, sin } from "../../core/dmath";
import type { Rng } from "../../core/rng";
import type { FarBank } from "../../core/types";
import { add, area, centroid, convexHull, convexOverlap, dot, insetEdges, mul, perp, pointInPoly, polylinePolyDist, qp, qpoly, rect, segPointDist, sub, type Poly, type Pt } from "./geom";
import type { Feature, FieldPiece, Footprint, PlacedBuilding, Road } from "./hamlet";
import { CHURCH_SIZE, blob, building, compassOf, insetOutline, leftToRight, marketSize, nearestWard, plotsFor, type FrontKind, type Plot, type TownLayout, type WardGeo } from "./streets";
import { contourLines, heightField } from "./height";
import { blockFaces, deadEnds, nodeStreets, type Face, type Side } from "./graph";
import { cutRibbon, fillBlock, shapeOn, splitBlock, type BlockKind, type Lot, type Open } from "./blocks";
import { organicStreets } from "./organic";
import type { TownOpts } from "./streets";

/** The shapes a grown town takes. */
export type Form = "river" | "ridge" | "castle" | "street" | "crossroads" | "abbey" | "harbour" | "organic";
/** Forms with a far bank over their bridge. */
export const BANKED: Form[] = ["river", "ridge"];
/** The forms whose land between streets is cut into blocks (dense-blocks rework); the rest still cut rows of plots. */
export const BLOCKED: Form[] = ["organic", "river"];
let blockedForms = new Set<Form>(BLOCKED);
/** Tests only: try forms on blocks before they are switched over for good. */
export function setBlockedForTest(forms: Form[]): void { blockedForms = new Set(forms.length ? forms : BLOCKED); }

export interface RiverOpts extends TownOpts {
  /** the town's shape; a river town when absent */
  form?: Form;
  /** what lies over the bridge, for the forms that have one */
  farBank?: FarBank;
  /** plots the dominant bank needs */
  need: number;
  /** plots the far bank needs */
  farNeed?: number;
  /** the land between streets is cut into blocks: no back lanes or cross lanes behind the fronts */
  blocks?: boolean;
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
  /** castle-gate and abbey-gate towns: the castle's mound or the abbey precinct's middle */
  anchor?: Pt;
  /** the castle bailey's radius, for a castle-gate town */
  anchorR?: number;
  /** a ridge town's crest: from its foot by the river, up along `dir` */
  ridge?: { foot: Pt; dir: Pt; half: number };
}

const dirOf = (a: number): Pt => [cos(a), sin(a)];
const urbanOf = (o: TownOpts) => o.scale === "town" || o.scale === "city";

/** How far the town proper reaches from its market, for this many plots. */
export function townRadius(o: TownOpts, need: number, blocks = false): number {
  const plotArea = urbanOf(o) ? 6.75 * 28 : o.scale === "village" ? 8.75 * 28 : 13.5 * 32;
  // Streets and lanes take about as much ground again as the plots. A town of blocks packs its lots
  // back to back round shared yards: about 1.3 plots' ground each, streets included.
  return Math.sqrt((Math.max(need, 30) * plotArea * (blocks ? 1.15 : 3.4)) / PI) * (o.room ?? 1);
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
  const form = o.form ?? "river";
  // A harbour loses half its round of ground to the sea, a ridge town both its flanks: give them more.
  const R = townRadius(o, o.need, !!o.blocks) * (form === "harbour" ? 1.45 : form === "ridge" ? 1.15 : 1);
  const extent = R * 2.6 + 200;
  // Towns at a crossing stand on a river; the others have a stream passing clear of them, for the mills.
  const crossing = BANKED.includes(form) || form === "harbour";
  const width = (urbanOf(o) ? r.range(12, 18) : r.range(7, 10)) * (crossing ? 1 : 0.6);
  const theta = r.range(0, TAU);
  const u = dirOf(theta), n = perp(u);
  // Meanders: three sine terms along the river's course.
  const amp = extent * r.range(0.08, 0.15);
  const waves = [0.55, 0.3, 0.15].map((w) => ({ a: amp * w, l: extent * r.range(0.25, 0.6) * (w + 0.5), p: r.range(0, TAU) }));
  const wob = (t: number) => waves.reduce((s, w) => s + w.a * sin(t / w.l + w.p), 0);
  // The river passes the town proper at a little distance: the town is on the -n side of the line.
  const off0 = Math.max(R * r.range(0.3, 0.42), amp * 1.4 + width * 3);
  const off = crossing ? off0 : Math.max(off0, R * 1.2 + amp);
  const river: Pt[] = [];
  const step = extent / 40;
  for (let t = -extent * 1.1; t <= extent * 1.1 + 1e-6; t += step) river.push(add(mul(u, t), mul(n, off + wob(t) - wob(0))));
  if (r.chance(0.5)) river.reverse(); // which way it flows
  // Rises and hollows about the size of the town itself, so the streets that follow them bend.
  const base = heightField(r, R * 1.4);
  // The land rises from the river towards the town and falls away beyond it.
  const tilt = r.range(0.18, 0.3);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const slope = (p: Pt) => tilt * clamp(-dot(p, n) / (extent * 0.6), -1, 1);
  let height = (p: Pt) => base(p) * 0.6 + slope(p);
  const near = sideOf(river, [0, 0]);
  // The anchor of a castle-gate or abbey-gate town: off to one side of the middle, away from the stream.
  let anchor: Pt | undefined, anchorR: number | undefined;
  if (form === "castle" || form === "abbey") {
    let phi = r.range(0, TAU);
    for (let k = 0; k < 8 && dot(dirOf(phi), n) > 0.2; k++) phi = r.range(0, TAU);
    anchor = mul(dirOf(phi), R * (form === "castle" ? 0.38 : 0.42));
  }
  if (form === "castle") {
    // The castle's mound: the ground falls away from it on every side, so the streets that keep
    // to the level go round it in arcs, as Devizes' streets follow the castle's ditches.
    anchorR = urbanOf(o) ? r.range(55, 72) : r.range(38, 48);
    const C = anchor!;
    height = (p: Pt) => base(p) * 0.3 + slope(p) * 0.5 + 1.1 * Math.max(0, 1 - hypot(p[0] - C[0], p[1] - C[1]) / (R * 1.4));
  }
  // A ridge: one long back of high ground rising from the crossing into the town.
  let ridgeAlong = 0;
  if (form === "ridge") {
    const a = mul(n, -1);
    height = (p: Pt) => {
      const rel = sub(p, mul(n, off));
      const up = clamp(dot(rel, a) / (R * 1.8), 0, 1.15);
      const across = (dot(p, u) - ridgeAlong) / (R * 0.42);
      return base(p) * 0.2 + 1.2 * up / ((1 + across * across) * (1 + across * across));
    };
  }
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
  ridgeAlong = along;
  let bi = 0, bd = Infinity;
  const aim = add(mul(u, along), mul(n, off));
  river.forEach((p, i) => { const d = (p[0] - aim[0]) ** 2 + (p[1] - aim[1]) ** 2; if (d < bd) { bd = d; bi = i; } });
  const i0 = Math.max(0, bi - 1), i1 = Math.min(river.length - 1, bi + 1);
  const t = sub(river[i1], river[i0]);
  const tl = hypot(t[0], t[1]) || 1;
  const bridge = { p: river[bi], t: [t[0] / tl, t[1] / tl] as Pt };
  let sea: RiverSite["sea"];
  let line = river;
  if (o.terrain === "coast" || form === "harbour") {
    // The sea beyond the river's mouth, downstream; a harbour town stands right on its shore.
    const down = sub(river[river.length - 1], river[0]);
    const dl = hypot(down[0], down[1]) || 1;
    const sn: Pt = [down[0] / dl, down[1] / dl];
    sea = { n: sn, d: form === "harbour" ? R * 0.35 : Math.max(R * 1.3, dot(bridge.p, sn) + R * 0.9) };
    if (form === "harbour") {
      // The land climbs steeply from the shore.
      const d0 = sea.d;
      // Coombes and spurs run down to the water, so the streets that keep to the level bend.
      const tq = perp(sn), l1 = R * r.range(0.7, 1.1), l2 = R * r.range(0.3, 0.5), p1 = r.range(0, TAU), p2 = r.range(0, TAU);
      const spur = (p: Pt) => R * (0.22 * sin(dot(p, tq) / l1 + p1) + 0.1 * sin(dot(p, tq) / l2 + p2));
      height = (p: Pt) => base(p) * 0.8 + 1.3 * clamp((d0 - dot(p, sn) + spur(p) * clamp((d0 - dot(p, sn)) / (R * 0.3), 0, 1)) / (R * 1.1), 0, 1.3);
    }
    // The river runs on until it meets the shore, and a little way out, so its mouth opens into the sea.
    const k = river.findIndex((p) => dot(p, sn) > sea!.d);
    if (k > 0) {
      const a = river[k - 1], b = river[k];
      const f = (sea.d - dot(a, sn)) / (dot(b, sn) - dot(a, sn));
      const mouth = add(a, mul(sub(b, a), f));
      line = [...river.slice(0, k), mouth, add(mouth, mul(sn, width))];
    }
  }
  // A ridge town's high point is the top of its ridge; a castle-gate town's is the castle mound.
  if (form === "ridge") high = add(add(mul(u, along), mul(n, off)), mul(n, -R * 1.45));
  // A harbour's high point is up the hill behind its quay, on its own ground.
  if (form === "harbour" && sea) {
    let hb = -Infinity;
    for (let i = 0; i < 64; i++) {
      const p: Pt = [r.range(-0.8, 0.8) * R, r.range(-0.8, 0.8) * R];
      if (dot(p, sea.n) > sea.d - R * 0.25 || sideOf(river, p) !== near) continue;
      const h = height(p);
      if (h > hb) { hb = h; high = p; }
    }
  }
  const ridge = form === "ridge" ? { foot: add(mul(u, along), mul(n, off)), dir: mul(n, -1), half: R * 0.34 } : undefined;
  if (form === "castle" && anchor) high = anchor;
  return { height, river: line, width, near, bridge, high, extent, radius: R, sea, ...(anchor ? { anchor } : {}), ...(anchorR ? { anchorR } : {}), ...(ridge ? { ridge } : {}) };
}

// ---- streets ------------------------------------------------------------------

export type StreetKind = "high" | "main" | "street" | "back" | "cross" | "water" | "far" | "quay";
export interface Street { id: string; kind: StreetKind; width: number; points: Pt[]; bank: "near" | "far" }
export interface StreetNet {
  streets: Street[];
  market: Pt[];
  gates: { p: Pt; t: Pt; road: string }[];
  /** the town wall (or hedge), an open line whose ends meet the river; absent when open */
  wallLine?: Pt[];
  /** the far bank's own place: the old village's green or the abbey's precinct */
  farPlace?: Pt[];
  /** where the market's streets come in: the high street's end, and its heading */
  marketAt: Pt;
  plotDepth: number;
  /** river crossings: the first is the town's bridge */
  bridges: Pt[];
  /** an abbey-gate town's precinct */
  anchorPoly?: Pt[];
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
  const form = o.form ?? "river";
  const hasFar = !!o.farBank && BANKED.includes(form);
  const walled = o.enclosure === "wall" || o.enclosure === "palisade";
  const R = site.radius;
  // Burgage plots: long and narrow, longer than in the crowded radial towns.
  // A town of blocks has two shallower lots back to back between its streets, not two long burgage plots.
  const depth = (urban || o.scale === "village" ? r.range(24, 32) : r.range(28, 36)) * (o.blocks ? 0.75 : 1);
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
  // A ridge town climbs its crest; a river town heads for the middle of its bank.
  const into = site.ridge ? site.ridge.dir : norm2(sub([0, 0], site.bridge.p));
  const foot = add(site.bridge.p, mul(into, site.width / 2 + 3));

  // 1–3. The spine: each form lays its own high street, market and main roads.
  const S = marketSize(o, o.need) * 1.35;
  const plotW = urban ? 6.75 : o.scale === "village" ? 8.75 : 13.5;
  let M: Pt = [0, 0], d: Pt = [1, 0], market: Pt[] = [], exits: Pt[] = [];
  let anchorPoly: Pt[] | undefined;
  // The roads run out as far as the suburbs along them: the DM's "many" sends them further.
  const reach = R * (walled ? 1.75 : 1.6) * (o.suburbs === "many" ? 1.45 : o.suburbs === "few" ? 0.85 : 1);
  const centreOf = (pts: Pt[]) => mul(pts.reduce((t, p) => add(t, p), [0, 0] as Pt), 1 / pts.length);
  // Where a form's town doesn't go: off a ridge's flanks, or round behind a castle-gate town's castle.
  const offSite = (p: Pt) => {
    if (site.ridge) {
      // A ridge town is long and narrow: along the crest from the river up, never far down its flanks.
      const rel = sub(p, site.ridge.foot), up = dot(rel, site.ridge.dir);
      return Math.abs(dot(rel, perp(site.ridge.dir))) > site.ridge.half || up < site.width || up > R * 2.2;
    }
    if ((form === "castle" || form === "abbey") && site.anchor) return dot(norm2(sub(p, site.anchor)), d) < -0.3;
    return false;
  };
  // A castle's bailey or an abbey's precinct: no street goes through it.
  const inAnchor = (p: Pt, margin = 0) => (form === "castle" && site.anchor ? hypot(p[0] - site.anchor[0], p[1] - site.anchor[1]) < (site.anchorR ?? 40) + margin : false)
    || (!!anchorPoly && (pointInPoly(p, anchorPoly) || lineDist([...anchorPoly, anchorPoly[0]], p) < margin));
  /** A main road out along bearing `b` from `start`, wandering along the easy ground. */
  const growRoad = (id: string, b: number, start: Pt, reachK = 1, straight = 0, kind: StreetKind = "main") => {
    const dir0 = rot([1, 0], b);
    const pts: Pt[] = [start];
    // A road leaving along a market's side runs straight beside it first.
    for (let s0 = 22; s0 <= straight; s0 += 22) pts.push(add(start, mul(dir0, s0)));
    const c0 = centreOf(market);
    // An organic town's roads were never laid out: they wander more.
    const wander = form === "organic" ? 1.8 : 1;
    let hd = dir0, bend = r.range(-0.05, 0.05) * wander;
    while (d2(pts[pts.length - 1], c0) < (reach * reachK) ** 2 && pts.length < 200) {
      const at = pts[pts.length - 1];
      bend = Math.max(-0.12 * wander, Math.min(0.12 * wander, bend + r.range(-0.04, 0.04) * wander));
      // Of three headings, the one that climbs least.
      let next = rot(hd, bend), nb = Infinity;
      for (const t of [-0.15, 0, 0.15]) {
        const c = rot(hd, bend + t);
        const p = add(at, mul(c, 22));
        // Round a castle mound the level way is a ring: a road away from a castle-gate town keeps going away.
        const away = form === "castle" && site.anchor ? (1 - dot(c, norm2(sub(p, site.anchor)))) * 1.5 : 0;
        const cost = Math.abs(site.height(p) - site.height(at)) * 40 + Math.abs(t) * 0.5 + away + (wet(p, 6) || inAnchor(p, 6) ? 100 : 0);
        if (cost < nb) { nb = cost; next = c; }
      }
      let p = add(at, mul(next, 22));
      // Never into the river: turn along the bank instead.
      for (let tries = 0; (wet(p, 6) || inAnchor(p, 6)) && tries < 8; tries++) {
        next = rot(next, (tries % 2 ? -1 : 1) * 0.25 * (tries + 1));
        p = add(at, mul(next, 22));
      }
      if (wet(p, 6) || inAnchor(p, 6)) break;
      hd = norm2(add(mul(hd, 0.6), mul(next, 0.4)));
      pts.push(p);
    }
    if (pts.length > 2) streets.push({ id, kind, width: mainW, points: pts, bank: "near" });
  };
  /** Start from whichever of the market's exits faces bearing `b` best. */
  const exitFor = (b: number) => {
    const dir0 = rot([1, 0], b), c0 = centreOf(market);
    let start = exits[0], sb = -Infinity;
    for (const x of exits) { const sc = dot(norm2(sub(x, c0)), dir0); if (sc > sb) { sb = sc; start = x; } }
    return start;
  };
  /** `k` bearings fanned unevenly across `spread` radians, centred on `mid`. */
  const fan = (mid: number, spread: number, k: number) => {
    const w = Array.from({ length: k }, () => r.range(0.5, 1.5));
    const tot = w.reduce((x, y) => x + y, 0);
    let acc = 0;
    return w.map((wi) => { const t = (acc + wi / 2) / tot; acc += wi; return mid - spread / 2 + t * spread; });
  };

  if (form === "river" || form === "ridge") {
    // 1. The high street climbs from the bridge foot, by the easiest rise that still heads into town.
    const high: Pt[] = [site.bridge.p, foot];
    let h = into;
    // A ridge town's high street climbs the whole crest; a river town's only to its market.
    const want = form === "ridge" ? R * 0.8 : hypot(foot[0], foot[1]) * r.range(0.8, 1.05);
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
    M = high[high.length - 1];
    d = norm2(sub(M, high[Math.max(0, high.length - 4)]));
    const side = perp(d);
    streets.push({ id: "high", kind: "high", width: mainW + 1, points: high, bank: "near" });

    // 2. The market: a long triangle opening from the high street, or the street itself widened
    // (always widened on a ridge, where there is no room for a triangle).
    if (form !== "ridge" && r.chance(0.5)) {
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

    // 3. Main roads: unevenly spaced bearings in the arc away from the bridge, wandering along the easy ground.
    const k = Math.max(1, o.roads - 1);
    let bearings: number[];
    if (form === "ridge") {
      // On up the crest beyond the market, and off down either flank.
      const up = angleOf(d);
      bearings = [up + r.range(-0.2, 0.2), up + PI / 2 + r.range(-0.3, 0.3), up - PI / 2 + r.range(-0.3, 0.3), up + PI * 0.3 + r.range(-0.1, 0.1), up - PI * 0.3 + r.range(-0.1, 0.1)].slice(0, k);
    } else {
      const back = angleOf(mul(d, -1));
      const free = TAU - (80 * PI) / 180, minGap = (35 * PI) / 180;
      const w = Array.from({ length: k + 1 }, () => r.range(0.3, 1.7));
      const wt = w.reduce((a, b) => a + b, 0);
      const spare = Math.max(0, free - (k + 1) * minGap);
      bearings = [];
      let acc = back + (40 * PI) / 180;
      for (let i = 0; i < k; i++) { acc += minGap + (spare * w[i]) / wt; bearings.push(acc); }
    }
    // A ridge town's road on up the crest is its backbone: it runs to the top whatever the suburbs.
  bearings.forEach((b, i) => growRoad(`main${i}`, b, exitFor(b), form === "ridge" && i === 0 ? (R * 1.6) / reach : 1));
  } else if (form === "castle" || form === "abbey") {
    // The town grows outside the gate: of a castle (Devizes, Ludlow) or an abbey precinct (St Albans, Peterborough).
    const C = site.anchor!;
    d = norm2(sub([0, 0], C));
    const tang = perp(d);
    let gate: Pt;
    if (form === "castle") {
      const cr = site.anchorR ?? 40;
      gate = add(C, mul(d, cr + 2));
      // The market: a broad space in the old outer bailey, bending round the castle.
      M = add(C, mul(d, cr + S * 0.95));
      const L = S * r.range(1.3, 1.6), Wd = S * r.range(0.5, 0.65), bow = S * 0.3;
      market = [add(add(M, mul(tang, -L)), mul(d, -bow)), add(add(M, mul(tang, -L * 0.5)), mul(d, -Wd)), add(add(M, mul(tang, L * 0.5)), mul(d, -Wd)),
        add(add(M, mul(tang, L)), mul(d, -bow)), add(add(M, mul(tang, L * 0.55)), mul(d, Wd)), add(add(M, mul(tang, -L * 0.55)), mul(d, Wd))];
      exits = [market[0], market[3], add(mul(add(market[4], market[5]), 0.5), mul(d, 2))];
      streets.push({ id: "high", kind: "high", width: mainW + 1, points: [gate, add(M, mul(d, -Wd + 1))], bank: "near" });
    } else {
      // The precinct: a great walled block, its gatehouse facing the town.
      // (Big enough for the church and its cloister, not so big it swallows the town.)
      const A = Math.max(urban ? 95 : 78, R * r.range(0.28, 0.36)), B = Math.max(urban ? 68 : 56, R * r.range(0.18, 0.24));
      anchorPoly = [add(add(C, mul(tang, -A / 2)), mul(d, -B / 2)), add(add(C, mul(tang, A / 2)), mul(d, -B / 2)), add(add(C, mul(tang, A / 2)), mul(d, B / 2)), add(add(C, mul(tang, -A / 2)), mul(d, B / 2))];
      gate = add(C, mul(d, B / 2));
      // The market: a broad funnel before the gatehouse, where pilgrims and townsfolk met.
      M = add(gate, mul(d, S));
      const W0 = S * r.range(1.1, 1.4), W1 = S * r.range(0.55, 0.8), Dp = S * r.range(1.8, 2.3);
      market = [add(add(gate, mul(tang, -W0)), mul(d, 5)), add(add(gate, mul(tang, W0)), mul(d, 5)), add(add(gate, mul(tang, W1)), mul(d, Dp)), add(add(gate, mul(tang, -W1)), mul(d, Dp))];
      exits = [market[0], market[1], market[2], market[3], add(mul(add(market[2], market[3]), 0.5), mul(d, 2))];
    }
    // Main roads fan out from the market, away from the castle or the abbey.
    // (A castle-gate town's high street is the way up to the castle gate; an abbey-gate town's is the first road out.)
    fan(angleOf(d), form === "castle" ? PI * 0.95 : PI * 1.3, Math.max(2, o.roads)).forEach((b, i) => growRoad(i === 0 && form === "abbey" ? "high" : `main${i}`, b, exitFor(b), 1, 0, i === 0 && form === "abbey" ? "high" : "main"));
  } else if (form === "street") {
    // One long, wide, gently curving street that is the market itself (Marlborough, Thame).
    d = dirOf(r.range(0, TAU));
    const side = perp(d);
    const Lm = R * r.range(1.7, 2.1);
    const bendK = r.range(-0.12, 0.12);
    const n2 = 10;
    const mid = (t: number): Pt => add(mul(d, (t * Lm) / 2), mul(side, bendK * Lm * (1 - t * t) * 0.5));
    const half = (t: number) => S * (0.2 + 0.18 * (1 - t * t));
    const left: Pt[] = [], right: Pt[] = [];
    for (let j = 0; j <= n2; j++) {
      const t = -1 + (2 * j) / n2;
      const tn = norm2(sub(mid(Math.min(1, t + 0.05)), mid(Math.max(-1, t - 0.05))));
      left.push(add(mid(t), mul(perp(tn), half(t))));
      right.push(add(mid(t), mul(perp(tn), -half(t))));
    }
    market = [...left, ...right.reverse()];
    M = mid(0);
    exits = [mid(-1), mid(1)];
    growRoad("high", angleOf(mul(d, -1)), mid(-1), 1, 0, "high");
    growRoad("main0", angleOf(d), mid(1));
    // At most one or two side roads off the middle of the street.
    for (let i = 1; i < Math.min(2, o.roads - 1); i++) {
      const sd = i % 2 ? 1 : -1, at = (i === 1 ? 0.15 : -0.3) * sd;
      const tn = norm2(sub(mid(at + 0.05), mid(at - 0.05)));
      growRoad(`main${i}`, angleOf(mul(perp(tn), sd)) + r.range(-0.3, 0.3), add(mid(at), mul(perp(tn), sd * half(at))));
    }
  } else if (form === "organic") {
    // The old heart of a town that grew round its market: roads out at uneven bearings, bending to
    // the ground; the blocks between them come after.
    const k = Math.max(3, Math.min(5, o.roads));
    // A market for a tight town of blocks: smaller than the sprawling plans' (S is sized for those).
    const shapeOf = Array.from({ length: 7 }, (_, i) => S * r.range(0.7, 0.95) * [1, 0.9, 1.1, 0.95, 1.05, 0.9, 1][i]);
    const a0 = r.range(0, TAU);
    market = shapeOf.map((rad, i) => mul(dirOf(a0 + (i / 7) * TAU + r.range(-0.15, 0.15)), rad));
    M = [0, 0];
    d = dirOf(a0);
    exits = market;
    fan(r.range(0, TAU), TAU * (1 - 1 / (k + 1)), k).forEach((b, i) => growRoad(i === 0 ? "high" : `main${i}`, b, exitFor(b), r.range(0.8, 1.2), 0, i === 0 ? "high" : "main"));
  } else if (form === "crossroads") {
    // Two through-roads crossing, their arms bending and unequal (Banbury, Abingdon); the market in one angle.
    const b0 = r.range(0, TAU);
    const arms = [b0, b0 + PI + r.range(-0.35, 0.35), b0 + PI / 2 + r.range(-0.45, 0.45), b0 - PI / 2 + r.range(-0.45, 0.45)];
    for (let i = 4; i < o.roads; i++) arms.push(b0 + PI * (i % 2 ? 0.25 : 1.25) + r.range(-0.2, 0.2));
    d = dirOf(b0);
    const a1 = dirOf(arms[0]), a2 = dirOf(arms[2]);
    const n1 = mul(perp(a1), dot(perp(a1), a2) >= 0 ? 1 : -1), n2 = mul(perp(a2), dot(perp(a2), a1) >= 0 ? 1 : -1);
    const off = mainW / 2 + 3;
    market = [add(mul(n1, off), mul(n2, off)), add(mul(a1, S * 2.3), mul(n1, off)), add(mul(a2, S * 2), mul(n2, off))];
    M = [0, 0];
    exits = [[0, 0]];
    arms.forEach((b, i) => growRoad(i === 0 ? "high" : `main${i}`, b, [0, 0], r.range(0.65, 1.3), i === 0 ? S * 2.3 : i === 2 ? S * 2 : 0, i === 0 ? "high" : "main"));
  } else {
    // A harbour: the quay along the shore, the market at the quayside, lanes climbing the hill behind (Dartmouth, Fowey).
    const sea = site.sea!;
    const t0 = perp(sea.n);
    const mouth = site.river[Math.max(0, site.river.length - 2)];
    const away: Pt = dot(sub([0, 0], mouth), t0) >= 0 ? t0 : mul(t0, -1);
    const s0 = dot(mouth, away) + site.width * 1.5 + 8;
    const Lq = Math.max(R * 0.9, Math.min(R * 2.2, o.need * plotW * 0.45));
    const line0 = mul(sea.n, sea.d - 9);
    const quay: Pt[] = [];
    for (let sq = s0; sq <= s0 + Lq; sq += 18) quay.push(add(line0, mul(away, sq)));
    streets.push({ id: "quay", kind: "quay", width: mainW, points: quay, bank: "near" });
    d = mul(sea.n, -1);
    M = add(line0, mul(away, s0 + Lq * 0.35));
    const qa = mainW / 2 + 2;
    market = [add(add(M, mul(away, -S * 1.1)), mul(d, qa)), add(add(M, mul(away, S * 1.1)), mul(d, qa)), add(add(M, mul(away, S * 0.9)), mul(d, qa + S)), add(add(M, mul(away, -S * 0.9)), mul(d, qa + S))];
    exits = [market[2], market[3], add(mul(add(market[2], market[3]), 0.5), mul(d, 2))];
    // On along the shore beyond the quay, and up the hill inland.
    growRoad("main0", angleOf(away), quay[quay.length - 1]);
    const inland = angleOf(d);
    [inland + r.range(-0.4, 0.4), inland + 0.9 + r.range(-0.2, 0.2), inland - 0.9 + r.range(-0.2, 0.2)].slice(0, Math.max(1, o.roads - 2)).forEach((b, i) => growRoad(i === 0 ? "high" : `main${i + 1}`, b, exitFor(b), 1, 0, i === 0 ? "high" : "main"));
  }
  const centre = centreOf(market);

  // 3b'. The organic plan's streets: the edges of cells grown round the market (organic.ts).
  if (form === "organic") {
    const streetW0 = urban ? 4.5 : 5;
    const roads = streets.filter((x) => x.kind === "main" || x.kind === "high").map((x) => x.points);
    const { streets: cut } = organicStreets(r, {
      centre, market, radius: R, roads, height: site.height, wet: (p) => wet(p, 3),
      ...(o.shape ? { shape: o.shape } : {}), streetW: streetW0, laneW,
    });
    cut.forEach((e, i) => streets.push({ id: e.lane ? `olane${i}` : `ostreet${i}`, kind: e.lane ? "cross" : "street", width: e.lane ? laneW : streetW0, points: e.points, bank: "near" }));
  }

  // 3b. Side streets: branch off the streets already there, bend a little, and
  // join the next street they meet, until there is frontage enough for the town.
  const streetW = urban ? 4.5 : 5;
  // Only the inner reach of a main road counts: its outer length becomes ribbons along the road,
  // and a town that counted it would be three spokes from a market with nothing between.
  const inner2 = (R * 0.55) ** 2;
  let frontSum = streets.filter((x) => x.kind !== "far").reduce((t, x) => t + polyLen(x.points.filter((p) => d2(p, centre) < inner2)), 0) * 2;
  // A street town's market is its main frontage; a harbour's quay fronts the water on one side only.
  if (form === "street") frontSum += polyLen([...market, market[0]]);
  // A street town's market sides, a little outside it, as streets its lanes can leave from.
  const marketSides: Street[] = [];
  if (form === "street") {
    const h = market.length / 2;
    const out = (pts: Pt[], sgn: number) => pts.map((p, j) => { const a2 = pts[Math.max(0, j - 1)], b2 = pts[Math.min(pts.length - 1, j + 1)]; return add(p, mul(perp(norm2(sub(b2, a2))), sgn * 2)); });
    for (const [pts, sgn] of [[market.slice(0, h), 1], [market.slice(h), 1]] as [Pt[], number][]) {
      const side = out(pts, sgn);
      // Whichever way is out of the market.
      const pts2 = pointInPoly(side[side.length >> 1], market) ? out(pts, -sgn) : side;
      marketSides.push({ id: "market-side", kind: "street", width: 0, points: pts2, bank: "near" });
    }
  }
  // How many side streets a street town allows itself: few, it is one street.
  const maxSide = form === "street" ? 2 + Math.round(o.need / 40) : Infinity;
  // The share of side streets that keep to the level: a ridge's run down its flanks instead.
  const levelShare = form === "ridge" ? 0.7 : form === "castle" ? 0.9 : form === "harbour" ? 0.85 : 0.85;
  const frontage = () => frontSum;
  // Junctions, lanes and corners lose plots: only about two-fifths of a street's frontage ends up built on.
  // A town of blocks loses little frontage at its junctions: its lots turn the corners.
  const wantFront = o.need * plotW * (o.blocks ? 1.0 : 2.6) * (o.room ?? 1) ** 2;
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
  for (let tries = 0; form !== "organic" && frontage() < wantFront && sn < maxSide && tries < 300 + o.need * 2; tries++) {
    // Mostly off the main streets; now and then off a side street, for a second row.
    // A street town's lanes leave from its one great street, both sides.
    const parents = form === "street" ? [...marketSides, ...(o.need > 600 ? streets.filter((x) => x.kind === "street" && r.chance(0.25)) : [])] : streets.filter((x) => x.kind === "main" || x.kind === "high" || (form === "harbour" && x.kind === "quay") || (x.kind === "street" && r.chance(0.25)));
    const par = r.pick(parents);
    if (par.points.length < 4) continue;
    const i = r.int(1, par.points.length - 2);
    const at = par.points[i];
    const offMarket = form === "street" ? false : pointInPoly(at, market) || lineDist(market, at) < S * 0.5;
    if (!at || (!site.ridge && d2(at, centre) > (R * 0.92) ** 2) || offMarket || inAnchor(at, depth) || offSite(at)) continue;
    // Not too close to another side street leaving the same street.
    if (streets.some((x) => x.kind === "street" && d2(x.points[0], at) < (block * 0.7) ** 2)) continue;
    const t = norm2(sub(par.points[i + 1], par.points[i - 1]));
    // Most side streets run along the slope; some go straight down it, which ties the rows together.
    // Off a road that itself runs along the slope, a level street would only shadow it: go down the slope instead.
    const t0 = norm2(sub(par.points[Math.min(par.points.length - 1, i + 1)], par.points[i - 1]));
    let level = r.chance(form === "river" ? 0.85 : levelShare);
    if (level && Math.abs(dot(contour(at, t0), t0)) > 0.8) level = false;
    const along = (p: Pt, prefer: Pt) => (level ? contour(p, prefer) : (() => { const c = contour(p, prefer); const d0 = perp(c); return dot(d0, prefer) >= 0 ? d0 : mul(d0, -1); })());
    let hd = along(at, rot(perp(t), r.chance(0.5) ? 0 : PI));
    // A street that would run along its parent is no side street.
    if (Math.abs(dot(hd, t)) > 0.8) continue;
    const pts: Pt[] = [at];
    let joined = false;
    for (let step = 0; step < (form === "street" ? (o.need > 600 ? 14 : 9) : 60); step++) {
      const cur = pts[pts.length - 1];
      hd = norm2(add(mul(hd, 0.6), mul(along(cur, hd), 0.4)));
      hd = rot(hd, r.range(-0.03, 0.03));
      const p = add(cur, mul(hd, 18));
      if (wet(p, depth) || (!site.ridge && d2(p, centre) > (R * 0.98) ** 2) || pointInPoly(p, market) || inAnchor(p, depth) || offSite(p)) break;
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
  // The market is in the town (a river town's lies well inside it anyway).
  if (form !== "river") built.push(...market);
  // An abbey's precinct, and a castle, stand within the town's wall.
  if (anchorPoly) built.push(...anchorPoly);
  if (form === "castle" && site.anchor) for (let j = 0; j < 12; j++) built.push(add(site.anchor, mul(dirOf((j / 12) * TAU), site.anchorR ?? 40)));
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
    // Beyond the outermost streets' lots; once the town is built the wall is pulled in close round it.
    return Math.max(lifted[i], t / 9) + depth + 8;
  });
  const wallR = Math.max(...wallAt);
  // A hedge and ditch follows the same line as a wall would, without gates or towers.
  if (walled || o.enclosure === "hedge") {
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
  // (Without a bridge gate, the high street and the quay go out through gates of their own.)
  const hasBridge = BANKED.includes(form);
  if (walled && wallLine) for (const st of streets) if (st.kind === "main" || (!hasBridge && (st.kind === "high" || st.kind === "quay"))) {
    const g = crossing(st.points);
    if (!g) continue;
    gates.push({ ...g, road: st.id });
    // A road that wanders back across the wall further out goes through a second gate (not in a river town, as before).
    if (form === "river") continue;
    for (let i = 0; i + 1 < st.points.length; i++) for (let j = 0; j + 1 < wallLine.length; j++) {
      const x = segX(st.points[i], st.points[i + 1], wallLine[j], wallLine[j + 1]);
      if (x && d2(x, g.p) > 30 * 30 && gates.every((h) => d2(h.p, x) > 30 * 30)) gates.push({ p: x, t: norm2(sub(st.points[i + 1], st.points[i])), road: st.id });
    }
  }
  // The bridge gate stands back from the water, at the head of the bridge.
  if (walled && wallLine && hasBridge) gates.push({ p: add(foot, mul(into, 6)), t: into, road: "high" });

  // 5. Back lanes: a plot's depth behind every street front in town, both sides. (Not in a town of
  // blocks: there the side streets are two lots apart, and the lots of both meet back to back.)
  const inTown = (p: Pt) => d2(p, centre) < (R * 1.02) ** 2;
  const fronts = streets.filter((s) => s.kind === "high" || s.kind === "main" || s.kind === "street");
  const backs: Street[] = [];
  if (!o.blocks) for (const st of fronts) for (const sd of [1, -1]) {
    const off = offsetLine(st.points, sd * (depth + st.width / 2 + laneW / 2));
    let run: Pt[] = [];
    const flush = () => { if (run.length >= 3) backs.push({ id: `back${backs.length}`, kind: "back", width: laneW, points: run, bank: "near" }); run = []; };
    for (const p of off) {
      const clear = inTown(p) && !wet(p, 3) && !pointInPoly(p, market) && lineDist(market, p) > depth * (form === "river" ? 0.6 : 1.1) && !inAnchor(p, 4)
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

  // 8. The far bank, for the forms that have one: the road over the bridge, and the far side's own pattern.
  let farPlace: Pt[] | undefined;
  if (hasFar) {
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
  }

  // On the coast, a quay along the near bank, from the bridge down to the sea (a harbour has its own).
  if (site.sea && hasBridge) {
    const sideSign = site.near === 1 ? 1 : -1;
    const qline = offsetLine(site.river, sideSign * (site.width / 2 + 6));
    const bi = qline.reduce((bi, p, i) => (d2(p, foot) < d2(qline[bi], foot) ? i : bi), 0);
    const down = qline.slice(bi).filter((p) => bank(p) === site.near);
    if (down.length >= 3) streets.push({ id: "quay", kind: "quay", width: laneW + 2, points: [foot, ...down.slice(1)], bank: "near" });
  }

  // A city needs a second crossing, downstream or up.
  const bridges: Pt[] = hasBridge ? [site.bridge.p] : [];
  if (o.scale === "city" && hasBridge) {
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
  return { streets, market, gates, wallLine, farPlace, marketAt: M, plotDepth: depth, bridges, ...(anchorPoly ? { anchorPoly } : {}) };
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

/** The point inside a polygon furthest from its edges, found on a grid (its middle, for a convex one). */
function widestPoint(poly: Poly): Pt {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  let best = centroid(poly), bd = pointInPoly(best, poly) ? edgeDist(poly, best) : -1;
  const n = 14;
  for (let i = 1; i < n; i++) for (let j = 1; j < n; j++) {
    const p: Pt = [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * j) / n];
    if (!pointInPoly(p, poly)) continue;
    const d = edgeDist(poly, p);
    if (d > bd + 0.5) { bd = d; best = p; }
  }
  return best;
}
function edgeDist(poly: Poly, p: Pt): number {
  let d = Infinity;
  for (let k = 0; k < poly.length; k++) d = Math.min(d, segPointDist(p, poly[k], poly[(k + 1) % poly.length]));
  return d;
}

/** Whether a line crosses a polygon's outline. */
function lineCutsPoly(poly: Poly, line: Pt[]): boolean {
  for (let i = 0; i + 1 < line.length; i++) for (let j = 0; j < poly.length; j++) {
    const a = line[i], b = line[i + 1], c = poly[j], d = poly[(j + 1) % poly.length];
    const r = sub(b, a), q2 = sub(d, c), den = r[0] * q2[1] - r[1] * q2[0];
    if (Math.abs(den) < 1e-12) continue;
    const ca = sub(c, a), t = (ca[0] * q2[1] - ca[1] * q2[0]) / den, u = (ca[0] * r[1] - ca[1] * r[0]) / den;
    if (t > 0 && t < 1 && u > 0 && u < 1) return true;
  }
  return false;
}

interface RPlot extends Plot { far: boolean; suburb: boolean; street: string }

/** A river town: the town proper on its higher bank, a far bank over the bridge. */
export function layoutRiver(r: Rng, plan: Footprint[], o: RiverOpts & { far: number[] }): TownLayout {
  return layoutGrown(r, plan, { ...o, form: "river" });
}

/** A grown town of any form. */
export function layoutGrown(r: Rng, plan: Footprint[], o: RiverOpts & { far: number[] }): TownLayout {
  const urban = urbanOf(o);
  const form = o.form ?? "river";
  const hasFar = !!o.farBank && BANKED.includes(form);
  const walled = o.enclosure === "wall" || o.enclosure === "palisade";
  const coastTerrain = o.terrain === "coast";

  // ---- who stands where ------------------------------------------------------
  // The far bank's signature buildings, and enough ordinary housing beside them for its share.
  const farSet = new Set(hasFar ? o.far : []);
  const n = plan.length;
  if (hasFar) {
    const want = Math.round(n * r.range(0.17, 0.22));
    const homesFirst = o.farBank === "village" ? ["cottage", "farmhouse", "fisher_house", "tenement", "poor_row"] : o.farBank === "bridgend" ? ["poor_row", "tenement", "cottage"] : ["tenement", "cottage", "poor_row", "journeyman_house", "farmhouse", "fisher_house"];
    // Its own kind of people first, but never all of them: the town proper keeps some of every kind.
    for (const kind of [...homesFirst, ...HOUSING]) {
      let left = Math.ceil(plan.filter((p) => p.kind === kind).length * 0.6);
      for (let i = n - 1; i >= 0 && farSet.size < want && left > 0; i--) if (!farSet.has(i) && plan[i].kind === kind) { farSet.add(i); left--; }
    }
    // Never more than a quarter: the town proper keeps the rest.
    const cap = Math.floor(n * 0.23);
    if (farSet.size > cap) {
      // Drop ordinary housing first, the far bank's own signature buildings never.
      const extra = [...farSet].filter((i) => HOUSING.has(plan[i].kind ?? "")).sort((a, b) => (o.far.includes(a) ? 1 : 0) - (o.far.includes(b) ? 1 : 0) || b - a);
      extra.reverse();
      while (farSet.size > cap && extra.length) farSet.delete(extra.pop()!);
    }
  }
  const siteOf = (p: Footprint) => (p.site === "edge" ? "suburb" : p.site);
  let needNear = 0, needFar = 0;
  plan.forEach((p, i) => {
    if (GEO.has(siteOf(p) ?? "") && !(siteOf(p) === "gate" && !walled)) return;
    if (farSet.has(i)) needFar += plotsFor(p); else needNear += plotsFor(p);
  });

  // ---- the site and its streets ---------------------------------------------------
  const blocked = blockedForms.has(form);
  const ro: RiverOpts = { ...o, need: Math.ceil(needNear * 1.08), farNeed: Math.ceil(needFar * 1.15), ...(blocked ? { blocks: true } : {}) };
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
  let cr = urban ? r.range(38, 55) : 28;
  if (castleIdx >= 0 && form === "castle" && site.anchor) {
    // A castle-gate town's castle is where the town began: on its mound, already chosen.
    cr = site.anchorR ?? cr;
    castleAt = site.anchor;
    castle = qpoly(Array.from({ length: 9 }, (_, s2) => add(site.anchor!, mul(dirOf((s2 / 9) * TAU + r.range(-0.1, 0.1)), cr * r.range(0.92, 1.02)))));
    const bailey = castle;
    net.streets = net.streets.filter((st) => !((st.kind === "back" || st.kind === "cross" || st.kind === "water") && polylinePolyDist(st.points, bailey, st.width + 2) < st.width / 2 + 2));
  } else if (castleIdx >= 0) {
    let best: Pt | undefined, bs = -Infinity;
    for (let relax = 0; relax < 3 && !best; relax++) for (let k = 0; k < 60; k++) {
      const c = add(site.high, [r.range(-0.5, 0.5) * R, r.range(-0.5, 0.5) * R]);
      if (bank(c) !== site.near || lineDist(site.river, c) < site.width / 2 + cr * 0.6) continue;
      if (hypot(c[0] - mc[0], c[1] - mc[1]) < S + cr) continue;
      if (net.anchorPoly && (pointInPoly(c, net.anchorPoly) || lineDist([...net.anchorPoly, net.anchorPoly[0]], c) < cr + 6)) continue;
      if (inSea(c, cr + 6)) continue;
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
  const obstacles: Poly[] = [market, ...(castle ? [castle] : []), ...(net.farPlace ? [net.farPlace] : []), ...(net.anchorPoly ? [net.anchorPoly] : [])];
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
  const deadLanes = new Set<string>();
  // `own` "*": a block's lot, which may touch any street's edge, and whose neighbours it was cut with.
  const clearWhy = (poly: Poly, own: string, prev = -1): string | undefined => {
    // Cheap tests first: how far a segment is from the plot's middle, whether two boxes meet at all.
    const c = centroid(poly);
    let rad = 0;
    for (const p of poly) rad = Math.max(rad, hypot(p[0] - c[0], p[1] - c[1]));
    const seen = new Set<{ a: Pt; b: Pt; w: number; id: string }>();
    for (const k of keysOf(poly, 8)) for (const sg of sgrid.get(k) ?? []) {
      if (seen.has(sg)) continue;
      seen.add(sg);
      // A block's lots are inset from its streets already: only the wall and lanes that end inside a block can cross one.
      if (own === "*" && sg.id !== "wall" && !deadLanes.has(sg.id)) continue;
      const lim = sg.w / 2 - (sg.id === own || own === "*" ? 0.4 : -0.3);
      if (segPointDist(c, sg.a, sg.b) > rad + lim) continue;
      if (polylinePolyDist([sg.a, sg.b], poly, lim + 1) < lim) return "street:" + sg.id.replace(/\d+/g, "");
    }
    const bb = boxOf(poly);
    if (own !== "*") for (const k of keysOf(poly)) for (const j of pgrid.get(k) ?? []) {
      const o2 = boxes[j];
      if (o2[0] > bb[2] + 0.2 || o2[2] < bb[0] - 0.2 || o2[1] > bb[3] + 0.2 || o2[3] < bb[1] - 0.2) continue;
      // The plot before it on the street shares a side with it: touching is fine, crossing isn't.
      if (convexOverlap(poly, plots[j].poly, j === prev ? -0.2 : 0.15)) return "plot";
    }
    // A street town's market bends, and a bent shape is no convex one: test it by its edge.
    if (form === "street") {
      if (polylinePolyDist([...market, market[0]], poly, 1) < 0.5 || poly.some((p) => pointInPoly(p, market))) return "obstacle";
      return obstacles.slice(1).some((ob) => convexOverlap(poly, ob, 1) || poly.some((p) => pointInPoly(p, ob)) || ob.some((p) => pointInPoly(p, poly))) ? "obstacle" : undefined;
    }
    return obstacles.some((ob) => convexOverlap(poly, ob, 1) || poly.some((p) => pointInPoly(p, ob)) || ob.some((p) => pointInPoly(p, poly))) ? "obstacle" : undefined;
  };
  let runs = 0;
  const cutAlong = (line: Pt[], side: 1 | -1, half: number, own: string, kindOf: (mid: Pt) => FrontKind | undefined, far: boolean, d: number, widths = plotW) => {
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
      const w = r.range(widths[0], widths[1]);
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
      if (!kind || !dry || clearWhy(poly, own, idx ? plots.length - 1 : -1)) { s += w * 0.5; if (idx) { run = runs++; idx = 0; } continue; }
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
  if (blocked) { /* a town of blocks cuts the market's frontage with its blocks */ }
  else if (form === "street") {
    // A street town's market is one long street: cut each side as one frontage, not edge by edge.
    const h = market.length / 2;
    for (const pts of [market.slice(0, h), market.slice(h)]) {
      const mid = pts[pts.length >> 1], a = pts[(pts.length >> 1) - 1];
      const nrm: Pt = [-(mid[1] - a[1]), mid[0] - a[0]];
      // Narrow frontages along the great street, as in Marlborough or Chipping Campden.
      cutAlong(pts, dot(nrm, sub(mid, mc)) >= 0 ? 1 : -1, 1, "market", () => "market", false, depth, [5.5, 8]);
    }
  } else for (let i = 0; i + 1 < mClosed.length; i++) {
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
  const blocksOut: { id: string; outline: Poly; kind: BlockKind; ward: number }[] = [];
  const blockLots = new Map<string, RPlot[]>();
  const opens: Open[] = [];
  if (!blocked) for (const st of order) for (const side of [1, -1] as const) cutAlong(st.points, side, st.width / 2, st.id, frontOf(st), st.bank === "far", st.bank === "far" ? depth * 0.9 : depth);
  else {
    // The land between the streets, block by block. The market's edge is a street of its own; the
    // whole is closed a lot's depth beyond the outermost streets, so edge blocks have a back.
    const lines = [...net.streets.map((st) => ({ id: st.id, width: st.width, points: st.points })), { id: "market", width: 3, points: [...market, market[0]] }];
    // Round the town's own streets, not the roads out: those run on across it, so the edge blocks close.
    const close = insetEdges(convexHull(lines.filter((l) => !/^(main\d+|high)$/.test(l.id)).flatMap((l) => l.points)), -depth).poly;
    const graph = nodeStreets(lines, 3);
    // Blocks too big to fill are opened up by lanes across them (their backlands, built over).
    let ln = 0;
    const faces: Face[] = [];
    const laneW2 = urban ? 3 : 3.5;
    for (const f of blockFaces(graph, close)) {
      // (An organic town's blocks are sized by their seeds: small at the heart, larger outward. Left whole.)
      const sp = form === "organic" ? { faces: [f], lanes: [] } : splitBlock(f, laneW2, urban ? 4200 : 6500, () => `blane${ln++}`);
      faces.push(...sp.faces);
      sp.lanes.forEach((pts, k) => net.streets.push({ id: `blane${ln - sp.lanes.length + k}`, kind: "cross", width: laneW2, points: pts, bank: "near" }));
    }
    for (const d of deadEnds(graph, close)) deadLanes.add(d.street);
    const byId = new Map(net.streets.map((st) => [st.id, st]));
    const ids = { next: 0, run: runs };
    const midOf = (sd: Side): Pt => mul(add(sd.a, sd.b), 0.5);
    const frontAt = (sd: Side): FrontKind => (sd.street === "market" ? "market" : frontOf(byId.get(sd.street)!)(midOf(sd)) ?? "suburb");
    faces.forEach((f, fi) => {
      const c = centroid(f.outline);
      if (pointInPoly(c, market) || obstacles.slice(1).some((ob) => pointInPoly(c, ob))) return;
      const fronts = f.sides.map(frontAt);
      const near = hypot(c[0] - mc[0], c[1] - mc[1]);
      // A face of hectares is no block: it is the town's edge looking out on the fields, lined with crofts.
      const kind: BlockKind = area(f.outline) > 30000 || !inside(c) ? "croft"
        : fronts.includes("market") ? "shop"
        : near < R * 0.35 && fronts.some((k) => k === "main" || k === "quay") ? "shop"
        : area(f.outline) > 2400 && r.chance(0.1) ? "courtyard"
        : near < R * 0.8 && r.chance(0.1) ? "wellOff"
        : "ordinary";
      const { lots, open } = fillBlock(r, f, kind, frontAt, ids, `k${fi}`);
      blocksOut.push({ id: `k${fi}`, outline: qpoly(f.outline), kind, ward: -1 });
      blockLots.set(`k${fi}`, []);
      for (const l of lots) {
        const lc = centroid(l.poly);
        const bc = bank(lc);
        const far = hasFar && bc !== site.near;
        const want = far ? -site.near : site.near;
        if (bc !== want) continue;
        // Only a lot near the water need have each corner checked: away from it they're on one bank.
        const nearWater = riverGrid.dist(lc, 60) < 60 || inSea(lc, 60);
        if (nearWater && !l.poly.every((q2) => riverClear(q2, 1) && bank(q2) === want)) continue;
        if (clearWhy(l.poly, "*")) continue;
        const id = plots.length;
        const order = far ? hypot(lc[0] - site.bridge.p[0], lc[1] - site.bridge.p[1]) : hypot(lc[0] - mc[0], lc[1] - mc[1]);
        plots.push(Object.assign(l, { id, far, suburb: !far && l.kind === "suburb", order }));
        blockLots.get(`k${fi}`)!.push(plots[id]);
        boxes.push(boxOf(l.poly));
        for (const k of keysOf(l.poly)) { const g = pgrid.get(k); if (g) g.push(id); else pgrid.set(k, [id]); }
      }
      for (const op of open) if (riverClear(centroid(op.poly), 2)) opens.push(op);
    });
    // Beyond the blocks, the roads out are lined with houses: ribbons, thinning away from the gate.
    for (const st of net.streets) {
      if (st.kind !== "main" && st.kind !== "high") continue;
      const outside = st.points.filter((q2) => !pointInPoly(q2, close));
      if (outside.length < 2) continue;
      for (const side of [1, -1] as const) {
        const edge = offsetLine(outside, side * (st.width / 2));
        const ribbon = cutRibbon(r, edge, side, "croft", st.id, "suburb", (poly) => poly.every((q2) => riverClear(q2, 1) && bank(q2) === site.near) && !clearWhy(poly, st.id), ids);
        for (const l of ribbon) {
          const lc = centroid(l.poly);
          const id = plots.length;
          plots.push(Object.assign(l, { id, far: false, suburb: true, order: hypot(lc[0] - mc[0], lc[1] - mc[1]) }));
          boxes.push(boxOf(l.poly));
          for (const k of keysOf(l.poly)) { const g2 = pgrid.get(k); if (g2) g2.push(id); else pgrid.set(k, [id]); }
        }
      }
    }
    runs = ids.run;
  }

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
  const farNear = ["bridge", "river", o.farBank ?? "village"];
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
    // Neighbours on the street, with no lot dropped between them (one crossing a wall, or a lane).
    return seq.length === m && seq.every(free) && seq.every((x, k) => k === 0 || x.idx === seq[k - 1].idx + 1) ? seq : undefined;
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
  const placeYard = (i: number, seq: RPlot[], kind: "church" | "precinct", whole?: Poly) => {
    placeYardBody(i, seq, kind, whole);
    claim(result[i]);
  };
  const placeYardBody = (i: number, seq: RPlot[], kind: "church" | "precinct", whole?: Poly) => {
    for (const x of seq) x.used = true;
    const ordered = leftToRight(seq);
    const first = ordered[0], last = ordered[ordered.length - 1];
    // In a town of blocks a church or a religious house takes a whole block for its yard.
    const yard = insetOutline(whole ?? qpoly([first.poly[0], last.poly[1], last.poly[2], first.poly[3]]), 1.2);
    // In a bent block the middle may be in a thin arm, or outside it: stand it where the block is widest.
    const c = whole || blocked ? widestPoint(yard) : centroid(yard);
    const p = plan[i];
    // Square to the map, as ever; in a whole block, along its longest side.
    let u: Pt = [1, 0];
    if (whole || blocked) { let bl = -1; yard.forEach((v0, k) => { const e = sub(yard[(k + 1) % yard.length], v0); const L = hypot(e[0], e[1]); if (L > bl) { bl = L; u = [e[0] / L, e[1] / L]; } }); }
    const v = perp(u);
    const at = (x: number, y: number): Pt => add(c, add(mul(u, x), mul(v, y)));
    const fits = (polys: Poly[]) => polys.every((pl) => pl.every((pt) => pointInPoly(pt, yard)));
    let kk = 1;
    if (kind === "church") {
      const [cw0, cd0] = CHURCH_SIZE[p.size] ?? [16, 7.5];
      // Shrink to fit the yard: a church never stands over the street.
      for (; kk > 0.12; kk -= 0.04) if (fits([rect(at(-cw0 * kk * 0.12, 0), u, cw0 * kk * 0.76, cd0 * kk), rect(at(cw0 * kk * 0.38, 0), u, cw0 * kk * 0.24, cd0 * kk * 0.72)])) break;
      const cw = cw0 * kk, cd = cd0 * kk;
      const parts = [{ kind: "chancel", poly: qpoly(rect(at(cw * 0.38, 0), u, cw * 0.24, cd * 0.72)) }];
      if (p.size === "grand_temple" || p.size === "temple") {
        parts.push({ kind: "transept", poly: qpoly(rect(at(cw * 0.14, 0), u, cd * 0.9, cd * 2.3)) });
        parts.push({ kind: "tower", poly: qpoly(rect(at(-cw * 0.47, 0), u, cd * 0.8, cd * 0.8)) });
      }
      result[i] = { planIndex: i, poly: qpoly(rect(at(-cw * 0.12, 0), u, cw * 0.76, cd)), parts, plot: yard, plotKind: "churchyard", front: qp(c), road: first.street, ward: first.ward, block: first.block };
      if (!wards[first.ward].near.includes(p.size)) wards[first.ward].near.push(p.size);
      churchAt.push(c);
    } else {
      for (; kk > 0.12; kk -= 0.04) if (fits([rect(at(0, -9 * kk), u, 30 * kk, 9 * kk), rect(at(0, 8 * kk), u, 20 * kk, 16 * kk)])) break;
      result[i] = { planIndex: i, poly: qpoly(rect(at(0, -9 * kk), u, 30 * kk, 9 * kk)), parts: [{ kind: "cloister", poly: qpoly(rect(at(0, 8 * kk), u, 20 * kk, 16 * kk)) }], plot: yard, plotKind: "precinct", front: qp(c), road: first.street, ward: first.ward, block: first.block };
    }
  };
  /** A whole free block for a church or religious house, by score; marks it as that kind of block. */
  const wholeBlock = (i: number, kind: "church" | "precinct", minArea: number, score: (c: Pt) => number, minWidth = 0): boolean => {
    if (!blocked) return false;
    const onFar = farSet.has(i);
    let best: { b: (typeof blocksOut)[number]; lots: RPlot[] } | undefined, bs = -Infinity;
    for (const b of blocksOut) {
      const lots = blockLots.get(b.id) ?? [];
      // (A friary may stand outside the walls, as many did; a parish church stands among its people.)
      if (!lots.length || lots.some((l) => l.used || l.far !== onFar || l.kind === "market") || (kind === "church" && !onFar && lots.some((l) => l.suburb))) continue;
      if (area(b.outline) < minArea || b.kind === "church" || b.kind === "precinct") continue;
      // Wide enough to hold it, not just big enough: a long thin block squeezes a church to nothing.
      // (Its width as area over half its outline: true for bent and curving blocks too.)
      let rim = 0;
      b.outline.forEach((v, k) => { const w2 = b.outline[(k + 1) % b.outline.length]; rim += hypot(w2[0] - v[0], w2[1] - v[1]); });
      if (area(b.outline) / Math.max(1, rim / 2) < minWidth) continue;
      // The smallest block that will do: a church doesn't swallow a whole quarter.
      const sc = score(centroid(b.outline)) - (area(b.outline) / minArea - 1) * 30;
      if (sc > bs) { bs = sc; best = { b, lots }; }
    }
    if (!best) return false;
    best.b.kind = kind;
    placeYard(i, best.lots, kind, best.b.outline);
    return true;
  };
  for (const { p, i } of churches) {
    const onFar = farSet.has(i);
    const [cw0, cd0] = CHURCH_SIZE[p.size] ?? [16, 7.5];
    const churchScore = (c: Pt) => onFar && net.farPlace ? -hypot(c[0] - centroid(net.farPlace)[0], c[1] - centroid(net.farPlace)[1])
      : !churchAt.length && !onFar ? site.height(c) * 6 - hypot(c[0] - mc[0], c[1] - mc[1]) / R
      : Math.min(300, ...churchAt.map((q2) => hypot(c[0] - q2[0], c[1] - q2[1]))) + r.range(0, 20);
    if ([2.2, 1.4].some((k) => wholeBlock(i, "church", cw0 * cd0 * k, churchScore, cd0 * 1.8))) continue;
    let best: RPlot[] | undefined, bs = -Infinity;
    // The longest run there is, up to what the church wants: it shrinks to fit its yard.
    // (Not on the backland round a block's inner court: those lots are a cottage deep.)
    const cands = plots.filter((x) => !x.used && x.far === onFar && (onFar || !x.suburb) && x.kind !== "market" && x.kind !== "lane");
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
  // Religious houses: an abbey-gate town's abbey in its great precinct, the abbey's precinct over the
  // bridge, others on a long run of plots.
  const abbeyAt = form === "abbey" && net.anchorPoly ? plan.findIndex((p) => p.kind === "abbey") : -1;
  if (abbeyAt >= 0 && net.anchorPoly) {
    const yard = qpoly(net.anchorPoly);
    const c = centroid(yard);
    const u = norm2(sub(net.anchorPoly[1], net.anchorPoly[0])), v = perp(u);
    // The abbey church along the precinct, its cloister beside it, the gatehouse facing the town.
    // A great church for its town, about Tewkesbury's length on this map's scale, not the precinct's.
    const k2 = urban ? 1.35 : 1.15;
    result[abbeyAt] = {
      planIndex: abbeyAt, poly: qpoly(rect(add(c, mul(v, -10 * k2)), u, 48 * k2, 13 * k2)),
      parts: [{ kind: "cloister", poly: qpoly(rect(add(c, mul(v, 10 * k2)), u, 26 * k2, 22 * k2)) }, { kind: "tower", poly: qpoly(rect(add(c, add(mul(v, -10 * k2), mul(u, -27 * k2))), u, 8 * k2, 8 * k2)) }],
      plot: yard, plotKind: "precinct", front: qp(c), road: "high", ward: nearestWard(wards, c), block: "precinct",
    };
    wards[result[abbeyAt]!.ward!].near.push("abbey");
  }
  plan.forEach((p, i) => {
    if (p.site !== "precinct" || result[i]) return;
    if (farSet.has(i) && net.farPlace && o.farBank === "abbey") {
      const yard = qpoly(net.farPlace);
      const c = centroid(yard);
      const w = wards.find((x) => x.bank === "far");
      const k = p.kind === "cell" ? 0.6 : 1; // a cell is a few monks, not a convent
      result[i] = { planIndex: i, poly: qpoly(rect(add(c, [0, -9 * k]), [1, 0], 30 * k, 9 * k)), parts: [{ kind: "cloister", poly: qpoly(rect(add(c, [0, 8 * k]), [1, 0], 20 * k, 16 * k)) }], plot: yard, plotKind: "precinct", front: qp(c), road: "far", ward: w?.id, block: "precinct" };
      return;
    }
    const onFar = farSet.has(i);
    // Out towards the edge, where there was room for a convent's garden and close.
    const want = p.kind === "cell" ? 900 : 2200;
    if ([1, 0.5, 0.25].some((k) => wholeBlock(i, "precinct", want * k, (c) => hypot(c[0] - mc[0], c[1] - mc[1]) / R + r.range(0, 0.2), 20))) return;
    for (const m of [8, 6, 5, 4, 3, 2, 1]) {
      const x = plots.filter((q2) => !q2.used && q2.far === onFar && q2.kind !== "market").sort((a, b) => b.order - a.order || a.id - b.id).find((q2) => runFrom(q2, m));
      if (x) { placeYard(i, runFrom(x, m)!, "precinct"); break; }
    }
  });
  // The market hall, in the market.
  plan.forEach((p, i) => {
    if (p.site !== "market_place") return;
    if (form === "street") {
      // A street town's hall stands in the middle of its street, end on to the traffic.
      const along = norm2(sub(market[market.length / 2 - 1], market[0]));
      const at = net.marketAt;
      result[i] = { planIndex: i, poly: qpoly(rect(at, along, p.size === "hall" ? 18 : 12, p.size === "hall" ? 9 : 7)), parts: [], front: qp(at), road: "market", ward: nearestWard(wards, at), block: "market" };
      return;
    }
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
    if (w.bank === "far") w.value = r.pick(FAR_VALUES[o.farBank ?? "village"]);
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
  const gentle = form === "river" && !blocked;
  const spillShare = (urban ? 0.12 : 0.06) * (o.suburbs === "few" ? (gentle ? 0.25 : 0.1) : o.suburbs === "many" ? (gentle ? 2.5 : 5) : 1);
  // (In the forms besides the river, "many" sends the next class of housing out too.)
  const spillTop = !gentle && o.suburbs === "many" ? 2 : 1;
  const spillOut = new Set(orderIx.filter((i) => !farSet.has(i) && (!plan[i].site || plan[i].kind === "poor_row") && plotsFor(plan[i]) === 1 && (plan[i].value?.[0] ?? 9) <= spillTop && r.chance(Math.min(0.9, spillShare * 2))));
  const spill: number[] = [];
  const overflowOk = form === "river" || (o.room ?? 1) > 1.45;
  for (const i of orderIx) {
    const p = plan[i];
    const far = farSet.has(i);
    const m = plotsFor(p);
    const housing = !p.site && m === 1 && !spillOut.has(i);
    let fronts: FrontKind[] = far ? (p.site === "quay" || p.site === "shore" ? ["quay", "main", "street"] : ["main", "street", "quay"]) : isSub(p) || spillOut.has(i) ? ["suburb", "street", "main"] : FRONTS[p.site ?? "housing"] ?? FRONTS.housing;
    // A street town's great street is where its trades are.
    if (form === "street" && !fronts.includes("market") && !fronts.includes("suburb")) fronts = [...fronts, "market"];
    const lo = far ? 0 : p.value?.[0] ?? 0, hi = far ? 8 : p.value?.[1] ?? 8;
    let got: RPlot[] | undefined;
    if (housing) {
      // Ordinary houses fill from the middle out, trading distance against a class of value. In the forms
      // besides the river, a town that can't house its people inside is laid out again roomier, and only
      // the last try lets them overflow to the roads outside.
      let best: RPlot | undefined, bc = Infinity;
      const overflow = form === "river" || (o.room ?? 1) > 1.45;
      for (const fr of [...fronts, ...(overflow ? ["suburb" as FrontKind] : [])]) for (let v = 0; v <= 8; v++) {
        const c = peek(`${far ? 1 : 0}:${fr}:${far ? 0 : v}`);
        if (!c) continue;
        // (A street town's houses stand along its great street first, all the way along.)
        const cost = c.order + 10 * (v < lo ? lo - v : v > hi ? v - hi : 0) + (fr === "suburb" ? R : 0) - (form === "street" && fr === "market" ? R * 0.8 : 0);
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
              // The first free plot in each stretch of the street, so a filling town still has a choice.
              let k = j;
              while (k + 1 < Math.min(l.length, j + stride) && l[k].used) k++;
              const c = l[k];
              if (c.used) continue;
              const seq = runFrom(c, m);
              if (!seq) continue;
              const cc = centroid(c.poly);
              let nearest = Infinity;
              // The latest few of its kind are enough to keep apart from (or close to).
              for (const q2 of (prior ?? []).slice(-40)) nearest = Math.min(nearest, hypot(cc[0] - q2[0], cc[1] - q2[1]));
              const sc = (prior?.length ? (p.cluster ? -nearest : Math.min(nearest, 500)) : 0) - c.order * 0.5 - fronts.indexOf(fr) * (form === "river" ? 40 : 120);
              if (sc > bs) { bs = sc; best = seq; }
            }
          }
          // A river town takes the first kind of street with room; the other forms weigh them all, so a
          // kind of street with few plots doesn't end up a row of one trade.
          // (What spills beyond the gates takes the first suburb it can, in every form.)
          if (best && (form === "river" || spillOut.has(i))) break;
        }
        got = best;
      }
      if (!got && m > 1) for (const fr of fronts) { const c = peek(`${far ? 1 : 0}:${fr}:0`) ?? [...plots].find((x) => !x.used && x.far === far); if (c) { got = [c]; break; } }
    }
    // Out of room on this bank: say so (the layout is tried again roomier), unless this is the last try.
    if (!got) { const c = plots.find((x) => !x.used && x.far === far && (overflowOk || !housing || !x.suburb)) ?? ((o.room ?? 1) > 1.45 ? plots.find((x) => !x.used) : undefined); if (c) got = [c]; }
    if (!got) { spill.push(i); continue; }
    for (const x of got) x.used = true;
    if (p.kind) { const kk = familyOf(p.kind); const l = placedAt.get(kk) ?? []; l.push(centroid(got[0].poly)); placedAt.set(kk, l); }
    result[i] = blocked ? shapeOn(r, i, p, got as Lot[], (got[0] as Lot).kindOfBlock ?? "ordinary") : building(r, i, p, got, urban);
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
  if (net.bridges.length && r.chance(0.6)) features.push({ kind: "bridge_chapel", p: qp(site.bridge.p) });
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
  // On the coast the map reaches the river's mouth, wherever the town stands from it.
  const mouthReach = site.sea && blocked ? hypot(site.river[site.river.length - 1][0] - mc[0], site.river[site.river.length - 1][1] - mc[1]) + 20 : 0;
  const extent = Math.max(outerR + 140, builtReach + 80, mouthReach);
  let coastLine: Pt[] | undefined, sea: Poly | undefined;
  if (site.sea) {
    // The shore beside the town (a river town's is drawn from the map's middle, as it always was).
    const u = perp(site.sea.n), b0 = form === "river" ? mul(site.sea.n, site.sea.d) : add(mc, mul(site.sea.n, site.sea.d - dot(mc, site.sea.n)));
    const L = form === "river" ? extent * 1.5 : extent * 2.5;
    coastLine = [qp(add(b0, mul(u, -L))), qp(add(b0, mul(u, L)))];
    sea = qpoly([coastLine[0], coastLine[1], add(coastLine[1], mul(site.sea.n, extent * 3)), add(coastLine[0], mul(site.sea.n, extent * 3))]);
  }
  const quayLine = net.streets.find((s) => s.kind === "quay")?.points;
  const high = contourLines(site.height, mc, R * 1.3, 28);
  const lowLines = contourLines(site.height, mc, R * 1.3, 28, [0.25, 0.45]);
  // The wall was fitted to the streets before anything was built on them: pull it in to what was,
  // bearing by bearing, so it doesn't loop round empty ground. Gatehouses count as built, so the
  // wall stays put at its gates, and its ends stay on the river.
  // A wall with no river to close it is a ring: its last point is its first.
  const ring = !!net.wallLine && net.wallLine.length > 6 && net.wallLine[0] === net.wallLine[net.wallLine.length - 1];
  if (net.wallLine && net.wallLine.length > 6) {
    const NB = 72;
    const binOf = (p: Pt) => Math.round(((atan2(p[1] - mc[1], p[0] - mc[0]) + TAU) % TAU) / TAU * NB) % NB;
    const reachAt: number[] = Array.from({ length: NB }, () => 0);
    const mark = (p: Pt) => { const k = binOf(p); reachAt[k] = Math.max(reachAt[k], hypot(p[0] - mc[0], p[1] - mc[1])); };
    // A town of blocks has lots to spare at its edges: the wall goes round the ones built on.
    // (In a town of blocks, any lot within the first line, though the old reckoning called it suburb.)
    const firstLine = net.wallLine;
    const within = (q2: Pt) => pointInPoly(q2, firstLine);
    // (A town of blocks has whole blocks to spare at its edges, empty: its wall goes round the blocks built in.)
    const builtIn = new Set(plots.filter((p) => p.used).map((p) => p.block.replace(/b$/, "")));
    for (const p of plots) if (!p.far && (!p.suburb || (blocked && within(centroid(p.poly)))) && (!blocked || builtIn.has(p.block.replace(/b$/, "")))) p.poly.forEach(mark);
    market.forEach(mark);
    castle?.forEach(mark);
    // Every gate holds the wall where it is, gatehouse or none (a river town's gates all have theirs).
    if (form !== "river") for (const g of net.gates) mark(add(g.p, mul(norm2(sub(g.p, mc)), 4)));
    // The castle, whatever ward it falls in: its keep and hall, and its bailey's whole edge.
    if (form !== "river" && castleIdx >= 0 && result[castleIdx]) {
      const cb = result[castleIdx]!;
      for (const pl of [cb.poly, ...cb.parts.map((x) => x.poly)]) pl.forEach(mark);
      if (castle) for (let j = 0; j < castle.length; j++) { const a = castle[j], b = castle[(j + 1) % castle.length]; for (let s2 = 0; s2 <= 1; s2 += 0.1) mark(add(a, mul(sub(b, a), s2))); }
    }
    // The precinct's whole edge, not just its corners: a bearing between two corners must clear its side too.
    if (form !== "river" && net.anchorPoly) for (let j = 0; j < net.anchorPoly.length; j++) {
      const a = net.anchorPoly[j], b = net.anchorPoly[(j + 1) % net.anchorPoly.length];
      for (let s2 = 0; s2 <= 1; s2 += 0.05) mark(add(a, mul(sub(b, a), s2)));
    }
    // Buildings of the town's wards; for the forms besides the river, only those that stood within the wall
    // (a mill out on the stream belongs to its nearest ward, but the wall needn't go out to it).
    // (In a town of blocks, everything built within the first line, whatever ward it was counted in.)
    for (const b of result) if (b && (blocked ? within(centroid(b.poly)) : wards[b.ward ?? -1]?.kind === "intramural" && (form === "river" || inside(centroid(b.poly))))) (b.plot ?? b.poly).forEach(mark);
    // Fit the wall: bearings with nothing on them take the line between their built neighbours; in a
    // town of blocks the wall then goes round any house it would cut that stands within, and stops short
    // of any it would cut outside, until it cuts none.
    const base = net.wallLine;
    // The fitting passes are for the forms whose walls ring their towns; a river town's wall keeps its own fit.
    const refit = blocked && form !== "river";
    const cap: number[] = Array.from({ length: NB }, () => Infinity);
    const fit = (): Pt[] => {
      const known = reachAt.map((v, k) => (v > 0 ? k : -1)).filter((k) => k >= 0);
      if (!known.length) return base;
      const filled = reachAt.map((v, k) => {
        if (v > 0) return v;
        let lo = k, hi = k;
        while (reachAt[(lo + NB) % NB] === 0) lo--;
        while (reachAt[hi % NB] === 0) hi++;
        const r0 = reachAt[(lo + NB) % NB], r1 = reachAt[hi % NB];
        if (form === "river") return r0 + ((r1 - r0) * (k - lo)) / (hi - lo);
        // Straight across from one built bearing to the next: where this bearing's ray meets that chord.
        const a0 = (lo / NB) * TAU, a1 = (hi / NB) * TAU, ak = (k / NB) * TAU;
        const P0 = mul(dirOf(a0), r0), P1 = mul(dirOf(a1), r1), u = dirOf(ak), e = sub(P1, P0);
        const den = u[0] * e[1] - u[1] * e[0];
        return Math.abs(den) < 1e-9 ? Math.min(r0, r1) : Math.max(0, (P0[0] * e[1] - P0[1] * e[0]) / den);
      });
      // Clear of the back lanes and a little more, and never notched between neighbours.
      const want = filled.map((_, k) => Math.min(cap[k], Math.max(filled[(k + NB - 1) % NB], filled[k], filled[(k + 1) % NB]) + 10));
      // Towards its ends the wall eases back out to meet the river where it did (a ring has no ends).
      const K = 6;
      return base.map((p, j) => {
        const ease = ring ? 1 : Math.min(1, Math.min(j, base.length - 1 - j) / K);
        const d = hypot(p[0] - mc[0], p[1] - mc[1]);
        const w = want[binOf(p)];
        // (Only where it runs free: towards its ends, where it eases back to the river, it only comes in.)
        return w < d || (refit && w > d && w < Infinity && ease === 1) ? add(mc, mul(sub(p, mc), (d - (d - w) * ease) / d)) : p;
      });
    };
    let line = fit();
    if (refit) for (let pass = 0; pass < 4; pass++) {
      // Only houses by the wall can be cut by it: look up the wall's stretches near each one.
      const wg = new SegGrid<0>(40);
      wg.addLine(line, 0);
      const cut = result.filter((b): b is PlacedBuilding => {
        if (!b || plan[b.planIndex].site === "gate") return false;
        const c = centroid(b.poly);
        let rad = 0;
        for (const v of b.poly) rad = Math.max(rad, hypot(v[0] - c[0], v[1] - c[1]));
        return wg.near(c, rad + 1).some((sg) => lineCutsPoly(b.poly, [sg.a, sg.b]));
      });
      if (!cut.length) break;
      // Within or without: by the first line, which nothing was built across.
      for (const b of cut) {
        if (pointInPoly(centroid(b.poly), base)) b.poly.forEach(mark);
        else for (const p of b.poly) { const k = binOf(p); cap[k] = Math.min(cap[k], hypot(p[0] - mc[0], p[1] - mc[1]) - 3); }
      }
      line = fit();
    }
    net.wallLine = line;
  }
  const towers: Pt[] = [];
  if (net.wallLine && walled) for (let i = 0; i < net.wallLine.length; i += 4) towers.push(qp(net.wallLine[i]));
  const roads: Road[] = net.streets.map((st) => ({
    id: st.id, kind: st.kind === "back" || st.kind === "cross" || st.kind === "water" ? "lane" as const : "road" as const, width: q(st.width), points: st.points.map(qp),
  }));

  return {
    kind: "town",
    plan: form === "organic" ? "radial" : form,
    ...(hasFar ? { farBank: o.farBank } : {}),
    ...(o.farBank === "village" && net.farPlace ? { farGreen: qpoly(net.farPlace) } : {}),
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
    wall: { line: (ring ? net.wallLine!.slice(0, -1) : net.wallLine ?? []).map(qp), closed: ring, towers, gates: net.gates.map((g) => ({ p: qp(g.p), t: qp(g.t), road: g.road })) },
    market: qpoly(market),
    gardens,
    wards,
    bridges: net.bridges.map(qp),
    ...(quayLine ? { quay: quayLine.map(qp) } : {}),
    ...(castle ? { castle } : {}),
    ...(high.length ? { high } : {}),
    contourLines: lowLines,
    ...(blocked ? { blocks: blocksOut, opens } : {}),
  };
}

/** Lines of equal height round the town, at its higher levels: marching squares, chained into polylines. */
