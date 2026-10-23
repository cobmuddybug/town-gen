import { poss } from "../../core/text";
import { isUrban } from "../core";
import { BLOCKS, BLOCK_HOURS, describeDate, fastOn, feastOn, parseDate, weekday, type Block } from "../../core/calendar";
import { data } from "../../core/content";
import type { Address } from "../../core/address";
import type { Entity, Town } from "../../core/town";
import type { Module, PanelLink, PanelRow } from "../../core/types";
import type { Row } from "../../core/registry";
import routinesYaml from "./content/routines.yaml";
import { visitorsOn } from "../visitors";
import type { BuildingUse, Occupation } from "../uses";
import { capacityOf, isStreetPlan, nearestBuilding, nearestBuildings } from "../layout";
import { weatherOn } from "../weather";
import { patronalOn, patronOf } from "../religion";
import type { Tier } from "../core";

// Where is everyone right now? Routines are pure functions of the person, the
// date and the block: nothing is stored, so the clock can move freely.

interface Slot { where: string; doing: string }
interface RoutineData {
  templates: Record<string, Record<Block, Slot>>;
  months: Record<string, Record<string, string> & { out?: string[] }>;
}
const content = data<RoutineData>(routinesYaml);

export interface Whereabouts {
  /** a building address, or a place key: place:green, place:fields, place:pasture, place:roads, place:away */
  where: string;
  label: string;
  doing: string;
}

export const PLACES: Record<string, string> = {
  "place:green": "on the green",
  "place:fields": "out in the fields",
  "place:pasture": "on the common pasture",
  "place:roads": "on the roads",
  "place:sea": "at sea",
  "place:shore": "on the beach",
  "place:mine": "down the mine",
  "place:woods": "in the woods",
  "place:away": "nobody knows where",
  "place:fair": "away at the fair",
  "place:demesne": "on the lord's demesne",
  "place:elsewhere": "elsewhere, on the lord's business",
  "place:market": "in the market place",
  "place:streets": "out in the streets",
  "place:walls": "up on the walls",
  "place:river": "down at the river",
  "place:quay": "on the quay",
  "place:grave": "dead and buried",
  "place:gallows": "at the gallows outside the gates",
};

/** Other modules may put someone somewhere for a block (in gaol, at the scene of a crime).
 *  `where` is a building address or a place key. A hook must not call whereabouts(). */
export interface RoutineHook extends Row {
  at(town: Town, person: Address, date: string, block: Block): { where: string; doing: string } | undefined;
}

const DRINK = ["tavern", "town_alehouse", "alehouse", "inn"];
// Where a parish hears mass. A wayside shrine holds a dozen, not a congregation.
const PARISH = ["fane", "temple", "grand_temple", "chapel"];
// Public buildings where somebody may sleep, but nobody receives friends.
const OFFICIAL = new Set(["watch_house", "gatehouse", "guildhall", "market_hall", "courthouse", "gaol", "castle", "school", "hospital", "lazar_house", "friary", "priory", "cell", "abbey", "nunnery"]);
// Trades that keep working when everyone else keeps the feast.
const SERVING = new Set(["alehouse", "innkeeper", "taverner", "bathhouse", "cook"]);
// Offices that put a man on the streets at night (set by the civic module).
const WATCH_OFFICES = new Set(["officer of the watch", "sergeant of the watch", "marshal", "deputy marshal"]);

const FARM = new Set(["large_tenant_farmer", "tenant_farmer", "small_farmer"]);
const CRAFT = new Set(["baker", "smith", "carpenter", "cooper", "chandler", "thatcher", "weaver", "boatwright", "ropemaker",
  "mason", "slater", "netmaker", "carder", "tanner", "sawyer"]);
// Templates whose people follow the head out to work.
const FOLLOW = new Set(["farmer", "labourer", "fisher", "miner", "woodcutter", "shepherd", "craftsman", "town_labourer"]);

function headTemplate(occ: string, town?: Town): string {
  const row = town?.registry<Occupation>("occupations").find(occ);
  if (row?.routine) return row.routine === "labourer" && town && isStreetPlan(town) ? "town_labourer" : row.routine;
  const t = headTemplateHamlet(occ);
  // In a town, a labourer works for whoever hires him, not in the fields.
  return t === "labourer" && town && isStreetPlan(town) ? "town_labourer" : t;
}

