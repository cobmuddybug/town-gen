import type { Town } from "../core/town";
import type { Edge, PanelRow, PanelSpec } from "../core/types";

// Player view: what can be on a screen the players see. Secrets, the
// underworld, debts and the DM's tools stay behind it.

export const HIDDEN_PANELS = (id: string) => id === "secrets" || id.startsWith("crime-");
// "richest" is here because its notes give away money from the crews and what each house has put by.
export const HIDDEN_LISTS = new Set(["debts", "secrets", "feuds", "underworld", "crimes", "gaol", "richest"]);
export const HIDDEN_ALMANAC = new Set(["secret", "crime", "life"]);

export const playerPanels = (panels: PanelSpec[]): PanelSpec[] => panels.filter((p) => !HIDDEN_PANELS(p.id));

/** A row with no "who knows?" and no edit, reroll or star tools. */
export const playerRow = (r: PanelRow): PanelRow => ({ ...r, key: undefined, fact: undefined, rerollable: undefined });

const edgeMemo = new WeakMap<Town, Map<string, Edge>>();
function edgeById(town: Town, id: string): Edge | undefined {
  let m = edgeMemo.get(town);
  if (!m) edgeMemo.set(town, (m = new Map(town.edges().map((e) => [e.id, e]))));
  return m.get(id);
}

/** The rows players may see: ties the town doesn't know about are left out, and the rest lose their tools. */
export function playerRows(town: Town, rows: PanelRow[]): PanelRow[] {
  return rows.filter((r) => {
    if (!r.fact?.startsWith("edge:")) return true;
    const e = edgeById(town, r.fact.slice(5));
    return !e || e.knownBy === "public";
  }).map(playerRow);
}
