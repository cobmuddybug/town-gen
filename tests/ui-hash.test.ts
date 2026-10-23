// Everything the UI shows for a handful of towns, hashed, so a speed change can prove it changed
// nothing. Opt-in and slow (about 15s):
//   UIHASH=before.json npx vitest run tests/ui-hash.test.ts   (on the old code)
//   UIHASH=after.json  npx vitest run tests/ui-hash.test.ts   (on the new), then compare the files.
// CASES=g-riv,g-big runs some of them.
import { test } from "vitest";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { generate, defaultModules as modules } from "../src/town-gen";
import { serialize } from "../src/core/save";
import { findHooks } from "../src/modules/sifters";
import { occupancy, whereabouts } from "../src/modules/routines";
import { ordinaryDay } from "../src/modules/civic";
import { renderMap, renderPeople } from "../src/ui/map";
import { glance } from "../src/ui/glance";
import { directory, DIRECTORY_TABS } from "../src/ui/directory";
import { almanac, dayOf, search } from "../src/ui/discover";
import { jobBoard, report, encounter } from "../src/ui/party";
import { stepClock } from "../src/ui/topbar";
import type { Town } from "../src/core/town";
const CASES: [string, number, string | undefined][] = [["g-ham", 60, undefined], ["g-vil", 700, undefined], ["g-rad", 4000, "radial"], ["g-riv", 3000, "river"], ["g-cas", 2500, "castle"], ["g-har", 5000, "harbour"], ["g-big", 12000, undefined]];
test.skipIf(!process.env.UIHASH)("ui hash", () => {
  const res: Record<string, Record<string, string>> = {};
  const only = process.env.CASES?.split(",");
  for (const [seed, pop, layout] of CASES) {
    if (only && !only.includes(seed)) continue;
    const parts: Record<string, string> = {};
    const H = (k: string, v: unknown) => { parts[k] = createHash("sha1").update(JSON.stringify(v) ?? "u").digest("hex").slice(0, 12); };
    const town = generate(seed, { pop, ...(layout ? { design: { layout: layout as never } } : {}) });
    town.clock = { date: ordinaryDay(town), block: "forenoon" };
    town.society();
    H("save", serialize(town));
    H("map", renderMap(town));
    const panelsOf = (t: Town, a: string) => modules.flatMap((m) => m.panels ?? []).filter((p) => p.for === t.get(a).type).map((p) => [p.id, p.rows(t, t.get(a))]);
    const people = town.allEntities().filter((e) => e.type === "person").map((e) => e.address).sort();
    const sample = people.filter((_, i) => i % Math.max(1, Math.floor(people.length / 25)) === 0);
    const blds = town.children(town.root, "building").map((b) => b.address).filter((_, i) => i % 7 === 0).slice(0, 30);
    for (let step = 0; step < 4; step++) {
      const { date, block } = town.clock;
      H(`s${step}:root`, panelsOf(town, town.root));
      H(`s${step}:glance`, glance(town, town.root, date, block as never));
      H(`s${step}:hooks`, findHooks(town));
      H(`s${step}:occ`, [...occupancy(town, date, block as never)]);
      H(`s${step}:ppl`, renderPeople(town, occupancy(town, date, block as never)));
      H(`s${step}:persons`, sample.map((p) => [panelsOf(town, p), glance(town, p, date, block as never), whereabouts(town, p, date, block as never)]));
      H(`s${step}:blds`, blds.map((b) => [panelsOf(town, b), glance(town, b, date, block as never)]));
      H(`s${step}:dir`, DIRECTORY_TABS(town).map((t) => directory(town, t.id, { date, block: block as never, filter: "" } as never)));
      H(`s${step}:alm`, almanac(town, date));
      H(`s${step}:jobs`, jobBoard(town, date));
      H(`s${step}:party`, [report(town, [0, 0], date, block as never), encounter(town, [0, 0], date, block as never, 1)]);
      if (step === 0) H("dayof", sample.slice(0, 5).map((p) => dayOf(town, p, date)));
      if (step === 0) H("search", search(town, "a"));
      const c = stepClock(date, block, step === 2 ? 900 : 3); town.clock = c;
    }
    res[seed] = parts;
  }
  writeFileSync(process.env.UIHASH!, JSON.stringify(res, null, 1));
}, 1800000);
