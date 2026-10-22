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
  // Both plans retry roomier on some seeds, so take a few. Each pair runs back to back, so a burst of
  // load elsewhere lands on both halves of a pair, and the median pair ignores the odd one it doesn't.
  const ratios = ["p1", "p2", "p3", "p4", "p5"].map((s) => {
    const radial = time(`perf-r-${s}`, "radial"), river = time(`perf-v-${s}`, "river");
    console.log("30000 layout", s, ": radial", radial.toFixed(0), "ms; river", river.toFixed(0), "ms");
    return river / radial;
  }).sort((x, y) => x - y);
  expect(ratios[2]).toBeLessThanOrEqual(2);
}, 600000);
