// The streets as a graph, and the blocks between them. Street polylines are cut where they cross
// and where one ends against another (ends within `snap` metres join), so every street meets the
// next at a node. The faces of that graph are the blocks: each is the land between its streets'
// edges, the street centre lines moved in by half each street's width. A boundary (the wall, or the
// edge of the built town) can close the faces at the town's edge; their outline then follows it.

import { atan2 } from "../../core/dmath";
import { add, cross, dist, dot, insetEdges, mul, pointInPoly, sub, type Poly, type Pt } from "./geom";

export interface Side {
  street: string;
  width: number;
  /** the side as it runs along the block's outline */
  a: Pt;
  b: Pt;
  /** which edge of the outline (from outline[edge] to outline[edge + 1]) */
  edge: number;
}

export interface Face {
  /** the block between the streets' edges, anticlockwise */
  outline: Poly;
  /** the outline's edges that front a street (edges along the boundary have none) */
  sides: Side[];
  /** part of its boundary is the closing line, not a street */
  open: boolean;
}

export interface StreetLine { id: string; width: number; points: Pt[] }
export interface StreetGraph { streets: StreetLine[]; snap: number }

interface Seg { a: Pt; b: Pt; street: string; width: number }
interface Edge { u: number; v: number; street: string; width: number }

/** Streets ready to be cut into blocks. The work is done when the blocks are asked for. */
export function nodeStreets(streets: StreetLine[], snap = 3): StreetGraph {
  return { streets: streets.filter((s) => s.points.length >= 2), snap };
}

const CELL = 40;

/**
 * Join the streets' loose ends, as the blocks will see them: an end within `snap` of an earlier end
 * moves onto it, then onto a street it stops just short of (or just past). A caller that draws the
 * streets should draw these points, or the blocks and the streets drawn will disagree by up to `snap`.
 */