function headTemplateHamlet(occ: string): string {
  if (FARM.has(occ)) return "farmer";
  if (occ === "labourer" || occ === "ploughman") return "labourer";
  if (occ === "herdsman" || occ === "cowherd") return "herdsman";
  if (occ === "shepherd") return "shepherd";
  if (occ === "fisherman") return "fisher";
  if (occ === "miner") return "miner";
  if (occ === "woodcutter") return "woodcutter";
  if (occ === "charcoal_burner") return "collier";
  if (occ === "wool_factor" || occ === "assayer") return "shopkeeper";
  if (occ === "freighter") return "carter";
  if (occ === "miller") return "miller";
  if (occ === "general_trader") return "shopkeeper";
  if (occ === "alehouse_keeper" || occ === "alewife") return "alehouse";
  if (occ === "chaplain" || occ === "shrine_keeper") return "chaplain";
  if (occ === "carter") return "carter";
  if (occ === "widow_spinster") return "spinner";
  if (CRAFT.has(occ)) return "craftsman";
  return "labourer";
}

export function templateFor(town: Town, p: Entity): string {
  const age = p.get<number>("age");
  const role = p.get<string>("role");
  const male = p.get("sex") === "m";
  const hh = town.get(town.parentOf(p.address)!);
  const occ = hh.get<string>("occupation");
  if (age < 5) return "infant";
  if (age < 12) return "child";
  const own = p.get<string>("occupation");
  if (role === "cleric" || role === "retainer" || role === "inmate") {
    return town.registry<Occupation>("occupations").find(own)?.routine ?? (role === "cleric" ? "priest" : "servant_house");
  }
  if (age >= 68) return "old";
  if (town.edges({ from: p.address, kind: "apprentice_of" }).length) return "apprentice";
  if (town.edges({ from: p.address, kind: "office_in" }).some((e) => WATCH_OFFICES.has(e.facts?.office as string))) return "watch";
  switch (role) {
    case "head": return headTemplate(occ, town);
    case "spouse":
      // Where the house serves the public, the whole household works it.
      if (SERVING.has(headTemplate(occ, town)) && headTemplate(occ, town) !== "cook") return headTemplate(occ, town);
      if (!male) return "housewife";
      return isStreetPlan(town) ? "town_labourer" : "labourer";
    case "servant": {
      const so = p.get<string>("occupation");
      if (so === "farm_servant") return "farmer";
      if (so === "mill_hand") return "miller";
      return "servant_house";
    }
    case "child":
      if (!male) return "servant_house";
      return FOLLOW.has(headTemplate(occ, town)) ? headTemplate(occ, town) : isStreetPlan(town) ? "town_labourer" : "labourer";
    case "parent": return age >= 58 ? "old" : male ? (isStreetPlan(town) ? "town_labourer" : "labourer") : "housewife";
    case "sibling": return male ? headTemplate(occ, town) : "housewife";
  }
  return "labourer";
}

function firstOfUse(town: Town, use: string | string[]): Address | undefined {
  const uses = Array.isArray(use) ? use : [use];
  return town.children(town.root, "building").find((b) => uses.includes(b.get("use")))?.address;
}

function buildingOfPerson(town: Town, p: Address): Address {
  return town.parentOf(town.parentOf(p)!)!;
}

function place(town: Town, p: Entity, where: string): string {
  const home = buildingOfPerson(town, p.address);
  if (isStreetPlan(town)) {
    switch (where) {
      case "green": case "market": return "place:market";
      case "streets": return "place:streets";
      case "walls": return "place:walls";
      case "river": return "place:river";
      case "quay": return town.settlement().get<{ quay?: unknown }>("map").quay ? "place:quay" : "place:river";
      case "chapel": case "church": {
        // A cleric's church is his own; everyone else goes to the nearest parish church.
        const role = p.get<string>("role");
        if (role === "cleric" || (role === "head" && /priest|provost|bishop|chaplain|prior|abbot|warden|master/.test(p.get<string>("occupation") ?? town.get(town.parentOf(p.address)!).get<string>("occupation")))) return home;
        const parish = town.get(town.parentOf(p.address)!).get<string | null>("parish");
        return parish ?? nearestBuilding(town, home, PARISH) ?? "place:streets";
      }
      case "alehouse": case "tavern": {
        // Everyone has a usual house: one of the three nearest, the same one every night.
        const near = nearestBuildings(town, home, DRINK, 3);
        if (!near.length) return "place:streets";
        const i = town.rngFor(p.address, routines, "local").weighted([0, 1, 2].slice(0, near.length), (k) => [5, 3, 2][k]);
        return near[i];
      }
      case "hall": return nearestBuilding(town, home, ["guildhall", "courthouse", "market_hall"]) ?? nearestBuilding(town, home, DRINK) ?? "place:market";
      case "watch": return nearestBuilding(town, home, ["watch_house"]) ?? "place:streets";
      case "castle": return nearestBuilding(town, home, ["castle"]) ?? home;
      case "employer": {
        const hh = town.parentOf(p.address)!;
        const head = town.children(hh, "person")[0];
        const e = head && town.edges({ to: head.address, kind: "employer" })[0];
        return e && e.from.includes("/building:") ? buildingOfPerson(town, e.from) : "place:streets";
      }
    }
  }
  switch (where) {
    case "home": case "work": return home;
    case "fields": return "place:fields";
    case "pasture": return "place:pasture";
    case "roads": return "place:roads";
    case "sea": return "place:sea";
    case "shore": return "place:shore";
    case "mine": return "place:mine";
    case "woods": return "place:woods";
    case "green": return "place:green";
    case "chapel": return firstOfUse(town, ["chapel", "shrine"]) ?? "place:away";
    case "alehouse": return firstOfUse(town, "alehouse") ?? home;
    case "master": {
      const e = town.edges({ from: p.address, kind: "apprentice_of" })[0];
      return e ? buildingOfPerson(town, e.to) : home;
    }
    case "employer": return "place:fields";
    case "demesne": return "place:demesne";
    case "manor": return firstOfUse(town, "manor_house") ?? "place:elsewhere";
    case "tavern": case "hall": return firstOfUse(town, "alehouse") ?? home;
    case "church": return firstOfUse(town, ["chapel", "shrine"]) ?? home;
    case "market": case "streets": return "place:green";
    case "river": return "place:fields";
  }
  return home;
}


