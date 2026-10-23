// Villages: a chapel stands in its churchyard, and the green lies on the level.
import { describe, expect, test } from "vitest";
import { generate } from "../src/town-gen";
import type { MapData } from "../src/modules/layout";
import { renderMap } from "../src/ui/map";
type Pt = [number, number];
const inside = (p: Pt, poly: Pt[]) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };

describe("villages", () => {
  test("a village chapel stands in its churchyard, and the map draws it", () => {
    let seen = 0;
    for (let i = 0; i < 12 && seen < 3; i++) {
      const t = generate(`vch-${i}`, { pop: 500 });
      const chapel = t.children(t.root, "building").find((b) => b.get("use") === "chapel");
      if (!chapel) continue;
      seen++;
      const m = t.settlement().get<MapData>("map");
      const yard = (m.greens ?? []).find((g) => g.kind === "graveyard");
      expect(yard, `vch-${i}`).toBeDefined();
      expect(chapel.get<Pt[]>("poly").every((p) => inside(p, yard!.poly)), `vch-${i}`).toBe(true);
      expect(renderMap(t)).toContain('class="m-graveyard"');
    }
    expect(seen).toBeGreaterThan(0);
  }, 300000);
  test("the green lies on ground no steeper than the village's around it", () => {
    for (const s of ["g1", "g2", "g3", "g4", "g5", "g6"]) {
      const m = generate(`vgreen-${s}`, { pop: 300 }).settlement().get<MapData>("map");
      expect(m.slopeAtGreen, s).toBeDefined();
      expect(m.slopeAtGreen!, s).toBeLessThanOrEqual(m.slopeAround!);
    }
  }, 300000);
});
