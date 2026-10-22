import { beforeAll, describe, expect, test } from "vitest";
import { generate, defaultModules as modules } from "../src/town-gen";
import type { Town } from "../src/core/town";
import { HIDDEN_ALMANAC, HIDDEN_LISTS, playerPanels, playerRow, playerRows } from "../src/ui/player";
import { DIRECTORY_TABS } from "../src/ui/directory";
import { paletteGroups } from "../src/ui/palette";

let town: Town;
beforeAll(() => { town = generate("burgh-a", { pop: 8000 }); town.society(); }, 120000);

describe("player view", () => {
  test("drops secrets and every crime panel, keeps relationships", () => {
    const ids = playerPanels(modules.flatMap((m) => m.panels ?? [])).map((p) => p.id);
    expect(ids).not.toContain("secrets");
    expect(ids.some((i) => i.startsWith("crime-"))).toBe(false);
    expect(ids).toContain("relationships");
  });

  test("rows lose who-knows and edit tools", () => {
    expect(playerRow({ label: "x", value: "y", key: "k", fact: "edge:1", rerollable: true })).toEqual({ label: "x", value: "y", key: undefined, fact: undefined, rerollable: undefined });
  });

  test("relationships the town doesn't know about are not shown", () => {
    const secret = town.edges().find((e) => e.knownBy !== "public" && town.get(e.from).type === "person")!;
    const panel = modules.flatMap((m) => m.panels ?? []).find((p) => p.id === "relationships")!;
    const rows = panel.rows(town, town.get(secret.from));
    expect(rows.some((r) => r.fact === `edge:${secret.id}`)).toBe(true);
    expect(playerRows(town, rows).some((r) => /not common knowledge/.test(JSON.stringify(r.value)))).toBe(false);
    expect(playerRows(town, rows).length).toBeLessThan(rows.length);
  });

  test("the directory offers no debts, secrets or crime lists", () => {
    const ids = DIRECTORY_TABS(town, { hiddenLists: HIDDEN_LISTS }).map((t) => t.id);
    for (const h of HIDDEN_LISTS) expect(ids).not.toContain(`list:${h}`);
    expect(ids).toContain("list:hire");
  });

  test("the palette never offers a hidden list", () => {
    for (const q of ["secrets", "debts", "underworld", "gaol"]) {
      const lists = paletteGroups(town, q, { player: true, hiddenLists: HIDDEN_LISTS }).find((g) => g.title === "Lists");
      expect(lists?.items.some((i) => HIDDEN_LISTS.has(i.list!)) ?? false).toBe(false);
    }
  });

  test("the almanac hides secrets, crimes and deaths", () => {
    expect([...HIDDEN_ALMANAC].sort()).toEqual(["crime", "life", "secret"]);
  });
});

import { world } from "../src/modules/crime";
import { jobBoard } from "../src/ui/party";
import { search } from "../src/ui/discover";
import { glance } from "../src/ui/glance";
import { directory } from "../src/ui/directory";
import { maskDoing, playerJobs, underworldOf, coverTrade } from "../src/ui/player";
import type { PanelRow } from "../src/core/types";
import type { Occupation } from "../src/modules/uses";
import { BLOCKS } from "../src/core/calendar";

const textOf = (v: PanelRow["value"]) => (Array.isArray(v) ? v : [v]).map((x) => (typeof x === "object" ? x.text : String(x))).join("");

