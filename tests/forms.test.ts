// The grown forms beyond the river town: ridge, castle-gate, street, crossroads, abbey-gate, harbour.
// Every form is held to the same whole-town properties, plus a test of its own shape.
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { Town } from "../src/core/town";
import type { Design, LayoutPlan } from "../src/core/types";
import { clearLayoutCache, type MapData } from "../src/modules/layout";
import { convexOverlap, pointInPoly, polylinePolyDist, segPointDist, type Pt } from "../src/modules/layout/geom";
import { CHURCH_SIZE } from "../src/modules/layout/streets";
import { setBlockedForTest } from "../src/modules/layout/grown";
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
      // Every gatehouse stands at a gate; a road that crosses the wall twice may have a plain gate the second time.
      const houses = bs.filter((b) => b.get("use") === "gatehouse" && b.get("road") !== "postern");
      expect(houses.length, seed).toBeGreaterThan(0);
      expect(houses.length, seed).toBeLessThanOrEqual(map.wall!.gates.length);
      for (const h of houses) expect(map.wall!.gates.some((g) => Math.hypot(g.p[0] - h.get<Pt>("front")[0], g.p[1] - h.get<Pt>("front")[1]) < 2), seed).toBe(true);
    }
  }, 300000);

  test("every road through the wall has its gate", () => {
    for (const [seed, pop, gates] of [["g1", 8000, 4], ["g2", 15000, 6], ["g3", 3000, 2]] as const) {
      const { map } = town(`${form}-${seed}`, pop, form, { walls: "wall", gates }, form === "harbour" ? "fishing" : "agricultural");
      const wall = map.wall!.line.concat(map.wall!.closed ? [map.wall!.line[0]] : []);
      for (const rd of map.roads.filter((r) => /^(high|main\d*|quay)$/.test(r.id))) {
        for (let i = 0; i + 1 < rd.points.length; i++) for (let j = 0; j + 1 < wall.length; j++) {
          if (!segX(rd.points[i], rd.points[i + 1], wall[j], wall[j + 1])) continue;
          const at = rd.points[i];
          expect(map.wall!.gates.some((g) => Math.hypot(g.p[0] - at[0], g.p[1] - at[1]) < 30), `${seed} ${rd.id}`).toBe(true);
        }
      }
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
      expect(gap[gap.length - 1], seed).toBeLessThanOrEqual(115);
    }
  }, 300000);

  test("same seed, same map, laid out afresh", () => {
    const hash = () => { clearLayoutCache(); return createHash("sha256").update(JSON.stringify(town(`${form}-same`, 4000, form).map)).digest("hex"); };
    expect(hash()).toBe(hash());
  }, 300000);
});

describe("walls across many towns", () => {
  test("no house stands across a wall, over a sweep of seeds", () => {
    const bad: string[] = [];
    for (const form of ["street", "abbey", "crossroads", "castle"] as const) for (const [pop, base] of [[750, "fishing"], [2500, "agricultural"], [5000, "herding"]] as const) for (let i = 0; i < 5; i++) {
      for (const market of ["small", undefined] as const) {
        const { t, map } = town(`sweep-${form}-${pop}-${i}-${market ?? "any"}`, pop, form, { walls: "wall", ...(market ? { market } : {}) }, base);
        if (!map.wall?.line.length) continue;
        const line = map.wall.closed ? [...map.wall.line, map.wall.line[0]] : map.wall.line;
        for (const b of t.children(t.root, "building")) if (b.get("use") !== "gatehouse" && crossesLine(b.get<Pt[]>("poly"), line)) bad.push(`${form} ${pop} ${i} ${market ?? "any"}: ${b.get("use")}`);
      }
    }
    expect(bad).toEqual([]);
  }, 900000);
});

describe("blocks in the grown engine", () => {
  test("a river town on blocks: real blocks, every lot in one, nothing in the water or over another", () => {
    setBlockedForTest(["river"]);
    try {
      clearLayoutCache();
      const { t, map } = town("blk-river", 3000, "river");
      expect(map.blocks?.length ?? 0).toBeGreaterThanOrEqual(20);
      expect(trouble(t)).toEqual([]);
      const flat = t.children(t.root, "building").filter((b) => {
        const p = b.get<Pt[]>("poly");
        let a = 0, longest = 0;
        p.forEach((v, i) => { const w = p[(i + 1) % p.length]; a += v[0] * w[1] - w[0] * v[1]; longest = Math.max(longest, Math.hypot(w[0] - v[0], w[1] - v[1])); });
        return Math.abs(a) / 2 / longest < 2;
      });
      expect(flat.map((b) => b.get("use"))).toEqual([]);
    } finally {
      setBlockedForTest([]);
      clearLayoutCache();
    }
  }, 600000);
});

