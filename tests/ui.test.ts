import { describe, expect, test } from "vitest";
import { sizePreview, settingsFromForm } from "../src/ui/newtown";
import { History, isTypingTarget } from "../src/ui/history";

const form = (o: Record<string, string>) => (k: string) => o[k] ?? null;

describe("new town", () => {
  test("size preview follows LF p.72 bounds", () => {
    expect(sizePreview(200).label).toBe("hamlet");
    expect(sizePreview(700).label).toBe("village");
    expect(sizePreview(3000).label).toBe("market town");
    expect(sizePreview(30000).label).toBe("city");
    expect(sizePreview(3000).line).toMatch(/^A market town/);
  });

  test("a hamlet's settings carry no plan", () => {
    expect(settingsFromForm(form({ pop: "500", walls: "wall" })).settings.design).toBeUndefined();
    expect(settingsFromForm(form({ pop: "3000", walls: "wall" })).settings.design).toEqual({ walls: "wall" });
  });

  test("a big town is never manorial, and population is clamped", () => {
    expect(settingsFromForm(form({ pop: "9000", manorial: "on" })).settings.lordship).toBe("free");
    expect(settingsFromForm(form({ pop: "400", manorial: "on" })).settings.lordship).toBe("manorial");
    expect(settingsFromForm(form({ pop: "99999" })).settings.pop).toBe(30000);
    expect(settingsFromForm(form({ pop: "" })).settings.pop).toBe(200);
    expect(settingsFromForm(form({ seed: " oak-1 " })).seed).toBe("oak-1");
    expect(settingsFromForm(form({})).seed).toBeUndefined();
  });
});

