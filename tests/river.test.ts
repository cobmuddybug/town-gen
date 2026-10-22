import { describe, expect, test } from "vitest";
import { Rng } from "../src/core/rng";
import { segPointDist, type Pt } from "../src/modules/layout/geom";
import { heightField } from "../src/modules/layout/height";
import { riverSite, riverStreets, sideOf, type RiverOpts, type RiverSite, type StreetNet } from "../src/modules/layout/river";
import { convexOverlap, pointInPoly, polylinePolyDist } from "../src/modules/layout/geom";
import type { MapData } from "../src/modules/layout";
import type { Town } from "../src/core/town";
import { generate } from "../src/town-gen";
import type { Design, FarBank, LayoutPlan } from "../src/core/types";

const settlement = (seed: string, pop: number, design?: Design, base = "agricultural") =>
  generate(seed, { pop, base, ...(design ? { design } : {}) }).settlement();

describe("rolling the layout and the far bank", () => {
  test("about two in three street plans are river towns", () => {
    const n = Array.from({ length: 150 }, (_, i) => settlement(`rv${i}`, 1500).get("layoutPlan")).filter((x) => x === "river").length;
    expect(n / 150).toBeGreaterThan(0.55);
    expect(n / 150).toBeLessThan(0.78);
  });

  test("coast towns are radial unless the DM chooses", () => {
    for (let i = 0; i < 20; i++) expect(settlement(`cs${i}`, 2000, undefined, "fishing").get("layoutPlan")).toBe("radial");
    expect(settlement("cs0", 2000, { layout: "river" }, "fishing").get("layoutPlan")).toBe("river");
  });

  test("hamlets have no layout plan", () => {
    expect(settlement("ham", 300).get("layoutPlan")).toBeUndefined();
  });

  test("choosing the layout moves no other draw", () => {
    for (let i = 0; i < 6; i++) {
      const a = settlement(`same${i}`, 3000);
      const forced = settlement(`same${i}`, 3000, { layout: a.get("layoutPlan") as LayoutPlan, ...(a.get("farBank") ? { farBank: a.get("farBank") as FarBank } : {}) });
      expect(forced.get("plan")).toEqual(a.get("plan"));
      expect(forced.get("farUses")).toEqual(a.get("farUses"));
    }
  });

  test("each far-bank kind brings its signature buildings, even at 750 people", () => {
    const sig: Record<FarBank, string[][]> = {
      village: [["chapel", "fane"]],
      bridgend: [["town_tannery"], ["inn", "hostel"], ["livery_stable", "town_carter"]],
      abbey: [["priory", "friary"], ["chapel"]],
      wharf: [["warehouse"], ["boatwright"]],
    };
    for (const k of Object.keys(sig) as FarBank[]) for (const pop of [750, 3000, 12000]) {
      const s = settlement(`sig-${k}`, pop, { layout: "river", farBank: k });
      const plan = s.get<string[]>("plan");
      const far = s.get<number[]>("farUses").map((i) => plan[i]);
      for (const any of sig[k]) expect(far.some((u) => any.includes(u)), `${k} at ${pop}: ${any}`).toBe(true);
    }
  });

  test("far-bank indices are distinct and point into the plan", () => {
    const s = settlement("idx", 5000, { layout: "river", farBank: "bridgend" });
    const far = s.get<number[]>("farUses"), n = s.get<string[]>("plan").length;
    expect(new Set(far).size).toBe(far.length);
    expect(far.every((i) => i >= 0 && i < n)).toBe(true);
  });

  test("radial plans reserve nothing for a far bank", () => {
    expect(settlement("rad", 3000, { layout: "radial" }).get("farUses")).toEqual([]);
  });

  test("a wharf is never rolled below 1,001 people, but the DM may choose one", () => {
    for (let i = 0; i < 60; i++) expect(settlement(`wf${i}`, 850, { layout: "river" }).get("farBank")).not.toBe("wharf");
    expect(settlement("wf", 850, { layout: "river", farBank: "wharf" }).get("farBank")).toBe("wharf");
  });
});

const OPTS = (need: number, extra: Partial<RiverOpts> = {}): RiverOpts =>
  ({ scale: need > 1500 ? "town" : "village", enclosure: "wall", roads: 4, terrain: "farmland", farBank: "village", need, ...extra });
const nearestDist = (line: Pt[], p: Pt) => Math.min(...line.slice(1).map((b, i) => segPointDist(p, line[i], b)));

