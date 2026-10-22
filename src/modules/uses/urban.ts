// The building plan for big villages, towns and cities (LF pp.83-104).
//
// Trades come from `per` (about one per that many people); religious seats
// from a population budget (LF p.85); the town's own buildings from size
// thresholds; and everyone else lives in housing mixed to the urban
// composition (LF pp.83-84): mostly workers in tenements, a fifth of them
// poor, some journeymen, a few clerks and widows in narrow town houses.

import type { Rng } from "../../core/rng";
import type { Registry } from "../../core/registry";
import type { Design, Era } from "../../core/types";
import type { Base } from "../core";
import type { BuildingUse } from "./index";

export interface UrbanPlan {
  plan: string[];
  roads: number;
  quarters: number;
}

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
  return { plan: [...all, ...r.shuffle(houses)], roads, quarters };
}