describe("player view: nothing leaks through a side door", () => {
  const date = "1203-10-01";
  // What must never be on a shared screen: crew names, aliases, secret ties, debts, covert trades.
  const tells = () => {
    const W = world(town)!;
    const occs = town.registry<Occupation>("occupations").list().filter((o) => o.tier === "criminal" && (o as { routine?: string }).routine === "thief").map((o) => o.label);
    const aliases = town.allEntities().flatMap((e) => (e.get<string | undefined>("crime.alias") ? [`"${e.get<string>("crime.alias")}"`] : []));
    return [town.label(W.address), ...W.gangs.map((g) => town.label(g.address)), ...aliases, ...occs, "not common knowledge", " owes ", "who owes"];
  };

  test("no panel row on any page shows a tell", () => {
    const bad = tells();
    const under = underworldOf(town);
    const panels = playerPanels(modules.flatMap((m) => m.panels ?? []));
    const ents = town.allEntities().filter((e, i) => !under.has(e.address) && (e.type !== "person" || i % 3 === 0));
    const leaks: string[] = [];
    for (const e of ents) for (const p of panels.filter((x) => x.for === e.type)) {
      for (const r of playerRows(town, p.rows(town, e), { entity: e.address, panel: p.id })) {
        const t = `${r.label} ${textOf(r.value)} ${r.hint ?? ""}`;
        for (const b of bad) if (t.includes(b)) leaks.push(`${e.address} [${p.id}] ${b}: ${t.slice(0, 120)}`);
      }
    }
    expect(leaks.slice(0, 5)).toEqual([]);
  });

  test("the card's Now line hides a crew member at work", () => {
    const W = world(town)!;
    const leaks: string[] = [];
    for (const g of W.gangs) for (const m of g.members) for (const b of BLOCKS) {
      const now = glance(town, m.p, date, b, { player: true }).find((r) => r.label === "Now")!;
      const t = textOf(now.value);
      if (/crew|purses|likely houses|back room/.test(t)) leaks.push(`${m.p} ${b}: ${t}`);
      const tr = glance(town, m.p, date, b, { player: true }).find((r) => r.label === "Trade")!;
      for (const x of tells()) if (textOf(tr.value).includes(x)) leaks.push(`trade ${m.p}: ${textOf(tr.value)}`);
    }
    expect(leaks.slice(0, 5)).toEqual([]);
  });

  test("maskDoing leaves an honest doing alone", () => {
    const p = town.allEntities().find((e) => e.type === "person" && !e.get("crime.alias"))!.address;
    expect(maskDoing(town, p, date, "forenoon", "at the loom")).toBe("at the loom");
  });

  test("search offers no crew, no underworld and no covert trade", () => {
    const W = world(town)!;
    for (const a of [W.address, ...W.gangs.map((g) => g.address)]) {
      const words = town.label(a).replace(/^The /, "");
      const hits = paletteGroups(town, words, { player: true, hiddenLists: HIDDEN_LISTS }).flatMap((g) => g.items);
      expect(hits.some((h) => h.address === a)).toBe(false);
    }
    expect(paletteGroups(town, "cutpurse", { player: true, hiddenLists: HIDDEN_LISTS }).find((g) => g.title === "Trades")).toBeUndefined();
    expect(search(town, "underworld", 60, { player: true, hide: underworldOf(town) }).results).toEqual([]);
  });

  test("the directory shows a cover trade, never a covert one", () => {
    const d = directory(town, "people", { date, block: "forenoon", player: true, hiddenLists: HIDDEN_LISTS });
    expect(d.rows.some((r) => String(r.cells[1]).includes("cutpurse"))).toBe(false);
    const t = directory(town, "trades", { date, block: "forenoon", player: true, hiddenLists: HIDDEN_LISTS });
    expect(t.rows.some((r) => String(r.cells[0]).includes("cutpurse"))).toBe(false);
    const o = directory(town, "offices", { date, block: "forenoon", player: true, hiddenLists: HIDDEN_LISTS });
    const under = underworldOf(town);
    expect(o.rows.some((r) => tells().some((b) => r.cells.join(" ").includes(b)) || (r.address && under.has(r.address)))).toBe(false);
  });

  test("the job board offers players no secret, debt, racket or blackmail", () => {
    const jobs = playerJobs(town, jobBoard(town, date));
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(j.id).not.toMatch(/^(debt|racket|blackmail)\//);
      const t = [...j.detail, ...j.risk].map((x) => (typeof x === "object" ? x.text : x)).join("");
      for (const b of tells()) expect(t).not.toContain(b);
      expect(t).not.toMatch(/nobody knows|which nobody/);
    }
  });

  test("a cover trade hides only covert work", () => {
    expect(coverTrade(town, "cutpurse")).toBe("labourer");
    expect(coverTrade(town, "baker")).toBe(town.registry<Occupation>("occupations").get("baker").label);
  });
});
