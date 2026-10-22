// Prices and the market: a harvest each year, prices that follow it and the
// season, and what each shop has on its board today. Pure functions of the
// seed and the date. Our own round numbers.
import { formatDate, parseDate, weekday, WEEKDAYS } from "../../core/calendar";
import { data } from "../../core/content";
import { Rng } from "../../core/rng";
import type { Town } from "../../core/town";
import type { Module, PanelRow } from "../../core/types";
import { lsd } from "../households";
import { hourOf, type Rumour, type RumourSource } from "../gossip";
import marketYaml from "./content/market.yaml";

interface Price { id: string; label: string; price: number; food?: boolean; season?: number[]; note?: string; needs?: string[]; hamlet?: boolean }
interface Harvest { id: string; label: string; mult: number; weight: number }
interface MarketData { prices: Price[]; harvest: Harvest[]; stock: Record<string, [string, number][]> }
const content = data<MarketData>(marketYaml);

/** The harvest that feeds a year: last autumn's, which runs out by spring. */
export function harvestOf(town: Town, year: number): Harvest {
  // The weather of the region, not of the town: neighbours share a bad year.
  return new Rng(`harvest|${town.seed.slice(0, 3)}|${year}`).weighted(content.harvest, (h) => h.weight);
}

/** How dear food is today: last harvest, worse towards summer's hungry gap. */
export function dearness(town: Town, date: string): number {
  const d = parseDate(date);
  // Until the new harvest is in (August), we live on last year's.
  const h = harvestOf(town, d.m >= 9 ? d.y : d.y - 1);
  const gap = d.m >= 4 && d.m <= 7 ? 1 + (h.mult - 1) * 0.6 + 0.08 : 1;
  return h.mult * gap;
}

const money = (p: number) => (p < 1 ? (p <= 0.25 ? "a farthing" : p <= 0.5 ? "a halfpenny" : "three farthings") : lsd(Math.round(p)));

/** Today's price of a thing, in pence. */
export function priceOf(town: Town, id: string, date: string): number {
  const p = content.prices.find((x) => x.id === id);
  if (!p) return 0;
  return p.food ? p.price * dearness(town, date) : p.price;
}

export const market: Module = {
  id: "market",
  version: "1.0.0",
  requires: ["core", "uses", "gossip"],
  register(add) {
    add<RumourSource>("rumourSources", [{ id: "prices", rumours: priceTalk, source: "our own" }]);
  },
  panels: [
    {
      id: "prices",
      title: "Prices",
      for: "settlement",
      order: 1.7,
      rows(town) {
        const date = town.clock.date;
        const d = parseDate(date);
        const h = harvestOf(town, d.m >= 9 ? d.y : d.y - 1);
        const k = dearness(town, date);
        const rows: PanelRow[] = [{ label: "Harvest", value: h.label }];
        const uses = new Set(town.children(town.root, "building").map((b) => b.get<string>("use")));
        for (const p of content.prices) {
          if (p.season && !p.season.includes(d.m)) continue;
          if (p.needs && !p.needs.some((u) => uses.has(u))) continue;
          if (p.hamlet && (uses.has("cookshop") || uses.has("inn"))) continue;
          const v = p.food ? p.price * k : p.price;
          // The farthing loaf keeps its price; its weight changes with the corn.
          if (p.id === "loaf") { rows.push({ label: p.label, value: `${Math.round(16 / k)} oz by the assize of bread` }); continue; }
          rows.push({ label: p.label, value: money(v) });
        }
        return rows;
      },
    },
    {
      id: "stock",
      title: "On the board",
      for: "building",
      order: 1.5,
      rows(town, b) {
        const items = content.stock[b.get<string>("use")];
        if (!items) return [];
        const date = town.clock.date;
        const r = new Rng(`stock|${town.seed}|${b.address}|${date}`);
        const k = dearness(town, date);
        const food = /butcher|fish|poult|bake|cook|alehouse|tavern|inn|hay/.test(b.get<string>("use"));
        const shut = WEEKDAYS[weekday(date)] === "Sunday";
        if (shut) return [{ label: "Shut", value: "the shutters up for Sunday; knock at the side door if you must" }];
        return r.shuffle(items).slice(0, Math.min(items.length, r.int(3, 5))).map(([what, p]) => {
          const v = p * (food ? k : 1) * r.range(0.9, 1.15);
          return { label: what, value: r.chance(0.08) ? "sold out today" : money(v) };
        });
      },
    },
  ],
};

/** Talk about prices: when the harvest is poor, the price of bread is news every few weeks. */
function priceTalk(town: Town, year: number): Rumour[] {
  const out: Rumour[] = [];
  for (let m = 1; m <= 12; m++) {
    const date = formatDate({ y: year, m, d: 10 });
    const k = dearness(town, date);
    if (k < 1.3 && !(m === 9 && harvestOf(town, year).mult < 0.9)) continue;
    const t = m === 9 && k < 1.3 ? "the harvest's in, and a good one: bread will be cheap this winter"
      : k >= 2 ? "bread at twice its price, and the poor are eating bran and nettles"
      : "the price of bread is up again, and the baker's loaves are lighter every week";
    out.push({ id: `prices/${date}`, kind: "news", topic: "prices", start: hourOf(date, "forenoon"), origin: town.root, texts: [t, t, `${t}, and they say the bakers are hoarding`], about: [], lastToKnow: [], how: "everyone who buys bread knows" });
  }
  return out;
}
