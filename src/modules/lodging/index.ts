import { parseDate } from "../../core/calendar";
import type { Module, PanelRow } from "../../core/types";
import { lsd } from "../households";
import { isStreetPlan, type MapData } from "../layout";
import type { NameProvider } from "../names";
import type { BuildingUse } from "../uses";
import { visitorsOn } from "../visitors";

// Lodging (LF pp.93-94): who stays where, at what grade, for how much. Who
// is staying tonight is a pure function of the date, like routines.

type Quality = "poor" | "common" | "good" | "extravagant";

const KIND: Record<string, { serves: string; meals: string; stabling?: string }> = {
  inn: { serves: "aristocrats and the middle class: merchants, lawyers, gentry on the road", meals: "dinner and supper in the hall, or in a private room for those who pay", stabling: "stabling for twenty horses, a coach barn, and a locked room for goods in transit" },
  tavern: { serves: "everyone", meals: "food at most hours, wine and ale" },
  town_alehouse: { serves: "locals", meals: "bread and cheese with the ale; a room or two above" },
  alehouse: { serves: "locals", meals: "bread and cheese with the ale; a room or two above" },
  rooming_house: { serves: "the lower middle and upper lower class, staying a week or more", meals: "meals at fixed hours, and narrow ones: miss supper and go without" },
  hostel: { serves: "the poor", meals: "a light breakfast; a dormitory" },
  sleeping_house: { serves: "whoever the taverns turned away", meals: "none; a bench or a share of a bed" },
};

const PRICE: Record<Quality, number> = { poor: 1, common: 2, good: 4, extravagant: 12 };

const GUESTS = [
  "a wool merchant from {place}", "two pilgrims bound for {place}", "a drover with beasts for the market", "a lawyer and his clerk",
  "a carrier from {place} and his boy", "a pedlar with a pack of ribbons", "a knight's squire carrying letters", "a mason looking for work on the church",
  "a widow travelling to her son at {place}", "a minstrel who sings for his supper", "three journeymen walking the country", "a priest on his bishop's business",
  "a horse dealer, loud", "a man who says he is a merchant and has no goods",
];

export const lodging: Module = {
  id: "lodging",
  version: "1.0.0",
  requires: ["core", "uses", "layout", "households", "names", "visitors"],
  hooks: {
    onBuildingResolved(ctx, b) {
      if (!isStreetPlan(ctx.town)) return;
      const use = ctx.registry<BuildingUse>("buildingUses").find(b.get("use"));
      if (!use?.lets_rooms || !KIND[use.id]) return;
      const map = ctx.town.settlement().get<MapData>("map");
      const value = map.wards?.[b.get<number>("ward") ?? 0]?.value ?? 2;
      ctx.gen(b, "lodging.quality", (r): Quality => {
        if (use.id === "hostel" || use.id === "sleeping_house") return "poor";
        if (use.id === "inn") return value >= 6 && r.chance(0.3) ? "extravagant" : r.chance(0.7) ? "good" : "common";
        if (use.id === "tavern") return value >= 5 && r.chance(0.5) ? "good" : r.chance(0.8) ? "common" : "poor";
        if (use.id === "rooming_house") return r.chance(0.7) ? "common" : "poor";
        return r.chance(0.6) ? "poor" : "common";
      });
      ctx.gen(b, "lodging.rooms", (r) => Math.max(1, Math.round(use.lets_rooms! * r.range(0.7, 1.4))));
      if (use.id === "tavern") ctx.gen(b, "lodging.trade", (r) => (r.chance(0.4) ? "travellers" : "locals"));
    },
  },
  panels: [
    {
      id: "lodging",
      title: "Lodging",
      for: "building",
      order: 1,
      rows(town, b) {
        const q = b.get<Quality | undefined>("lodging.quality");
        if (!q) return [];
        const use = b.get<string>("use");
        const k = KIND[use];
        const rooms = b.get<number>("lodging.rooms");
        const trade = b.get<string | undefined>("lodging.trade");
        const rows: PanelRow[] = [
          { label: "Grade", value: q, key: "lodging.quality", options: ["poor", "common", "good", "extravagant"] },
          { label: "Serves", value: trade === "travellers" ? "travellers: more rooms and stabling, less drinking" : trade === "locals" ? "locals: more drinking than beds" : k.serves, hint: "LF pp.93-94" },
          { label: "Rooms", value: `${rooms} to let`, key: "lodging.rooms" },
          { label: "A night", value: `${lsd(PRICE[q])} a head${q === "poor" ? ", sharing" : ""}`, hint: "abstract value; compare, don't price" },
          { label: "Meals", value: k.meals },
        ];
        if (k.stabling || trade === "travellers") rows.push({ label: "Stabling", value: k.stabling ?? "a yard and stalls for a few horses" });
        // Tonight: busier in summer, full at the fair and the assizes.
        const { date } = town.clock;
        const r = town.rngFor(b.address, lodging, `guests:${date}`);
        const m = parseDate(date).m;
        let fill = m >= 5 && m <= 9 ? r.range(0.4, 0.9) : r.range(0.1, 0.5);
        if (visitorsOn(town, date).some((v) => (v.kind === "fair" && v.local) || v.kind === "assize")) fill = 1;
        const n = Math.round(rooms * fill * (q === "poor" ? 2 : 1));
        const names = town.registry<NameProvider>("nameProviders").get("anglo-norman");
        const who = r.shuffle(GUESTS).slice(0, Math.min(3, n)).map((g) => g.replace("{place}", () => names.place(r)));
        rows.push({ label: "Tonight", value: n ? `${n} staying: ${who.join("; ")}${n > who.length ? "; and others" : ""}` : "nobody staying" });
        return rows;
      },
    },
  ],
};
