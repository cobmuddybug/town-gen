import { describe, expect, test } from "vitest";
import { addDays, describeDate, easter, feastOn, weekday } from "../src/core/calendar";
import { BLOCKS } from "../src/core/calendar";
import { occupancy, whereabouts } from "../src/modules/routines";
import { generate } from "../src/town-gen";
import type { Tier } from "../src/modules/core";

describe("calendar", () => {
  test("weekdays and day arithmetic", () => {
    expect(weekday("2026-10-20")).toBe(2); // a Tuesday
    expect(weekday("2000-01-01")).toBe(6); // a Saturday
    expect(addDays("1203-12-31", 1)).toBe("1204-01-01");
    expect(addDays("1204-03-01", -1)).toBe("1204-02-29");
  });
  test("Easter and the feasts that hang off it", () => {
    expect(easter(2024)).toBe("2024-03-31");
    expect(easter(2025)).toBe("2025-04-20");
    expect(feastOn("2024-03-31")?.name).toBe("Easter Day");
    expect(feastOn(addDays("2024-03-31", 49))?.name).toBe("Whitsunday");
    expect(feastOn("1203-09-29")?.quarter).toBe(true);
    expect(feastOn("2026-10-20")).toBeUndefined();
    expect(describeDate("1203-12-25")).toMatch(/Christmas/);
  });
});

describe("society", () => {
  const t = generate("society-1");
  t.society();
  const tiers = t.registry<Tier>("tiers");
  const rank = (person: string) => tiers.get(t.get(t.parentOf(person)!).get("tier")).rank;

  test("every edge points at an entity that exists", () => {
    for (const e of t.edges()) {
      expect(t.find(e.from), e.id).toBeDefined();
      expect(t.find(e.to), e.id).toBeDefined();
    }
  });

  test("no one courts their own kin or household", () => {
    for (const e of [...t.edges({ kind: "courting" }), ...t.edges({ kind: "betrothed" })]) {
      expect(t.parentOf(e.from)).not.toBe(t.parentOf(e.to));
      expect(t.edges({ kind: "kin" }).some((k) => (k.from === e.from && k.to === e.to) || (k.from === e.to && k.to === e.from))).toBe(false);
    }
  });

  test("money is lent downhill (except the ale slate)", () => {
    for (const d of t.edges({ kind: "debtor_of" })) {
      if (d.facts?.reason === "the ale slate") continue;
      expect(rank(d.to)).toBeGreaterThanOrEqual(rank(d.from));
    }
  });

  test("a daughter's maiden name matches her father's family", () => {
    for (const k of t.edges({ kind: "kin" })) {
      if (k.facts?.rel !== "daughter" || t.get(k.from).get("role") !== "spouse") continue;
      const fatherHh = t.get(t.parentOf(k.to)!);
      expect(t.get(k.from).get("birthname")).toBe(fatherHh.get<{ name: string }>("surname").name);
    }
  });

  test("the society phase doesn't care what was looked at first", () => {
    const a = generate("society-2");
    a.society();
    const b = generate("society-2");
    const last = b.children(b.root, "building").at(-1)!;
    b.children(b.children(last.address, "household")[0]?.address ?? last.address, "person").forEach((p) => p.get("history"));
    expect(JSON.stringify(b.edges())).toBe(JSON.stringify(a.edges()));
  });
});

describe("routines", () => {
  const t = generate("routine-1");
  test("everyone is somewhere, every block", () => {
    t.resolveAll();
    const n = t.allEntities().filter((e) => e.type === "person").length;
    for (const b of BLOCKS) {
      const occ = occupancy(t, "1203-05-14", b);
      expect([...occ.values()].reduce((s, v) => s + v.length, 0)).toBe(n);
    }
  });
  test("whereabouts are a pure function of person, date and block", () => {
    const p = t.allEntities().find((e) => e.type === "person" && e.get<number>("age") > 20)!;
    const a = whereabouts(t, p.address, "1203-05-14", "afternoon");
    expect(whereabouts(generate("routine-1"), p.address, "1203-05-14", "afternoon")).toEqual(a);
  });
  test("on a Sunday forenoon most people are at the chapel", () => {
    const sunday = ["1203-05-11", "1203-05-12", "1203-05-13", "1203-05-14", "1203-05-15", "1203-05-16", "1203-05-17"].find((d) => weekday(d) === 0)!;
    const chapel = t.children(t.root, "building").find((b) => b.get("use") === "chapel")!.address;
    const occ = occupancy(t, sunday, "forenoon");
    const total = [...occ.values()].reduce((s, v) => s + v.length, 0);
    expect(occ.get(chapel)!.length / total).toBeGreaterThan(0.7);
  });
  test("at night nearly everyone is home", () => {
    const occ = occupancy(t, "1203-05-14", "late_night");
    const away = (occ.get("place:fields")?.length ?? 0) + (occ.get("place:green")?.length ?? 0);
    expect(away).toBe(0);
  });
});
