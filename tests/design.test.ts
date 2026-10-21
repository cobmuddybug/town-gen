import { describe, expect, test } from "vitest";
import { generate, defaultModules } from "../src/town-gen";
import { load, serialize } from "../src/core/save";
import { pointInPoly } from "../src/modules/layout/geom";
import { stableStringify } from "../src/core/town";
import { designFrom, townKey } from "../src/ui/library";
import type { MapData } from "../src/modules/layout";

const placedAll = (t: ReturnType<typeof generate>) => t.children(t.root, "building").length === t.settlement().get<string[]>("plan").length;

describe("town plans (settings.design)", () => {
  test("walls, gates and the castle follow the plan", () => {
    const open = generate("design-a", { pop: 9000, design: { walls: "none", gates: 2, castle: false } });
    expect(open.settlement().get("enclosure")).toMatch(/open/);
    expect(open.settlement().get("mainRoads")).toBe(2);
    expect(open.settlement().get<string[]>("plan")).not.toContain("castle");
    const walled = generate("design-a", { pop: 9000, design: { walls: "wall", gates: 6, castle: true } });
    expect(walled.settlement().get("enclosure")).toBe("stone wall");
    expect(walled.settlement().get("mainRoads")).toBe(6);
    expect(walled.settlement().get<string[]>("plan")).toContain("castle");
    expect(placedAll(open) && placedAll(walled)).toBe(true);
  });

  test("small street plans take gates too; hamlets ignore plans", () => {
    expect(generate("design-b", { pop: 850, design: { gates: 5 } }).settlement().get("mainRoads")).toBe(5);
    const h = generate("design-b", { pop: 200, design: { walls: "wall", shape: "long" } });
    const plain = generate("design-b", { pop: 200 });
    expect(stableStringify(h.settlement().get("map"))).toBe(stableStringify(plain.settlement().get("map")));
    expect(h.settlement().get("enclosure")).toBe(plain.settlement().get("enclosure"));
  });

  test("a long town lies along its first road, and the river stays outside", () => {
    for (const seed of ["design-c", "design-d", "design-e"]) {
      const t = generate(seed, { pop: 7000, design: { shape: "long", gates: 2 } });
      const m = t.settlement().get<MapData & { kind: "town" }>("map");
      // Longest extent of the town ground is clearly longer than its width.
      let best = 0, worst = Infinity;
      for (let k = 0; k < 36; k++) {
        const a = (k / 36) * Math.PI, u = [Math.cos(a), Math.sin(a)];
        const proj = m.hedge.map((p) => p[0] * u[0] + p[1] * u[1]);
        const span = Math.max(...proj) - Math.min(...proj);
        best = Math.max(best, span); worst = Math.min(worst, span);
      }
      expect(best / worst, seed).toBeGreaterThan(1.4);
      expect(m.stream.points.filter((p) => pointInPoly(p, m.hedge)).length, seed).toBe(0);
      expect(placedAll(t), seed).toBe(true);
    }
  });

  test("a plan rides in the save and the URL", () => {
    const t = generate("design-f", { pop: 4000, design: { shape: "round", market: "large", suburbs: "few", castle: true } });
    const save = JSON.parse(serialize(t));
    expect(save.town.config.design).toEqual({ shape: "round", market: "large", suburbs: "few", castle: true });
    expect(stableStringify(load(save, defaultModules).settlement().get("map"))).toBe(stableStringify(t.settlement().get("map")));
    const key = townKey(save);
    expect(key).toContain("castle=1");
    expect(designFrom((k) => new URLSearchParams(key).get(k))).toEqual(save.town.config.design);
    expect(townKey(generate("design-f", { pop: 4000 }).toSave())).not.toContain("shape");
  });

  test("a market or suburbs choice changes the plan's size where asked", () => {
    const small = generate("design-g", { pop: 9000, design: { market: "small" } }).settlement().get<MapData & { kind: "town" }>("map");
    const large = generate("design-g", { pop: 9000, design: { market: "large" } }).settlement().get<MapData & { kind: "town" }>("map");
    const area = (p: [number, number][]) => Math.abs(p.reduce((a, q, i) => { const n = p[(i + 1) % p.length]; return a + q[0] * n[1] - n[0] * q[1]; }, 0) / 2);
    expect(area(large.market!)).toBeGreaterThan(area(small.market!) * 2);
  });
});
