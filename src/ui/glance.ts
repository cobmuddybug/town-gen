import type { Address } from "../core/address";
import type { Block } from "../core/calendar";
import type { Town } from "../core/town";
import type { PanelLink } from "../core/types";
import { lsd } from "../modules/households";
import { occupancy, whereabouts } from "../modules/routines";
import type { Occupation } from "../modules/uses";

export type GlanceValue = (string | PanelLink)[];
export interface GlanceRow { label: string; value: GlanceValue }

const L = (town: Town, a: Address): PanelLink => ({ text: town.label(a), address: a });

/** The few facts asked for most, at the top of an entity's page. */
export function glance(town: Town, a: Address, date: string, block: Block): GlanceRow[] {
  const e = town.get(a);
  const occs = town.registry<Occupation>("occupations");
  const trade = (id: unknown) => (id ? occs.find(String(id))?.label ?? String(id) : "—");
  if (e.type === "person") {
    const hh = town.parentOf(a)!;
    const w = whereabouts(town, a, date, block);
    const where: string | PanelLink = w.where.startsWith("place:") ? w.label : L(town, w.where);
    return [
      { label: "Trade", value: [trade(e.get("occupation") ?? town.get(hh).get("occupation"))] },
      { label: "Age", value: [String(e.get("age"))] },
      { label: "Household", value: [L(town, hh)] },
      { label: "Now", value: [where, `, ${w.doing}`] },
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

/** The facts the DM starred on this page: events of kind "star", by the row's label. */
export function starsOf(town: Town, a: Address): { label: string; index: number }[] {
  return town.events.flatMap((ev, index) => (ev.kind === "star" && ev.target === a ? [{ label: ev.text, index }] : []));
}
