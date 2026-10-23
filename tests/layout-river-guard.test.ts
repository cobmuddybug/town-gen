// A guard on the river plan: its output, for fixed plans and streams, must not move when the
// grown-town engine is reorganised around it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { Rng } from "../src/core/rng";
import { generate } from "../src/town-gen";
import type { BuildingUse } from "../src/modules/uses";
import type { Footprint } from "../src/modules/layout/hamlet";
import { layoutRiver } from "../src/modules/layout/grown";
import type { FarBank } from "../src/core/types";

const CASES: [string, number, "thorp" | "village" | "town" | "city", number, FarBank, "wall" | "none" | "hedge", string][] = [
  ["v1", 800, "thorp", 3, "village", "none", "farmland"], ["v2", 3000, "village", 4, "bridgend", "hedge", "hills"],
  ["v3", 9000, "town", 5, "abbey", "wall", "farmland"], ["v4", 26000, "city", 6, "wharf", "wall", "forest"], ["v5", 4000, "village", 4, "wharf", "wall", "coast"],
];

// The plans are frozen: the generator above the layout may change, the layout must not.
const FIXTURE = new URL("./fixtures/river-guard.json", import.meta.url);
const frozen: Record<string, { fp: Footprint[]; far: number[] }> = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : {};

function footprints(seed: string, pop: number, farBank: FarBank): { fp: Footprint[]; far: number[] } {
  if (frozen[seed]) return frozen[seed];
  const t = generate(seed, { pop, design: { layout: "river", farBank } });
  const s = t.settlement();
  const reg = t.registry<BuildingUse>("buildingUses");
  const fp = s.get<string[]>("plan").map((u) => {
    const row = reg.find(u);
    return { size: row?.size ?? "cottage", site: row?.site, kind: u, ...(row?.plots ? { plots: row.plots } : {}), ...(row?.value ? { value: row.value } : {}), ...(row?.cluster ? { cluster: true } : {}) };
  });
  frozen[seed] = { fp, far: s.get<number[]>("farUses") };
  writeFileSync(FIXTURE, JSON.stringify(frozen));
  return frozen[seed];
}

test.each(CASES)("river layout %s (%i people) is unchanged", (seed, pop, scale, roads, farBank, enclosure, terrain) => {
  const { fp, far } = footprints(seed, pop, farBank);
  const map = layoutRiver(new Rng(`river-guard|${seed}`), fp, { scale, enclosure, roads, terrain: terrain as never, farBank, far, need: 0 });
  expect(createHash("sha256").update(JSON.stringify(map)).digest("hex")).toMatchSnapshot();
}, 300000);
