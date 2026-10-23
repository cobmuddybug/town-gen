// Filling a block. Buildings stand round the edge of a block, square to the street, sharing side
// walls; each corner is split between its two streets or taken by one L-shaped house; and the
// middle is whatever the kind of block makes of it: slivers of yard behind shops, small yards and a
// shared green behind ordinary houses, one common court, private gardens, a graveyard, a green.
// The same cutter lines a lone road with a ribbon of lots, square to it, plots ending at a back fence.
//
// A lot is front-left, front-right, back-right, back-left as you face it from the street, and lots
// along one stretch of street (a run) are numbered left to right, so a building on several lots
// takes neighbours and its outline comes out the right way round.

import type { Rng } from "../../core/rng";
import { add, area, convexOverlap, cross, dist, dot, insetEdges, len, mul, norm, perp, pointInPoly, qp, qpoly, sub, type Poly, type Pt } from "./geom";
import type { Face, Side } from "./graph";
import type { Footprint, PlacedBuilding } from "./hamlet";
import { leftToRight, type FrontKind, type Plot } from "./streets";

export type BlockKind = "shop" | "ordinary" | "courtyard" | "wellOff" | "church" | "green" | "precinct" | "croft";

/** Lot widths, how deep the house stands on its lot, and what the middle of the block becomes. */
export const KIND_SPEC: Record<BlockKind, { lotW: [number, number]; depth: [number, number]; yard: "sliver" | "small" | "court" | "garden" | "none"; behind: [number, number] }> = {
  shop: { lotW: [4.5, 7], depth: [12, 20], yard: "sliver", behind: [1, 4] },
  ordinary: { lotW: [5, 9], depth: [9, 14], yard: "small", behind: [6, 12] },
  courtyard: { lotW: [12, 22], depth: [9, 13], yard: "court", behind: [0, 0] },
  wellOff: { lotW: [14, 24], depth: [10, 15], yard: "garden", behind: [10, 18] },
  croft: { lotW: [8, 12], depth: [5, 7], yard: "none", behind: [16, 26] },
  church: { lotW: [6, 9], depth: [9, 13], yard: "none", behind: [0, 0] },
  green: { lotW: [6, 9], depth: [9, 13], yard: "none", behind: [0, 0] },
  precinct: { lotW: [10, 16], depth: [8, 12], yard: "none", behind: [0, 0] },
};

export interface Lot extends Plot {
  street: string;
  kindOfBlock: BlockKind;
  /** a corner lot: one of two that split the corner, or one L-shaped house */
  corner?: "split" | "L";
  far: boolean;
  suburb: boolean;
  /** how deep the house on it stands */
  depth: number;
}

/** What is left open in a block: yards, a court, a green, gardens, a graveyard. */
export interface Open {
  kind: "yard" | "court" | "green" | "garden" | "graveyard";
  poly: Poly;
  private?: boolean;
}

export interface Ids { next: number; run: number }

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const range = (r: Rng, [a, b]: [number, number]) => (a === b ? a : r.range(a, b));
/** The foot of p on the line through a and b, as a fraction along a -> b. */
const along = (p: Pt, a: Pt, b: Pt) => { const e = sub(b, a); return dot(sub(p, a), e) / dot(e, e); };
/** The angle at b between b -> a and b -> c, in degrees, inside an anticlockwise outline. */
function cornerAngle(a: Pt, b: Pt, c: Pt): number {
  const u = norm(sub(a, b)), v = norm(sub(c, b));
  const cos = Math.max(-1, Math.min(1, dot(u, v)));
  // acos by a short series is overkill: the threshold test only needs cos.
  const deg = cos >= 1 ? 0 : cos <= -1 ? 180 : 90 - (cos + cos ** 3 / 6 + (3 * cos ** 5) / 40 + (5 * cos ** 7) / 112) * (180 / Math.PI);
  return cross(sub(b, a), sub(c, b)) >= 0 ? deg : 360 - deg;
}

function newLot(ids: Ids, poly: Poly, side: Side, front: FrontKind, kind: BlockKind, run: number, idx: number, depth: number, block: string, corner?: "split" | "L"): Lot {
  return {
    id: ids.next++, poly: qpoly(poly), kind: front, ward: -1, run, idx, block, ring: 0, used: false, order: 0,
    street: side.street, kindOfBlock: kind, far: false, suburb: false, depth, ...(corner ? { corner } : {}),
  };
}

