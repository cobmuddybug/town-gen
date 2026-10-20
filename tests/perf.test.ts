import { test } from "vitest";
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
