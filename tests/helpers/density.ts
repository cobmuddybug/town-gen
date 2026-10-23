// People per hectare and building cover inside a town's wall: the measure of a town of blocks.
import type { Town } from "../../src/core/town";
import type { MapData } from "../../src/modules/layout";
import { pointInPoly, type Pt } from "../../src/modules/layout/geom";

const mid = (poly: Pt[]): Pt => [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];

/** People per hectare and building cover inside the wall (or the hedge round an open town). */
export function density(t: Town, map: MapData): { perHa: number; cover: number } {
  const ring = map.wall?.line && map.wall.line.length > 4 ? map.wall.line : map.hedge;
  const shoelace = (p: Pt[]) => { let a = 0; p.forEach((v, i) => { const w = p[(i + 1) % p.length]; a += v[0] * w[1] - w[0] * v[1]; }); return Math.abs(a) / 2; };
  const A = shoelace(ring);
  let built = 0, people = 0;
  for (const b of t.children(t.root, "building")) {
    const poly = b.get<Pt[]>("poly");
    if (!pointInPoly(mid(poly), ring)) continue;
    built += shoelace(poly) + (b.get<{ poly: Pt[] }[]>("parts") ?? []).reduce((u, x) => u + shoelace(x.poly), 0);
    for (const h of t.children(b.address, "household")) people += t.children(h.address, "person").length;
  }
  return { perHa: people / (A / 1e4), cover: built / A };
}