/** Cut a run of lots between two front points and two back points (front a0 -> a1, back b0 -> b1). */
function cutStrip(r: Rng, kind: BlockKind, a0: Pt, a1: Pt, b0: Pt, b1: Pt): [Pt, Pt, Pt, Pt][] {
  const L = dist(a0, a1);
  if (L < 1.5) return [];
  const [w0, w1] = KIND_SPEC[kind].lotW;
  const cuts: number[] = [0];
  for (let s = 0; s < L;) {
    const w = r.range(w0, w1);
    // What's left is too narrow for a house of its own: the last lot takes it.
    if (L - s - w < w0 * 0.6) { cuts.push(L); break; }
    s += w;
    cuts.push(s);
  }
  if (cuts[cuts.length - 1] < L) cuts[cuts.length - 1] = L;
  const out: [Pt, Pt, Pt, Pt][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const t0 = cuts[i] / L, t1 = cuts[i + 1] / L;
    out.push([lerp(a0, a1, t0), lerp(a0, a1, t1), lerp(b0, b1, t1), lerp(b0, b1, t0)]);
  }
  return out;
}

/**
 * Fill a block of a kind. `front` says what kind of street each side is. Church, green and precinct
 * blocks are left whole here (their fill is the engine's); every other kind gets lots.
 */
