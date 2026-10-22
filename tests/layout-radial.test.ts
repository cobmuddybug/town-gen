// A guard on the radial street plan: its output, for fixed plans and streams,
// must not move when code is reorganised around it.
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { Rng } from "../src/core/rng";
import { generate } from "../src/town-gen";
import type { BuildingUse } from "../src/modules/uses";
import type { Footprint } from "../src/modules/layout/hamlet";
import { layoutRadial } from "../src/modules/layout/radial";

const CASES: [string, number, "thorp" | "village" | "town" | "city", number][] = [
  ["g1", 800, "thorp", 3], ["g2", 3000, "village", 4], ["g3", 9000, "town", 5], ["g4", 26000, "city", 6],
];

function footprints(seed: string, pop: number): Footprint[] {
  const t = generate(seed, { pop, design: { layout: "radial" } });
  const s = t.settlement();
  const reg = t.registry<BuildingUse>("buildingUses");
  return s.get<string[]>("plan").map((u) => {
    const row = reg.find(u);
    return { size: row?.size ?? "cottage", site: row?.site, kind: u, ...(row?.plots ? { plots: row.plots } : {}), ...(row?.value ? { value: row.value } : {}), ...(row?.cluster ? { cluster: true } : {}) };
  });
}

test.each(CASES)("radial layout %s (%i people) is unchanged", (seed, pop, scale, roads) => {
  const fp = footprints(seed, pop);
  const map = layoutRadial(new Rng(`radial-guard|${seed}`), fp, { scale, enclosure: "wall", roads, terrain: "farmland" }) as unknown as Record<string, unknown>;
  const { plan: _plan, ...rest } = map;
  expect(createHash("sha256").update(JSON.stringify(rest)).digest("hex")).toMatchSnapshot();
});
