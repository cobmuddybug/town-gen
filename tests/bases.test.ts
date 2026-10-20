import { describe, expect, test } from "vitest";
import { generate } from "../src/town-gen";
import type { Base } from "../src/modules/core";
import type { MapData } from "../src/modules/layout";
import { occupancy } from "../src/modules/routines";
import { visitsIn, visitorsOn } from "../src/modules/visitors";
import { findHooks } from "../src/modules/sifters";
import { jdn, parseDate } from "../src/core/calendar";

const BASES = ["agricultural", "fishing", "herding", "mining", "woodcutting"];

describe("economic bases", () => {
  for (const base of BASES) {
    test(`${base}: core buildings, terrain, council and hooks`, () => {
      for (const seed of ["x1", "x2", "x3"]) {
        const t = generate(`${base}-${seed}`, { base, pop: 220 });
        const b = t.registry<Base>("bases").get(base);
        const uses = t.children(t.root, "building").map((x) => x.get<string>("use"));
        for (const u of b.core) if (u !== "place_of_worship") expect(uses, `${seed} ${u}`).toContain(u);
        expect(uses).toContain(Object.keys(b.fill)[0]);
        expect(t.children(t.root, "building").length).toBe(t.settlement().get<string[]>("plan").length);
        expect(t.settlement().get<MapData>("map").terrain).toBe(b.terrain);
        const c = t.get(`${t.root}/institution:council`);
        expect(c.get<{ why: string }[]>("seats").some((s) => s.why.includes(b.stake === "acres" ? "land" : b.stake))).toBe(true);
        expect(b.richest).toContain(t.settlement().get("richestTrade"));
        t.society();
        const n = t.allEntities().filter((e) => e.type === "person").length;
        expect(n).toBeGreaterThan(160);
        expect(n).toBeLessThan(290);
        findHooks(t);
      }
    });
  }

  test("terrain features turn up where they belong", () => {
    const has = (base: string, kind: string) => generate(`feat-${base}`, { base }).settlement().get<MapData>("map").features.some((f) => f.kind === kind);
    expect(has("fishing", "boat")).toBe(true);
    expect(has("herding", "fold")).toBe(true);
    expect(has("mining", "adit")).toBe(true);
    expect(has("woodcutting", "clamp")).toBe(true);
    expect(generate("feat-fishing", { base: "fishing" }).settlement().get<MapData>("map").sea).toBeDefined();
  });

  test("on a fishing working day, the boats are out", () => {
    const t = generate("fish-1", { base: "fishing" });
    const occ = occupancy(t, "1203-07-15", "forenoon"); // a Tuesday
    expect(occ.get("place:sea")?.length ?? 0).toBeGreaterThan(10);
  });

  test("miners are down the mine and woodcutters in the woods", () => {
    expect(occupancy(generate("m1", { base: "mining" }), "1203-07-15", "forenoon").get("place:mine")?.length ?? 0).toBeGreaterThan(10);
    expect(occupancy(generate("w1", { base: "woodcutting" }), "1203-07-15", "forenoon").get("place:woods")?.length ?? 0).toBeGreaterThan(10);
  });

  test("the plan for a farming hamlet still has a mill and no sea", () => {
    const t = generate("farm-check");
    expect(t.children(t.root, "building").map((b) => b.get("use"))).toContain("mill");
    expect(t.settlement().get<MapData>("map").sea).toBeUndefined();
  });
});

describe("visitors", () => {
  const t = generate("visitors-1");

  test("visits are a pure function of town and year", () => {
    expect(JSON.stringify(visitsIn(generate("visitors-1"), 1210))).toBe(JSON.stringify(visitsIn(t, 1210)));
  });

  test("the tax collector comes once or twice a year, every year", () => {
    for (let y = 1200; y < 1220; y++) {
      const n = visitsIn(t, y).filter((v) => v.kind === "tax").length;
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(2);
    }
  });

  test("the same band comes back within five years only when flagged", () => {
    for (const seed of ["v1", "v2", "v3", "v4"]) {
      const town = generate(seed);
      const last = new Map<string, number>();
      for (let y = 1150; y < 1260; y++) {
        for (const v of visitsIn(town, y).filter((x) => x.kind === "band")) {
          const prev = last.get(v.who);
          if (prev !== undefined && y - prev < 5) expect(v.tooSoon?.last, `${v.who} ${y}`).toBe(prev);
          else expect(v.tooSoon).toBeUndefined();
          last.set(v.who, y);
        }
      }
    }
  });

  test("thefts always follow a tinker visit", () => {
    for (let y = 1200; y < 1230; y++) {
      const vs = visitsIn(t, y);
      for (const th of vs.filter((v) => v.kind === "thefts")) {
        const tinkers = vs.find((v) => v.kind === "tinkers" && v.start === th.after);
        expect(tinkers).toBeDefined();
        expect(jdn(parseDate(th.start))).toBeGreaterThan(jdn(parseDate(tinkers!.start)));
      }
    }
  });

  test("on fair day, half the hamlet is away", () => {
    const fair = visitsIn(t, 1203).find((v) => v.kind === "fair")!;
    expect(visitorsOn(t, fair.start).some((v) => v.kind === "fair")).toBe(true);
    const occ = occupancy(t, fair.start, "afternoon");
    const away = occ.get("place:fair")?.length ?? 0;
    // Unless it falls on a holy day, when nobody goes.
    expect(away).toBeGreaterThan(20);
  });
});
