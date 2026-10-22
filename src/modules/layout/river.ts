// River towns (L1): a town grown at a bridge, lopsided across its river. Our
// own generator, written from scratch.
//
// The model: the town proper sits on the higher bank. A high street climbs
// from the bridge to a market where the roads in meet, a triangle or a
// widened street, never a central square. Main roads wander out from it along
// the easy ground; back lanes run behind the plots and water lanes drop to the
// river. Over the bridge lies a smaller, older place with a character of its
// own: an old village, a bridge-end, an abbey's side or a wharf side.

import { PI, TAU, cos, hypot, sin } from "../../core/dmath";
import type { Rng } from "../../core/rng";
import type { FarBank } from "../../core/types";
import { add, dot, mul, perp, sub, type Pt } from "./geom";
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
  const off = Math.max(R * r.range(0.45, 0.6), amp * 1.4 + width * 3);
  const river: Pt[] = [];
  const step = extent / 40;
  for (let t = -extent * 1.1; t <= extent * 1.1 + 1e-6; t += step) river.push(add(mul(u, t), mul(n, off + wob(t) - wob(0))));
  if (r.chance(0.5)) river.reverse(); // which way it flows
  const base = heightField(r, extent);
  // The land rises from the river towards the town and falls away beyond it.
  const tilt = r.range(0.35, 0.55);
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
