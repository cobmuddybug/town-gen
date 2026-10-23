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

  test("a broad query still offers people, however many places match", () => {
    expect(paletteGroups(town, "a").map((g) => g.title)).toContain("People");
    expect(paletteGroups(town, "a", { player: true }).map((g) => g.title)).toContain("People");
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

import { glance, starsOf } from "../src/ui/glance";
import { defaultModules as modules } from "../src/town-gen";
import { withEvent, withoutEvent } from "../src/core/save";

describe("inspector card and stars", () => {
  let hamlet: Town;
  beforeAll(() => { hamlet = generate("ashby"); hamlet.society(); }, 120000);
  const at = ["1203-10-01", "forenoon"] as const;

  test("a person's card has trade, age, household and where they are now", () => {
    const p = hamlet.allEntities().find((e) => e.type === "person")!;
    const g = glance(hamlet, p.address, ...at);
    expect(g.map((r) => r.label)).toEqual(["Trade", "Age", "Household", "Now"]);
    expect(g[1].value).toEqual([String(p.get("age"))]);
  });

  test("a building's card has its use, households and who is inside", () => {
    const b = hamlet.allEntities().find((e) => e.type === "building" && hamlet.children(e.address, "household").length)!;
    expect(glance(hamlet, b.address, ...at).map((r) => r.label)).toEqual(["Use", "Households", "Inside now"]);
  });

  test("a household's card has its head, trade and income; the town has none", () => {
    const h = hamlet.allEntities().find((e) => e.type === "household")!;
    expect(glance(hamlet, h.address, ...at).map((r) => r.label)).toEqual(["Head", "Trade", "Income"]);
    expect(glance(hamlet, hamlet.root, ...at)).toEqual([]);
  });

  test("a star leaves every panel's rows unchanged, and can be taken back", () => {
    const p = hamlet.allEntities().find((e) => e.type === "person")!.address;
    const rows = (t: Town) => JSON.stringify(modules.flatMap((m) => m.panels ?? []).filter((x) => x.for === "person").map((x) => x.rows(t, t.get(p))));
    const before = rows(hamlet);
    const t2 = withEvent(hamlet, modules, { kind: "star", target: p, text: "Age", date: "1203-10-01" });
    t2.society();
    expect(rows(t2)).toBe(before);
    expect(starsOf(t2, p)).toEqual([{ label: "Age", index: t2.events.length - 1 }]);
    const t3 = withoutEvent(t2, modules, starsOf(t2, p)[0].index);
    expect(starsOf(t3, p)).toEqual([]);
  });
});

import { keyAction } from "../src/ui/history";
import { eventsWithDeed, eventsWithStar, starKey, starredRows } from "../src/ui/glance";
import { load } from "../src/core/save";
import { rumoursIn } from "../src/modules/gossip";

describe("review fixes", () => {
  test("no shortcut but Ctrl+K fires while typing", () => {
    for (const e of [{ key: "ArrowLeft", altKey: true }, { key: "ArrowRight", altKey: true }, { key: "/" }, { key: "[" }, { key: "]" }, { key: "P", shiftKey: true }]) expect(keyAction(e, true)).toBeUndefined();
    expect(keyAction({ key: "k", ctrlKey: true }, true)).toBe("search");
    expect(keyAction({ key: "ArrowLeft", altKey: true }, false)).toBe("back");
    expect(keyAction({ key: "ArrowRight", altKey: true }, false)).toBe("forward");
    expect(keyAction({ key: "/" }, false)).toBe("search");
    expect(keyAction({ key: "]" }, false)).toBe("later");
    expect(keyAction({ key: "[" }, false)).toBe("earlier");
    expect(keyAction({ key: "P", shiftKey: true }, false)).toBe("player");
    expect(keyAction({ key: "p" }, false)).toBeUndefined();
  });

  test("starring and unstarring never changes who the town blames for a deed", () => {
    const base = generate("ashby"); base.society();
    const at = base.children(base.root, "building")[0].address;
    const deed = { kind: "deed", date: "1203-10-01", block: "forenoon", at, text: "broke a window at the mill" };
    const star = { kind: "star", target: at, text: "Use⁣mill", date: "1203-10-01" };
    const tell = (events: typeof base.events) => {
      const t = load({ ...base.toSave(), events }, modules); t.society();
      return rumoursIn(t, 1203).filter((r) => r.topic === "deed").map((r) => `${r.id} ${r.texts[2]}`);
    };
    const plain = tell([deed]);
    expect(plain.length).toBe(1);
    expect(tell(eventsWithDeed(eventsWithStar([], star), deed))).toEqual(plain);
    expect(tell(eventsWithStar([deed], star))).toEqual(plain);
  });

  test("a star picks out one row, not every row with that label", () => {
    const rows = [{ label: "cousin of", value: "Ann" }, { label: "cousin of", value: "Bob" }, { label: "Age", value: 30 }];
    const stars = [{ label: starKey(rows[1]), index: 0 }];
    expect(starredRows(rows, stars)).toEqual([rows[1]]);
    expect(starKey(rows[0])).not.toBe(starKey(rows[1]));
  });

  test("a trade filter keeps exactly that trade's people, not namesakes", () => {
    const town = generate("burgh-a", { pop: 3000 }); town.society();
    const occ = (e: ReturnType<Town["get"]>) => e.get<string | undefined>("occupation") ?? town.get(town.parentOf(e.address)!).get<string>("occupation");
    const people = town.allEntities().filter((e) => e.type === "person");
    const want = people.filter((e) => occ(e) === "smith").length;
    const d = directory(town, "people", { date: "1203-10-01", block: "forenoon", trade: "smith" });
    expect(d.rows.length).toBe(want);
    expect(d.rows.every((r) => occ(town.get(r.address!)) === "smith")).toBe(true);
  });
});

import { designFrom } from "../src/ui/library";
import { renderMap } from "../src/ui/map";

describe("river towns in the UI", () => {
  test("designFrom reads the layout and the far bank, and ignores nonsense", () => {
    const get = (o: Record<string, string>) => (k: string) => o[k] ?? null;
    expect(designFrom(get({ layout: "river", farBank: "abbey" }))).toEqual({ layout: "river", farBank: "abbey" });
    expect(designFrom(get({ layout: "radial" }))).toEqual({ layout: "radial" });
    expect(designFrom(get({ layout: "spiral", farBank: "moon" }))).toBeUndefined();
  });

  test("designFrom drops the choices the dialog hides for the chosen layout", () => {
    const get = (o: Record<string, string>) => (k: string) => o[k] ?? null;
    expect(designFrom(get({ layout: "radial", farBank: "abbey", shape: "oval" }))).toEqual({ layout: "radial", shape: "oval" });
    expect(designFrom(get({ layout: "river", farBank: "abbey", shape: "oval" }))).toEqual({ layout: "river", farBank: "abbey" });
    expect(designFrom(get({ farBank: "abbey", shape: "oval" }))).toEqual({ farBank: "abbey", shape: "oval" });
    // A ridge town has a bridge and a far bank; the other grown forms have neither, nor a shape.
    expect(designFrom(get({ layout: "ridge", farBank: "wharf", shape: "long" }))).toEqual({ layout: "ridge", farBank: "wharf" });
    for (const layout of ["castle", "street", "crossroads", "abbey", "harbour"]) expect(designFrom(get({ layout, farBank: "wharf", shape: "long" }))).toEqual({ layout });
  });

  test("the new town dialog offers the layout and the far bank", () => {
    const h = newTownHtml();
    for (const s of ['name="layout"', 'name="farBank"', "river town", "radial web", "ridge, down to a river", "castle gate", "one long street", "crossroads", "abbey gate", "harbour", "old village", "bridge-end", "abbey's side", "wharf side", 'id="farbank-field"', 'id="shape-field"']) expect(h).toContain(s);
  });

  test("the map draws a river town's bridge as a deck, and its high ground", () => {
    const t = generate("draw", { pop: 3000, design: { layout: "river" } });
    const svg = renderMap(t);
    expect(svg).toContain('class="m-bridge-deck');
    expect(svg).toContain('class="m-high');
  }, 300000);

  test("a ridge town's bridge is a deck too", () => {
    expect(renderMap(generate("draw-ridge", { pop: 3000, design: { layout: "ridge" } }))).toContain('class="m-bridge-deck');
  }, 300000);

  test("a radial town's map is drawn as before", () => {
    const svg = renderMap(generate("draw-r", { pop: 3000, design: { layout: "radial" } }));
    expect(svg).not.toContain('class="m-bridge-deck"');
    expect(svg).not.toContain('class="m-high');
  }, 300000);
});