describe("buildings have room inside", () => {
  // A building on two plots took the shared corner for both of its front corners on one side of
  // every street, and was drawn as a line.
  test.each(["radial", "river", ...FORMS] as const)("no %s town has a building drawn as a line", (form) => {
    for (const [seed, pop] of [["a", 1500], ["b", 4000], ["c", 12000]] as const) {
      const { t } = town(`thin-${form}-${seed}`, pop, form);
      const flat = t.children(t.root, "building").filter((b) => {
        const p = b.get<Pt[]>("poly");
        let a = 0, longest = 0;
        p.forEach((v, i) => { const w = p[(i + 1) % p.length]; a += v[0] * w[1] - w[0] * v[1]; longest = Math.max(longest, Math.hypot(w[0] - v[0], w[1] - v[1])); });
        return Math.abs(a) / 2 / longest < 2;
      }).map((b) => b.get<string>("use"));
      expect(flat, `${seed} ${pop}`).toEqual([]);
    }
  }, 600000);
});

describe("churches have room in their yards", () => {
  // The same fault drew a churchyard as a line on one side of the street, and its church shrank to
  // a box a yard across: the "shrines" round the market.
  test.each(["river", "castle", "harbour"] as const)("no %s town's church is squeezed to a fraction of its size", (form) => {
    for (const [seed, pop] of [["a", 4000], ["b", 12000]] as const) {
      const { t } = town(`ch-${form}-${seed}`, pop, form);
      const small = t.children(t.root, "building").flatMap((b) => {
        const size = CHURCH_SIZE[b.get<string>("use")];
        if (!size || b.get<string>("use") === "shrine") return [];
        const p = b.get<Pt[]>("poly");
        let a = 0;
        p.forEach((v, i) => { const w = p[(i + 1) % p.length]; a += v[0] * w[1] - w[0] * v[1]; });
        const k = Math.sqrt(Math.abs(a) / 2 / (size[0] * 0.76 * size[1]));
        return k < 0.45 ? [`${b.get("use")} at ${k.toFixed(2)}`] : [];
      });
      expect(small, `${seed} ${pop}`).toEqual([]);
    }
  }, 600000);
});

