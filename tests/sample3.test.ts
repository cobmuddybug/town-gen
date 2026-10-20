import { test } from "vitest";
import { generate } from "../src/town-gen";
import { findHooks } from "../src/modules/sifters";
test.skipIf(!process.env.SAMPLE)("sample manor", () => {
  const counts: Record<string, number> = {};
  for (let i = 0; i < 10; i++) {
    const t = generate(`mh${i}`, { lordship: "manorial" });
    if (i === 0) console.log(t.label(`${t.root}/institution:manor/person:lord`), t.get(`${t.root}/institution:manor`).get("lordKind"));
    for (const h of findHooks(t)) {
      counts[h.sifter] = (counts[h.sifter] ?? 0) + 1;
      if (["bought-freedom", "leaving-the-land", "socman-squeeze", "skimming-the-chain"].includes(h.sifter) && counts[h.sifter] <= 2) console.log(`[${h.title}] ${h.summary}`);
    }
  }
  console.log(counts);
});