describe("the river site", () => {
  test("the river crosses the site and the dominant bank is the higher one", () => {
    for (let i = 0; i < 20; i++) {
      const s = riverSite(new Rng(`site${i}`), OPTS(600));
      expect(s.river.length).toBeGreaterThan(10);
      expect(sideOf(s.river, s.high)).toBe(s.near);
      expect(sideOf(s.river, [0, 0])).toBe(s.near);
      expect(nearestDist(s.river, s.bridge.p)).toBeLessThan(s.width);
      expect(nearestDist(s.river, [0, 0])).toBeGreaterThan(s.width * 2);
      // Higher on average on the near side, close to the river.
      let near = 0, far = 0, nn = 0, nf = 0;
      for (let k = 0; k < 400; k++) {
        const p: Pt = [((k % 20) / 10 - 1) * s.extent * 0.5, (Math.floor(k / 20) / 10 - 1) * s.extent * 0.5];
        if (sideOf(s.river, p) === s.near) { near += s.height(p); nn++; } else { far += s.height(p); nf++; }
      }
      expect(near / Math.max(1, nn)).toBeGreaterThan(far / Math.max(1, nf));
    }
  });

  test("river widths suit the size", () => {
    expect(riverSite(new Rng("w"), OPTS(4000, { scale: "town" })).width).toBeGreaterThanOrEqual(12);
    expect(riverSite(new Rng("w"), OPTS(700, { scale: "thorp" })).width).toBeLessThanOrEqual(10);
  });

  test("the height field is deterministic and smooth", () => {
    const h = heightField(new Rng("h"), 800), g = heightField(new Rng("h"), 800);
    expect(h([10, 20])).toBe(g([10, 20]));
    expect(Math.abs(h([10, 20]) - h([11, 20]))).toBeLessThan(0.02);
  });

  test("on the coast the river stops at the sea", () => {
    const s = riverSite(new Rng("sea"), OPTS(3000, { terrain: "coast" }));
    expect(s.sea).toBeDefined();
    for (const p of s.river) expect(p[0] * s.sea!.n[0] + p[1] * s.sea!.n[1]).toBeLessThanOrEqual(s.sea!.d + 1);
  });
});

// ---- street-network helpers ------------------------------------------------
const pairs = (pts: Pt[]) => pts.slice(1).map((b, i) => [pts[i], b] as [Pt, Pt]);
/** One network: streets join where an end lies on another street, the market, or the bridge. */
function connected(net: StreetNet): boolean {
  const n = net.streets.length;
  const parent = net.streets.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: number, b: number) => { parent[find(a)] = find(b); };
  const MARKET = n;
  parent.push(MARKET);
  for (let i = 0; i < n; i++) {
    const s = net.streets[i];
    for (const end of [s.points[0], s.points[s.points.length - 1]]) {
      if (polylinePolyDist([end, end], net.market) < 2 || pointInPoly(end, net.market)) join(i, MARKET);
      for (let j = 0; j < n; j++) if (j !== i && nearestDist(net.streets[j].points, end) < 1) join(i, j);
    }
  }
  return net.streets.every((_, i) => find(i) === find(0));
}
function crossesRiverAwayFromBridge(s: RiverSite, a: Pt, b: Pt): boolean {
  if (sideOf(s.river, a) === sideOf(s.river, b)) return false;
  const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return Math.hypot(m[0] - s.bridge.p[0], m[1] - s.bridge.p[1]) > s.width * 2;
}
/** Long side over short side, in the polygon's own principal axes. */
function aspect(poly: Pt[]): number {
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length, cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of poly) { const x = p[0] - cx, y = p[1] - cy; sxx += x * x; syy += y * y; sxy += x * y; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), u: Pt = [Math.cos(th), Math.sin(th)], v: Pt = [-u[1], u[0]];
  const span = (d: Pt) => { const ps = poly.map((p) => p[0] * d[0] + p[1] * d[1]); return Math.max(...ps) - Math.min(...ps); };
  const a = span(u), b = span(v);
  return Math.max(a, b) / Math.max(1e-9, Math.min(a, b));
}
/** Gaps between the main roads' bearings, 60 units out from the market's centre. */
function bearingGaps(net: StreetNet): number[] {
  const cx = net.market.reduce((a, p) => a + p[0], 0) / net.market.length, cy = net.market.reduce((a, p) => a + p[1], 0) / net.market.length;
  const bs = net.streets.filter((s) => s.kind === "main").map((s) => {
    let acc = 0; let at = s.points[s.points.length - 1];
    for (const [a, b] of pairs(s.points)) { const l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (acc + l >= 60) { const t = (60 - acc) / l; at = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; break; } acc += l; }
    return Math.atan2(at[1] - cy, at[0] - cx);
  }).sort((a, b) => a - b);
  return bs.map((b, i) => (i + 1 < bs.length ? bs[i + 1] - b : bs[0] + 2 * Math.PI - b));
}