// Errands: where people go to buy things, and what they're about there.
// `rank`: only households at least this well off; `sex`: who usually goes.
const ERRANDS: { uses: string[]; doing: string[]; weight: number; rank?: number; sex?: string }[] = [
  { uses: ["bakehouse", "town_bakehouse"], doing: ["buying the day's bread", "taking the dough round to be baked"], weight: 5 },
  { uses: ["mill"], doing: ["taking a sack of grain to be ground, and watching the miller's thumb"], weight: 3 },
  { uses: ["trader"], doing: ["buying salt, needles and a little thread", "swapping eggs for salt"], weight: 4 },
  { uses: ["butcher_shop"], doing: ["at the butcher's, haggling over a joint", "buying offal for the pot"], weight: 4 },
  { uses: ["fishmonger"], doing: ["buying salt herring", "turning over the fish to find a fresh one"], weight: 3 },
  { uses: ["poulterer"], doing: ["buying a fowl, and a dozen eggs"], weight: 2 },
  { uses: ["cookshop"], doing: ["buying a hot pie to take home"], weight: 2 },
  { uses: ["chandlery", "town_chandlery"], doing: ["buying candles and soap"], weight: 2 },
  { uses: ["smithy", "town_smithy"], doing: ["taking a cracked pot to be mended", "waiting while a hinge is made"], weight: 2 },
  { uses: ["cobbler"], doing: ["getting boots mended, again"], weight: 2 },
  { uses: ["fripperer"], doing: ["turning over second-hand clothes"], weight: 2 },
  { uses: ["apothecary"], doing: ["buying a remedy for a cough"], weight: 1 },
  { uses: ["spicer"], doing: ["buying pepper, a pinch at a time"], weight: 1, rank: 6 },
  { uses: ["draper", "mercer"], doing: ["choosing cloth for a new gown"], weight: 2, rank: 6 },
  { uses: ["wine_merchant"], doing: ["ordering wine for the house"], weight: 1, rank: 7 },
  { uses: ["barber"], doing: ["being shaved, and catching up on the talk"], weight: 2, sex: "m" },
];
// Who runs a household's errands.
const SHOPPERS = new Set(["housewife", "servant_house", "old", "spinner"]);
// Ties people go visiting on.
const VISIT = new Set(["friend", "kin", "courting", "betrothed"]);

const shopMemo = new WeakMap<Town, Set<string>>();
function usesHere(town: Town): Set<string> {
  let s = shopMemo.get(town);
  if (!s) shopMemo.set(town, (s = new Set(town.children(town.root, "building").map((b) => b.get<string>("use")))));
  return s;
}

