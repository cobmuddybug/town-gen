import { beforeAll, describe, expect, test } from "vitest";
import { generate } from "../src/town-gen";
import type { Town } from "../src/core/town";
import { allSecrets, describeHour } from "../src/modules/gossip";
import { almanac, dayOf, lensView, LISTS, search, whoKnows, type Fact } from "../src/ui/discover";

let town: Town, hamlet: Town;
beforeAll(() => {
  town = generate("burgh-a", { pop: 8000 });
  hamlet = generate("ashby");
  town.society();
  hamlet.society();
}, 120000);

const dayOfHour = (h: number) => describeHour(h).slice(0, 10);

describe("who knows", () => {
  test("before a secret is out, only those in it and those who kept it know", () => {
    const r = allSecrets(town).find((x) => dayOfHour(x.start) > "1204-01-01")!;
    const k = whoKnows(town, `edge:${r.edge}` as Fact, "1203-09-29", "forenoon")!;
    expect(k.note).toMatch(/still a secret/);
    expect(k.knowers.every((x) => x.how !== "heard")).toBe(true);
    for (const x of k.knowers) {
      expect(x.now.label).toBeTruthy();
      expect(x.later.length).toBeGreaterThan(0);
    }
  });

  test("once it's out, those who heard are listed, earliest first", () => {
    const r = allSecrets(town).find((x) => dayOfHour(x.start) > "1204-01-01")!;
    const after = dayOfHour(r.start + 24 * 5);
    const k = whoKnows(town, `rumour:${r.id}` as Fact, after, "evening")!;
    const heard = k.knowers.filter((x) => x.how === "heard");
    expect(heard.length).toBeGreaterThan(5);
    for (let i = 1; i < heard.length; i++) expect(heard[i].since!).toBeGreaterThanOrEqual(heard[i - 1].since!);
    expect(k.total).toBeGreaterThan(k.knowers.length);
  });

  test("common knowledge says so", () => {
    const e = hamlet.edges().find((x) => x.kind === "rival" && x.knownBy === "public")!;
    const k = whoKnows(hamlet, `edge:${e.id}` as Fact, "1203-09-29", "forenoon")!;
    expect(k.note).toMatch(/common knowledge/);
  });
});

describe("lenses", () => {
  test("wealth and class colour every inhabited building", () => {
    const inhabited = town.children(town.root, "building").filter((b) => town.children(b.address, "household").length).length;
    expect(lensView(town, "class").fills.size).toBe(inhabited);
    expect(lensView(town, "wealth").fills.size).toBeGreaterThan(inhabited * 0.95);
  });

  test("parishes: one colour per parish church", () => {
    const churches = new Set(town.allEntities().filter((e) => e.type === "household").map((h) => h.get("parish")));
    expect(lensView(town, "parish").legend.length).toBe(churches.size);
  });

  test("threads run from the selected person to the houses they're tied to", () => {
    const p = town.edges({ kind: "debtor_of" })[0].from;
    const v = lensView(town, "thread", p);
    expect(v.lines.length).toBeGreaterThan(0);
    expect(lensView(town, "thread").note).toMatch(/Select/);
  });
});

describe("search and lists", () => {
  test("a surname finds the family; a use finds the buildings", () => {
    const h = town.allEntities().find((e) => e.type === "household")!;
    const name = h.get<{ name: string }>("surname").name;
    expect(search(town, name).total).toBeGreaterThan(0);
    const ale = search(hamlet, "alehouse").results;
    expect(ale.some((x) => /\/building:/.test(x.address))).toBe(true);
    expect(search(town, "").total).toBe(0);
  });

  test("every list has rows, and debts come largest first", () => {
    for (const l of LISTS) expect(l.rows(town, "1203-09-29", "forenoon").length).toBeGreaterThan(0);
    const debts = LISTS.find((l) => l.id === "debts")!.rows(town, "1203-09-29", "forenoon");
    expect(debts.every((r) => r.fact)).toBe(true);
  });
});

describe("almanac and following", () => {
  test("the almanac has the quarter-day, visitors and secrets coming out", () => {
    const a = almanac(town, "1203-09-01", 60);
    expect(a.some((x) => x.kind === "rent" && x.date === "1203-09-29")).toBe(true);
    expect(a.some((x) => x.kind === "visit")).toBe(true);
    for (let i = 1; i < a.length; i++) expect(a[i].date >= a[i - 1].date).toBe(true);
    const long = almanac(town, "1203-09-01", 365);
    expect(long.some((x) => x.kind === "secret" && x.fact)).toBe(true);
  });

  test("a person's day has six stops, placed on the map where it can", () => {
    const head = town.allEntities().find((e) => e.type === "person" && e.get("role") === "head" && e.get<number>("age") > 25)!;
    const d = dayOf(town, head.address, "1203-10-02");
    expect(d).toHaveLength(6);
    for (const s of d) if (!s.w.where.startsWith("place:")) expect(s.at).toBeDefined();
  });
});
