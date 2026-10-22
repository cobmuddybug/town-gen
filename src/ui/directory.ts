import { ancestors, typeOf, type Address } from "../core/address";
import type { Block } from "../core/calendar";
import type { Town } from "../core/town";
import type { PanelLink, PanelRow } from "../core/types";
import { lsd } from "../modules/households";
import { isStreetPlan } from "../modules/layout";
import type { Occupation } from "../modules/uses";
import { LISTS, type Fact } from "./discover";

export type DirTab = "people" | "households" | "buildings" | "trades" | "offices" | "wards" | `list:${string}`;
export interface DirRow { address?: Address; cells: (string | number)[]; sort: (string | number)[]; fact?: Fact }
export interface Directory { columns: string[]; rows: DirRow[] }
export interface DirOpts { date: string; block: Block; filter?: string; sort?: { col: number; desc: boolean }; hiddenLists?: Set<string> }

const FIXED: { id: DirTab; title: string }[] = [
  { id: "people", title: "People" },
  { id: "households", title: "Households" },
  { id: "buildings", title: "Buildings" },
  { id: "trades", title: "Trades" },
  { id: "offices", title: "Offices" },
  { id: "wards", title: "Wards" },
];

/** The Directory's tabs: the fixed indexes, then one per list. A hamlet has no wards. */
export function DIRECTORY_TABS(town: Town, opts: { hiddenLists?: Set<string> } = {}): { id: DirTab; title: string; list?: boolean }[] {
  const street = isStreetPlan(town);
  return [
    ...FIXED.filter((t) => t.id !== "wards" || street),
    ...LISTS.filter((l) => !opts.hiddenLists?.has(l.id)).map((l) => ({ id: `list:${l.id}` as DirTab, title: l.title, list: true })),
  ];
}

const text = (v: PanelRow["value"]): string =>
  (Array.isArray(v) ? v : [v]).map((x) => (typeof x === "object" ? (x as PanelLink).text : String(x))).join("");
const firstLink = (v: PanelRow["value"]): Address | undefined =>
  (Array.isArray(v) ? v : [v]).find((x): x is PanelLink => typeof x === "object")?.address;

/** One tab of the Directory as a table: filtered by every word, sorted by a column. */
export function directory(town: Town, tab: DirTab, opts: DirOpts): Directory {
  town.society();
  const occs = town.registry<Occupation>("occupations");
  const trade = (id: unknown) => (id ? occs.find(String(id))?.label ?? String(id) : "");
  const label = (a: Address | undefined) => (a ? town.label(a) : "");
  const row = (address: Address | undefined, cells: (string | number)[], sort = cells, fact?: Fact): DirRow => ({ address, cells, sort, ...(fact ? { fact } : {}) });
  const all = town.allEntities();
  let columns: string[];
  let rows: DirRow[];

  if (tab === "people") {
    columns = ["Name", "Trade", "Age", "Household", "Building"];
    rows = all.filter((e) => e.type === "person").map((e) => {
      const hh = town.parentOf(e.address)!;
      return row(e.address, [town.label(e.address), trade(e.get("occupation") ?? town.get(hh).get("occupation")), e.get<number>("age"), label(hh), label(town.parentOf(hh))]);
    });
  } else if (tab === "households") {
    columns = ["Household", "Trade", "Income", "Members", "Building"];
    rows = all.filter((e) => e.type === "household").map((e) => {
      const income = e.get<number>("income") ?? 0;
      const cells = [town.label(e.address), trade(e.get("occupation")), lsd(income), town.children(e.address, "person").length, label(town.parentOf(e.address))];
      return row(e.address, cells, [cells[0], cells[1], income, cells[3], cells[4]]);
    });
  } else if (tab === "buildings") {
    columns = ["Building", "Use", "Ward", "Households"];
    rows = all.filter((e) => e.type === "building").map((e) =>
      row(e.address, [town.label(e.address), String(e.get("use") ?? "").replace(/_/g, " "), label(ancestors(e.address).find((a) => typeOf(a) === "ward")), town.children(e.address, "household").length]));
  } else if (tab === "trades") {
    columns = ["Trade", "People"];
    const n = new Map<string, number>();
    for (const e of all) if (e.type === "person") {
      const id = e.get<string | undefined>("occupation") ?? town.get(town.parentOf(e.address)!).get<string | undefined>("occupation");
      if (id) n.set(id, (n.get(id) ?? 0) + 1);
    }
    rows = [...n].map(([id, k]) => row(undefined, [trade(id), k]));
  } else if (tab === "offices") {
    columns = ["Office", "Holder", "In"];
    rows = town.edges({ kind: "office_in" }).map((e) => row(e.from, [String(e.facts?.office ?? "office"), town.label(e.from), town.label(e.to)]));
  } else if (tab === "wards") {
    columns = ["Ward", "Buildings", "People"];
    rows = all.filter((e) => e.type === "ward").map((w) => {
      let b = 0, p = 0;
      for (const e of all) if (e.address.startsWith(w.address + "/")) { if (e.type === "building") b++; else if (e.type === "person") p++; }
      return row(w.address, [town.label(w.address), b, p]);
    });
  } else {
    const l = LISTS.find((x) => `list:${x.id}` === tab && !opts.hiddenLists?.has(x.id));
    columns = ["", "Entry", "Note"];
    rows = l ? l.rows(town, opts.date, opts.block).map((r) => row(firstLink(r.value), [r.label, text(r.value), r.hint ?? ""], undefined, r.fact)) : [];
  }

  const words = (opts.filter ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) rows = rows.filter((r) => { const t = r.cells.join(" ").toLowerCase(); return words.every((w) => t.includes(w)); });
  // Lists keep their own order unless asked; tables start sorted by their first column.
  const s = opts.sort ?? (tab.startsWith("list:") ? undefined : { col: 0, desc: false });
  if (s) {
    const k = s.desc ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const x = a.sort[s.col], y = b.sort[s.col];
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return k * c || String(a.address ?? a.cells[0]).localeCompare(String(b.address ?? b.cells[0]));
    });
  }
  return { columns, rows };
}