/** An errand to a shop, if one's due: the building and what they're doing there. */
function errand(town: Town, p: Entity, home: Address, date: string, block: Block): { where: string; doing: string } | undefined {
  const r = town.rngFor(p.address, routines, `errand:${date}:${block}`);
  const market = isStreetPlan(town) && (town.settlement().get<string[]>("marketDays") ?? []).includes(weekdayName(date));
  const wet = weatherOn(town, date).wet;
  if (!r.chance((market ? 0.4 : 0.22) * (wet ? 0.6 : 1))) return undefined;
  if (market && r.chance(0.5)) return { where: "place:market", doing: r.pick(["at the market, buying for the week", "at the market stalls, comparing prices", "at the market, mostly talking"]) };
  const here = usesHere(town);
  const hh = town.get(town.parentOf(p.address)!);
  const rank = town.registry<Tier>("tiers").find(hh.get<string>("tier") ?? "")?.rank ?? 4;
  const sex = p.get<string>("sex");
  // In a town people buy their bread and their salt; the mill and the village trader are for country folk.
  const urban = isUrban(town);
  const ok = ERRANDS.filter((e) => e.uses.some((u) => here.has(u)) && (e.rank === undefined || rank >= e.rank) && (!e.sex || e.sex === sex) && !(urban && (e.uses.includes("mill") || e.uses.includes("trader"))));
  if (!ok.length) return undefined;
  // On a fish day the fishmonger does the trade the butcher doesn't.
  const fast = fastOn(date);
  const e = r.weighted(ok, (x) => x.weight * (fast && x.uses.includes("fishmonger") ? 4 : fast && x.uses.includes("butcher_shop") ? 0.2 : 1));
  // One of the three nearest, by habit: everyone has their own baker.
  const choices = nearestBuildings(town, home, e.uses.filter((u) => here.has(u)), 3);
  const to = choices.length ? choices[town.rngFor(p.address, routines, `shop:${e.uses[0]}`).int(0, choices.length - 1)] : undefined;
  if (!to || to === home) return undefined;
  return { where: to, doing: r.pick(e.doing) };
}

