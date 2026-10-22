import { table } from "../../core/content";
import type { Row } from "../../core/registry";
import type { Module } from "../../core/types";
import type { Base, Material } from "../core";
import usesYaml from "./content/uses.yaml";
import occupationsYaml from "./content/occupations.yaml";
import urbanYaml from "./content/urban.yaml";
import urbanOccupationsYaml from "./content/urban-occupations.yaml";
import { planUrban, rollLayout, type UrbanPlan } from "./urban";

export interface BuildingUse extends Row {
  label: string;
  category: string;
  size: string;
  site?: string;
  /** a fixed count, or a range rolled per building */
  households: number | [number, number];
  occupations: Record<string, number>;
  congregation?: number;
  lets_rooms?: number;
  avgSize?: number;
  /** street plans: about one per this many people, and none below `min_pop` */
  per?: number;
  min_pop?: number;
  plots?: number;
  value?: [number, number];
  look?: string;
  /** street plans: copies keep together (a shambles) rather than spreading out */
  cluster?: boolean;
}

export interface StaffSpec { occupation: string; n: [number, number]; role: string; sex?: "m" | "f" }

export interface Occupation extends Row {
  label: string;
  tier: string;
  byname?: string;
  female?: boolean;
  celibate?: boolean;
  land?: [number, number];
  stake?: [number, number];
  servants?: [number, number];
  guild?: string;
  /** the head is always a man */
  male?: boolean;
  apprentices?: [number, number];
  staff?: StaffSpec[];
  routine?: string;
}

/** Above this many people the layout is a street plan, not a hamlet. */
export const STREET_PLAN_POP = 700;
/** Above this many the building plan is urban (trades by population, housing by composition). */
export const URBAN_PLAN_POP = 1000;

// Wall and roof ladders, cheapest first (LF p.79), for street plans, by era.
// Brick returns to England only late; plank roofs were never usual; chimneys
// belong to the rich and the stone-built before the 14th century.
const WALL_LADDERS: Record<string, string[]> = {
  early_medieval: ["wattle_and_daub", "timber_and_board", "timber_and_plaster", "timber_and_stone", "stone"],
  high_medieval: ["wattle_and_daub", "timber_and_board", "timber_and_plaster", "timber_and_plaster", "timber_and_stone", "stone"],
  late_medieval: ["wattle_and_daub", "timber_and_plaster", "timber_and_brick", "timber_and_stone", "brick", "stone"],
  early_modern: ["wattle_and_daub", "timber_and_board", "timber_and_plaster", "timber_and_brick", "timber_and_stone", "brick", "stone"],
};
const ROOF_LADDERS: Record<string, string[]> = {
  early_medieval: ["thatch", "thatch", "shingle", "slate", "lead"],
  high_medieval: ["thatch", "shingle", "tile", "slate", "lead"],
  late_medieval: ["thatch", "tile", "tile", "slate", "lead"],
  early_modern: ["thatch", "tile", "tile", "slate", "lead"],
};
// Chance of a chimney by ward value (0-8), per era.
const CHIMNEY: Record<string, (value: number) => number> = {
  early_medieval: () => 0,
  high_medieval: (v) => (v >= 6 ? 0.45 : v >= 4 ? 0.08 : 0),
  late_medieval: (v) => (v >= 5 ? 0.8 : v >= 3 ? 0.35 : 0.05),
  early_modern: (v) => (v >= 3 ? 0.85 : 0.4),
};
// Streets that make a frontage worth building up.
const MAIN = new Set(["market", "road", "street", "quay"]);

// Average size of a household in a special building, used only to budget
// how many ordinary houses to plan.
const OTHER_SIZE = 4.2;

const CONDITIONS = ["sound", "sound", "sound", "weathered", "weathered", "in want of mending", "newly built"];

