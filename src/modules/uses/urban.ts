// The building plan for big villages, towns and cities (LF pp.83-104).
//
// Trades come from `per` (about one per that many people); religious seats
// from a population budget (LF p.85); the town's own buildings from size
// thresholds; and everyone else lives in housing mixed to the urban
// composition (LF pp.83-84): mostly workers in tenements, a fifth of them
// poor, some journeymen, a few clerks and widows in narrow town houses.

import type { Rng } from "../../core/rng";
import type { Registry } from "../../core/registry";
import type { Design, Era, FarBank, LayoutPlan } from "../../core/types";
import type { Base } from "../core";
import type { BuildingUse } from "./index";

export interface UrbanPlan {
  plan: string[];
  roads: number;
  quarters: number;
  layout: LayoutPlan;
  farBank?: FarBank;
  /** indices into `plan` that stand on a river town's far bank */
  far: number[];
}

const FAR_ODDS: [FarBank, number][] = [["village", 0.35], ["bridgend", 0.3], ["abbey", 0.15], ["wharf", 0.2]];

// People per household in a shop or workshop, counting servants and apprentices (measured).
const PEOPLE = 4.8;

function households(u: BuildingUse | undefined): number {
  const h = u?.households ?? 1;
  return Array.isArray(h) ? (h[0] + h[1]) / 2 : h;
}

export function planUrban(
  r: Rng, pop: number, sizeClass: string, base: Base, era: Era, useReg: Registry<BuildingUse>, walled: boolean, manorial: boolean, design?: Design,
): UrbanPlan {
  const urban = sizeClass === "town" || sizeClass === "city";
  const special: string[] = [];
  const count = (n: number) => Math.floor(n) + (r.chance(n - Math.floor(n)) ? 1 : 0);

  // The base's own buildings and trades, once each, as in a hamlet.
  for (const u of base.core) if (u !== "place_of_worship" && useReg.has(u)) special.push(u);
  for (const u of base.extras) if (useReg.has(u)) special.push(u);
  if (manorial) {
    special.push("manor_house");
    if (r.chance(0.6)) special.push("socman_house");
  }

  // Trades by population. Villages support about half as many.
  const scale = urban ? 1 : 0.5;
  for (const u of useReg.list(era)) {
    if (!u.per || pop < (u.min_pop ?? 0)) continue;
    const n = count((pop / u.per) * scale * r.range(0.8, 1.2));
    for (let i = 0; i < n; i++) special.push(u.id);
  }

  // Religion (LF p.85): a budget by congregation.
  const worship: string[] = [];
  if (sizeClass === "city" || (urban && pop >= 15000 && r.chance(0.4))) worship.push("grand_temple");
  if (urban) {
    const temples = Math.max(1, Math.round(pop / 12000));
    for (let i = 0; i < temples; i++) worship.push("temple");
    for (let i = 0, n = count(pop / 800); i < n; i++) worship.push("fane");
    for (let i = 0, n = count(pop / 2200); i < n; i++) worship.push("chapel");
    for (let i = 0, n = count(pop / 3200); i < n; i++) worship.push("chantry");
    for (let i = 0, n = count(pop / 1800); i < n; i++) worship.push("shrine");
  } else {
    // A market town has a parish church for every few hundred souls, as the old towns did.
    worship.push("fane");
    for (let i = 0, n = count((pop - 1000) / 900); i < n; i++) worship.push("fane");
    for (let i = 0, n = count(pop / 1800); i < n; i++) worship.push("chapel");
    for (let i = 0, n = count(pop / 1200); i < n; i++) worship.push("shrine");
    if (r.chance(0.3)) worship.push("chantry");
  }
  if (pop >= 4500) for (let i = 0, n = Math.max(1, count(pop / 8000)); i < n; i++) worship.push("friary");
  if (pop >= 9000 && r.chance(0.6)) worship.push("priory");
  if (pop >= 12000 && r.chance(0.5)) worship.push("nunnery");
  if (pop >= 3000) for (let i = 0, n = Math.max(1, count(pop / 7000)); i < n; i++) worship.push("hospital");
  if (pop >= 5000) worship.push("lazar_house");

  // The town's own buildings.
  const rolled = urban ? (sizeClass === "city" ? r.int(5, 6) : r.int(4, 5)) : r.int(3, 4);
  const roads = design?.gates ?? rolled;
  const quarters = urban ? Math.min(4, roads) : 1;
  const civic: string[] = [];
  if (pop >= 1500) civic.push("market_hall");
  if (pop >= 4000) civic.push("guildhall");
  if (pop >= 8000) for (let i = 0, n = Math.floor(pop / 6000); i < n; i++) civic.push("craft_hall");
  if (pop >= 3000) civic.push("gaol");
  if (pop >= 10000) civic.push("courthouse");
  if (urban) for (let i = 0; i < quarters; i++) civic.push("watch_house");
  if (walled && urban) for (let i = 0; i < roads; i++) civic.push("gatehouse");
  const castle = (sizeClass === "city" && r.chance(0.8)) || (sizeClass === "town" && r.chance(0.45));
  if (design?.castle ?? castle) civic.push("castle");
  if (pop >= 3000) for (let i = 0, n = 1 + Math.floor(pop / 10000); i < n; i++) civic.push("school");
  if (pop >= 10000) for (let i = 0, n = count(pop / 12000); i < n; i++) civic.push("noble_town_house");

  const all = [...special, ...worship, ...civic].filter((u) => useReg.has(u));

  // Everyone else. In a village most still live in the base's own houses;
  // in a town that share falls away and tenements take over.
  let people = 0;
  for (const u of all) {
    const row = useReg.find(u);
    people += households(row) * PEOPLE;
  }
  const rest = Math.max(0, pop - people);
  const fill = Object.entries(base.fill).filter(([u]) => useReg.has(u));
  const baseShare = urban ? Math.max(0.06, Math.min(0.3, (12000 - pop) / 25000)) : Math.max(0.45, Math.min(0.9, (7000 - pop) / 6000));
  const mix: [string, number][] = [
    ...fill.map(([u, s]) => [u, s * baseShare] as [string, number]),
    ["tenement", (1 - baseShare) * (urban ? 0.6 : 0.55)],
    ["poor_row", (1 - baseShare) * (urban ? 0.2 : 0.1)],
    ["journeyman_house", (1 - baseShare) * (urban ? 0.1 : 0.15)],
    ["townhouse", (1 - baseShare) * (urban ? 0.1 : 0.2)],
  ];
  const houses: string[] = [];
  for (const [u, share] of mix) {
    const row = useReg.find(u);
    if (!row) continue;
    const per = row.avgSize ?? households(row) * PEOPLE;
    for (let i = 0, n = Math.round((rest * share * r.range(0.9, 1.1)) / per); i < n; i++) houses.push(u);
  }
  for (let i = 0, n = Math.round(houses.length * 0.01); i < n; i++) houses.push("empty");
  const plan = [...all, ...r.shuffle(houses)];
  return { plan, roads, quarters, ...rollLayout(r, plan, pop, base, useReg, design) };
}