export function snapEnds(lines: StreetLine[], snap = 3): Pt[][] {
  const pts = lines.map((l) => l.points.map((p) => [p[0], p[1]] as Pt));
  // (The earlier ends kept in a grid of `snap`-sized cells: the first within reach, in the order they came.)
  const ends: Pt[] = [];
  const endGrid = new Map<string, number[]>();
  const cellOf = (p: Pt) => [Math.floor(p[0] / snap), Math.floor(p[1] / snap)];
  pts.forEach((ps) => {
    for (const k of [0, ps.length - 1]) {
      const [cx, cy] = cellOf(ps[k]);
      let found = -1;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const e of endGrid.get(`${cx + dx},${cy + dy}`) ?? []) if ((found < 0 || e < found) && dist(ends[e], ps[k]) <= snap) found = e;
      if (found >= 0) ps[k] = [ends[found][0], ends[found][1]];
      else { ends.push(ps[k]); const key = `${cx},${cy}`; const l = endGrid.get(key); if (l) l.push(ends.length - 1); else endGrid.set(key, [ends.length - 1]); }
    }
  });
  const segs: Seg[] = [];
  lines.forEach((l, i) => {
    for (let j = 0; j + 1 < pts[i].length; j++) if (dist(pts[i][j], pts[i][j + 1]) > 1e-6) segs.push({ a: pts[i][j], b: pts[i][j + 1], street: l.id, width: l.width });
  });
  const grid = new Map<string, number[]>();
  const cellsOf = (s: Seg) => {
    const out: string[] = [];
    const x0 = Math.floor((Math.min(s.a[0], s.b[0]) - snap) / CELL), x1 = Math.floor((Math.max(s.a[0], s.b[0]) + snap) / CELL);
    const y0 = Math.floor((Math.min(s.a[1], s.b[1]) - snap) / CELL), y1 = Math.floor((Math.max(s.a[1], s.b[1]) + snap) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x},${y}`);
    return out;
  };
  segs.forEach((s, i) => { for (const k of cellsOf(s)) { const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]); } });
  const near = (s: Seg) => { const set = new Set<number>(); for (const k of cellsOf(s)) for (const j of grid.get(k) ?? []) set.add(j); return [...set].sort((a, b) => a - b); };
  // An end that stops just short of (or just past) another street joins it.
  pts.forEach((ps, li) => {
    for (const k of [0, ps.length - 1]) {
      const p = ps[k];
      for (const j of near({ a: p, b: p, street: "", width: 0 })) {
        const s = segs[j];
        if (s.street === lines[li].id) continue;
        const e = sub(s.b, s.a), t = dot(sub(p, s.a), e) / dot(e, e);
        if (t <= 0 || t >= 1) continue;
        const q = add(s.a, mul(e, t));
        if (dist(q, p) <= snap) { p[0] = q[0]; p[1] = q[1]; break; }
      }
    }
  });
  return pts;
}

/** Cut the segments where they cross, join near ends, and return the nodes and edges. */
function build(lines: StreetLine[], snap: number): { nodes: Pt[]; edges: Edge[] } {
  // 1. Loose ends joined (snapEnds).
  const pts = snapEnds(lines, snap);
  const segs: Seg[] = [];
  lines.forEach((l, i) => {
    for (let j = 0; j + 1 < pts[i].length; j++) if (dist(pts[i][j], pts[i][j + 1]) > 1e-6) segs.push({ a: pts[i][j], b: pts[i][j + 1], street: l.id, width: l.width });
  });
  const grid = new Map<string, number[]>();
  const cellsOf = (s: Seg) => {
    const out: string[] = [];
    const x0 = Math.floor((Math.min(s.a[0], s.b[0]) - snap) / CELL), x1 = Math.floor((Math.max(s.a[0], s.b[0]) + snap) / CELL);
    const y0 = Math.floor((Math.min(s.a[1], s.b[1]) - snap) / CELL), y1 = Math.floor((Math.max(s.a[1], s.b[1]) + snap) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x},${y}`);
    return out;
  };
  segs.forEach((s, i) => { for (const k of cellsOf(s)) { const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]); } });
  const near = (s: Seg) => { const set = new Set<number>(); for (const k of cellsOf(s)) for (const j of grid.get(k) ?? []) set.add(j); return [...set].sort((a, b) => a - b); };
  // 2. Where segments cross (or one ends on another), both are cut there.
  const cuts: { t: number; p: Pt }[][] = segs.map((s) => [{ t: 0, p: s.a }, { t: 1, p: s.b }]);
  segs.forEach((s, i) => {
    for (const j of near(s)) {
      if (j <= i) continue;
      const o = segs[j];
      const r = sub(s.b, s.a), q = sub(o.b, o.a);
      const den = cross(r, q);
      if (Math.abs(den) < 1e-9) continue;
      const ao = sub(o.a, s.a);
      const t = cross(ao, q) / den, u = cross(ao, r) / den;
      const eps = 1e-6;
      if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) continue;
      const p = add(s.a, mul(r, t));
      cuts[i].push({ t, p });
      cuts[j].push({ t: u, p });
    }
  });
  // 3. Nodes: points within a few centimetres are one.
  const nodes: Pt[] = [];
  const nodeGrid = new Map<string, number[]>();
  const nodeOf = (p: Pt) => {
    const gx = Math.floor(p[0] / 0.5), gy = Math.floor(p[1] / 0.5);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const n of nodeGrid.get(`${gx + dx},${gy + dy}`) ?? []) if (dist(nodes[n], p) < 0.05) return n;
    nodes.push(p);
    const k = `${gx},${gy}`; const l = nodeGrid.get(k); if (l) l.push(nodes.length - 1); else nodeGrid.set(k, [nodes.length - 1]);
    return nodes.length - 1;
  };
  const edges: Edge[] = [];
  const seen = new Set<string>();
  segs.forEach((s, i) => {
    const cs = cuts[i].sort((a, b) => a.t - b.t);
    for (let k = 0; k + 1 < cs.length; k++) {
      const u = nodeOf(cs[k].p), v = nodeOf(cs[k + 1].p);
      if (u === v) continue;
      const key = u < v ? `${u}-${v}` : `${v}-${u}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ u, v, street: s.street, width: s.width });
    }
  });
  return { nodes, edges };
}

/** Peel off edges that end nowhere, again and again: what's left has a block either side. */
function prune(nodes: Pt[], edges: Edge[]): { kept: Edge[]; dangling: Edge[] } {
  const live = edges.map(() => true);
  const deg = nodes.map(() => 0);
  for (const e of edges) { deg[e.u]++; deg[e.v]++; }
  const at = nodes.map(() => [] as number[]);
  edges.forEach((e, i) => { at[e.u].push(i); at[e.v].push(i); });
  const queue = deg.map((d, n) => (d === 1 ? n : -1)).filter((n) => n >= 0);
  while (queue.length) {
    const n = queue.pop()!;
    if (deg[n] !== 1) continue;
    const i = at[n].find((k) => live[k]);
    if (i === undefined) continue;
    live[i] = false;
    const e = edges[i];
    deg[e.u]--; deg[e.v]--;
    const other = e.u === n ? e.v : e.u;
    if (deg[other] === 1) queue.push(other);
  }
  return { kept: edges.filter((_, i) => live[i]), dangling: edges.filter((_, i) => !live[i]) };
}

const BOUNDARY = "";

function closing(close: Poly | undefined): StreetLine[] {
  return close ? [{ id: BOUNDARY, width: 0, points: [...close, close[0]] }] : [];
}

/** The blocks: the bounded faces of the street graph (inside `close`, if given), each inset from its streets. */
export function blockFaces(g: StreetGraph, close?: Poly): Face[] {
  const { nodes, edges } = build([...g.streets, ...closing(close)], g.snap);
  const { kept } = prune(nodes, edges);
  // Outgoing half-edges at each node, by angle.
  const out = nodes.map(() => [] as { to: number; e: number; ang: number }[]);
  kept.forEach((e, i) => {
    out[e.u].push({ to: e.v, e: i, ang: atan2(nodes[e.v][1] - nodes[e.u][1], nodes[e.v][0] - nodes[e.u][0]) });
    out[e.v].push({ to: e.u, e: i, ang: atan2(nodes[e.u][1] - nodes[e.v][1], nodes[e.u][0] - nodes[e.v][0]) });
  });
  for (const l of out) l.sort((a, b) => a.ang - b.ang || a.to - b.to);
  const used = new Set<string>();
  const faces: Face[] = [];
  for (let u0 = 0; u0 < nodes.length; u0++) for (const h0 of out[u0]) {
    if (used.has(`${u0}>${h0.to}`)) continue;
    // Walk with the face on the left: at each node, turn as sharply right as the streets allow.
    const ring: number[] = [], via: number[] = [];
    let u = u0, h = h0;
    for (let guard = 0; guard < 100000; guard++) {
      used.add(`${u}>${h.to}`);
      ring.push(u); via.push(h.e);
      const v = h.to, list = out[v];
      const back = list.findIndex((x) => x.to === u && x.e === h.e);
      const next = list[(back - 1 + list.length) % list.length];
      u = v; h = next;
      if (u === u0 && h.to === h0.to && h.e === h0.e) break;
    }
    const poly = ring.map((n) => nodes[n]);
    let a2 = 0;
    for (let i = 0; i < poly.length; i++) a2 += cross(poly[i], poly[(i + 1) % poly.length]);
    if (a2 <= 2) continue; // the outside, or a sliver
    // Merge runs of nearly straight edges of one street into one side.
    const pts: Pt[] = [], eds: Edge[] = [];
    for (let i = 0; i < poly.length; i++) {
      const e = kept[via[i]], prev = eds[eds.length - 1];
      if (prev && prev.street === e.street && pts.length >= 1) {
        const a = pts[pts.length - 1], b = poly[i], c = poly[(i + 1) % poly.length];
        const turn = cross(sub(b, a), sub(c, b)) / (dist(a, b) * dist(b, c) || 1);
        if (Math.abs(turn) < 0.02) continue;
      }
      pts.push(poly[i]); eds.push(e);
    }
    const inner = interiorPoint(pts);
    if (close && !pointInPoly(inner, close)) continue;
    const { poly: outline, edges: src } = insetEdges(pts, eds.map((e) => e.width / 2));
    if (outline.length < 3) continue;
    const sides: Side[] = [];
    src.forEach((k, i) => {
      const e = eds[k];
      if (e.street === BOUNDARY) return;
      sides.push({ street: e.street, width: e.width, a: outline[i], b: outline[(i + 1) % outline.length], edge: i });
    });
    // A face with no street at all is the space round the town inside the boundary: no block.
    if (!sides.length) continue;
    faces.push({ outline, sides, open: eds.some((e) => e.street === BOUNDARY) });
  }
  return faces;
}

/** A point surely inside a simple polygon: the middle of the widest span across its middle height. */
function interiorPoint(p: Poly): Pt {
  let y0 = Infinity, y1 = -Infinity;
  for (const v of p) { y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); }
  const y = (y0 + y1) / 2 + (y1 - y0) * 1e-3;
  const xs: number[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
  }
  xs.sort((a, b) => a - b);
  let best = 0, bx = (xs[0] ?? 0);
  for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > best) { best = xs[i + 1] - xs[i]; bx = (xs[i] + xs[i + 1]) / 2; }
  return [bx, y];
}

/** Lanes that run into a block and stop: chains with a loose end inside the town. */
export function deadEnds(g: StreetGraph, close?: Poly): { street: string; points: Pt[] }[] {
  const { nodes, edges } = build([...g.streets, ...closing(close)], g.snap);
  const { dangling } = prune(nodes, edges);
  const byStreet = new Map<string, Pt[][]>();
  for (const e of dangling) {
    if (e.street === BOUNDARY) continue;
    const a = nodes[e.u], b = nodes[e.v];
    // Stubs of roads running on out of town are not lanes.
    if (close && !pointInPoly(mul(add(a, b), 0.5), close)) continue;
    const l = byStreet.get(e.street) ?? [];
    l.push([a, b]);
    byStreet.set(e.street, l);
  }
  return [...byStreet].map(([street, segs]) => ({ street, points: segs.flat() }));
}
