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
