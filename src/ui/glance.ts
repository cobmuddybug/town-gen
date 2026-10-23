// The card at the top of an entity's page: the few facts asked for most, then
// the rows the DM has starred (stars are save events of kind "star").
import type { Address } from "../core/address";
import type { Block } from "../core/calendar";
import type { Town } from "../core/town";
import type { PanelLink, PanelRow } from "../core/types";
import { lsd } from "../modules/households";
import { occupancy, whereabouts } from "../modules/routines";
import type { Occupation } from "../modules/uses";
import { coverTrade, maskDoing } from "./player";

export type GlanceValue = (string | PanelLink)[];
export interface GlanceRow { label: string; value: GlanceValue }

const L = (town: Town, a: Address): PanelLink => ({ text: town.label(a), address: a });

/** The few facts asked for most, at the top of an entity's page. */
export function glance(town: Town, a: Address, date: string, block: Block, opts: { player?: boolean } = {}): GlanceRow[] {
  const e = town.get(a);
  const occs = town.registry<Occupation>("occupations");
  const trade = (id: unknown) => (!id ? "—" : opts.player ? coverTrade(town, id) : occs.find(String(id))?.label ?? String(id));
  if (e.type === "person") {
    const hh = town.parentOf(a)!;
    const w = whereabouts(town, a, date, block);
    const where: string | PanelLink = w.where.startsWith("place:") ? w.label : L(town, w.where);
    return [
      { label: "Trade", value: [trade(e.get("occupation") ?? town.get(hh).get("occupation"))] },
      { label: "Age", value: [String(e.get("age"))] },
      { label: "Household", value: [L(town, hh)] },
      { label: "Now", value: [where, `, ${opts.player ? maskDoing(town, a, date, block, w.doing) : w.doing}`] },
    ];
  }
  if (e.type === "building") {
    const hs = town.children(a, "household");
    const inside = occupancy(town, date, block).get(a) ?? [];
    const shown = inside.slice(0, 3).map((p) => L(town, p));
    return [
      { label: "Use", value: [String(e.get("use") ?? "").replace(/_/g, " ")] },
      { label: "Households", value: hs.length ? hs.flatMap((h, i) => (i ? [", ", L(town, h.address)] : [L(town, h.address)])) : ["none"] },
      { label: "Inside now", value: inside.length ? [`${inside.length}: `, ...shown.flatMap((x, i) => (i ? [", ", x] : [x])), ...(inside.length > shown.length ? [` and ${inside.length - shown.length} more`] : [])] : ["nobody"] },
    ];
  }
  if (e.type === "household") {
    const head = town.children(a, "person").find((p) => p.get("role") === "head") ?? town.children(a, "person")[0];
    return [
      { label: "Head", value: head ? [L(town, head.address)] : ["—"] },
      { label: "Trade", value: [trade(e.get("occupation"))] },
      { label: "Income", value: [`${lsd(e.get<number>("income") ?? 0)} a year`] },
    ];
  }
  return [];
}

type Ev = Town["events"][number];
const SEP = "\u2063"; // invisible separator: label, then the row's words

const textOf = (v: PanelRow["value"]) => (Array.isArray(v) ? v : [v]).map((x) => (typeof x === "object" ? (x as PanelLink).text : String(x))).join("");

/** What a star remembers about a row: its label and its words, so two "cousin of" rows are two stars. */
export const starKey = (r: PanelRow): string => `${r.label}${SEP}${textOf(r.value)}`;

/** Does this star mean this row? Older stars kept only the label. */
const matches = (r: PanelRow, key: string) => (key.includes(SEP) ? key === starKey(r) : key === r.label);

/** The rows the DM starred, in the order they were starred. */
export function starredRows(rows: PanelRow[], stars: { label: string }[]): PanelRow[] {
  return stars.flatMap((s) => { const r = rows.find((x) => matches(x, s.label)); return r ? [r] : []; });
}
/** The star on a row, if the DM starred it. */
export const starOf = (r: PanelRow, stars: { label: string; index: number }[]) => stars.find((s) => matches(r, s.label));

// Deeds spread as gossip keyed by their place among the events, so stars always
// go after every deed: starring and unstarring then never moves a deed.
export const eventsWithStar = (events: Ev[], star: Ev): Ev[] => [...events, star];
/** The events with a deed added, ahead of any stars. */
export function eventsWithDeed(events: Ev[], deed: Ev): Ev[] {
  const i = events.findIndex((e) => e.kind === "star");
  return i < 0 ? [...events, deed] : [...events.slice(0, i), deed, ...events.slice(i)];
}

/** The facts the DM starred on this page: events of kind "star", by the row's label. */
export function starsOf(town: Town, a: Address): { label: string; index: number }[] {
  return town.events.flatMap((ev, index) => (ev.kind === "star" && ev.target === a ? [{ label: ev.text, index }] : []));
}
