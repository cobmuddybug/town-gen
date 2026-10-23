// How a household lives, by tier: its dwelling, light, heat, cooking, water,
// diet, drink, dress, arms, bedding and what it has on show.
import { isUrban } from "../core";
import { table } from "../../core/content";
import type { Row } from "../../core/registry";
import type { Module, PanelRow } from "../../core/types";

export interface Living extends Row {
  [field: string]: unknown;
}

const FIELDS = ["dwelling", "light", "heat", "cooking", "water", "diet", "drink", "dress", "arms", "bedding", "display"] as const;
const LABELS: Record<string, string> = {
  dwelling: "Dwelling", light: "Light", heat: "Heat", cooking: "Cooking", water: "Water", diet: "Diet",
  drink: "Drink", dress: "Dress", arms: "Arms", bedding: "Bedding", display: "Showpiece",
};

const HOUSING = new Set(["tenement", "poor_row", "journeyman_house", "townhouse", "cottage", "farmhouse", "empty"]);
const SHOP_DWELLING = ["the shop on the street, two rooms above it, rented from a landlord", "the workshop below and the family in the one chamber above", "the shop, a back room behind it, and a loft for the children"];

import livingYaml from "./content/living.yaml";
import livingTownYaml from "./content/living-town.yaml";

/** The Materials component: how a household lives, drawn from its tier (LF Tables 2:2-2:16). */
export const materials: Module = {
  id: "materials",
  version: "1.0.0",
  requires: ["core", "households"],
  provides: ["living"],
  register(add) {
    add("living", table<Living>(livingYaml, "living"));
    add("living", table<Living>(livingTownYaml, "town living"));
  },
  hooks: {
    onHouseholdResolved(ctx, h) {
      const reg = ctx.registry<Living>("living");
      // Towns and cities live differently from the country (LF pp.83-84).
      const town = isUrban(ctx.town);
      const row = (town ? reg.find(`town:${h.get("tier")}`) : undefined) ?? reg.find(h.get("tier")) ?? reg.find("lower_lower")!;
      // A town household that keeps a shop lives over it, whatever its tier.
      const b = ctx.town.get(ctx.town.parentOf(h.address)!);
      const keepsShop = town && h.address.endsWith("/household:0") && !HOUSING.has(b.get<string>("use"));
      for (const f of FIELDS) {
        let opts = row[f] as (string | null)[] | undefined;
        if (f === "dwelling" && keepsShop && /lower/.test(h.get<string>("tier"))) opts = SHOP_DWELLING;
        if (!opts?.length) continue;
        ctx.gen(h, `living.${f}`, (r) => r.pick(opts!));
      }
    },
  },
  panels: [
    {
      id: "materials",
      title: "How they live",
      for: "household",
      order: 10,
      rows(_town, h) {
        const rows: PanelRow[] = [];
        for (const f of FIELDS) {
          const v = h.get<string | null>(`living.${f}`);
          if (v) rows.push({ label: LABELS[f], value: v, key: `living.${f}`, rerollable: true });
        }
        return rows;
      },
    },
  ],
};