export const uses: Module = {
  id: "uses",
  version: "2.1.0",
  requires: ["core"],
  provides: ["buildingUses", "occupations"],
  register(add) {
    add("buildingUses", table<BuildingUse>(usesYaml, "uses"));
    add("buildingUses", table<BuildingUse>(urbanYaml, "urban uses"));
    add("occupations", table<Occupation>(occupationsYaml, "occupations"));
    add("occupations", table<Occupation>(urbanOccupationsYaml, "urban occupations"));
  },
  hooks: {
    onSettlementGenerated(ctx, s) {
      const pop = s.get<number>("targetPop");
      const base = ctx.registry<Base>("bases").get(s.get("base"));
      const useReg = ctx.registry<BuildingUse>("buildingUses");
      const sizeClass = s.get<string>("sizeClass");
      if (pop > URBAN_PLAN_POP) {
        // Big villages, towns and cities: see urban.ts.
        const enclosure = s.get<string>("enclosure");
        const walled = /wall|palisade/.test(enclosure);
        const u = ctx.gen(s, "plan", (r) => planUrban(r, pop, sizeClass, base, ctx.era, useReg, walled, ctx.town.settings.lordship === "manorial", ctx.town.settings.design)) as unknown as UrbanPlan;
        ctx.set(s, "plan", u.plan);
        ctx.set(s, "layoutPlan", u.layout);
        ctx.set(s, "farBank", u.farBank);
        ctx.set(s, "farUses", u.far);
        ctx.set(s, "mainRoads", u.roads);
        ctx.set(s, "quarters", u.quarters);
      } else ctx.gen(s, "plan", (r) => {
        const special: string[] = [];
        for (const u of base.core) {
          if (u === "place_of_worship") special.push(pop >= 120 ? "chapel" : "shrine");
          else special.push(u);
        }
        // A manor has the lord's house and demesne barn, and often a socman (LF pp.77-78).
        if (ctx.town.settings.lordship === "manorial") {
          special.push("manor_house");
          if (r.chance(0.6)) special.push("socman_house");
        }
        const extras = Math.max(0, Math.floor((pop - 250) / 100));
        for (const u of base.extras.slice(0, extras)) if (useReg.has(u)) special.push(u);
        const fill = Object.entries(base.fill).filter(([u]) => useReg.has(u));
        const avg = fill.reduce((a, [u, share]) => a + share * (useReg.get(u).avgSize ?? 4.2), 0);
        const rest = Math.max(4, pop - special.length * OTHER_SIZE);
        const dwellings = Math.max(4, Math.round(rest / avg));
        // The first fill use is the base's own kind of house; vary its share a little.
        const firstShare = fill[0][1] * r.range(0.85, 1.15);
        const nFirst = Math.max(2, Math.round(dwellings * firstShare));
        const houses: string[] = [];
        for (let i = 0; i < dwellings; i++) houses.push(i < nFirst ? fill[0][0] : (fill[1] ?? fill[0])[0]);
        if (r.chance(0.35)) houses.push("empty");
        return [...special.filter((u) => useReg.has(u)), ...r.shuffle(houses)];
      });
      if (pop > STREET_PLAN_POP && pop <= URBAN_PLAN_POP) {
        ctx.gen(s, "mainRoads", (r) => { const n = r.int(3, 4); return ctx.town.settings.design?.gates ?? n; });
        // A big village's street plan rolls its layout too; a river town's far bank adds to the plan.
        const roll = ctx.gen(s, "layoutRoll", (r) => {
          const plan = [...s.get<string[]>("plan")];
          return { plan, ...rollLayout(r, plan, pop, base, useReg, ctx.town.settings.design) };
        });
        ctx.set(s, "plan", roll.plan);
        ctx.set(s, "layoutPlan", roll.layout);
        ctx.set(s, "farBank", roll.farBank);
        ctx.set(s, "farUses", roll.far);
      }
      const plan = s.get<string[]>("plan");
      // "Usually richest" (LF pp.72-75): one of the base's richest trades that
      // is actually practised here.
      const practised = new Set(plan.flatMap((u) => Object.keys(useReg.find(u)?.occupations ?? {})));
      const candidates = base.richest.filter((o) => practised.has(o));
      ctx.gen(s, "richestTrade", (r) => (candidates.length ? r.pick(candidates) : base.richest[0]));
      ctx.set(s, "buildingCount", plan.length);
    },

    onBuildingResolved(ctx, b) {
      const plan = ctx.town.settlement().get<string[]>("plan");
      ctx.set(b, "use", plan[b.get<number>("planIndex")] ?? "empty");
      const use = ctx.registry<BuildingUse>("buildingUses").find(b.get("use"));
      const base = ctx.registry<Base>("bases").get(ctx.town.settlement().get("base"));
      if (b.get("ward") !== undefined) return streetPlanConstruction(ctx, b, use);
      ctx.gen(b, "walls", (r) => {
        if (use?.id === "chapel" || use?.id === "mill") return r.chance(0.6) ? "fieldstone" : "timber_and_plaster";
        return r.pick(base.walls);
      });
      ctx.gen(b, "roof", (r) => (use?.id === "chapel" && r.chance(0.5) ? "shingle" : r.pick(base.roofs)));
      ctx.gen(b, "storeys", (r) => (use?.id === "mill" ? 2 : use?.size === "inn" && r.chance(0.4) ? 2 : 1));
      ctx.gen(b, "condition", (r) => (use?.id === "empty" ? r.pick(["ruinous", "roofless", "shut up", "falling in"]) : r.pick(CONDITIONS)));
      ctx.gen(b, "hearth", (r) => {
        if (use?.id === "chapel" || use?.id === "shrine") return "none";
        if (use?.id === "smithy") return "a forge, and an open hearth behind";
        const roof = b.get<string>("roof");
        return r.chance(0.85) ? `open hearth, smoke out through ${roof === "thatch" ? "the thatch" : roof === "turf" ? "a hole in the turf" : "a louvre in the roof"}` : "hearth against a stone fire-back";
      });
    },
  },
  panels: [
    {
      id: "building",
      title: "Building",
      for: "building",
      order: 0,
      rows(town, b) {
        const useReg = town.registry<BuildingUse>("buildingUses");
        const mats = town.registry<Material>("materials");
        const use = useReg.find(b.get("use"));
        return [
          { label: "Use", value: use?.label ?? b.get<string>("use"), key: "use", options: useReg.list(town.settings.era).map((u) => u.id) },
          { label: "Walls", value: mats.find(b.get("walls"))?.label ?? b.get<string>("walls"), key: "walls", rerollable: true },
          { label: "Roof", value: mats.find(b.get("roof"))?.label ?? b.get<string>("roof"), key: "roof", rerollable: true },
          { label: "Storeys", value: b.get<number>("storeys") },
          { label: "Condition", value: b.get<string>("condition"), key: "condition", rerollable: true },
          { label: "Hearth", value: b.get<string>("hearth"), rerollable: true, key: "hearth" },
        ];
      },
    },
  ],
  label(town, e) {
    if (e.type !== "building") return undefined;
    const use = town.registry<BuildingUse>("buildingUses").find(e.get("use"));
    return use ? use.label[0].toUpperCase() + use.label.slice(1) : undefined;
  },
};

