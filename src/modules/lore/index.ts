// Place lore: the tales a place tells about itself, tied to its buildings;
// its customs and its children's rhymes; and now and then a wonder or a
// fright that goes round the alehouses. All our own words.
import { formatDate, fromJdn, jdn } from "../../core/calendar";
import { data } from "../../core/content";
import type { Town } from "../../core/town";
import type { Module, PanelRow } from "../../core/types";
import { isUrban } from "../core";
import { hourOf, type Rumour, type RumourSource } from "../gossip";
import loreYaml from "./content/lore.yaml";

interface LoreData { tales: Record<string, string[]>; customs: string[]; rhymes: string[]; wonders: string[] }
const content = data<LoreData>(loreYaml);

// Which tales a building's use draws on.
const KIND: Record<string, string> = {
  fane: "church", temple: "church", grand_temple: "church", chapel: "church", inn: "inn", tavern: "inn", alehouse: "alehouse",
  town_alehouse: "alehouse", mill: "mill", watermill: "mill", gatehouse: "gate", gaol: "gaol", market_hall: "market",
  cottage: "old", tenement: "old", townhouse: "old", farmhouse: "old", empty: "old",
};

export const lore: Module = {
  id: "lore",
  version: "1.0.0",
  requires: ["core", "uses"],
  register(add) {
    add<RumourSource>("rumourSources", [{ id: "lore", rumours: wonders, source: "our own" }]);
  },
  hooks: {
    onSettlementGenerated(ctx, s) {
      ctx.gen(s, "lore.customs", (r) => r.shuffle(content.customs).slice(0, r.int(2, 4)));
      ctx.gen(s, "lore.rhyme", (r) => r.pick(content.rhymes));
    },
    onBuildingResolved(ctx, b) {
      const kind = KIND[b.get<string>("use")];
      if (!kind) return;
      // Every church and inn has a tale; one ordinary house in twenty.
      const odds = kind === "old" ? 0.04 : kind === "alehouse" ? 0.3 : 0.8;
      ctx.gen(b, "lore.tale", (r) => (r.chance(odds) ? r.pick(content.tales[kind]) : null));
    },
  },
  panels: [
    {
      id: "lore-building",
      title: "Lore",
      for: "building",
      order: 2.5,
      rows(_town, b) {
        const t = b.get<string | null>("lore.tale");
        return t ? [{ label: "They say", value: t, key: "lore.tale", rerollable: true }] : [];
      },
    },
    {
      id: "lore-place",
      title: "Customs and sayings",
      for: "settlement",
      order: 1.9,
      rows(_town, s) {
        const rows: PanelRow[] = (s.get<string[]>("lore.customs") ?? []).map((c) => ({ label: "Custom", value: c }));
        const rhyme = s.get<string>("lore.rhyme");
        if (rhyme) rows.push({ label: "The children sing", value: rhyme, key: "lore.rhyme", rerollable: true });
        return rows;
      },
    },
  ],
};

/** A wonder or a fright every month or two. */
function wonders(town: Town, year: number): Rumour[] {
  const out: Rumour[] = [];
  const first = jdn({ y: year, m: 1, d: 1 });
  const every = isUrban(town) ? 40 : 70;
  for (let j = first; j < first + 365; j += every) {
    const r = town.rngFor(town.root, lore, `wonder:${j}`);
    if (!r.chance(0.6)) continue;
    const day = formatDate(fromJdn(j + r.int(0, every - 1)));
    if (Number(day.slice(0, 4)) !== year) continue;
    const t = r.pick(content.wonders);
    out.push({ id: `wonder/${day}`, kind: "news", topic: "lore:wonder", start: hourOf(day, "evening"), origin: town.root, texts: [t, `${t}, and there's worse that nobody will say`, `${t}, though some say it was only the drink`], about: [], lastToKnow: [], how: "seen with their own eyes, they swear" });
  }
  return out;
}
