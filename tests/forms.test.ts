// The grown forms beyond the river town: ridge, castle-gate, street, crossroads, abbey-gate, harbour.
// Every form is held to the same whole-town properties, plus a test of its own shape.
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { Town } from "../src/core/town";
import type { Design, LayoutPlan } from "../src/core/types";
import { clearLayoutCache, type MapData } from "../src/modules/layout";
import { convexOverlap, pointInPoly, polylinePolyDist, segPointDist, type Pt } from "../src/modules/layout/geom";
import { generate } from "../src/town-gen";

const FORMS = ["ridge", "castle", "street", "crossroads", "abbey", "harbour"] as const;
type Form = (typeof FORMS)[number];

const town = (seed: string, pop: number, layout: LayoutPlan, design: Design = {}, base = "agricultural") => {
  const t = generate(seed, { pop, base, design: { layout, ...design } });
  return { t, map: t.settlement().get<MapData>("map") };
};
const lineDist = (l: Pt[], p: Pt) => { let d = Infinity; for (let i = 0; i + 1 < l.length; i++) d = Math.min(d, segPointDist(p, l[i], l[i + 1])); return d; };
const mid = (poly: Pt[]): Pt => [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];
function segX(a: Pt, b: Pt, c: Pt, e: Pt): boolean {
  const r = [b[0] - a[0], b[1] - a[1]], s = [e[0] - c[0], e[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return false;
  const ca = [c[0] - a[0], c[1] - a[1]];
  const t = (ca[0] * s[1] - ca[1] * s[0]) / den, u = (ca[0] * r[1] - ca[1] * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}
const crossesLine = (poly: Pt[], line: Pt[]) => poly.some((p, i) => { const q = poly[(i + 1) % poly.length]; return line.slice(1).some((b, j) => segX(p, q, line[j], b)); });

/** Buildings that overlap each other, or stand in the river or the sea. */
function trouble(t: Town): string[] {
  const map = t.settlement().get<MapData>("map") as MapData & { sea?: Pt[] };
  const bs = t.children(t.root, "building").map((b) => ({ a: `${b.get("use")}`, poly: b.get<Pt[]>("poly") }));
  const cell = 40, grid = new Map<string, number[]>();
  const out: string[] = [];
  bs.forEach((b, i) => {
    const xs = b.poly.map((p) => p[0]), ys = b.poly.map((p) => p[1]);
    const keys: string[] = [];
    for (let x = Math.floor(Math.min(...xs) / cell); x <= Math.floor(Math.max(...xs) / cell); x++) for (let y = Math.floor(Math.min(...ys) / cell); y <= Math.floor(Math.max(...ys) / cell); y++) keys.push(`${x},${y}`);
    const seen = new Set<number>();
    for (const k of keys) for (const j of grid.get(k) ?? []) if (!seen.has(j)) { seen.add(j); if (convexOverlap(b.poly, bs[j].poly, -0.3)) out.push(`${b.a} × ${bs[j].a}`); }
    for (const k of keys) { const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]); }
    if (b.poly.some((p) => lineDist(map.stream.points, p) < map.stream.width / 2 - 0.5)) out.push(`${b.a} in the river`);
    if (map.sea && b.poly.some((p) => pointInPoly(p, map.sea!))) out.push(`${b.a} in the sea`);
  });
  return out;
}

describe.each(FORMS)("%s towns", (form: Form) => {
  test.each([1000, 3000, 12000])("place everything, with nothing overlapping and nothing in the water, at %i people", (pop) => {
    const { t, map } = town(`${form}-${pop}`, pop, form, {}, form === "harbour" ? "fishing" : "agricultural");
    expect(map.plan).toBe(form);
    expect(t.children(t.root, "building").length).toBe(t.settlement().get<string[]>("plan").length);
    expect(trouble(t).slice(0, 5)).toEqual([]);
  }, 300000);

  test("a walled town: nothing through the wall, a gatehouse at every gate", () => {
    for (const seed of ["w1", "w2"]) {
      // A town (above 6,000) has gatehouses; a market town's wall has gates without them.
      const { t, map } = town(`${form}-${seed}`, 8000, form, { walls: "wall" }, form === "harbour" ? "fishing" : "agricultural");
      const bs = t.children(t.root, "building");
      expect(bs.filter((b) => b.get("use") !== "gatehouse" && crossesLine(b.get<Pt[]>("poly"), map.wall!.line)).map((b) => b.get("use")), seed).toEqual([]);
      expect(map.wall!.gates.length, seed).toBeGreaterThan(0);
      expect(bs.filter((b) => b.get("use") === "gatehouse" && b.get("road") !== "postern").length, seed).toBe(map.wall!.gates.length);
    }
  }, 300000);

  test("no church, castle or abbey stands on a street", () => {
    const { t, map } = town(`${form}-church`, 8000, form, { castle: form !== "crossroads" });
    const big = t.children(t.root, "building").filter((b) => ["castle", "fane", "temple", "grand_temple", "chapel", "priory", "friary", "abbey"].includes(b.get<string>("use")));
    expect(big.filter((b) => map.roads.some((rd) => polylinePolyDist(rd.points, b.get<Pt[]>("poly")) < rd.width / 2 - 0.5)).map((b) => b.get("use"))).toEqual([]);
  }, 300000);

  test("a big town's trades are spread out, not in rows", () => {
    const { t } = town(`${form}-spread`, form === "street" ? 6000 : 12000, form);
    const by = new Map<string, Pt[]>();
    for (const b of t.children(t.root, "building")) {
      const u = b.get<string>("use");
      if (!["tailor", "town_weaver", "town_mason", "brewhouse", "town_smithy", "cordwainer", "skinner", "fripperer", "livery_stable", "merchant_house"].includes(u)) continue;
      by.set(u, [...(by.get(u) ?? []), mid(b.get<Pt[]>("poly"))]);
    }
    let n = 0, next = 0;
    for (const c of by.values()) for (let k = 0; k < c.length; k++) { n++; if (c.some((q, j) => j !== k && Math.hypot(q[0] - c[k][0], q[1] - c[k][1]) < 14)) next++; }
    expect(n).toBeGreaterThan(20);
    expect(next / n).toBeLessThan(0.3);
  }, 300000);

  test("the Suburbs choice changes how much lies beyond the gates", () => {
    // (A street town is a small market town: its one street can't carry six thousand.)
    const outside = (suburbs: "few" | "many") => {
      const { t, map } = town(`${form}-subs`, form === "street" ? 2500 : 6000, form, { suburbs });
      return t.children(t.root, "building").filter((b) => { const w = map.wards![b.get<number>("ward")]; return w?.kind === "suburb" && w.bank !== "far"; }).length;
    };
    expect(outside("many")).toBeGreaterThan(outside("few") * 1.3);
  }, 300000);

  test("the wall goes round what was built, not round empty ground", () => {
    // A wall runs straight from one arm of the town to the next, as real walls did, so some ground
    // behind it lies empty; but it never loops far out round nothing.
    for (const seed of ["h1", "h2", "h3"]) {
      const { t, map } = town(`${form}-${seed}`, 6000, form, { walls: "wall" });
      // Measured to the outlines of what was built (a precinct is one great plot with only four corners).
      const inside = t.children(t.root, "building").filter((b) => map.wards![b.get<number>("ward")]?.kind === "intramural").map((b) => b.get<Pt[]>("plot") ?? b.get<Pt[]>("poly")).concat(map.gardens ?? []);
      const line = map.wall!.closed ? map.wall!.line : map.wall!.line.slice(6, -6);
      const gap = line.map((p) => Math.min(...inside.map((poly) => lineDist([...poly, poly[0]], p)))).sort((a, b) => a - b);
      expect(gap[Math.floor(gap.length * 0.85)], seed).toBeLessThanOrEqual(90);
      expect(gap[gap.length - 1], seed).toBeLessThanOrEqual(160);
    }
  }, 300000);

  test("same seed, same map, laid out afresh", () => {
    const hash = () => { clearLayoutCache(); return createHash("sha256").update(JSON.stringify(town(`${form}-same`, 4000, form).map)).digest("hex"); };
    expect(hash()).toBe(hash());
  }, 300000);
});

describe("each form's own shape", () => {
  /** Long side over short side of a cloud of points. */
  const aspect = (pts: Pt[]) => {
    const [cx, cy] = mid(pts);
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) { const x = p[0] - cx, y = p[1] - cy; sxx += x * x; syy += y * y; sxy += x * y; }
    const tr = sxx + syy, det = sxx * syy - sxy * sxy, l1 = tr / 2 + Math.sqrt(tr * tr / 4 - det), l2 = tr / 2 - Math.sqrt(tr * tr / 4 - det);
    return Math.sqrt(l1 / Math.max(1e-9, l2));
  };
  const intramural = (t: Town, map: MapData) => t.children(t.root, "building").filter((b) => map.wards![b.get<number>("ward")]?.kind === "intramural");

  test("a ridge town is long and narrow, and climbs from its bridge", () => {
    for (const seed of ["r1", "r2", "r3"]) {
      const { t, map } = town(`ridge-${seed}`, 4000, "ridge");
      expect(aspect(intramural(t, map).map((b) => mid(b.get<Pt[]>("poly")))), seed).toBeGreaterThan(1.5);
      const high = map.roads.find((r) => r.id === "high")!.points;
      // The high street leaves from the bridge.
      expect(Math.hypot(high[0][0] - map.bridges![0][0], high[0][1] - map.bridges![0][1]), seed).toBeLessThan(2);
    }
  }, 300000);

  test("a castle-gate town lies on one side of its castle, its market at the castle's gate", () => {
    for (const seed of ["c1", "c2", "c3"]) {
      const { t, map } = town(`castle-${seed}`, 4000, "castle");
      const castle = t.children(t.root, "building").find((b) => b.get("use") === "castle")!;
      expect(castle, seed).toBeDefined();
      const C = mid(map.castle!), M = mid(map.market!);
      const toM = [M[0] - C[0], M[1] - C[1]];
      const on = intramural(t, map).filter((b) => { const p = mid(b.get<Pt[]>("poly")); return (p[0] - C[0]) * toM[0] + (p[1] - C[1]) * toM[1] > 0; }).length;
      expect(on / intramural(t, map).length, seed).toBeGreaterThan(0.85);
      expect(polylinePolyDist([...map.market!, map.market![0]], map.castle!), seed).toBeLessThan(80);
    }
  }, 300000);

  test("a street town's market is one long street, and much of the town fronts it", () => {
    for (const seed of ["s1", "s2", "s3"]) {
      const { t, map } = town(`street-${seed}`, 2500, "street");
      expect(aspect(map.market!), seed).toBeGreaterThan(4);
      const inside = intramural(t, map);
      expect(inside.filter((b) => b.get("road") === "market").length / inside.length, seed).toBeGreaterThan(0.2);
    }
  }, 300000);

  test("a crossroads town has four arms from one crossing, of unequal length", () => {
    for (const seed of ["x1", "x2", "x3"]) {
      const { map } = town(`crossroads-${seed}`, 4000, "crossroads");
      const arms = map.roads.filter((r) => (r.id === "high" || r.id.startsWith("main")) && Math.hypot(r.points[0][0], r.points[0][1]) < 1);
      expect(arms.length, seed).toBeGreaterThanOrEqual(4);
      const len = arms.map((r) => r.points.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - r.points[i][0], p[1] - r.points[i][1]), 0));
      expect(Math.max(...len) / Math.min(...len), seed).toBeGreaterThan(1.1);
    }
  }, 300000);

  test("an abbey-gate town has its abbey in a great precinct, the market at its gate", () => {
    for (const seed of ["a1", "a2", "a3"]) {
      const { t, map } = town(`abbey-${seed}`, 4000, "abbey");
      const abbey = t.children(t.root, "building").find((b) => b.get("use") === "abbey")!;
      expect(abbey, seed).toBeDefined();
      expect(abbey.get("plotKind"), seed).toBe("precinct");
      expect(polylinePolyDist([...map.market!, map.market![0]], abbey.get<Pt[]>("plot")), seed).toBeLessThan(10);
    }
  }, 300000);

  test("a harbour town has its quay along the shore, and its river runs into the sea", () => {
    for (const seed of ["q1", "q2", "q3"]) {
      const { map } = town(`harbour-${seed}`, 4000, "harbour", {}, "fishing");
      expect(map.quay, seed).toBeDefined();
      for (const p of map.quay!) expect(lineDist(map.coast!, p), seed).toBeLessThan(15);
      expect(Math.min(...map.stream.points.map((p) => lineDist(map.coast!, p))), seed).toBeLessThanOrEqual(2);
    }
  }, 300000);
});
