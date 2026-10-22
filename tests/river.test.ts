import { describe, expect, test } from "vitest";
import { Rng } from "../src/core/rng";
import { segPointDist, type Pt } from "../src/modules/layout/geom";
import { heightField } from "../src/modules/layout/height";
import { riverSite, riverStreets, sideOf, type RiverOpts, type RiverSite, type StreetNet } from "../src/modules/layout/river";
import { convexOverlap, pointInPoly, polylinePolyDist } from "../src/modules/layout/geom";
import type { MapData } from "../src/modules/layout";
import type { Town } from "../src/core/town";
import { defaultModules, generate } from "../src/town-gen";
import { withEdit } from "../src/core/save";
import { clearLayoutCache } from "../src/modules/layout";
import type { Design, FarBank, LayoutPlan } from "../src/core/types";
import { renderMap } from "../src/ui/map";

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

  test("choosing the layout or the far bank moves no other draw", () => {
    for (let i = 0; i < 4; i++) {
      const choices: Design[] = [{ layout: "radial" }, ...(["village", "bridgend", "abbey", "wharf"] as FarBank[]).map((farBank) => ({ layout: "river" as LayoutPlan, farBank }))];
      const towns = choices.map((d) => settlement(`same${i}`, 3000, d));
      const base = towns[0].get<string[]>("plan");
      for (const [k, t] of towns.entries()) {
        const why = `same${i} ${JSON.stringify(choices[k])}`;
        // The far bank only adds its own buildings after the rest of the plan.
        expect(t.get<string[]>("plan").slice(0, base.length), why).toEqual(base);
        for (const key of ["mainRoads", "quarters", "enclosure", "sizeClass"]) expect(t.get(key), `${why} ${key}`).toEqual(towns[0].get(key));
      }
    }
  });

  test("each far-bank kind brings its signature buildings, even at 750 people", () => {
    const sig: Record<FarBank, string[][]> = {
      village: [["chapel", "fane"]],
      bridgend: [["town_tannery"], ["inn", "hostel"], ["livery_stable", "town_carter"]],
      abbey: [["priory", "friary", "cell"], ["chapel"], ["mill"]],
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
    // Up to the shore, and its mouth a river's width out.
    for (const p of s.river) expect(p[0] * s.sea!.n[0] + p[1] * s.sea!.n[1]).toBeLessThanOrEqual(s.sea!.d + s.width + 1);
    expect(s.river.filter((p) => p[0] * s.sea!.n[0] + p[1] * s.sea!.n[1] > s.sea!.d + 1).length).toBe(1);
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
  abbey: [["priory", "friary", "cell"], ["mill"]],
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

  test("same seed, same map, laid out afresh", () => {
    const a = JSON.stringify(riverTown("det", 5000).map);
    clearLayoutCache();
    expect(JSON.stringify(riverTown("det", 5000).map)).toBe(a);
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

describe("river towns in the generator", () => {
  test("an edit keeps the river layout and ward ids", () => {
    const { t, map } = riverTown("edit", 3000, "bridgend");
    t.society();
    const p = t.allEntities().find((e) => e.type === "person")!.address;
    const t2 = withEdit(t, defaultModules, p, "name.given", "Wat");
    expect(JSON.stringify(t2.settlement().get("map"))).toBe(JSON.stringify(map));
    expect(t2.children(t2.root, "ward").map((w) => w.address)).toEqual(t.children(t.root, "ward").map((w) => w.address));
  }, 300000);

  test("ward entities carry their bank", () => {
    const { t } = riverTown("bank", 3000);
    expect(t.children(t.root, "ward").some((w) => w.get("bank") === "far")).toBe(true);
    expect(t.children(t.root, "ward").some((w) => w.get("bank") === "near")).toBe(true);
  }, 300000);

  test("the layout module is at 2.0", () => {
    expect(defaultModules.find((m) => m.id === "layout")!.version).toBe("2.0.0");
  });
});

describe("the rest of the town follows the banks", () => {
  const bankOf = (t: Town, building: string) => t.settlement().get<MapData>("map").wards![t.get(building).get<number>("ward")]?.bank;

  test("far-bank households go to a church on their own bank", () => {
    for (const k of ["village", "abbey"] as FarBank[]) {
      const { t } = riverTown(`parish-${k}`, 4000, k);
      t.society();
      let far = 0;
      for (const h of t.allEntities().filter((e) => e.type === "household")) {
        const parish = h.get<string | null>("parish");
        if (!parish) continue;
        const home = bankOf(t, t.parentOf(h.address)!);
        expect(bankOf(t, parish), `${k} ${h.address}`).toBe(home);
        if (home === "far") far++;
      }
      expect(far, k).toBeGreaterThan(0);
    }
  }, 300000);

  test("the far ward is named for the far bank", () => {
    for (const k of ["village", "bridgend", "abbey", "wharf"] as FarBank[]) {
      const { t } = riverTown(`nm-${k}`, 3000, k);
      const names = t.children(t.root, "ward").filter((w) => w.get("bank") === "far").map((w) => w.get<string>("name"));
      expect(names.length, k).toBeGreaterThan(0);
      for (const n of names) expect(n, k).toMatch(/Bridge|Strand|Abbey|^Old /);
    }
  }, 300000);

  test("an old village over the bridge is held by another lord", () => {
    const { t } = riverTown("lord", 3000, "village");
    const w = t.children(t.root, "ward").find((x) => x.get("bank") === "far")!;
    const panel = defaultModules.flatMap((m) => m.panels ?? []).find((p) => p.id === "ward")!;
    expect(panel.rows(t, w).some((r) => r.label === "Held by")).toBe(true);
  }, 300000);

  test("abbey towns can quarrel over the abbot's mill; river towns over the bridge", () => {
    const issue = (t: Town) => String(t.find(`${t.root}/institution:town`)?.get("politics.issue") ?? "");
    const abbey = Array.from({ length: 30 }, (_, i) => riverTown(`qa${i}`, 4000, "abbey").t);
    abbey.forEach((t) => t.society());
    expect(abbey.some((t) => issue(t).includes("abbot"))).toBe(true);
    const radial = Array.from({ length: 30 }, (_, i) => generate(`qr${i}`, { pop: 4000, design: { layout: "radial" } }));
    radial.forEach((t) => t.society());
    expect(radial.every((t) => !issue(t).includes("abbot") && !issue(t).includes("far bank"))).toBe(true);
  }, 600000);
});

// ---- review fixes ------------------------------------------------------------
const segX = (a: Pt, b: Pt, c: Pt, d: Pt) => {
  const r = [b[0] - a[0], b[1] - a[1]], s2 = [d[0] - c[0], d[1] - c[1]], den = r[0] * s2[1] - r[1] * s2[0];
  if (Math.abs(den) < 1e-9) return false;
  const t = ((c[0] - a[0]) * s2[1] - (c[1] - a[1]) * s2[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t > 0 && t < 1 && u > 0 && u < 1;
};
const crossesLine = (poly: Pt[], line: Pt[]) => poly.some((p, i) => { const q = poly[(i + 1) % poly.length]; return line.slice(1).some((b, j) => segX(p, q, line[j], b)); });

describe("river towns: review fixes", () => {
  test("a river town forced onto the coast places everything, and nothing in the sea", () => {
    for (const [seed, pop] of [["sea1", 9000], ["sea2", 9000], ["sea3", 900], ["sea4", 900]] as const) {
      const { t, map } = riverTown(seed, pop, pop > 1000 ? "wharf" : "village", "fishing");
      expect(t.children(t.root, "building").length, seed).toBe(t.settlement().get<string[]>("plan").length);
      const sea = (map as MapData & { sea?: Pt[] }).sea!;
      for (const b of t.children(t.root, "building")) expect(b.get<Pt[]>("poly").some((p) => pointInPoly(p, sea)), `${seed} ${b.get("use")}`).toBe(false);
    }
  }, 600000);

  test("no house is built through the town wall", () => {
    for (const seed of ["wall1", "wall2", "wall3", "wall4"]) for (const pop of [3000, 8000]) {
      const t = generate(seed, { pop, design: { layout: "river", walls: "wall" } });
      const map = t.settlement().get<MapData>("map");
      const bad = t.children(t.root, "building").filter((b) => b.get("use") !== "gatehouse" && crossesLine(b.get<Pt[]>("poly"), map.wall!.line));
      expect(bad.map((b) => b.get("use")), `${seed} ${pop}`).toEqual([]);
    }
  }, 600000);

  test("an open river town has no gates", () => {
    for (const seed of ["open1", "open2"]) {
      const t = generate(seed, { pop: 2000, design: { layout: "river", walls: "none" } });
      const map = t.settlement().get<MapData>("map");
      expect(map.wall!.gates, seed).toEqual([]);
      expect(t.children(t.root, "ward").some((w) => /gate/i.test(w.get<string>("name"))), seed).toBe(false);
    }
  }, 300000);

  test("the Suburbs choice changes how much lies beyond the gates", () => {
    const outside = (choice: "few" | "many") => {
      const t = generate("subs", { pop: 6000, design: { layout: "river", suburbs: choice } });
      const map = t.settlement().get<MapData>("map");
      return t.children(t.root, "building").filter((b) => { const w = map.wards![b.get<number>("ward")]; return w?.kind === "suburb" && w.bank === "near"; }).length;
    };
    expect(outside("many")).toBeGreaterThan(outside("few") * 1.5);
  }, 600000);

  test("no castle or church stands on a street or lane", () => {
    const onRoad = (t: Town) => {
      const map = t.settlement().get<MapData>("map");
      return t.children(t.root, "building").filter((b) => ["castle", "fane", "temple", "grand_temple", "chapel", "priory", "friary"].includes(b.get<string>("use")))
        .filter((b) => map.roads.some((rd) => polylinePolyDist(rd.points, b.get<Pt[]>("poly")) < rd.width / 2 - 0.5)).map((b) => b.get<string>("use"));
    };
    for (let i = 0; i < 8; i++) expect(onRoad(generate(`cast${i}`, { pop: 3000, design: { layout: "river", castle: true } })), `cast${i}`).toEqual([]);
    expect(onRoad(riverTown("place30000", 30000).t)).toEqual([]);
  }, 900000);
});

describe("river towns: small things", () => {
  test("a big town's trades that don't keep together are spread out, not in rows", () => {
    const { t } = riverTown("spread", 12000);
    const by = new Map<string, Pt[]>();
    for (const b of t.children(t.root, "building")) {
      const u = b.get<string>("use");
      if (!["tailor", "town_weaver", "town_mason", "brewhouse", "town_smithy", "cordwainer", "skinner", "fripperer", "livery_stable", "merchant_house"].includes(u)) continue;
      const p = b.get<Pt[]>("poly"), c: Pt = [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
      by.set(u, [...(by.get(u) ?? []), c]);
    }
    let n = 0, next = 0;
    for (const c of by.values()) for (let k = 0; k < c.length; k++) {
      n++;
      if (c.some((q, j) => j !== k && Math.hypot(q[0] - c[k][0], q[1] - c[k][1]) < 14)) next++;
    }
    expect(n).toBeGreaterThan(30);
    // Some will fall next door by chance; most should not.
    expect(next / n).toBeLessThan(0.25);
  }, 300000);

  test("an old village over the bridge has its green drawn; other far banks don't", () => {
    const v = riverTown("vgreen", 2000, "village");
    expect(v.map.farGreen?.length).toBeGreaterThan(3);
    expect(renderMap(v.t)).toContain('class="m-green m-far-green"');
    const a = riverTown("vgreen", 2000, "abbey");
    expect(a.map.farGreen).toBeUndefined();
    expect(renderMap(a.t)).not.toContain("m-far-green");
  }, 300000);

  test("a hedged river town has its hedge drawn, without towers or gates", () => {
    let hedged = 0;
    for (let i = 0; i < 30 && hedged < 2; i++) {
      const { t, map } = riverTown(`hedge${i}`, 1500);
      if (map.enclosure !== "hedge") continue;
      hedged++;
      expect(map.wall!.line.length).toBeGreaterThan(5);
      expect(map.wall!.towers).toEqual([]);
      expect(map.wall!.gates).toEqual([]);
      expect(renderMap(t)).toContain('class="m-hedge"');
    }
    expect(hedged).toBeGreaterThan(0);
  }, 300000);

  test("an old village's chapel shows its parish", () => {
    const { t } = riverTown("farparish", 2000, "village");
    const seat = defaultModules.flatMap((m) => m.panels ?? []).find((p) => p.id === "seat")!;
    const chapels = t.children(t.root, "building").filter((b) => b.get("use") === "chapel" && wardOf(t, b)?.bank === "far");
    expect(chapels.length).toBeGreaterThan(0);
    const rows = chapels.flatMap((c) => seat.rows(t, c));
    expect(rows.some((r) => r.label === "Parish" && /^[1-9]\d* households/.test(String(r.value)))).toBe(true);
  }, 300000);

  test("a small town's abbey side is a priory cell with its mill; a big one's is a priory", () => {
    const farUses = (pop: number) => { const { t } = riverTown(`cell${pop}`, pop, "abbey"); return t.children(t.root, "building").filter((b) => wardOf(t, b)?.bank === "far").map((b) => b.get<string>("use")); };
    const small = farUses(2000);
    expect(small).toContain("cell");
    expect(small).not.toContain("priory");
    expect(small).toContain("mill");
    const big = farUses(8000);
    expect(big.some((u) => u === "priory" || u === "friary")).toBe(true);
    expect(big).not.toContain("cell");
    for (const base of ["fishing", "mining", "herding", "woodcutting"]) {
      const { t } = riverTown(`cellmill${base}`, 2000, "abbey", base);
      expect(t.children(t.root, "building").filter((b) => wardOf(t, b)?.bank === "far").map((b) => b.get<string>("use")), base).toContain("mill");
    }
  }, 300000);

  test("a postern is named for the way it faces", () => {
    // More gatehouses than roads through the wall on this seed: one is a postern.
    const t = generate("pf5-1", { pop: 20000, design: { layout: "river", walls: "wall", gates: 5 } });
    const posterns = t.children(t.root, "building").filter((b) => b.get("use") === "gatehouse" && b.get("road") === "postern");
    expect(posterns.length).toBeGreaterThan(0);
    for (const b of posterns) expect(t.label(b.address)).toMatch(/^The (North|South|East|West) postern$/);
  }, 300000);
});

describe("fishing towns", () => {
  const lineDist = (l: Pt[], p: Pt) => { let d = Infinity; for (let i = 0; i + 1 < l.length; i++) d = Math.min(d, segPointDist(p, l[i], l[i + 1])); return d; };
  test("the river always runs into the sea, on the map", () => {
    for (const layout of ["river", "radial"] as const) for (const pop of [1500, 6000]) for (let i = 0; i < 12; i++) {
      const t = generate(`sea${i}`, { pop, base: "fishing", design: { layout } });
      const m = t.settlement().get<MapData>("map");
      expect(m.coast, `${layout} ${pop} sea${i}`).toBeTruthy();
      const [bx, by, bw, bh] = m.bounds;
      const onMap = m.stream.points.filter((p) => p[0] >= bx && p[0] <= bx + bw && p[1] >= by && p[1] <= by + bh);
      const gap = Math.min(...onMap.map((p) => lineDist(m.coast!, p)));
      expect(gap, `${layout} ${pop} sea${i}`).toBeLessThanOrEqual(2);
    }
  }, 600000);
});

describe("the wall hugs the town", () => {
  test("no stretch of wall stands far out from everything built inside it", () => {
    const worst: string[] = [];
    for (let i = 0; i < 8; i++) {
      const t = generate(`hug${i}`, { pop: 6000, design: { layout: "river", walls: "wall" } });
      const m = t.settlement().get<MapData>("map");
      const inside = t.children(t.root, "building").filter((b) => m.wards![b.get<number>("ward")]?.kind === "intramural").flatMap((b) => b.get<Pt[]>("plot") ?? b.get<Pt[]>("poly"))
        .concat((m.gardens ?? []).flat()); // a garden is ground in use too
      const line = m.wall!.line;
      // Its ends run out to the river across whatever lies between, so only the stretch round the town counts.
      for (const p of line.slice(6, -6)) {
        const d = Math.min(...inside.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1])));
        if (d > 90) { worst.push(`hug${i}: ${d.toFixed(0)}`); break; }
      }
    }
    expect(worst).toEqual([]);
  }, 600000);
});