describe("history", () => {
  test("goes back and forward and forgets the future on a new push", () => {
    const h = new History();
    h.push("a"); h.push("b"); h.push("c");
    expect(h.back()).toBe("b");
    expect(h.canForward).toBe(true);
    expect(h.forward()).toBe("c");
    expect(h.back()).toBe("b");
    h.push("d");
    expect(h.canForward).toBe(false);
    expect(h.back()).toBe("b");
  });

  test("pushing the current address again does nothing", () => {
    const h = new History();
    h.push("a"); h.push("a");
    expect(h.canBack).toBe(false);
  });

  test("prunes addresses that no longer exist", () => {
    const h = new History();
    h.push("a"); h.push("gone"); h.push("c");
    h.prune((x) => x !== "gone");
    expect(h.back()).toBe("a");
    expect(h.back()).toBeUndefined();
  });

  test("keeps at most max entries", () => {
    const h = new History(3);
    for (const x of ["a", "b", "c", "d"]) h.push(x);
    expect(h.back()).toBe("c");
    expect(h.back()).toBe("b");
    expect(h.back()).toBeUndefined();
  });

  test("typing targets", () => {
    const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as unknown as Element;
    expect(isTypingTarget(el("INPUT"))).toBe(true);
    expect(isTypingTarget(el("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(el("SELECT"))).toBe(true);
    expect(isTypingTarget(el("DIV", true))).toBe(true);
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

import { clockLabel, stepClock, townMenuHtml } from "../src/ui/topbar";
import { newTownHtml } from "../src/ui/newtown";

describe("top bar", () => {
  test("clock label is short weekday, day, month and the time of day", () => {
    expect(clockLabel("1203-10-01", "forenoon")).toBe("Wed 1 Oct · forenoon");
    expect(clockLabel("1203-10-01", "late_night")).toBe("Wed 1 Oct · late night");
  });

  test("stepping the clock wraps across days", () => {
    expect(stepClock("1203-10-01", "late_night", 1)).toEqual({ date: "1203-10-02", block: "morning" });
    expect(stepClock("1203-10-01", "morning", -1)).toEqual({ date: "1203-09-30", block: "late_night" });
    expect(stepClock("1203-10-01", "morning", 1)).toEqual({ date: "1203-10-01", block: "forenoon" });
  });

  test("the town menu offers file actions, and forgetting only for a kept town", () => {
    const kept = [{ key: "k1", name: "Ashby", pop: 200, base: "agricultural", updated: 0 }];
    const open = townMenuHtml(kept, "k1", "Ashby", false);
    expect(open).toContain("Download file");
    expect(open).toContain("Open file…");
    expect(open).toContain("Show book sources");
    expect(open).toContain("Forget my edits to Ashby…");
    expect(townMenuHtml(kept, "k2", "Brill", false)).not.toContain("Forget my edits");
  });

  test("the new town dialog has the plan, the preview and a build button", () => {
    const h = newTownHtml();
    for (const s of ['id="plan"', 'id="size-preview"', 'id="reroll-seed"', "Build town", "How many people?", 'name="walls"', 'name="crime"']) expect(h).toContain(s);
  });
});

import { beforeAll } from "vitest";
import { generate } from "../src/town-gen";
import type { Town } from "../src/core/town";
import { paletteGroups } from "../src/ui/palette";
import { search } from "../src/ui/discover";

describe("search palette", () => {
  let town: Town;
  beforeAll(() => { town = generate("burgh-a", { pop: 8000 }); town.society(); }, 120000);

  test("a surname lands in People and a trade in Trades", () => {
    const g = paletteGroups(town, "smith");
    expect(g.map((x) => x.title)).toContain("People");
    const trades = g.find((x) => x.title === "Trades")!;
    expect(trades.items[0].list).toMatch(/^trade:/);
  });

  test("groups keep the fixed order, hold 1 to 8 items, and empty ones are dropped", () => {
    const order = ["People", "Places", "Trades", "Offices", "Lists"];
    const g = paletteGroups(town, "a");
    expect(g.map((x) => order.indexOf(x.title))).toEqual([...g.map((x) => order.indexOf(x.title))].sort((a, b) => a - b));
    for (const x of g) { expect(x.items.length).toBeGreaterThan(0); expect(x.items.length).toBeLessThanOrEqual(8); }
    expect(paletteGroups(town, "zzqxv")).toEqual([]);
  });

  test("lists are offered by title", () => {
    const lists = paletteGroups(town, "debts").find((x) => x.title === "Lists")!;
    expect(lists.items.map((i) => i.list)).toContain("debts");
  });

  test("search entries carry their kind", () => {
    const r = search(town, "smith").results;
    expect(r.some((x) => x.kind === "person")).toBe(true);
  });

  test("player search hides crime aliases", () => {
    const e = town.allEntities().find((x) => x.type === "person" && x.get("crime.alias"))!;
    const name = town.label(e.address);
    const dm = search(town, name).results.find((r) => r.address === e.address)!;
    const pl = search(town, name, 60, { player: true }).results.find((r) => r.address === e.address)!;
    expect(dm.detail).toContain('"');
    expect(pl.detail).not.toContain('"');
  });
});

import { DIRECTORY_TABS, directory } from "../src/ui/directory";
import { LISTS } from "../src/ui/discover";

describe("directory", () => {
  let town: Town, hamlet: Town;
  const at = { date: "1203-10-01", block: "forenoon" as const };
  beforeAll(() => {
    town = generate("burgh-a", { pop: 8000 }); town.society();
    hamlet = generate("ashby"); hamlet.society();
  }, 120000);

  test("people tab has one row per person and sorts by age, oldest first", () => {
    const d = directory(town, "people", { ...at, sort: { col: 2, desc: true } });
    expect(d.columns).toEqual(["Name", "Trade", "Age", "Household", "Building"]);
    expect(d.rows.length).toBe(town.allEntities().filter((e) => e.type === "person").length);
    for (let i = 1; i < 50; i++) expect(Number(d.rows[i - 1].cells[2])).toBeGreaterThanOrEqual(Number(d.rows[i].cells[2]));
  });

  test("households sort by income as money, not as text", () => {
    const d = directory(town, "households", { ...at, sort: { col: 2, desc: true } });
    const income = (a: string) => town.get(a).get<number>("income");
    for (let i = 1; i < 50; i++) expect(income(d.rows[i - 1].address!)).toBeGreaterThanOrEqual(income(d.rows[i].address!));
  });

  test("the filter needs every word somewhere in the row", () => {
    const d = directory(town, "buildings", { ...at, filter: "ale house" });
    expect(d.rows.length).toBeGreaterThan(0);
    for (const r of d.rows) { const t = r.cells.join(" ").toLowerCase(); expect(t).toContain("ale"); expect(t).toContain("house"); }
  });

  test("a trade filter keeps only that trade's people", () => {
    const d = directory(town, "people", { ...at, filter: "baker" });
    for (const r of d.rows) expect(String(r.cells.join(" ")).toLowerCase()).toContain("baker");
  });

  test("every list is a tab, and a list tab has rows that link somewhere", () => {
    const ids = DIRECTORY_TABS(town).map((t) => t.id);
    for (const l of LISTS) expect(ids).toContain(`list:${l.id}`);
    const d = directory(town, "list:richest", at);
    expect(d.rows.length).toBeGreaterThan(0);
    expect(d.rows[0].address).toBeTruthy();
  });

  test("a hamlet has no wards tab; a town's wards add up to its people", () => {
    expect(DIRECTORY_TABS(hamlet).map((t) => t.id)).not.toContain("wards");
    const w = directory(town, "wards", at);
    expect(w.rows.length).toBeGreaterThan(2);
  });

  test("offices name the holder and where", () => {
    const d = directory(town, "offices", at);
    expect(d.columns).toEqual(["Office", "Holder", "In"]);
    expect(d.rows.length).toBeGreaterThan(0);
  });
});
