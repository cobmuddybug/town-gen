import { test } from "vitest";
import { generate } from "../src/town-gen";
import { findHooks } from "../src/modules/sifters";
import { whereabouts, occupancy } from "../src/modules/routines";
import { BLOCKS } from "../src/core/calendar";

test.skipIf(!process.env.SAMPLE)("sample output", () => {
  const counts: Record<string, number> = {};
  for (let i = 0; i < 20; i++) {
    const t = generate(`s${i}`);
    const hs = findHooks(t);
    for (const h of hs) counts[h.sifter] = (counts[h.sifter] ?? 0) + 1;
    if (i < 3) for (const h of hs) console.log(`[${h.title}] ${h.summary}`);
  }
  console.log(counts);
  const t = generate("s0");
  t.resolveAll();
  const ppl = t.allEntities().filter((e) => e.type === "person");
  for (const p of [ppl[0], ppl[1], ppl[5], ppl[9], ppl[20]]) {
    console.log(t.label(p.address), p.get("age"), p.get("history"));
    for (const b of BLOCKS) { const w = whereabouts(t, p.address, "1203-08-14", b); console.log("  ", b, w.label, "-", w.doing); }
  }
  const occ = occupancy(t, "1203-08-14", "evening");
  console.log([...occ].map(([k, v]) => `${t.find(k) ? t.label(k) : k}: ${v.length}`).join("; "));
  console.log(t.edges().reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {} as Record<string, number>));
});