/** A street plan's layout and far bank: drawn last and always, so a choice moves nothing else.
 *  A coast town is radial unless the DM says otherwise: the radial plan has the sea.
 *  For a river town, `plan` gains the far bank's signature buildings. */
export function rollLayout(r: Rng, plan: string[], pop: number, base: Base, useReg: Registry<BuildingUse>, design?: Design): Pick<UrbanPlan, "layout" | "farBank" | "far"> {
  const rolledPlan: LayoutPlan = r.chance(2 / 3) && base.terrain !== "coast" ? "river" : "radial";
  let rolledBank = r.weighted(FAR_ODDS, ([, w]) => w)[0];
  if (rolledBank === "wharf" && pop < 1001) rolledBank = "village";
  const layout = design?.layout ?? rolledPlan;
  if (layout !== "river") return { layout, far: [] };
  const farBank = design?.farBank ?? rolledBank;
  return { layout, farBank, far: farBankUses(r, plan, farBank, pop, base, useReg) };
}

/** The far bank's signature buildings: taken from the plan where it has them, added where it doesn't. Returns their indices. */
function farBankUses(r: Rng, plan: string[], kind: FarBank, pop: number, base: Base, useReg: Registry<BuildingUse>): number[] {
  const far: number[] = [];
  const taken = new Set<number>();
  // One of `ids` for the far bank: the last free one in the plan, or a new one (the first id that exists).
  const reserve = (ids: string[], add = true) => {
    for (let i = plan.length - 1; i >= 0; i--) if (ids.includes(plan[i]) && !taken.has(i)) { taken.add(i); far.push(i); return; }
    const id = ids.find((u) => useReg.has(u));
    if (!add || !id) return;
    plan.push(id);
    taken.add(plan.length - 1);
    far.push(plan.length - 1);
  };
  const move = (ids: string[], n: number) => { for (let k = 0; k < n; k++) reserve(ids, false); };
  if (kind === "village") {
    far.push(plan.length); plan.push(pop >= 3000 ? "fane" : "chapel"); taken.add(plan.length - 1);
    const homes = Object.keys(base.fill).filter((u) => useReg.has(u));
    const want = r.int(3, 8);
    for (let k = 0; k < want; k++) reserve(homes.length ? homes : ["cottage"], true);
    far.push(plan.length); plan.push("town_alehouse"); taken.add(plan.length - 1);
  } else if (kind === "bridgend") {
    reserve(["town_tannery"]);
    reserve([pop >= 1500 ? "inn" : "hostel"]);
    reserve(["livery_stable", "town_carter"]);
    move(["poor_row"], 6);
  } else if (kind === "abbey") {
    // Below a friary's town the abbey keeps only a cell over the bridge: a prior and a few monks.
    reserve(["friary", "priory"].filter((u) => plan.includes(u)).concat(pop >= 4500 ? "priory" : "cell"));
    far.push(plan.length); plan.push("chapel"); taken.add(plan.length - 1);
    // The abbot's mill, which the town quarrels over.
    reserve(["mill"]);
  } else {
    reserve(["warehouse"]);
    reserve(["boatwright"]);
    move(["rooming_house", "tenement"], 3);
    far.push(plan.length); plan.push("town_alehouse"); taken.add(plan.length - 1);
  }
  return far.sort((a, b) => a - b);
}
