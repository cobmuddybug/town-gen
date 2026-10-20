// Writes preview SVGs for a few seeds: npx vitest run tools/preview.test.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { test } from "vitest";
import { generate } from "../src/town-gen";
import { renderMap } from "../src/ui/map";

test.skipIf(!process.env.PREVIEW_DIR)("preview", () => {
  const dir = process.env.PREVIEW_DIR!;
  mkdirSync(dir, { recursive: true });
  for (const seed of (process.env.SEEDS ?? "ashby,b,c").split(",")) {
    const pop = Number(process.env.POP ?? 200);
    const base = process.env.BASE ?? "agricultural";
    const t = generate(seed, { pop, base });
    writeFileSync(`${dir}/${base}-${seed}-${pop}.svg`, renderMap(t, { width: 1400 }));
    writeFileSync(`${dir}/${base}-${seed}-${pop}-village.svg`, renderMap(t, { width: 1400, village: true }));
  }
});