export function fillBlock(r: Rng, face: Face, kind: BlockKind, front: (s: Side) => FrontKind, ids: Ids, block = `k${ids.run}`): { lots: Lot[]; open: Open[] } {
  const O = face.outline;
  const n = O.length;
  if (kind === "church" || kind === "green" || kind === "precinct") {
    return { lots: [], open: kind === "green" ? [{ kind: "green", poly: O }] : kind === "church" ? [{ kind: "graveyard", poly: O }] : [] };
  }
  const spec = KIND_SPEC[kind];
  const sideAt = new Map<number, Side>();
  for (const s of face.sides) sideAt.set(s.edge, s);
  // How deep the lots run: the house and what's behind it. A block too small for that is filled to the middle.
  let D = range(r, spec.depth) + range(r, spec.behind);
  // A narrow block can't take the full depth from both sides: shallower lots, so that no street
  // side long enough for houses is lost to its corners.
  const long = [...sideAt.keys()].filter((i) => dist(O[i], O[(i + 1) % n]) > spec.lotW[1] * 2);
  const insetBy = (d: number) => insetEdges(O, O.map((_, i) => (sideAt.has(i) ? d : 0)));
  let inner = insetBy(D);
  for (let k = 0; k < 14 && (inner.poly.length < 3 || long.some((i) => !inner.edges.includes(i))); k++) { D *= 0.87; inner = insetBy(D); }
  // Too thin to hold a house: a strip of yard (or the water's edge, or a sliver between two streets).
  if (inner.poly.length < 3 || D < 6) return { lots: [], open: [{ kind: "yard", poly: O }] };
  const I = inner.poly, src = inner.edges, m = I.length;
  const lots: Lot[] = [], open: Open[] = [];
  // Each kept edge j runs along outline edge src[j]; its back is the inner edge from I[j] to I[j+1].
  // Where it starts: at a convex corner between two streets, after the corner piece; else at the outline vertex.
  type End = { front: Pt; back: Pt; corner: boolean };
  const ends: { start: End; end: End }[] = [];
  for (let j = 0; j < m; j++) {
    const e = src[j], a = O[e], b = O[(e + 1) % n];
    const ta = along(I[j], a, b), tb = along(I[(j + 1) % m], a, b);
    ends.push({ start: { front: lerp(a, b, Math.max(0, ta)), back: I[j], corner: false }, end: { front: lerp(a, b, Math.min(1, tb)), back: I[(j + 1) % m], corner: false } });
  }
  // The corners: between kept edge j-1 and j, at inner vertex I[j].
  const corners: { j: number; region: Poly; streetPrev?: Side; streetNext?: Side; angle: number }[] = [];
  for (let j = 0; j < m; j++) {
    const jp = (j + m - 1) % m, ep = src[jp], en = src[j];
    const sp = sideAt.get(ep), sn = sideAt.get(en);
    const Pp = ends[jp].end.front, Pn = ends[j].start.front;
    // The outline vertices between the two edges (more than one if an edge between them vanished).
    const verts: Pt[] = [];
    for (let k = (ep + 1) % n; ; k = (k + 1) % n) { verts.push(O[k]); if (k === en) break; }
    const angle = cornerAngle(O[ep], O[(ep + 1) % n], O[(ep + 2) % n]);
    const convex = verts.length > 1 || angle < 180;
    // A blunt corner, its arms shorter than a lot: no corner house, the two rows just meet.
    const armsShort = dist(Pp, O[(ep + 1) % n]) < 4 || dist(O[en], Pn) < 4;
    if (!sp || !sn || !convex || armsShort) {
      // No corner piece: each street's run reaches the outline vertex, mitred to the inner one.
      ends[jp].end = { front: O[(ep + 1) % n], back: I[j], corner: false };
      ends[j].start = { front: O[en], back: I[j], corner: false };
      continue;
    }
    ends[jp].end.corner = true; ends[j].start.corner = true;
    corners.push({ j, region: [Pp, ...verts, Pn, I[j]], streetPrev: sp, streetNext: sn, angle });
  }
  // The runs along each street.
  const runOf = new Map<number, number>();
  const firstIdx = new Map<number, number>();
  for (let j = 0; j < m; j++) {
    const side = sideAt.get(src[j]);
    if (!side) continue;
    const run = ids.run++;
    runOf.set(j, run);
    firstIdx.set(j, 1);
    const f = front(side);
    const { start, end } = ends[j];
    cutStrip(r, kind, start.front, end.front, start.back, end.back).forEach((q, k) => {
      lots.push(newLot(ids, q, side, f, kind, run, k + 1, range(r, spec.depth), block));
    });
  }
  // Corner pieces: split between the two streets, or one L-shaped house; a house deep, the rest is
  // yard. Each corner piece is a run of its own: a house on several lots never takes one. A sharp corner is left as a yard; a very blunt one is always one house.
  const turn = Math.sign(O.reduce((t, v, i) => t + cross(v, O[(i + 1) % n]), 0)) || 1;
  const meet = (p: Pt, u: Pt, q: Pt, v: Pt): Pt | undefined => {
    const den = cross(u, v);
    return Math.abs(den) < 1e-9 ? undefined : add(p, mul(u, cross(sub(q, p), v) / den));
  };
  for (const c of corners) {
    const runN = runOf.get(c.j), runP = runOf.get((c.j + m - 1) % m);
    const [Pp, ...rest] = c.region;
    const Pn = rest[rest.length - 2], verts = rest.slice(0, -2);
    if (c.angle < 55 || runN === undefined || runP === undefined) { open.push({ kind: "yard", poly: qpoly(c.region) }); continue; }
    const O0 = verts[0];
    const Olast = verts[verts.length - 1];
    const eP = norm(sub(O0, Pp)), eN = norm(sub(Pn, Olast));
    const nP = mul(perp(eP), turn), nN = mul(perp(eN), turn);
    const dd = Math.min(range(r, KIND_SPEC[kind].depth), dist(Pp, O0) * 0.95, dist(Olast, Pn) * 0.95);
    const X = meet(add(Pp, mul(nP, dd)), eP, add(Pn, mul(nN, dd)), eN);
    // The house's inner corner must fall inside the corner: nearly parallel sides meet far off.
    if (dd < 4 || !X || !pointInPoly(X, c.region) || dist(X, O0) > 3 * dd + dist(O0, Olast)) { open.push({ kind: "yard", poly: qpoly(c.region) }); continue; }
    const fN = front(c.streetNext!), fP = front(c.streetPrev!);
    if (verts.length === 1 && c.angle <= 125 && r.chance(0.6)) {
      if (r.chance(0.5)) {
        // The next street's house takes the whole corner; the other street's stands beside it.
        const Y = meet(O0, eP, add(O0, mul(nN, dd)), eN);
        if (Y && dist(Pp, O0) > dist(Y, O0) + 2) {
          lots.push(newLot(ids, [O0, Pn, add(Pn, mul(nN, dd)), Y], c.streetNext!, fN, kind, ids.run++, 0, dd, block, "split"));
          lots.push(newLot(ids, [Pp, Y, X, add(Pp, mul(nP, dd))], c.streetPrev!, fP, kind, ids.run++, 0, dd, block, "split"));
          continue;
        }
      } else {
        const Y = meet(O0, eN, add(O0, mul(nP, dd)), eP);
        if (Y && dist(O0, Pn) > dist(O0, Y) + 2) {
          lots.push(newLot(ids, [Pp, O0, Y, add(Pp, mul(nP, dd))], c.streetPrev!, fP, kind, ids.run++, 0, dd, block, "split"));
          lots.push(newLot(ids, [Y, Pn, add(Pn, mul(nN, dd)), X], c.streetNext!, fN, kind, ids.run++, 0, dd, block, "split"));
          continue;
        }
      }
    }
    // One house round the corner.
    // Its own run: a house on two lots never spans round a corner.
    lots.push(newLot(ids, [Pp, ...verts, Pn, add(Pn, mul(nN, dd)), X, add(Pp, mul(nP, dd))], c.streetNext!, fN, kind, ids.run++, 0, dd, block, "L"));
  }
  // A lot too thin to hold a house (a leftover at an awkward corner) is yard.
  for (let k = lots.length - 1; k >= 0; k--) {
    const pl = lots[k].poly;
    let longest = 0;
    pl.forEach((v, i) => { longest = Math.max(longest, dist(v, pl[(i + 1) % pl.length])); });
    if (area(pl) / Math.max(1e-9, longest) < 3) { open.push({ kind: "yard", poly: pl }); lots.splice(k, 1); }
  }
  // The middle.
  const mid = qpoly(I);
  if (spec.yard === "court") open.push({ kind: "court", poly: mid });
  else if (spec.yard === "garden") open.push({ kind: "garden", poly: mid, private: true });
  else if (spec.yard === "small" && area(I) > 900 && r.chance(0.5)) open.push({ kind: "green", poly: qpoly(insetEdges(I, 2).poly.length >= 3 ? insetEdges(I, 2).poly : I) });
  else if (spec.yard !== "none") open.push({ kind: "yard", poly: mid });
  lots.sort((a, b) => a.run - b.run || a.idx - b.idx);
  return { lots, open };
}