describe("the rest of the town follows the form", () => {
  // The country panel names where each road out of town leads, not every street in it.
  test.each(["river", ...FORMS] as const)("a %s town's roads out are its main roads, not its streets", (form) => {
    for (const pop of [800, 6000]) {
      const { t } = town(`out-${form}`, pop, form, { walls: "wall" });
      const rows = (t.modules.flatMap((m) => m.panels ?? []).find((p) => p.id === "country")!.rows(t, t.settlement())).filter((r) => r.label.startsWith("Road "));
      const gates = new Set((t.settlement().get<MapData>("map").wall?.gates ?? []).map((g) => g.road));
      expect(rows.length, `${pop}`).toBeGreaterThanOrEqual(2);
      expect(rows.length, `${pop}`).toBeLessThanOrEqual(5);
      // Every gate is on a road out; a harbour road along the shore can leave without one.
      expect(rows.length, `${pop}`).toBeGreaterThanOrEqual(gates.size);
    }
  }, 600000);

  test("a ridge town has both a higher and a lower part", () => {
    for (const [seed, pop] of [["hl1", 1500], ["hl2", 4000], ["hl3", 9000], ["hl4", 1500], ["hl5", 2500]] as const) {
      const { t } = town(`ridge-${seed}`, pop, "ridge");
      const names = t.children(t.root, "ward").map((w) => w.get<string>("name")).join(", ");
      expect(names, seed).toMatch(/Higher/);
      expect(names, seed).toMatch(/Lower/);
    }
  }, 600000);

  test.each([["castle", /Castle|Bailey/], ["abbey", /Abbey|Sanctuary/], ["harbour", /Quay|Strand/], ["ridge", /Higher|Lower/], ["crossroads", /Street/]] as const)("a %s town's wards are named for what it is", (form, words) => {
    for (const pop of [3000, 9000]) {
      const { t } = town(`wards-${form}-${pop}`, pop, form, {}, form === "harbour" ? "fishing" : "agricultural");
      const names = t.children(t.root, "ward").map((w) => w.get<string>("name"));
      expect(names.some((n) => words.test(n)), `${pop}: ${names.join(", ")}`).toBe(true);
    }
  }, 600000);

  test.each([["castle", /castle|garrison|constable/], ["abbey", /abbot|abbey/], ["harbour", /harbour|quay|wreck/], ["street", /street|stalls/], ["crossroads", /crossroads|carriers/]] as const)("a %s town quarrels over its own kind of thing", (form, words) => {
    const issue = (t: Town) => String(t.find(`${t.root}/institution:town`)?.get("politics.issue") ?? "");
    const towns = Array.from({ length: 20 }, (_, i) => town(`q-${form}-${i}`, 3000, form, {}, form === "harbour" ? "fishing" : "agricultural").t);
    towns.forEach((t) => t.society());
    expect(towns.some((t) => words.test(issue(t)))).toBe(true);
  }, 900000);

  test("a ridge town's far bank keeps its own parish", () => {
    const { t, map } = town("ridge-parish", 4000, "ridge", { farBank: "village" });
    t.society();
    const bankOf = (a: string) => map.wards![t.get(a).get<number>("ward")]?.bank;
    let far = 0;
    for (const h of t.allEntities().filter((e) => e.type === "household")) {
      const parish = h.get<string | null>("parish");
      if (!parish) continue;
      const home = bankOf(t.parentOf(h.address)!);
      expect(bankOf(parish), h.address).toBe(home);
      if (home === "far") far++;
    }
    expect(far).toBeGreaterThan(0);
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

  test("a small street town's market hall stands in its street, clear of the houses", () => {
    for (const base of ["agricultural", "herding", "fishing"]) for (const castle of [false, true]) {
      const { t } = town(`street-hall-${base}`, 1500, "street", { market: "small", suburbs: "few", castle }, base);
      expect(trouble(t).filter((x) => x.includes("market_hall")), `${base} ${castle}`).toEqual([]);
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

  test("an abbey-gate town's abbey is great but not colossal", () => {
    const area = (p: Pt[]) => Math.abs(p.reduce((a, q, i) => { const r = p[(i + 1) % p.length]; return a + q[0] * r[1] - r[0] * q[1]; }, 0)) / 2;
    for (const [seed, pop] of [["big1", 4000], ["big2", 9000], ["big3", 20000]] as const) {
      const { t, map } = town(`abbey-${seed}`, pop, "abbey");
      const abbey = t.children(t.root, "building").find((b) => b.get("use") === "abbey")!;
      const poly = abbey.get<Pt[]>("poly");
      const longest = Math.max(...poly.map((p, i) => Math.hypot(poly[(i + 1) % poly.length][0] - p[0], poly[(i + 1) % poly.length][1] - p[1])));
      expect(longest, `${seed} church`).toBeLessThanOrEqual(75);
      const inside = t.children(t.root, "building").filter((b) => map.wards![b.get<number>("ward")]?.kind === "intramural").reduce((a, b) => a + area(b.get<Pt[]>("plot") ?? b.get<Pt[]>("poly")), 0);
      expect(area(abbey.get<Pt[]>("plot")) / inside, `${seed} precinct`).toBeLessThan(0.14);
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

  test("a harbour town's castle stands on land", () => {
    for (let i = 0; i < 12; i++) for (const base of ["fishing", "agricultural"]) {
      const { t, map } = town(`sea-${i}-${base}`, 9000, "harbour", { castle: true }, base);
      const sea = (map as MapData & { sea?: Pt[] }).sea!;
      const castle = t.children(t.root, "building").find((b) => b.get("use") === "castle");
      if (!castle) continue;
      expect([castle.get<Pt[]>("poly"), map.castle!].some((p) => p.some((q) => pointInPoly(q, sea))), `sea-${i}-${base}`).toBe(false);
    }
  }, 600000);

  test("a harbour town has its quay along the shore, and its river runs into the sea", () => {
    for (const seed of ["q1", "q2", "q3"]) {
      const { map } = town(`harbour-${seed}`, 4000, "harbour", {}, "fishing");
      expect(map.quay, seed).toBeDefined();
      for (const p of map.quay!) expect(lineDist(map.coast!, p), seed).toBeLessThan(15);
      expect(Math.min(...map.stream.points.map((p) => lineDist(map.coast!, p))), seed).toBeLessThanOrEqual(2);
    }
  }, 300000);
});
