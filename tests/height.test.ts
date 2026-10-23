// Every layout has ground that rises and falls: villages too, with contour lines on the map, and
// their houses on the easier ground.
import { describe, expect, test } from "vitest";
import { generate } from "../src/town-gen";
import type { MapData } from "../src/modules/layout";
import { renderMap } from "../src/ui/map";

describe("height in villages", () => {
  for (const [pop, base] of [[120, "agricultural"], [600, "mining"], [400, "fishing"]] as const) {
    test(`a place of ${pop} (${base}) has contour lines`, () => {
      const t = generate(`hv-${pop}`, { pop, base });
      const m = t.settlement().get<MapData>("map");
      expect(m.contourLines?.length ?? 0).toBeGreaterThanOrEqual(3);
      expect(renderMap(t)).toContain('class="m-contour"');
    });
  }
  test("the houses stand on the easier ground", () => {
    for (const s of ["e1", "e2", "e3", "e4"]) {
      const t = generate(`hv-slope-${s}`, { pop: 200 });
      const m = t.settlement().get<MapData>("map");
      expect(m.slopeAtHomes, s).toBeDefined();
      expect(m.slopeAtHomes!, s).toBeLessThan(0.35);
    }
  });
});