const STONE = new Set(["grand_temple", "temple", "fane", "chapel", "chantry", "friary", "priory", "cell", "abbey", "nunnery", "castle", "gatehouse", "guildhall", "courthouse", "gaol"]);

/** Street plans: the ward's value class and the use pick from the cost ladders (LF p.79). */
function streetPlanConstruction(ctx: import("../../core/types").Ctx, b: import("../../core/types").EntityLike, use: BuildingUse | undefined) {
  const s = ctx.town.settlement();
  const map = s.get<{ wards: { value: number }[]; kind?: string }>("map");
  const value = map.wards?.[b.get<number>("ward")]?.value ?? 2;
  const urban = /town|city/.test(s.get<string>("sizeClass"));
  const id = use?.id ?? "empty";
  const era = ctx.era;
  const WALL_LADDER = WALL_LADDERS[era] ?? WALL_LADDERS.high_medieval, ROOF_LADDER = ROOF_LADDERS[era] ?? ROOF_LADDERS.high_medieval;
  ctx.gen(b, "walls", (r) => {
    if (STONE.has(id)) return id === "chapel" && r.chance(0.4) ? "timber_and_stone" : "stone";
    // Up the ladder with the ward's value, a step either way.
    const k = Math.round((value / 8) * (urban ? WALL_LADDER.length - 2 : 3) + r.range(-1, 1));
    return WALL_LADDER[Math.max(0, Math.min(WALL_LADDER.length - 2, k))];
  });
  ctx.gen(b, "roof", (r) => {
    if (id === "grand_temple" || id === "temple") return "lead";
    if (STONE.has(id)) return r.pick(["tile", "slate", "lead"]);
    // Towns forbid thatch where they can, for fear of fire.
    const k = Math.round((value / 8) * (urban ? 3 : 2) + r.range(-1, 1) + (urban ? 1 : 0));
    return ROOF_LADDER[Math.max(0, Math.min(ROOF_LADDER.length - 2, k))];
  });
  // Storeys follow the plot: a cottage stays low; houses on the main street
  // and the market build up, the more so where ground is dear.
  const main = MAIN.has(b.get<string>("road") ?? "");
  ctx.gen(b, "storeys", (r) => {
    if (!urban) return use?.size === "inn" || use?.size === "merchant" ? 2 : r.chance(0.25) ? 2 : 1;
    if (STONE.has(id) || id === "market_hall") return id === "gatehouse" ? 2 : 1;
    if (id === "cottage" || id === "farmhouse" || id === "poor_row") return r.chance(value >= 3 ? 0.4 : 0.15) ? 2 : 1;
    const top = id === "tenement" || id === "townhouse" || id === "merchant_house" ? 4 : 3;
    const n = 1.2 + value / 4 + (main ? 0.8 : 0) + (s.get<string>("sizeClass") === "city" ? 0.4 : 0) + r.range(-0.6, 0.6);
    return Math.max(1, Math.min(top, Math.round(n)));
  });
  ctx.gen(b, "condition", (r) => (id === "empty" ? r.pick(["ruinous", "shut up", "half pulled down"]) : value <= 1 && r.chance(0.4) ? r.pick(["sagging", "patched and leaning", "damp through"]) : r.pick(CONDITIONS)));
  ctx.gen(b, "hearth", (r) => {
    if (["grand_temple", "temple", "fane", "chapel", "chantry", "shrine", "market_hall", "empty"].includes(id)) return "none";
    if (id === "town_smithy" || id === "armourer" || id === "cutler") return "a forge, and a hearth behind";
    if (id === "cookshop" || id === "bakehouse" || id === "inn" || id === "tavern") return "great ovens and a kitchen hearth";
    // Lower-class town households often have no hearth fit for cooking (LF p.63).
    if (value <= 2 && r.chance(0.6) && !["farmhouse", "cottage"].includes(id)) return "a brazier only; food goes to the cookshop or bakehouse";
    return r.chance((CHIMNEY[era] ?? CHIMNEY.high_medieval)(value)) ? "a chimneyed hearth" : r.chance(0.5) ? "an open hearth, smoke out through a louvre" : "a hearth with a smoke hood, and a stone fire-back";
  });
}
