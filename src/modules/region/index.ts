// The country round a settlement: where its main roads lead, its neighbours
// and old ruins, the carriers that run to the towns, and the news they bring
// in. Pure functions of the seed (and the date, for news), like visitors.
import { addDays, formatDate, jdn, parseDate, weekday, WEEKDAYS } from "../../core/calendar";
import { data } from "../../core/content";
import { atan2, TAU } from "../../core/dmath";
import type { Town } from "../../core/town";
import type { Module, PanelRow } from "../../core/types";
import { isUrban } from "../core";
import type { NameProvider } from "../names";
import { buildingsOfUse, type MapData } from "../layout";
import { pointInPoly } from "../layout/geom";
import { hourOf, type Rumour, type RumourSource } from "../gossip";
import regionYaml from "./content/region.yaml";

interface RegionData {
  destinations: { kind: string; weight: number; miles: [number, number] }[];
  neighbours: string[];
  ruins: string[];
  news: string[];
}
const content = data<RegionData>(regionYaml);

export interface Destination { road: number; name: string; kind: string; miles: number; dir: string }
export interface Carrier { to: string; day: string; from?: string }
export interface Region { roads: Destination[]; neighbours: string[]; ruins: string[]; carriers: Carrier[]; shire: string }

const COMPASS = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];
const memo = new WeakMap<Town, Region>();

/** The country round: roads, neighbours, ruins, carriers, the shire town. */
export function regionOf(town: Town): Region {
  const hit = memo.get(town);
  if (hit) return hit;
  const names = town.registry<NameProvider>("nameProviders").get("anglo-norman");
  const r = town.rngFor(town.root, region, "country");
  const map = town.settlement().get<MapData>("map");
  // A grown town's roads are all its streets; the roads out are the main roads (and the high
  // street, where it runs on out of town) that leave the built town behind.
  const grown = map.kind === "town" && !!map.plan && map.plan !== "radial";
  const leadsOut = (rd: MapData["roads"][number]) => !grown ||
    (/^(high|main\d+)$/.test(rd.id) && (!pointInPoly(rd.points[0], map.hedge) || !pointInPoly(rd.points[rd.points.length - 1], map.hedge)));
  const roads: Destination[] = (map.roads ?? []).flatMap((rd, i) => (leadsOut(rd) ? [{ rd, i }] : [])).map(({ rd, i }) => {
    const d = r.weighted(content.destinations, (x) => x.weight);
    // The end out in the country, whichever way round the road was drawn.
    const last = rd.points[rd.points.length - 1] ?? [1, 0];
    const end = grown && pointInPoly(last, map.hedge) ? rd.points[0] : last;
    const k = Math.round((atan2(end[1], end[0]) / TAU) * 8 + 8) % 8;
    const name = d.kind === "the coast" ? `the coast at ${names.place(r)}` : d.kind === "abbey" ? `the abbey at ${names.place(r)}` : names.place(r);
    return { road: i, name, kind: d.kind, miles: r.int(d.miles[0], d.miles[1]), dir: COMPASS[k] };
  });
  // The shire town: where the sheriff sits and the assizes come from.
  const shireRoad = roads.find((x) => x.kind === "shire town" || x.kind === "city");
  const shire = shireRoad?.name ?? names.place(r);
  const neighbours = r.shuffle(content.neighbours).slice(0, r.int(2, 4)).map((t) => `${names.place(r)}: ${t.replace("{miles}", String(r.int(2, 12)))}`);
  const ruins = r.shuffle(content.ruins).slice(0, r.int(1, 3)).map((t) => `${t}, ${r.int(2, 15)} miles ${r.pick(COMPASS)}`);
  // Carriers run from the inns of a market town to the towns on its roads, once a week each.
  const carriers: Carrier[] = [];
  if (isUrban(town)) {
    const inns = buildingsOfUse(town, ["inn", "tavern", "town_alehouse"]);
    for (const d of roads.filter((x) => x.kind !== "village" && x.kind !== "abbey").slice(0, 3)) {
      carriers.push({ to: d.name, day: r.pick(WEEKDAYS.slice(1)), ...(inns.length ? { from: inns[r.int(0, inns.length - 1)].a } : {}) });
    }
  } else if (roads.length) carriers.push({ to: roads[0].name, day: r.pick(WEEKDAYS.slice(1)) });
  const out = { roads, neighbours, ruins, carriers, shire };
  memo.set(town, out);
  return out;
}

/** The carriers that set out on a date. */
export function carriersOn(town: Town, date: string): Carrier[] {
  return regionOf(town).carriers.filter((c) => c.day === WEEKDAYS[weekday(date)]);
}

/** News from outside: about one piece a week in a market town, a fortnight in a village. */
function outsideNews(town: Town, year: number): Rumour[] {
  const R = regionOf(town);
  const names = R.roads.map((x) => x.name.replace(/^the (coast|abbey) at /, ""));
  if (!names.length) return [];
  const out: Rumour[] = [];
  const every = isUrban(town) ? 7 : 14;
  const first = jdn({ y: year, m: 1, d: 1 }), last = jdn({ y: year, m: 12, d: 31 });
  const near = R.neighbours.map((n) => n.split(":")[0]);
  for (let j = first; j <= last; j += every) {
    const r = town.rngFor(town.root, region, `news:${j}`);
    const day = formatDate(parseDate(addDays(`${year}-01-01`, j - first + r.int(0, every - 1))));
    if (parseDate(day).y !== year) continue;
    const t = r.pick(content.news).replace("{near}", near.length ? r.pick(near) : r.pick(names)).replace("{far}", r.pick(names));
    const carrier = R.carriers.find((c) => c.from);
    out.push({
      id: `outside/${day}`, kind: "news", topic: "outside", start: hourOf(day, "evening"),
      origin: carrier?.from ?? town.root, texts: [t, t, t], about: [], lastToKnow: [], how: "brought in by the carrier",
    });
  }
  return out;
}

export const region: Module = {
  id: "region",
  version: "1.0.0",
  requires: ["core", "layout", "names", "gossip"],
  register(add) {
    add<RumourSource>("rumourSources", [{ id: "outside", rumours: outsideNews, source: "LFP (regional spread); our own" }]);
  },
  panels: [
    {
      id: "country",
      title: "The country round",
      for: "settlement",
      order: 1.8,
      rows(town) {
        const R = regionOf(town);
        const rows: PanelRow[] = [];
        for (const d of R.roads) rows.push({ label: `Road ${d.dir}`, value: `to ${d.name}, ${d.kind === "village" || d.kind === "abbey" || d.kind === "the coast" ? "" : `a ${d.kind}, `}${d.miles} miles; ${d.miles <= 12 ? "there and back in a day" : `${Math.ceil(d.miles / 20)} day${d.miles > 20 ? "s" : ""} on foot`}` });
        rows.push({ label: "Shire town", value: `${R.shire}: the sheriff, the county gaol, and the king's justices twice a year` });
        for (const c of R.carriers) rows.push({ label: "Carrier", value: c.from ? [`to ${c.to} every ${c.day}, from `, { text: town.label(c.from), address: c.from }] : `to ${c.to} every ${c.day}, passing through` });
        for (const n of R.neighbours) rows.push({ label: "Near by", value: n });
        for (const x of R.ruins) rows.push({ label: "Old works", value: x, hint: "LFP: towers, keeps and castles on the land, some abandoned" });
        return rows;
      },
    },
  ],
};

