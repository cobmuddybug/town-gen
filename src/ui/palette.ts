import type { Address } from "../core/address";
import type { Town } from "../core/town";
import type { Occupation } from "../modules/uses";
import { LISTS, search } from "./discover";
import { coverTrade, underworldOf } from "./player";

export type PaletteTitle = "People" | "Places" | "Trades" | "Offices" | "Lists";
export interface PaletteItem { address?: Address; list?: string; label: string; detail: string }
export interface PaletteGroup { title: PaletteTitle; items: PaletteItem[] }

const ORDER: PaletteTitle[] = ["People", "Places", "Trades", "Offices", "Lists"];
const PER_GROUP = 8;
const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const tradeMemo = new WeakMap<Town, { id: string; label: string; n: number }[]>();
/** The trades actually followed in this town, with how many people follow each. */
function trades(town: Town) {
  const hit = tradeMemo.get(town);
  if (hit) return hit;
  const occs = town.registry<Occupation>("occupations");
  const n = new Map<string, number>();
  for (const e of town.allEntities()) {
    if (e.type !== "person") continue;
    const id = e.get<string | undefined>("occupation") ?? town.get(town.parentOf(e.address)!).get<string | undefined>("occupation");
    if (id && occs.find(id)) n.set(id, (n.get(id) ?? 0) + 1);
  }
  const out = [...n].map(([id, k]) => ({ id, label: occs.get(id).label, n: k })).sort((a, b) => b.n - a.n || (a.label < b.label ? -1 : 1));
  tradeMemo.set(town, out);
  return out;
}

/** What the search box offers for a query, grouped and capped. `hidden` = list ids not to offer. */
export function paletteGroups(town: Town, query: string, opts: { player?: boolean; hiddenLists?: Set<string> } = {}): PaletteGroup[] {
  const hide = opts.player ? underworldOf(town) : undefined;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const all = (t: string) => words.every((w) => t.toLowerCase().includes(w));
  const groups = new Map<PaletteTitle, PaletteItem[]>(ORDER.map((t) => [t, []]));
  // All matches, not a capped page: places sort first, and a cap would starve People.
  for (const r of search(town, query, Infinity, { player: opts.player, hide }).results) {
    const g = r.kind === "person" ? "People" : r.kind === "institution" ? "Offices" : "Places";
    groups.get(g)!.push({ address: r.address, label: r.label, detail: r.detail });
  }
  for (const t of trades(town)) if (all(t.label) && !(opts.player && coverTrade(town, t.id) !== t.label)) groups.get("Trades")!.push({ list: `trade:${t.id}`, label: t.label, detail: `${t.n} ${t.n === 1 ? "person" : "people"}` });
  for (const l of LISTS) if (!opts.hiddenLists?.has(l.id) && all(l.title)) groups.get("Lists")!.push({ list: l.id, label: l.title, detail: "list" });
  return ORDER.map((title) => ({ title, items: groups.get(title)!.slice(0, PER_GROUP) })).filter((g) => g.items.length);
}

/** The palette's markup. Rows are numbered across groups; `active` is highlighted. */
export function paletteHtml(groups: PaletteGroup[], active: number, query: string): string {
  if (!query.trim()) return `<p class="pal-note">Type a name, a trade, a building or a ward. <kbd>↑</kbd><kbd>↓</kbd> to move, <kbd>Enter</kbd> to open.</p>`;
  if (!groups.length) return `<p class="pal-note">Nothing matches “${esc(query)}”.</p>`;
  let i = 0;
  return groups.map((g) => `<div class="pal-group"><p class="pal-head">${g.title}</p>${g.items.map((x) => {
    const n = i++;
    const data = x.address ? `data-pal-go="${esc(x.address)}"` : `data-pal-list="${esc(x.list!)}"`;
    return `<button type="button" role="option" class="pal-item${n === active ? " on" : ""}" aria-selected="${n === active}" data-pal="${n}" ${data}><span>${esc(x.label)}</span><span class="sub">${esc(x.detail)}</span></button>`;
  }).join("")}</div>`).join("");
}

/** The palette's rows in order, as the keyboard walks them. */
export const paletteItems = (groups: PaletteGroup[]): PaletteItem[] => groups.flatMap((g) => g.items);