describe("the river town's streets", () => {
  const net = (seed: string, need: number) => { const o = OPTS(need); const s = riverSite(new Rng(seed), o); return { s, net: riverStreets(new Rng(seed + "/streets"), s, o) }; };

  test("streets form one connected network, crossing the river only at the bridge", () => {
    for (let i = 0; i < 12; i++) {
      const { s, net: n } = net(`n${i}`, 1500);
      expect(connected(n)).toBe(true);
      for (const st of n.streets) for (const [a, b] of pairs(st.points)) expect(crossesRiverAwayFromBridge(s, a, b), `${st.id}`).toBe(false);
    }
  });

  test("the market meets at least two main roads and is not a disc", () => {
    for (let i = 0; i < 8; i++) {
      const { net: n } = net(`m${i}`, 3000);
      const touching = n.streets.filter((st) => (st.kind === "main" || st.kind === "high") && polylinePolyDist(st.points, n.market) < 2);
      expect(touching.length).toBeGreaterThanOrEqual(2);
      expect(aspect(n.market)).toBeGreaterThan(1.3);
    }
  });

  test("main roads do not radiate evenly", () => {
    let uneven = 0;
    for (let i = 0; i < 20; i++) {
      const gaps = bearingGaps(net(`b${i}`, 5000).net);
      if (Math.max(...gaps) / Math.min(...gaps) > 1.6) uneven++;
    }
    expect(uneven).toBeGreaterThanOrEqual(14);
  });

  test("there are back lanes, cross lanes, water lanes and a far-bank road", () => {
    const { net: n } = net("kinds", 4000);
    for (const k of ["high", "main", "back", "cross", "water", "far"]) expect(n.streets.some((s) => s.kind === k), k).toBe(true);
  });

  test("a walled town has gates on its main roads and one at the bridge", () => {
    const { net: n } = net("gates", 4000);
    expect(n.wallLine?.length).toBeGreaterThan(5);
    expect(n.gates.length).toBeGreaterThanOrEqual(OPTS(4000).roads);
    expect(n.gates.some((g) => g.road === "high")).toBe(true);
  });
});

// ---- whole river towns -------------------------------------------------------
const riverTown = (seed: string, pop: number, farBank: FarBank = "village", base = "agricultural") => {
  const t = generate(seed, { pop, base, design: { layout: "river", farBank } });
  return { t, map: t.settlement().get<MapData>("map") };
};
const wardOf = (t: Town, b: { get<T>(k: string): T }) => t.settlement().get<MapData>("map").wards![b.get<number>("ward")];
const farShare = (t: Town) => {
  const bs = t.children(t.root, "building");
  return bs.filter((b) => wardOf(t, b)?.bank === "far").length / bs.length;
};
/** Buildings that overlap each other or stand in the river (a grid keeps it quick). */
function overlaps(t: Town): string[] {
  const map = t.settlement().get<MapData>("map");
  const bs = t.children(t.root, "building").map((b) => ({ a: b.address, poly: b.get<Pt[]>("poly") }));
  const cell = 40, grid = new Map<string, number[]>();
  const out: string[] = [];
  bs.forEach((b, i) => {
    const xs = b.poly.map((p) => p[0]), ys = b.poly.map((p) => p[1]);
    const keys: string[] = [];
    for (let x = Math.floor(Math.min(...xs) / cell); x <= Math.floor(Math.max(...xs) / cell); x++) for (let y = Math.floor(Math.min(...ys) / cell); y <= Math.floor(Math.max(...ys) / cell); y++) keys.push(`${x},${y}`);
    const seen = new Set<number>();
    for (const k of keys) for (const j of grid.get(k) ?? []) if (!seen.has(j)) { seen.add(j); if (convexOverlap(b.poly, bs[j].poly, -0.3)) out.push(`${b.a} × ${bs[j].a}`); }
    for (const k of keys) { const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]); }
    if (b.poly.some((p) => nearestDist(map.stream.points, p) < map.stream.width / 2 - 0.5)) out.push(`${b.a} in the river`);
  });
  return out;
}
const SIG: Record<FarBank, string[][]> = {
  village: [["chapel", "fane"]],
  bridgend: [["town_tannery"], ["inn", "hostel"]],
  abbey: [["priory", "friary"]],
  wharf: [["warehouse"], ["boatwright"]],
};