const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** How many rows the page draws at once; the filter narrows the rest. */
export const DIR_MAX = 400;

/** The Directory page: tab chips, a filter, and the table. */
export function directoryHtml(tabs: { id: DirTab; title: string; list?: boolean }[], tab: DirTab, d: Directory, filter: string, sort?: { col: number; desc: boolean }): string {
  const chip = (t: { id: DirTab; title: string }) => `<button data-dir-tab="${esc(t.id)}" class="${t.id === tab ? "on" : ""}">${esc(t.title)}</button>`;
  const h: string[] = [`<h2>Directory</h2>`];
  h.push(`<div class="dir-tabs"><span class="dir-label">Index</span>${tabs.filter((t) => !t.list).map(chip).join("")}</div>`);
  h.push(`<div class="dir-tabs"><span class="dir-label">Lists</span>${tabs.filter((t) => t.list).map(chip).join("")}</div>`);
  h.push(`<input id="dir-filter" class="find" type="search" placeholder="Filter these rows: a name, a trade, a street…" value="${esc(filter)}" autocomplete="off" />`);
  const shown = d.rows.slice(0, DIR_MAX);
  h.push(`<p class="sub dir-count">${d.rows.length.toLocaleString()} ${d.rows.length === 1 ? "row" : "rows"}${d.rows.length > shown.length ? `, showing the first ${shown.length}: filter to narrow` : ""}</p>`);
  if (!d.rows.length) return h.join("") + `<p class="sub">Nothing here${filter ? " matches that filter" : ""}.</p>`;
  const arrow = (i: number) => (sort?.col === i ? (sort.desc ? " ▾" : " ▴") : "");
  h.push(`<table class="dir"><thead><tr>${d.columns.map((c, i) => `<th scope="col"><button data-sort="${i}" aria-sort="${sort?.col === i ? (sort.desc ? "descending" : "ascending") : "none"}">${esc(c) || "&nbsp;"}${arrow(i)}</button></th>`).join("")}</tr></thead><tbody>`);
  for (const r of shown) {
    const attr = r.address ? ` data-go="${esc(r.address)}" data-involves="${esc(r.address)}" tabindex="0"` : tab === "trades" ? ` data-dir-trade="${esc(r.cells[0])}" tabindex="0"` : "";
    h.push(`<tr${attr}>${r.cells.map((c) => `<td${typeof c === "number" ? ' class="num"' : /^(?:£|\d+[sd]\b)/.test(String(c)) ? ' class="money"' : ""}>${esc(c)}</td>`).join("")}</tr>`);
  }
  h.push(`</tbody></table>`);
  return h.join("");
}