/** A visit to someone they're close to, if one's due. */
function visit(town: Town, p: Entity, home: Address, date: string, block: Block, chance: number): { where: string; doing: string } | undefined {
  const r = town.rngFor(p.address, routines, `visit-friend:${date}:${block}`);
  if (!r.chance(chance)) return undefined;
  const ties = town.edges({ touching: p.address }).filter((e) => VISIT.has(e.kind) && e.from.includes("/building:") && e.to.includes("/building:"));
  // Nobody calls on a friend at the watch house, the gaol or the guildhall: they go when that friend is home.
  const away = ties.map((e) => (e.from === p.address ? e.to : e.from)).filter((o) => buildingOfPerson(town, o) !== home && !OFFICIAL.has(town.get(buildingOfPerson(town, o)).get<string>("use")));
  if (!away.length) return undefined;
  const who = r.pick(away);
  const kind = ties.find((e) => e.from === who || e.to === who)!.kind;
  const name = town.label(who);
  const doing = kind === "courting" || kind === "betrothed"
    ? r.pick([`walking out with ${name}, chaperoned, more or less`, `at ${poss(name)} house, being looked over by the family`])
    : block === "evening" || block === "night"
      ? r.pick([`round at ${poss(name)}, talking by the fire`, `at ${poss(name)}, sharing a jug and the news`, `sitting up with ${name}, putting the world right`])
      : r.pick([`calling on ${name}`, `at ${poss(name)}, helping with a job and talking the whole time`, `visiting ${name}, with a cake wrapped in a cloth`]);
  return { where: buildingOfPerson(town, who), doing };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function weekdayName(date: string): string {
  return WEEKDAYS[weekday(date) % 7];
}

function fill(text: string, month: number, trade = "the trade's", r?: { pick<T>(a: T[]): T }): string {
  const m = content.months[String(month)] ?? {};
  // "a | b | c": one of them, day by day.
  const one = r && text.includes(" | ") ? r.pick(text.split(" | ")) : text.split(" | ")[0];
  return one.replace(/\{(\w+)\}/g, (_, k) => (k === "trade" ? trade : m[k] ?? "at work"));
}

/** What a person's day is built from that doesn't change from day to day. */
interface Fixed {
  role: string; t: string; tpl: Record<Block, Slot>; traits: string[]; age: number; male: boolean; urban: boolean;
  parish: string | null; hh: Entity; home: Address; labourDay: number | undefined; trade: string;
  lover: boolean; baby: boolean; terrain: string; hooks: RoutineHook[];
}
// Kept per person once the town has settled: the map, the edges and the households stop changing then.
const fixedMemo = new WeakMap<Entity, Fixed>();

function fixedOf(town: Town, p: Entity): Fixed {
  const hit = fixedMemo.get(p);
  if (hit) return hit;
  const t = templateFor(town, p);
  const urban = isUrban(town);
  const hh = town.get(town.parentOf(p.address)!);
  const f: Fixed = {
    role: p.get<string>("role"), t, tpl: (urban && content.templates[`${t}_town`]) || content.templates[t],
    traits: p.get<string[]>("traits") ?? [], age: p.get<number>("age"), male: p.get("sex") === "m", urban,
    parish: urban ? hh.get<string | null>("parish") : null, hh, home: buildingOfPerson(town, p.address),
    labourDay: hh.get<number | undefined>("manor.labourDay"),
    trade: town.registry<Occupation>("occupations").find(hh.get<string>("occupation"))?.label ?? "the trade's",
    lover: town.edges({ touching: p.address, kind: "lover" }).length > 0,
    baby: town.children(hh.address, "person").some((x) => x.get<number>("age") < 3),
    terrain: town.settlement().get<string>("terrain") ?? "farmland",
    hooks: town.registry<RoutineHook>("routineHooks").list(),
  };
  if (town.settled) fixedMemo.set(p, f);
  return f;
}

export function whereabouts(town: Town, person: Address, date: string, block: Block): Whereabouts {
  town.society();
  const p = town.get(person);
  const fx = fixedOf(town, p);
  const role = fx.role;
  // Officers of the manor live elsewhere and only come for visits and courts.
  if (role === "official" || role === "lord") {
    const occ = p.get<string>("occupation");
    const hall = firstOfUse(town, "manor_house");
    const here = hall && (block === "forenoon" || block === "afternoon") && visitorsOn(town, date).some((v) =>
      (v.kind === "bailiff" && occ === "bailiff") || (v.kind === "manor_court" && (occ === "steward" || occ === "bailiff")));
    if (here) return { where: hall, label: `at ${town.label(hall).replace(/^The /, "the ")}`, doing: occ === "steward" ? "holding the manor court" : "going over the reeve's tallies" };
    return { where: "place:elsewhere", label: PLACES["place:elsewhere"], doing: role === "lord" ? "at another of his manors" : "about the lord's business" };
  }
  // A villein who ran is a criminal; his family says they don't know where he is.
  if (p.get("manor.fled")) return { where: "place:away", label: PLACES["place:away"], doing: "gone; his family won't say where" };
  for (const h of fx.hooks) {
    const o = h.at(town, person, date, block);
    if (o) return { where: o.where, label: o.where.startsWith("place:") ? PLACES[o.where] ?? o.where : o.where === fx.home ? "at home" : `at ${town.label(o.where).replace(/^The /, "the ")}`, doing: o.doing };
  }
  const { t, urban, tpl } = fx;
  const month = parseDate(date).m;
  let slot: Slot = tpl[block];
  const r = town.rngFor(person, routines, `day:${date}:${block}`);
  const { traits, age } = fx;
  const feast = feastOn(date);
  const sky = weatherOn(town, date);
  const working = SERVING.has(t) || t === "herdsman" && (block === "morning" || block === "evening");
  const male = fx.male;
  // Their parish keeps its patron's day: a procession and a church-ale.
  const parish = fx.parish;
  const patronal = parish && !feast?.holy && patronalOn(town, date).includes(parish) ? patronOf(town, parish) : undefined;

  if (feast?.holy && age >= 5 && !working) {
    // On a holy day a town parish hears mass in two sittings, an early mass and
    // the high mass; a village chapel holds its people at once.
    const early = urban && age >= 12 && town.rngFor(person, routines, `early-mass:${date}`).chance(0.35);
    const mass = feast.name === "Sunday" ? "mass" : `mass for ${feast.name}`;
    if (block === "morning") slot = early ? { where: "chapel", doing: `at the early ${mass}` } : slot.where !== "home" || /fields|beasts|work|shutters|bench/.test(slot.doing) ? { where: "home", doing: urban ? "a late start; the shops stay shut on a holy day" : "seeing to the beasts, and nothing else: it's a holy day" } : slot;
    else if (block === "forenoon") slot = early ? { where: "home", doing: "home from the early mass; the dinner on" } : { where: "chapel", doing: `at the high ${mass}` };
    else if (block === "afternoon") slot = feast.festival
      ? { where: "green", doing: feast.custom ? `keeping ${feast.name}: ${feast.custom}` : "feasting and games on the green" }
      : sky.wet ? (male && age >= 16 && r.chance(0.4) ? { where: "alehouse", doing: "out of the rain, a holy-day drink" } : { where: "home", doing: "kept in by the weather; no work today" })
      : age < 30 && r.chance(0.6) ? { where: "green", doing: urban ? "at the butts, or football in the street, or watching" : "football, wrestling, or watching" } : { where: "home", doing: "resting; no work today but what can't wait" };
    else if (block === "evening" && (feast.festival || (male && age >= 16 && r.chance(0.45)))) slot = { where: "alehouse", doing: feast.festival ? "the church-ale" : feast.name === "Sunday" ? "a Sunday drink" : "a holy-day drink" };
    else if (block === "evening" && slot.where === "home") slot = { where: "home", doing: feast.custom && /goose|dinner|supper|feast/.test(feast.custom) ? `supper: ${feast.custom.split(";")[0]}` : "a holy-day supper, the best the house can do" };
    else if ((block === "night" || block === "late_night") && slot.where !== "home") slot = { where: "home", doing: "asleep; no work on a holy day" };
  } else if (patronal && age >= 5 && !working && (block === "afternoon" || block === "evening") && r.chance(block === "afternoon" ? 0.5 : 0.4)) {
    slot = block === "afternoon" ? { where: "church", doing: `walking in the procession round the parish for ${poss(patronal)} day` } : { where: "church", doing: `at the church-ale in ${poss(patronal)} churchyard` };
  } else if (feast?.custom && feast.festival && age >= 10 && age < 35 && !working && block === "afternoon" && r.chance(0.6)) {
    slot = { where: "green", doing: `keeping ${feast.name}: ${feast.custom}` };
  } else if (!SERVING.has(t)) {
    if (block === "evening" && age >= 16 && traits.includes("drinker") && r.chance(sky.wet ? 0.65 : 0.5)) slot = { where: "alehouse", doing: urban ? "at the usual house, again" : "at the alehouse, again" };
    else if (block === "evening" && male && age >= 18 && r.chance(0.07)) slot = { where: "alehouse", doing: urban ? "a quick one at the usual house" : "a quick one at the alehouse" };
    else if (block === "afternoon" && traits.includes("gossip") && !sky.wet && r.chance(0.35)) slot = { where: urban ? "streets" : "green", doing: urban ? "at the conduit, talking" : "at the well, talking" };
    else if (block === "morning" && traits.includes("pious") && r.chance(0.3) && age >= 12) slot = { where: "chapel", doing: "an early prayer before work" };
  }
  // Weather: children and idlers come in out of the rain; nobody puts out to sea in a gale.
  if (sky.wet && (slot.where === "green" || slot.where === "streets") && (t === "child" || t === "old") && !feast?.festival) slot = { where: "home", doing: t === "child" ? "kept in by the rain, and underfoot" : "by the fire, out of the wet" };
  if (sky.rough && slot.where === "sea") slot = { where: "shore", doing: "boats hauled up out of the storm; mending nets in the lee" };
  // Errands to the shops, and visits to friends and kin. Their own streams, so
  // nobody else's day moves. `direct` holds a building chosen here; any later
  // change of plan (week-work, visitors, the watch) drops it.
  let direct: { slot: Slot; where: string } | undefined;
  {
    const home = fx.home;
    const free = !working && t !== "watch" && !(slot.where === "alehouse" || slot.where === "chapel");
    let go: { where: string; doing: string } | undefined;
    if (free && !feast?.holy && (block === "forenoon" || block === "afternoon") && (SHOPPERS.has(t) || (t === "child" && age >= 8))) {
      go = errand(town, p, home, date, block);
      if (go && t === "child") go.doing = `sent to the shop: ${go.doing}`;
    }
    if (!go && free && age >= 14 && slot.where === "home" && (block === "evening" || (feast?.holy && block === "afternoon"))) {
      go = visit(town, p, home, date, block, feast?.holy ? 0.35 : 0.14);
    }
    if (go) { slot = { where: "home", doing: go.doing }; direct = { slot, where: go.where }; }
  }
  // Week-work: one day in seven on the lord's demesne; boon days at harvest (LF p.77).
  const labourDay = fx.labourDay;
  if (labourDay && !feast?.holy && (block === "forenoon" || block === "afternoon") && age >= 14 && male && (role === "head" || role === "child" || role === "servant")) {
    const wd = weekday(date);
    const boon = (month === 8 || month === 9) && wd === ((labourDay + 2) % 6) + 1;
    if (wd === labourDay) slot = { where: "demesne", doing: `week-work on the lord's demesne: {farm}` };
    else if (boon) slot = { where: "demesne", doing: "boon-work at the lord's harvest; he feeds them at noon" };
  }
  if (block === "forenoon" && role === "head" && visitorsOn(town, date).some((v) => v.kind === "manor_court")) {
    slot = { where: "manor", doing: "at the manor court, answering for the year" };
  }
  // Visitors pull people away from their routine.
  if (!working && age >= 5 && block !== "night" && block !== "late_night") {
    for (const v of visitorsOn(town, date)) {
      const rv = town.rngFor(person, routines, `visit:${v.kind}:${date}:${block}`);
      if (v.kind === "fair" && v.local && age >= 10 && (block === "forenoon" || block === "afternoon") && rv.chance(0.5)) slot = { where: "market", doing: `at ${v.who}` };
      else if (v.kind === "fair" && age >= 14 && (block === "forenoon" || block === "afternoon") && rv.chance(0.5)) slot = { where: "fair", doing: `gone to ${v.who}` };
      else if ((v.kind === "players" || v.kind === "mountebank") && (block === "afternoon" || block === "evening") && rv.chance(0.45)) slot = { where: "green", doing: `watching ${v.who}` };
      else if (v.kind === "herald" && block === "forenoon" && age >= 12 && rv.chance(0.6)) slot = { where: "green", doing: `hearing ${v.who} proclaim ${v.note.replace(/^proclaiming /, "")}` };
      else if (v.kind === "tax" && !feast?.holy && (block === "forenoon" || block === "afternoon") && role === "head" && rv.chance(0.35)) slot = { where: "hall", doing: `queueing before ${v.who}, to pay up or explain` };
      else if (v.kind === "band" && block === "afternoon" && male && age >= 16 && rv.chance(0.2)) slot = { where: "pasture", doing: `haggling over horses with ${v.who}` };
      else if (v.kind === "friar" && block === "forenoon" && (traits.includes("pious") || rv.chance(0.3))) slot = { where: "chapel", doing: `hearing mass from ${v.who}` };
    }
  }
  // Towns: every able man takes his turn on the night watch (LF p.86).
  if (block === "night" && t !== "watch" && isStreetPlan(town) && role === "head" && male && age >= 18 && age <= 55
    && town.rngFor(person, routines, `watch:${date}`).chance(1 / 20)) {
    slot = { where: "streets", doing: "his turn on the watch, with a borrowed bill and a lantern" };
  }
  // Secret lovers are sometimes not where they say they are.
  if (block === "night" && fx.lover && town.rngFor(person, routines, `tryst:${date}`).chance(0.15)) {
    slot = { where: "away", doing: "out, and back before anyone wakes" };
  }
  const terrain = fx.terrain;
  // Harvest and haymaking pull wives and children into the fields, but only
  // where there are fields worth the name. On the coast they work the catch.
  const out = terrain === "farmland" ? content.months[String(month)]?.out ?? [] : [];
  if (terrain === "coast" && t === "housewife" && (block === "forenoon" || block === "afternoon") && !feast?.holy && r.chance(0.5)) {
    slot = { where: "shore", doing: "gutting and salting the catch, mending nets" };
  }
  const outdoors = slot.where === "home" && /\{(house|child)\}/.test(slot.doing) && out.includes(slot.doing.match(/\{(house|child)\}/)![1]);
  const chosen = direct && direct.slot === slot ? direct.where : undefined;
  const where = chosen ?? (slot.where === "away" ? "place:away" : slot.where === "fair" ? "place:fair" : outdoors ? "place:fields" : place(town, p, slot.where));
  const label = where.startsWith("place:") ? PLACES[where] : slot.where === "home" && !chosen ? "at home" : `at ${town.label(where).replace(/^The /, "the ")}`;
  let doing = fill(slot.doing, month, fx.trade, r);
  // Up in the night with a child only if there's a small one in the house.
  if (/, or up with a child/.test(doing) && !fx.baby) doing = doing.replace(", or up with a child", "");
  return { where, label, doing };
}

/** How full a building is: undefined while there's room, else a line for the DM. */
export function crowdAt(town: Town, b: Address, n: number): string | undefined {
  if (!isStreetPlan(town) && n < 40) return undefined;
  const cap = capacityOf(town, b);
  if (n <= cap * 0.8) return undefined;
  const use = town.get(b).get<string>("use");
  const outside = PARISH.includes(use) ? "in the churchyard and the porch, straining to hear" : DRINK.includes(use) ? "drinking in the street outside, jugs passed out of the window" : "waiting in the street outside";
  if (n <= cap) return `full: room for about ${cap}, and every bench taken`;
  return `packed to the doors: about ${cap} inside, and ${n - cap} more ${outside}`;
}

const occMemo = new WeakMap<Town, Map<string, Map<string, Address[]>>>();

/** Everyone's whereabouts for one block: key -> people there. Memoised: it is a pure function. */
export function occupancy(town: Town, date: string, block: Block): Map<string, Address[]> {
  let memo = occMemo.get(town);
  if (!memo) occMemo.set(town, (memo = new Map()));
  const k = `${date}|${block}`;
  const hit = memo.get(k);
  if (hit) return hit;
  const out = computeOccupancy(town, date, block);
  memo.set(k, out);
  if (memo.size > 24) memo.delete(memo.keys().next().value!);
  return out;
}

function computeOccupancy(town: Town, date: string, block: Block): Map<string, Address[]> {
  const out = new Map<string, Address[]>();
  town.resolveAll();
  for (const e of town.allEntities()) {
    if (e.type !== "person") continue;
    const w = whereabouts(town, e.address, date, block).where;
    const l = out.get(w);
    if (l) l.push(e.address);
    else out.set(w, [e.address]);
  }
  return out;
}

export const routines: Module = {
  id: "routines",
  version: "1.0.0",
  requires: ["core", "households", "people", "society", "visitors"],
  provides: ["routineHooks"],
  // Reads the manor's fields when present; works without it.
  panels: [
    {
      id: "today",
      title: "Today",
      for: "person",
      order: 4,
      rows(town, p) {
        const { date, block } = town.clock;
        return BLOCKS.map((b) => {
          const w = whereabouts(town, p.address, date, b);
          const value: PanelRow["value"] = w.where.startsWith("place:") || w.label === "at home"
            ? `${w.label}: ${w.doing}`
            : [{ text: town.label(w.where), address: w.where }, `: ${w.doing}`];
          return { label: `${b === block ? "▸ " : ""}${b.replace("_", " ")}`, value, hint: BLOCK_HOURS[b] + (b === block ? " — now" : "") };
        });
      },
    },
    {
      id: "here-now",
      title: "Here now",
      for: "building",
      order: 2,
      rows(town, b) {
        const { date, block } = town.clock;
        const here = occupancy(town, date, block as Block).get(b.address) ?? [];
        if (!here.length) return [{ label: "Nobody", value: `${describeDate(date)}, ${block.replace("_", " ")}` }];
        // A church at mass holds hundreds: one line per household, the first dozen households, and a count.
        const groups = new Map<string, { people: Address[]; doing: string }>();
        for (const a of here) {
          const doing = whereabouts(town, a, date, block as Block).doing;
          const k = `${town.parentOf(a)}|${doing}`;
          const g = groups.get(k);
          if (g) g.people.push(a);
          else groups.set(k, { people: [a], doing });
        }
        const all = [...groups.values()];
        const shared = all.every((g) => g.doing === all[0].doing) ? all[0].doing : undefined;
        const MAX = 12;
        const rows: PanelRow[] = [];
        const crowd = crowdAt(town, b.address, here.length);
        if (crowd) rows.push({ label: "Crowd", value: crowd });
        if (shared && here.length > 1) rows.push({ label: "", value: `${here.length} here, ${shared}` });
        for (const g of all.slice(0, MAX)) {
          const value: (string | PanelLink)[] = g.people.flatMap((a, i) => [...(i ? [", "] : []), { text: town.label(a), address: a }]);
          if (!shared) value.push(`: ${g.doing}`);
          rows.push({ label: "", value });
        }
        if (all.length > MAX) {
          const rest = all.slice(MAX).reduce((n, g) => n + g.people.length, 0);
          rows.push({ label: "", value: `and ${rest} more from ${all.length - MAX} other households` });
        }
        return rows;
      },
    },
    {
      id: "now",
      title: "Now",
      for: "settlement",
      order: 1,
      rows(town) {
        const { date, block } = town.clock;
        const occ = occupancy(town, date, block as Block);
        const rows: PanelRow[] = [{ label: "When", value: `${describeDate(date)}, ${block.replace("_", " ")} (${BLOCK_HOURS[block as Block]})` }];
        for (const v of visitorsOn(town, date)) if (v.kind !== "thefts") rows.push({ label: "In the place", value: `${v.who} — ${v.note}` });
        for (const [k, label] of Object.entries(PLACES)) {
          const n = occ.get(k)?.length ?? 0;
          if (n && k !== "place:away" && k !== "place:elsewhere") rows.push({ label: label.replace(/^(on|out in|in) (the )?/, ""), value: `${n}` });
        }
        // The busiest roofs, wherever the crowd is.
        const uses = town.registry<BuildingUse>("buildingUses");
        const busy = [...occ].filter(([k, v]) => !k.startsWith("place:") && v.length >= 4 && uses.find(town.get(k).get("use"))?.category !== "small_rural")
          .sort((a, b) => b[1].length - a[1].length).slice(0, 3);
        for (const [k, v] of busy) rows.push({ label: town.label(k).replace(/^The /, ""), value: [{ text: `${v.length} there`, address: k }] });
        return rows;
      },
    },
  ],
};