/**
 * Lots along one side of a road (`side` 1: to the left as the line runs; -1: to the right), square to
 * it, each plot ending at a back fence. `line` is the edge of the road. Crofts thin out along it.
 * `clear` says whether a lot may stand there (not in the water, not on another street).
 */
export function cutRibbon(r: Rng, line: Pt[], side: 1 | -1, kind: BlockKind, street: string, front: FrontKind, clear: (p: Poly) => boolean, ids: Ids, block = `r${ids.run}`): Lot[] {
  const spec = KIND_SPEC[kind];
  const out: Lot[] = [];
  let run = ids.run++, idx = 0;
  const total = line.slice(1).reduce((t, b, i) => t + dist(line[i], b), 0);
  let done = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const A = line[i], B = line[i + 1], L = dist(A, B);
    if (L < 1e-6) continue;
    const u = norm(sub(B, A)), inward = mul(perp(u), side);
    for (let s = 0; s + spec.lotW[0] <= L;) {
      const along_ = done + s;
      if (kind === "croft" && r.chance(0.15 + 0.5 * (along_ / Math.max(1, total)))) {
        s += r.range(4, 12);
        if (idx) { run = ids.run++; idx = 0; }
        continue;
      }
      const w = Math.min(r.range(spec.lotW[0], spec.lotW[1]), L - s);
      if (w < spec.lotW[0] * 0.8) break;
      const D = range(r, spec.depth) + range(r, spec.behind);
      const a = add(A, mul(u, s)), b = add(A, mul(u, s + w));
      const back = (p: Pt) => add(p, mul(inward, D));
      // Facing in from the road: on the left side the earlier end is the left; on the right, the later end.
      const poly: Poly = side === 1 ? [a, b, back(b), back(a)] : [b, a, back(a), back(b)];
      const prev = out[out.length - 1];
      // Round a bend, the lots on its inside would cross at the back: check the last few, of any run.
      const crosses = out.slice(-4).some((q) => q !== prev && convexOverlap(q.poly, poly, -0.2)) || (!!prev && prev.run !== run && convexOverlap(prev.poly, poly, -0.2));
      if (!clear(poly) || crosses || (prev && prev.run === run && overlapsPrev(prev.poly, poly))) {
        s += w;
        if (idx) { run = ids.run++; idx = 0; }
        continue;
      }
      out.push({
        id: ids.next++, poly: qpoly(poly), kind: front, ward: -1, run, idx: idx++, block, ring: 0, used: false, order: 0,
        street, kindOfBlock: kind, far: false, suburb: false, depth: range(r, spec.depth),
      });
      s += w;
    }
    done += L;
    // A bend starts a new run: lots either side of it don't share a wall.
    if (idx) { run = ids.run++; idx = 0; }
  }
  return out;
}

