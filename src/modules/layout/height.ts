// The lie of the land for a river town: a few broad rises and hollows. Smooth,
// cheap to sample, and drawn from the layout's own stream, so it is the same
// every time. Values run roughly 0 (low) to 1 (high).

import type { Rng } from "../../core/rng";
import type { Pt } from "./geom";

/** A height field over a square of half-width `extent` about the origin. */
export function heightField(r: Rng, extent: number): (p: Pt) => number {
  const n = r.int(3, 5);
  const bumps = Array.from({ length: n }, () => ({
    c: [r.range(-0.8, 0.8) * extent, r.range(-0.8, 0.8) * extent] as Pt,
    s2: (r.range(0.35, 0.8) * extent) ** 2,
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
