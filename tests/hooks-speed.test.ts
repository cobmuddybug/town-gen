// The town page finds its hooks on every step of the clock, so finding them must stay quick in a city.
import { describe, expect, test } from "vitest";
import type { Town } from "../src/core/town";
import { centroid, dist, type Poly } from "../src/modules/layout/geom";
import { findHooks, jumpedUp, paidInFull } from "../src/modules/sifters";
import { withEdit } from "../src/core/save";
import { dayOf } from "../src/ui/discover";
import { defaultModules, generate } from "../src/town-gen";

const childrenOf = (town: Town, person: string) =>
  town.edges({ to: person, kind: "kin" }).filter((e) => ["son", "daughter"].includes(e.facts?.rel as string)).map((e) => e.from);

/** The plain way, every pair: what the quick way must agree with. */
function paidInFullSlowly(town: Town): string[][] {
  const out: string[][] = [];
  for (const d of town.edges({ kind: "debtor_of" })) {
    const a = childrenOf(town, d.from), b = childrenOf(town, d.to);
    for (const kind of ["courting", "betrothed"]) for (const c of town.edges({ kind })) {
      const x = [c.from, c.to].find((p) => a.includes(p)), y = [c.from, c.to].find((p) => b.includes(p));
      if (x && y) out.push([d.from, d.to, x, y]);
    }
  }
  return out;
}

function jumpedUpSlowly(town: Town): string[][] {
  const out: string[][] = [];
  const headOf = (h: string) => town.children(h, "person")[0];
  for (const b of town.children(town.root, "building")) for (const h of town.children(b.address, "household")) {
    if (!h.get<string | null>("living.display")) continue;
    const head = headOf(h.address);
    if (!head) continue;
    const rivals = town.edges({ touching: head.address, kind: "rival" }).map((e) => (e.from === head.address ? e.to : e.from));
    const at = centroid(b.get<Poly>("poly"));
    for (const ob of town.children(town.root, "building")) {
      if (ob === b || dist(centroid(ob.get<Poly>("poly")), at) > 70) continue;
      for (const oh of town.children(ob.address, "household")) {
        const o = headOf(oh.address);
        if (o && o.get<string[]>("traits").includes("envious") && !rivals.includes(o.address)) rivals.push(o.address);
      }
    }
    if (rivals.length) out.push([head.address, ...rivals]);
  }
  return out;
}

describe("hooks", () => {
  test.each(["burgh-a", "vill-a", "hook3"])("the quick sifters find exactly what the plain ones do (%s)", (seed) => {
    const t = generate(seed, { pop: seed === "vill-a" ? 900 : 8000 });
    t.society();
    expect(paidInFull.match(t).map((m) => m.involves)).toEqual(paidInFullSlowly(t));
    expect(jumpedUp.match(t).map((m) => m.involves)).toEqual(jumpedUpSlowly(t));
  }, 300000);

  test("a city of 26,000 finds its hooks in a couple of seconds, not eight", () => {
    const t = generate("slow26", { pop: 26000 });
    t.society();
    t.clock = { date: "1203-10-01", block: "afternoon" };
    findHooks(t); // the first time also works out the year's talk, once
    t.clock = { date: "1203-10-01", block: "evening" };
    const t0 = performance.now();
    findHooks(t);
    expect(performance.now() - t0).toBeLessThan(2500);
  }, 300000);

  // Every edit rebuilds the town, and the town page then works out the year's talk and visitors
  // again. Before the speed pass that took three seconds in a city; now it is well under one.
  // A wall-clock budget: shared CI runners are two or three times slower than a desk, so it runs locally only.
  test.skipIf(!!process.env.CI)("after an edit, a city's town page and a day followed come back quickly", () => {
    const t = generate("slow26-edit", { pop: 26000 });
    t.society();
    t.clock = { date: "1203-10-01", block: "afternoon" };
    const person = t.allEntities().filter((e) => e.type === "person")[100].address;
    const e = withEdit(t, defaultModules, person, "name", "Bob");
    e.society();
    e.clock = t.clock;
    let t0 = performance.now();
    for (const p of defaultModules.flatMap((m) => m.panels ?? []).filter((p) => p.for === "settlement")) p.rows(e, e.settlement());
    findHooks(e);
    expect(performance.now() - t0).toBeLessThan(1500);
    t0 = performance.now();
    dayOf(e, person, e.clock.date);
    expect(performance.now() - t0).toBeLessThan(1200);
  }, 300000);
});
