// Core: the tables everything else reads (tiers of wealth, bases, size classes,
// materials, kinds of edge), and the first facts about a settlement: its size
// class, base, terrain, fuel, charter and what encloses it.
import { table } from "../../core/content";
import type { Row } from "../../core/registry";
import type { EdgeKind, Module } from "../../core/types";
import tiersYaml from "../../../content/tiers.yaml";
import basesYaml from "./content/bases.yaml";
import sizesYaml from "./content/sizes.yaml";
import materialsYaml from "./content/materials.yaml";
import { STREET_PLAN_POP } from "../uses";

export interface Tier extends Row { label: string; class: string; rank: number; income: number }
export interface Base extends Row {
  label: string; terrain: string; core: string[]; fill: Record<string, number>; extras: string[];
  walls: string[]; roofs: string[]; fuel: string; stake: string;
  richest: string[]; grievance: string; dispute: string; disputes: string[];
}
export interface SizeClass extends Row { label: string; min: number; max: number }
export interface Material extends Row { kind: "wall" | "roof"; cost: number; label: string }

/** A market town or bigger (LF's "village" of 1,001 and up has walls, wards, guilds and a market):
 * it gets town ways of life, town institutions and town talk. */
export function isUrban(town: { settlement(): { get<T>(k: string): T } }): boolean {
  return !/^(hamlet|thorp)$/.test(town.settlement().get<string>("sizeClass"));
}

const edgeKinds: EdgeKind[] = [
  { id: "kin", label: "kin of" },
  { id: "spouse", label: "spouse of", symmetric: true },
  { id: "betrothed", label: "betrothed to", symmetric: true },
  { id: "lover", label: "lover of", symmetric: true },
  { id: "employer", label: "employs", inverse: "employed by" },
  { id: "serves", label: "servant to", inverse: "master of" },
  { id: "apprentice_of", label: "apprentice to", inverse: "master of" },
  { id: "tenant_of", label: "tenant of", inverse: "landlord of" },
  { id: "debtor_of", label: "owes money to", inverse: "is owed money by" },
  { id: "rival", label: "rival of", symmetric: true },
  { id: "friend", label: "friend of", symmetric: true },
  { id: "godparent", label: "godparent of", inverse: "godchild of" },
  { id: "member_of", label: "member of", inverse: "has member" },
  { id: "office_in", label: "holds office in", inverse: "office held by" },
  { id: "vassal_of", label: "vassal of", inverse: "liege of" },
  { id: "owes_service", label: "owes service to", inverse: "is owed service by" },
  { id: "grievance", label: "has a grievance against", inverse: "is resented by" },
  { id: "dispute", label: "in dispute with", symmetric: true },
];

export const core: Module = {
  id: "core",
  version: "1.0.0",
  provides: ["tiers", "bases", "sizes", "materials", "edgeKinds", "sifters", "nameProviders"],
  register(add) {
    add("tiers", table<Tier>(tiersYaml, "tiers"));
    add("bases", table<Base>(basesYaml, "bases"));
    add("sizes", table<SizeClass>(sizesYaml, "sizes"));
    add("materials", table<Material>(materialsYaml, "materials"));
    add("edgeKinds", edgeKinds);
  },
  hooks: {
    onSettlementGenerated(ctx, s) {
      const { pop, base, era } = ctx.town.settings;
      const size = ctx.registry<SizeClass>("sizes").list().find((c) => pop >= c.min && pop <= c.max)!;
      const b = ctx.registry<Base>("bases").get(base);
      ctx.set(s, "sizeClass", size.id);
      ctx.set(s, "lordship", ctx.town.settings.lordship ?? "free");
      ctx.set(s, "base", b.id);
      ctx.set(s, "era", era);
      ctx.set(s, "targetPop", pop);
      // A market town buys its fuel: nobody burns dung inside the walls.
      ctx.set(s, "fuel", pop > 1000 ? (b.id === "mining" ? "sea-coal for the smiths, wood and charcoal for everyone else" : "wood and charcoal, bought by the cartload from the woodmongers; turf for the poor") : b.fuel);
      ctx.set(s, "terrain", b.terrain);
      // "Usually richest" (LF p.73): most of the time the rule holds.
      ctx.gen(s, "richestRuleHolds", (r) => r.chance(0.8));
      if (ctx.town.settings.lordship === "manorial") ctx.set(s, "charter", "manorial");
      else ctx.gen(s, "charter", (r) => (size.id === "hamlet" ? "lord-held" : r.pick(["lord-held", "lord-held", "chartered"])));
      // A street plan's walls can be the DM's choice (settings.design).
      const walls = pop > STREET_PLAN_POP ? ctx.town.settings.design?.walls : undefined;
      ctx.gen(s, "enclosure", (r) => {
        if (walls) return walls === "wall" ? "stone wall" : walls === "palisade" ? "earth bank and palisade" : "nothing; the place lies open";
        if (size.id === "hamlet") return r.pick(["hedge", "hedge", "fence"]);
        if (size.id === "thorp") return "palisade";
        if (size.id === "village") return r.pick(["hedge and ditch", "palisade", "palisade", "bank and ditch"]);
        // Towns wall themselves when they can afford it; early on, earth and timber.
        if (era === "early_medieval") return "earth bank and palisade";
        return size.id === "city" || r.chance(0.85) ? "stone wall" : "earth bank and palisade";
      });
    },
  },
  panels: [
    {
      id: "settlement",
      title: "Settlement",
      for: "settlement",
      order: 0,
      rows(town, s) {
        const size = town.registry<SizeClass>("sizes").get(s.get("sizeClass"));
        return [
          { label: "Size", value: s.get("lordship") === "manorial" ? `manorial village (${size.label}-sized)` : size.label },
          { label: "Economy", value: s.get<string>("base") },
          { label: "Era", value: s.get<string>("era").replace("_", " ") },
          s.get("lordship") === "manorial"
            ? { label: "Holding", value: "owned outright by its lord" }
            : { label: "Holding", value: s.get<string>("charter"), key: "charter", options: ["lord-held", "chartered", "free"] },
          { label: "Enclosed by", value: s.get<string>("enclosure"), key: "enclosure", rerollable: true },
          { label: "Fuel", value: s.get<string>("fuel") },
        ];
      },
    },
  ],
};