function overlapsPrev(a: Poly, b: Poly): boolean {
  // Lots on the inside of a bend would cross at the back.
  const ca = mul(add(a[2], a[3]), 0.5), cb = mul(add(b[2], b[3]), 0.5);
  return dist(ca, cb) < 0.5 * (dist(a[0], a[1]) + dist(b[0], b[1])) * 0.5;
}

const RANGES = new Set(["inn", "merchant", "warehouse", "yard"]);

/**
 * A building on its lots: across their whole frontage, to the lot's own depth, sharing side walls.
 * An L-shaped corner lot is all house. A big use on two or more lots (an inn, a merchant's, a
 * warehouse, a yard) gets a back range down one side of its yard.
 */
export function shapeOn(r: Rng, i: number, fp: Footprint, lots: Lot[], kind: BlockKind): PlacedBuilding {
  const ps = leftToRight(lots);
  const first = ps[0], last = ps[ps.length - 1];
  if (ps.length === 1 && first.poly.length !== 4) {
    return { planIndex: i, poly: first.poly, parts: [], plot: first.poly, plotKind: "yard", front: qp(lerp(first.poly[0], first.poly[1], 0.5)), road: first.kind, ward: first.ward, block: first.block };
  }
  const fl = first.poly[0], fr = last.poly[1], br = last.poly[2], bl = first.poly[3];
  const plot = qpoly([fl, fr, br, bl]);
  const lotD = (dist(fl, bl) + dist(fr, br)) / 2;
  const k = Math.min(1, Math.max(0.2, first.depth / Math.max(1, lotD)));
  const parts: { kind: string; poly: Poly }[] = [];
  let poly: Poly;
  if (kind === "wellOff" || kind === "croft") {
    // A house standing on its own: narrower than its plot, set back a little.
    const inset = kind === "croft" ? r.range(0.12, 0.22) : r.range(0.06, 0.14);
    const k0 = kind === "croft" ? Math.min(0.15, r.range(1, 3) / Math.max(1, lotD)) : 0;
    const L = lerp(fl, fr, inset), R = lerp(fl, fr, 1 - inset), LB = lerp(bl, br, inset), RB = lerp(bl, br, 1 - inset);
    poly = [lerp(L, LB, k0), lerp(R, RB, k0), lerp(R, RB, Math.min(0.95, k0 + k)), lerp(L, LB, Math.min(0.95, k0 + k))];
  } else {
    poly = [fl, fr, lerp(fr, br, k), lerp(fl, bl, k)];
  }
  // Behind a shop, and some houses: a back range or an outshot down one side of the yard (the burgage filling up).
  const back = kind === "shop" ? 0.6 : kind === "ordinary" ? 0.3 : 0;
  if (ps.length === 1 && k < 0.92 && r.chance(back)) {
    const left = r.chance(0.5), w = r.range(0.4, 0.6), reach = kind === "shop" ? r.range(0.8, 1) : r.range(0.35, 0.6);
    const a0 = left ? fl : lerp(fl, fr, 1 - w), a1 = left ? lerp(fl, fr, w) : fr;
    const b0 = left ? bl : lerp(bl, br, 1 - w), b1 = left ? lerp(bl, br, w) : br;
    const k2 = Math.min(0.98, k + (1 - k) * reach);
    parts.push({ kind: kind === "shop" ? "range" : "outshot", poly: qpoly([lerp(a0, b0, k), lerp(a1, b1, k), lerp(a1, b1, k2), lerp(a0, b0, k2)]) });
  }
  if (ps.length >= 2 && RANGES.has(fp.size) && k < 0.85) {
    const left = r.chance(0.5);
    const a0 = left ? fl : lerp(fl, fr, 0.7), a1 = left ? lerp(fl, fr, 0.3) : fr;
    const b0 = left ? bl : lerp(bl, br, 0.7), b1 = left ? lerp(bl, br, 0.3) : br;
    parts.push({ kind: "range", poly: qpoly([lerp(a0, b0, k), lerp(a1, b1, k), lerp(a1, b1, 0.95), lerp(a0, b0, 0.95)]) });
  }
  return { planIndex: i, poly: qpoly(poly), parts, plot, plotKind: "yard", front: qp(lerp(fl, fr, 0.5)), road: first.kind, ward: first.ward, block: first.block };
}

/** The lots' frontage, for picking where a use goes: how long its street front is. */
export const frontage = (l: Lot) => (l.poly.length >= 2 ? len(sub(l.poly[1], l.poly[0])) : 0);
