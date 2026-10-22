import { describe, expect, test } from "vitest";
import { Rng } from "../src/core/rng";
import { segPointDist, type Pt } from "../src/modules/layout/geom";
import { heightField } from "../src/modules/layout/height";
import { riverSite, sideOf, type RiverOpts } from "../src/modules/layout/river";
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
