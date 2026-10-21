// Small planar geometry kit for the layout. Points are [x, y] in metres.
import { hypot, q } from "../../core/dmath";

export type Pt = [number, number];
export type Poly = Pt[];

export const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
export const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
export const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
export const len = (a: Pt) => hypot(a[0], a[1]);
export const dist = (a: Pt, b: Pt) => hypot(a[0] - b[0], a[1] - b[1]);
export const perp = (a: Pt): Pt => [-a[1], a[0]];
export const norm = (a: Pt): Pt => {
  const l = len(a);
  return l === 0 ? [1, 0] : [a[0] / l, a[1] / l];
};
export const qp = (p: Pt): Pt => [q(p[0]), q(p[1])];
export const qpoly = (p: Poly): Poly => p.map(qp);

export function centroid(p: Poly): Pt {
  let x = 0, y = 0;
  for (const v of p) { x += v[0]; y += v[1]; }
  return [x / p.length, y / p.length];
}

export function area(p: Poly): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += cross(p[i], p[(i + 1) % p.length]);
  return Math.abs(s) / 2;
}

/** Rectangle centred on c, with `u` the unit direction of its width. */
export function rect(c: Pt, u: Pt, w: number, d: number): Poly {
  const v = perp(u);
  const hw = w / 2, hd = d / 2;
  return [
    add(add(c, mul(u, -hw)), mul(v, -hd)),
    add(add(c, mul(u, hw)), mul(v, -hd)),
    add(add(c, mul(u, hw)), mul(v, hd)),
    add(add(c, mul(u, -hw)), mul(v, hd)),
  ];
}

/** Separating-axis overlap test for two convex polygons, with an optional clearance. */
// Bounding boxes, cached per polygon: layouts test each new shape against
// everything already placed, so a cheap rejection first matters.
const boxes = new WeakMap<Poly, [number, number, number, number]>();
function box(p: Poly): [number, number, number, number] {
  let b = boxes.get(p);
  if (!b) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of p) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    boxes.set(p, (b = [x0, y0, x1, y1]));
  }
  return b;
}

export function convexOverlap(a: Poly, b: Poly, gap = 0): boolean {
  // Boxes this far apart can't pass the edge-normal test below. The test only
  // looks along edge normals, which can understate the true distance at a sharp
  // corner, so the margin is generous (good for corners down to about 15°).
  const A = box(a), B = box(b);
  const apart = Math.max(B[0] - A[2], A[0] - B[2], B[1] - A[3], A[1] - B[3]);
  if (apart > Math.max(0, gap) * 8) return false;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const e = sub(poly[(i + 1) % poly.length], poly[i]);
      const n = norm(perp(e));
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const p of a) { const s = dot(p, n); aMin = Math.min(aMin, s); aMax = Math.max(aMax, s); }
      for (const p of b) { const s = dot(p, n); bMin = Math.min(bMin, s); bMax = Math.max(bMax, s); }
      if (aMax + gap <= bMin || bMax + gap <= aMin) return false;
    }
  }
  return true;
}

export function pointInPoly(p: Pt, poly: Poly): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

export function segPointDist(p: Pt, a: Pt, b: Pt): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, add(a, mul(ab, t)));
}

function segsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(sub(b, a), sub(c, a));
  const d2 = cross(sub(b, a), sub(d, a));
  const d3 = cross(sub(d, c), sub(a, c));
  const d4 = cross(sub(d, c), sub(b, c));
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function segSegDist(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (segsCross(a, b, c, d)) return 0;
  return Math.min(segPointDist(a, c, d), segPointDist(b, c, d), segPointDist(c, a, b), segPointDist(d, a, b));
}

/** Whether a polyline comes within d of a polygon (touching or overlapping counts). */
export function nearLine(line: Pt[], poly: Poly, d: number): boolean {
  return polylinePolyDist(line, poly, d) < d;
}

/** Smallest distance between a polyline and a polygon (0 if they touch or overlap).
 *  Given `within`, any answer of `within` or more may come back as a larger number. */
export function polylinePolyDist(line: Pt[], poly: Poly, within = Infinity): number {
  let best = Infinity;
  const [x0, y0, x1, y1] = box(poly);
  for (let i = 0; i + 1 < line.length; i++) {
    // Skip segments whose box is already further off than the best so far
    // (a lower bound, so the answer is unchanged). Roads are long, houses many.
    const a = line[i], b = line[i + 1];
    const gx = Math.max(0, x0 - Math.max(a[0], b[0]), Math.min(a[0], b[0]) - x1);
    const gy = Math.max(0, y0 - Math.max(a[1], b[1]), Math.min(a[1], b[1]) - y1);
    const lim = Math.min(best, within) + 1e-6;
    if (gx * gx + gy * gy > lim * lim) continue;
    if (pointInPoly(line[i], poly)) return 0;
    for (let j = 0; j < poly.length; j++) {
      best = Math.min(best, segSegDist(line[i], line[i + 1], poly[j], poly[(j + 1) % poly.length]));
      if (best === 0) return 0;
    }
  }
  return best;
}

export function polylineLength(line: Pt[]): number {
  let s = 0;
  for (let i = 0; i + 1 < line.length; i++) s += dist(line[i], line[i + 1]);
  return s;
}

/** Point and unit tangent at arc length s along a polyline (clamped). */
export function along(line: Pt[], s: number): { p: Pt; t: Pt } {
  let acc = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const l = dist(line[i], line[i + 1]);
    if (acc + l >= s || i + 2 === line.length) {
      const k = l === 0 ? 0 : Math.max(0, Math.min(1, (s - acc) / l));
      return { p: add(line[i], mul(sub(line[i + 1], line[i]), k)), t: norm(sub(line[i + 1], line[i])) };
    }
    acc += l;
  }
  return { p: line[0], t: [1, 0] };
}

/** Arc length of the point on a polyline closest to p. */
export function project(line: Pt[], p: Pt): number {
  let best = Infinity, bestS = 0, acc = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1];
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
    const d = dist(p, add(a, mul(ab, t)));
    if (d < best) { best = d; bestS = acc + t * Math.sqrt(l2); }
    acc += Math.sqrt(l2);
  }
  return bestS;
}

export function convexHull(points: Pt[]): Poly {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(sub(lower[lower.length - 1], lower[lower.length - 2]), sub(p, lower[lower.length - 2])) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(sub(upper[upper.length - 1], upper[upper.length - 2]), sub(p, upper[upper.length - 2])) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Distance from origin `o` along unit ray `u` to where it leaves polygon `poly` (o inside). */
export function rayExit(o: Pt, u: Pt, poly: Poly): number {
  let best = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const e = sub(b, a);
    const den = cross(u, e);
    if (den === 0) continue;
    const ao = sub(a, o);
    const t = cross(ao, e) / den;
    const s = cross(ao, u) / den;
    if (t > 0 && s >= 0 && s <= 1) best = Math.max(best, t);
  }
  return best;
}
