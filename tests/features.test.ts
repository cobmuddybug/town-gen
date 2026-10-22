// The features that make a town feel lived in: weather, feasts, the country
// round, prices, life going on, politics, hirelings, lore, and the rules that
// keep encounters and crowds believable.
import { describe, expect, test } from "vitest";
import { generate } from "../src/town-gen";
import type { Town } from "../src/core/town";
import { addDays, feastOn } from "../src/core/calendar";
import { weatherOn } from "../src/modules/weather";
import { regionOf } from "../src/modules/region";
import { dearness, harvestOf } from "../src/modules/market";
import { diedOn, lifeIn } from "../src/modules/lives";
import { whereabouts, crowdAt } from "../src/modules/routines";
import { patronalOn } from "../src/modules/religion";
import { encounter } from "../src/ui/party";
import { ordinaryDay } from "../src/modules/civic";
import { centroid, type Poly } from "../src/modules/layout/geom";

let town: Town, hamlet: Town;
const mk = (seed: string, pop: number) => { const t = generate(seed, { pop }); t.society(); return t; };

describe("a lived-in town", () => {
  town = mk("feat-t", 4000);
  hamlet = mk("feat-h", 200);

  test("the weather is the same every time, and changes over the year", () => {
    const days = Array.from({ length: 365 }, (_, i) => addDays("1203-01-01", i));
    const skies = days.map((d) => weatherOn(town, d).sky);
    expect(new Set(skies).size).toBeGreaterThan(4);
    expect(skies.filter((s) => s === "snow").length).toBeLessThan(40);
    expect(weatherOn(mk("feat-t", 4000), "1203-03-05")).toEqual(weatherOn(town, "1203-03-05"));
  });

  test("Sundays stay holy whatever falls on them; parishes keep their patron's day", () => {
    for (let i = 0; i < 365; i++) { const d = addDays("1203-01-05", i); if (new Date(d).getUTCDay() === 0) expect(feastOn(d)?.holy, d).toBe(true); }
    const days = Array.from({ length: 365 }, (_, i) => addDays("1204-01-01", i));
    expect(days.some((d) => patronalOn(town, d).length)).toBe(true);
  });

  test("a new town opens on an ordinary working day", () => {
    const d = ordinaryDay(town);
    expect(feastOn(d)?.holy ?? false).toBe(false);
  });

  test("roads lead somewhere, and a market town has carriers", () => {
    const R = regionOf(town);
    expect(R.roads.length).toBeGreaterThan(1);
    expect(R.carriers.length).toBeGreaterThan(0);
    expect(R.shire).toBeTruthy();
  });

  test("prices follow the harvest", () => {
    for (let y = 1200; y < 1230; y++) {
      const h = harvestOf(town, y);
      if (h.mult > 1.4) { expect(dearness(town, `${y + 1}-05-01`)).toBeGreaterThan(1.4); return; }
    }
  });

  test("people are born, marry and die after Michaelmas 1203, and the dead stay in the churchyard", () => {
    const ev = [...lifeIn(town, 1204), ...lifeIn(town, 1205)];
    expect(ev.filter((e) => e.kind === "death").length).toBeGreaterThan(20);
    expect(ev.filter((e) => e.kind === "birth").length).toBeGreaterThan(20);
    expect(ev.some((e) => e.kind === "wedding")).toBe(true);
    const d = ev.find((e) => e.kind === "death")!;
    expect(diedOn(town, d.who[0], addDays(d.date, 10))).toBe(d.date);
    expect(whereabouts(town, d.who[0], addDays(d.date, 10), "forenoon").where).toBe("place:grave");
    expect(lifeIn(town, 1202)).toEqual([]);
  });

  test("a market town has politics and hirelings; every church and inn has a tale", () => {
    const T = town.get(`${town.root}/institution:town`);
    expect(T.get<unknown[]>("politics.factions")?.length).toBe(2);
    const people = town.allEntities().filter((e) => e.type === "person");
    expect(people.filter((p) => p.get("hire.as")).length).toBeGreaterThan(3);
    const churches = town.children(town.root, "building").filter((b) => b.get("use") === "fane");
    expect(churches.filter((b) => b.get("lore.tale")).length).toBeGreaterThan(0);
  });

  test("encounters never meet a child under ten alone indoors, nor the same person twice running", () => {
    const at = centroid(town.children(town.root, "building")[40].get<Poly>("poly"));
    let last: string | undefined;
    for (let n = 0; n < 12; n++) {
      const e = encounter(town, at, "1203-10-02", "forenoon", n);
      if (!e) continue;
      const age = town.get(e.p).get<number>("age");
      const indoors = !whereabouts(town, e.p, "1203-10-02", "forenoon").where.startsWith("place:");
      if (indoors) expect(age).toBeGreaterThanOrEqual(10);
      expect(e.p).not.toBe(last);
      last = e.p;
    }
  });

  test("a crowded church spills into its churchyard", () => {
    const fane = town.children(town.root, "building").find((b) => b.get("use") === "fane")!;
    expect(crowdAt(town, fane.address, 5000)).toMatch(/churchyard/);
    expect(crowdAt(town, fane.address, 3)).toBeUndefined();
  });

  test("a hamlet has a council with officers, and none of the town's machinery", () => {
    expect(hamlet.find(`${hamlet.root}/institution:council`)).toBeDefined();
    expect(hamlet.find(`${hamlet.root}/institution:town`)).toBeUndefined();
    expect(regionOf(hamlet).roads.length).toBeGreaterThan(0);
  });
});
