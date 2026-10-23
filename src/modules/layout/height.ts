// The lie of the land for a river town: a few broad rises and hollows. Smooth,
// cheap to sample, and drawn from the layout's own stream, so it is the same
// every time. Values run roughly 0 (low) to 1 (high).

import type { Rng } from "../../core/rng";
import { qp, type Pt } from "./geom";

/** A height field over a square of half-width `extent` about the origin. */
export function heightField(r: Rng, extent: number): (p: Pt) => number {
  const n = r.int(4, 6);
  const bumps = Array.from({ length: n }, () => ({
    c: [r.range(-0.8, 0.8) * extent, r.range(-0.8, 0.8) * extent] as Pt,
    s2: (r.range(0.4, 0.9) * extent) ** 2,
    a: r.range(0.4, 1) * (r.chance(0.25) ? -0.5 : 1),
  }));
  const total = bumps.reduce((t, b) => t + Math.abs(b.a), 0) || 1;
  // A rational falloff, (1 + d²/s²)^-2: Gaussian-shaped, with no exp().
  return (p) => {
    let h = 0;
    for (const b of bumps) {
      const dx = p[0] - b.c[0], dy = p[1] - b.c[1];
      const k = 1 + (dx * dx + dy * dy) / b.s2;
      h += b.a / (k * k);
    }
    return 0.5 + (0.5 * h) / total;
  };
}

/**
 * Lines of equal height over a square of half-width `half` about c, sampled on an n x n grid. Each
 * level is a quantile of the heights seen (0.62: higher than about three fifths of the ground).
 */
export function contourLines(height: (p: Pt) => number, c: Pt, half: number, n: number, levels = [0.62, 0.8]): Pt[][] {
  const step = (half * 2) / n;
  const at = (i: number, j: number): Pt => [c[0] - half + i * step, c[1] - half + j * step];
  const h: number[][] = [];
  const all: number[] = [];
  for (let i = 0; i <= n; i++) { h.push([]); for (let j = 0; j <= n; j++) { const v = height(at(i, j)); h[i].push(v); all.push(v); } }
  all.sort((a, b) => a - b);
  const out: Pt[][] = [];
  for (const lev of levels.map((q) => all[Math.floor(all.length * q)])) {
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

/** How steep the ground is at p: the rise in height units over 100 m, along the steepest way. */
export function slopeAt(height: (p: Pt) => number, p: Pt, step = 5): number {
  const dx = height([p[0] + step, p[1]]) - height([p[0] - step, p[1]]);
  const dy = height([p[0], p[1] + step]) - height([p[0], p[1] - step]);
  return (Math.sqrt(dx * dx + dy * dy) / (2 * step)) * 100;
}
