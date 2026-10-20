import { test } from "vitest";
import { generate } from "../src/town-gen";
import { findHooks } from "../src/modules/sifters";
test.skipIf(!process.env.SAMPLE)("sample bases", () => {
  const counts: Record<string, number> = {};
  for (const base of ["fishing", "herding", "mining", "woodcutting"]) for (let i = 0; i < 6; i++) {
    const t = generate(`q${i}`, { base });
    t.clock = { date: ["1203-03-10", "1203-06-20", "1203-08-02", "1203-11-15", "1204-01-20", "1203-05-05"][i], block: "forenoon" };
    const hs = findHooks(t);
    for (const h of hs) { counts[h.sifter] = (counts[h.sifter] ?? 0) + 1; if (i < 2 || !["owed-on-the-bench", "jumped-up", "bread-money"].includes(h.sifter)) if (counts[h.sifter] <= 2) console.log(`${base} [${h.title}] ${h.summary}`); }
  }
  console.log(counts);
});
