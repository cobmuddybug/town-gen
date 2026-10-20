import { describe, expect, test } from "vitest";
import { generate } from "../src/town-gen";
import { load, serialize } from "../src/core/save";
import { defaultModules } from "../src/town-gen";
import { occupancy, whereabouts } from "../src/modules/routines";
import { visitsIn } from "../src/modules/visitors";
import { findHooks } from "../src/modules/sifters";
import type { MapData } from "../src/modules/layout";
import { weekday } from "../src/core/calendar";

const manorial = (seed: string, base = "agricultural") => generate(seed, { lordship: "manorial", base });

describe("manorial village", () => {
  test("has a manor house, a manor with its chain of officers, and demesne strips", () => {
    for (const seed of ["m1", "m2", "m3", "m4"]) {
      const t = manorial(seed);
      expect(t.children(t.root, "building").map((b) => b.get("use"))).toContain("manor_house");
      const m = t.get(`${t.root}/institution:manor`);
      const officers = t.children(m.address, "person").map((p) => p.get("occupation"));
      expect(officers).toEqual(expect.arrayContaining(["lord", "steward", "regarder", "bailiff"]));
      const reeve = m.get<string>("reeve");
      expect(t.get(t.parentOf(reeve)!).get("manor.status")).toBe("villein");
      // reeve -> bailiff -> regarder -> steward -> lord
      expect(t.edges({ kind: "answers_to" })).toHaveLength(4);
      expect(t.settlement().get<MapData>("map").fields.some((f) => f.demesne)).toBe(true);
    }
  });

  test("a free hamlet with the same seed has none of it", () => {
    const t = generate("m1");
    expect(t.find(`${t.root}/institution:manor`)).toBeUndefined();
    expect(t.settlement().get<MapData>("map").fields.some((f) => f.demesne)).toBe(false);
    expect(t.toSave().town.config).not.toHaveProperty("lordship");
  });

  test("most farming households are villeins, and freed ones pay rent", () => {
    const t = manorial("m5");
    t.society();
    const statuses = t.allEntities().filter((e) => e.type === "household").map((h) => h.get<string>("manor.status"));
    expect(statuses.filter((s) => s === "villein" || s === "cottar").length / statuses.length).toBeGreaterThan(0.45);
    for (const e of t.edges({ kind: "tenant_of" })) {
      const hh = t.get(t.parentOf(e.from)!);
      if (hh.get("manor.status") === "commuted") expect(hh.get<number>("manor.rent")).toBeGreaterThan(0);
    }
  });

  test("villeins do their week-work on their day", () => {
    const t = manorial("m6");
    t.society();
    const villein = t.allEntities().find((e) => e.type === "household" && e.get("manor.status") === "villein" && e.get("occupation") !== "socman")!;
    const head = t.children(villein.address, "person")[0];
    const day = villein.get<number>("manor.labourDay");
    const dates = ["1203-05-12", "1203-05-13", "1203-05-14", "1203-05-15", "1203-05-16", "1203-05-17", "1203-05-18"];
    const workday = dates.find((d) => weekday(d) === day)!;
    if (head.get("sex") === "m" && head.get<number>("age") >= 14) {
      expect(whereabouts(t, head.address, workday, "forenoon").where).toBe("place:demesne");
    }
    expect(occupancy(t, workday, "forenoon").get("place:demesne")?.length ?? 0).toBeGreaterThan(0);
  });

  test("the bailiff visits every few weeks and the court sits twice a year", () => {
    const t = manorial("m7");
    const vs = visitsIn(t, 1204);
    expect(vs.filter((v) => v.kind === "bailiff").length).toBeGreaterThanOrEqual(14);
    expect(vs.filter((v) => v.kind === "manor_court")).toHaveLength(2);
    const court = vs.find((v) => v.kind === "manor_court")!;
    const occ = occupancy(t, court.start, "forenoon");
    const hall = t.children(t.root, "building").find((b) => b.get("use") === "manor_house")!.address;
    expect(occ.get(hall)!.length).toBeGreaterThan(10);
  });

  test("saves round-trip and are deterministic", () => {
    const t = manorial("m8", "herding");
    const back = load(JSON.parse(serialize(t)), defaultModules);
    expect(JSON.stringify(back.snapshot())).toBe(JSON.stringify(t.snapshot()));
  });

  test("manorial hooks turn up", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) for (const h of findHooks(manorial(`mh${i}`))) seen.add(h.sifter);
    for (const id of ["bought-freedom", "leaving-the-land", "socman-squeeze", "skimming-the-chain"]) expect([...seen]).toContain(id);
  });
});