describe("whole river towns", () => {
  test.each([800, 3000, 8000, 30000])("every footprint is placed, with no overlaps, at %i people", (pop) => {
    const { t, map } = riverTown(`place${pop}`, pop);
    expect(map.plan).toBe("river");
    expect(t.children(t.root, "building").length).toBe(t.settlement().get<string[]>("plan").length);
    expect(overlaps(t).slice(0, 5)).toEqual([]);
  }, 300000);

  test("smallest river towns place everything and keep the far bank's share", () => {
    for (const pop of [701, 750, 900, 1000]) for (const k of ["village", "bridgend", "abbey", "wharf"] as FarBank[]) {
      const { t } = riverTown(`small${pop}${k}`, pop, k);
      expect(t.children(t.root, "building").length, `${pop} ${k}`).toBe(t.settlement().get<string[]>("plan").length);
      const share = farShare(t);
      expect(share, `${pop} ${k}`).toBeGreaterThanOrEqual(0.15);
      expect(share, `${pop} ${k}`).toBeLessThanOrEqual(0.25);
    }
  }, 300000);

  test("the far bank holds 15–25% of buildings across seeds", () => {
    for (let i = 0; i < 10; i++) for (const pop of [1500, 6000]) {
      const s = farShare(riverTown(`share${i}`, pop).t);
      expect(s, `share${i} ${pop}`).toBeGreaterThanOrEqual(0.15);
      expect(s, `share${i} ${pop}`).toBeLessThanOrEqual(0.25);
    }
  }, 300000);

  test("each far-bank kind's signature uses stand on the far bank, at 750 and 5000", () => {
    for (const k of Object.keys(SIG) as FarBank[]) for (const pop of [750, 5000]) {
      const { t } = riverTown(`sig${k}${pop}`, pop, k);
      const far = t.children(t.root, "building").filter((b) => wardOf(t, b)?.bank === "far").map((b) => b.get<string>("use"));
      for (const any of SIG[k]) expect(far.some((u) => any.includes(u)), `${k} ${pop} ${any}`).toBe(true);
    }
  }, 300000);

  test("far-bank wards are suburbs, and the wall stays on the near bank", () => {
    const { map } = riverTown("wall", 8000);
    const far = map.wards!.filter((w) => w.bank === "far");
    expect(far.length).toBeGreaterThan(0);
    for (const w of far) expect(w.kind).toBe("suburb");
    const near = sideOf(map.stream.points, map.market![0]);
    expect(map.wall!.line.every((p) => sideOf(map.stream.points, p) === near)).toBe(true);
  }, 300000);

  test("a city has two bridges", () => expect(riverTown("city", 30000).map.bridges!.length).toBe(2), 300000);

  test("a coast river town has its quay on the near bank and the river reaches the sea", () => {
    const { map } = riverTown("coastal", 4000, "wharf", "fishing");
    expect(map.quay?.length).toBeGreaterThan(0);
    const near = sideOf(map.stream.points, map.market![0]);
    expect(map.quay!.every((p) => sideOf(map.stream.points, p) === near)).toBe(true);
    expect(map.coast?.length).toBeGreaterThan(0);
  }, 300000);

  test("same seed, same map", () => {
    expect(JSON.stringify(riverTown("det", 5000).map)).toBe(JSON.stringify(riverTown("det", 5000).map));
  }, 300000);
});

describe("river towns and the rest of the generator", () => {
  test("every quarter has a ward, so every quarter gets its constable", () => {
    for (const [seed, pop] of [["burgh-a", 8000], ["q1", 5000], ["q2", 9000], ["q3", 20000]] as const) {
      const t = generate(seed, { pop, design: { layout: "river" } });
      const quarters = t.settlement().get<number>("quarters");
      const have = new Set(t.children(t.root, "ward").filter((w) => w.get("kind") === "intramural").map((w) => w.get<number>("quarter")));
      for (let q = 0; q < quarters; q++) expect(have.has(q), `${seed} quarter ${q}`).toBe(true);
    }
  }, 300000);
});
