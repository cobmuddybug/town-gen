import { beforeAll, describe, expect, test } from "vitest";
import { generate } from "../src/town-gen";
import { formatDate, fromJdn } from "../src/core/calendar";
import type { Town } from "../src/core/town";
import { stableStringify } from "../src/core/town";
import { heardAt, hourOf, knownByAt, knows, reach, rumoursIn, spread, talkAt, type Rumour } from "../src/modules/gossip";
import { findHooks } from "../src/modules/sifters";

let town: Town;
beforeAll(() => {
  town = generate("burgh-a", { pop: 8000 });
  town.society();
}, 120000);

const secrets = (t: Town, y: number) => rumoursIn(t, y).filter((r) => r.kind === "secret");

describe("gossip", () => {
  test("rumours are the same whatever order the years are asked in", () => {
    const a = generate("burgh-a", { pop: 8000 });
    const later = rumoursIn(a, 1206).map((r) => r.id);
    const first = rumoursIn(a, 1203).map((r) => r.id);
    expect(rumoursIn(town, 1203).map((r) => r.id)).toEqual(first);
    expect(rumoursIn(town, 1206).map((r) => r.id)).toEqual(later);
    expect(first.length).toBeGreaterThan(10);
  }, 60000);

  test("talk spreads outward, and not at night", () => {
    const r = secrets(town, 1203)[0];
    const sp = [...spread(town, r).values()].map((s) => s.at);
    expect(Math.min(...sp)).toBeGreaterThanOrEqual(r.start);
    // Nobody hears anything between ten at night and five in the morning, unless it started then.
    for (const at of sp) { const h = ((at % 24) + 24) % 24; if (at > r.start + 1e-6) expect(h >= 5 && h <= 22).toBe(true); }
    // A large town hears it all within a couple of days.
    expect(Math.max(...sp) - r.start).toBeLessThan(48);
  });

  test("official news outruns gossip", () => {
    const all = [...rumoursIn(town, 1203), ...rumoursIn(town, 1204)];
    const off = all.find((r) => r.kind === "official")!;
    const sec = all.find((r) => r.kind === "secret")!;
    const span = (r: Rumour) => { const v = [...spread(town, r).values()].map((s) => s.at - r.start); return Math.max(...v); };
    expect(span(off)).toBeLessThan(span(sec));
  });

  test("those who kept the secret knew all along; the ones it's about hear last; children don't count", () => {
    const r = secrets(town, 1203).find((x) => x.lastToKnow.length && x.edge)!;
    const e = town.edges().find((x) => x.id === r.edge)!;
    for (const k of e.knownBy as string[]) expect(heardAt(town, r, k)).toBe(-Infinity);
    const victim = r.lastToKnow.find((p) => !(e.knownBy as string[]).includes(p));
    if (victim) {
      const home = town.parentOf(town.parentOf(victim)!)!;
      expect(heardAt(town, r, victim)!).toBeGreaterThanOrEqual(spread(town, r).get(home)!.at + 70);
    }
    const child = town.allEntities().find((p) => p.type === "person" && p.get<number>("age") < 12)!;
    expect(heardAt(town, r, child.address)).toBeUndefined();
  });

  test("knownBy grows once a secret is out, and becomes public in the end", () => {
    const r = secrets(town, 1204)[0];
    const e = town.edges().find((x) => x.id === r.edge)!;
    const at = (h: number): [string, "forenoon"] => [formatDate(fromJdn(Math.floor(h / 24))), "forenoon"];
    expect(knownByAt(town, e, ...at(r.start - 48))).toEqual(e.knownBy);
    const later = knownByAt(town, e, ...at(r.start + 72));
    expect(Array.isArray(later) && later.length).toBeGreaterThan((e.knownBy as string[]).length);
    expect(knownByAt(town, e, ...at(r.start + 24 * 60))).toBe("public");
  });

  test("by the evening of a busy day there is talk, and tellings differ by distance", () => {
    let found = false;
    for (const date of ["1203-09-29", "1204-03-10", "1205-06-20", "1206-01-15"]) {
      const now = hourOf(date, "evening");
      for (const r of talkAt(town, now)) {
        const { heard, total } = reach(town, r, now);
        expect(heard).toBeLessThanOrEqual(total);
        if (r.kind === "secret" && new Set([...spread(town, r).values()].map((s) => s.telling)).size > 1) found = true;
      }
    }
    expect(found).toBe(true);
  });

  test("gossip stores nothing: moving the clock leaves the town alone", () => {
    const a = generate("ashby");
    const before = stableStringify(a.snapshot());
    a.clock = { date: "1205-06-20", block: "evening" };
    findHooks(a);
    for (const p of a.allEntities().filter((x) => x.type === "person").slice(0, 20)) for (const r of talkAt(a, hourOf("1205-06-20", "evening"))) knows(a, r, p.address, hourOf("1205-06-20", "evening"));
    expect(stableStringify(a.snapshot())).toBe(before);
  });

  test("the people in a rumour are links in the panels", () => {
    const g = town.modules.find((m) => m.id === "gossip")!;
    const panel = (id: string) => g.panels!.find((p) => p.id === id)!;
    let checked = 0;
    for (const date of ["1203-09-29", "1204-03-10", "1205-06-20"]) {
      town.clock = { date, block: "evening" };
      const now = hourOf(date, "evening");
      for (const r of talkAt(town, now).filter((x) => x.about.length)) {
        const who = town.allEntities().find((p) => p.type === "person" && p.address.includes("/building:") && knows(town, r, p.address, now) && heardAt(town, r, p.address) !== -Infinity);
        if (!who) continue;
        const rows = panel("has-heard").rows(town, who);
        const links = rows.flatMap((row) => (Array.isArray(row.value) ? row.value : [row.value])).filter((v) => typeof v === "object");
        expect(links.length).toBeGreaterThan(0);
        for (const l of links as { address: string }[]) expect(town.find(l.address)).toBeDefined();
        checked++;
      }
      const talk = panel("talk-of-the-town").rows(town, town.settlement());
      for (const row of talk) if (row.label === "Rumour" || row.label === "Talk") expect(Array.isArray(row.value) && row.value.some((v) => typeof v === "object")).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
  }, 60000);

  test("people in a story, and those who knew, hear the true telling", () => {
    const g = town.modules.find((m) => m.id === "gossip")!.panels!.find((p) => p.id === "has-heard")!;
    for (const date of ["1203-09-29", "1204-03-10", "1205-06-20"]) {
      town.clock = { date, block: "evening" };
      for (const r of talkAt(town, hourOf(date, "evening"))) for (const a of r.about) {
        const row = g.rows(town, town.get(a)).find((x) => Array.isArray(x.value) && String(x.value[x.value.length - 1]).includes("it's about them"));
        if (!row || !r.wrong) continue;
        expect((row.value as { address?: string }[]).some((v) => v.address === r.wrong)).toBe(false);
      }
    }
  }, 60000);

  test("gossip hooks turn up", () => {
    const seen = new Set<string>();
    for (const date of ["1203-09-29", "1204-03-10", "1205-06-20"]) {
      town.clock = { date, block: "evening" };
      for (const h of findHooks(town)) seen.add(h.sifter);
    }
    expect([...seen].filter((s) => ["last-to-know", "wrong-name", "before-it-gets-out"].includes(s)).length).toBeGreaterThanOrEqual(2);
  }, 60000);
});

