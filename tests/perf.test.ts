import { expect, test } from "vitest";
import { generate } from "../src/town-gen";
test.skipIf(!process.env.PERF)("perf", () => {
  for (const pop of [200, 600, 2000, 8000, 20000]) {
    let t0 = performance.now();
    const t = generate("perf", { pop });
    const a = performance.now() - t0; t0 = performance.now();
    t.resolveAll();
    t.society();
    console.log(pop, "layout", a.toFixed(0), "ms; resolve + society", (performance.now() - t0).toFixed(0), "ms");
  }
});
import { occupancy } from "../src/modules/routines";
test.skipIf(!process.env.PERF)("perf occupancy", () => {
  for (const pop of [200, 600, 8000]) {
    const t = generate("perf", { pop });
    t.society();
    const t0 = performance.now();
    occupancy(t, "1203-05-14", "evening");
    console.log(pop, "occupancy", (performance.now() - t0).toFixed(0), "ms");
  }
});

test.skipIf(!process.env.PERF)("perf: a river town lays out within twice the radial time", () => {
  // Fresh seeds every time: the layout is cached by seed, and a cache hit times nothing.
  const time = (seed: string, layout: "radial" | "river") => {
    const t0 = performance.now();
    generate(seed, { pop: 30000, design: { layout } }).settlement().get("map");
    return performance.now() - t0;
  };
  time("perf-warm-a", "radial"); time("perf-warm-b", "river");
  // Both plans retry roomier on some seeds, so average a few of each.
  const seeds = ["p1", "p2", "p3", "p4"];
  const radial = seeds.reduce((t, s) => t + time(`perf-r-${s}`, "radial"), 0) / seeds.length;
  const river = seeds.reduce((t, s) => t + time(`perf-v-${s}`, "river"), 0) / seeds.length;
  console.log("30000 layout: radial", radial.toFixed(0), "ms; river", river.toFixed(0), "ms");
  expect(river).toBeLessThanOrEqual(radial * 2);
}, 600000);
