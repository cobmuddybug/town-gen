import { describe, expect, test } from "vitest";
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
