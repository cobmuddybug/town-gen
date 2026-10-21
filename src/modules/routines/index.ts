import { BLOCKS, BLOCK_HOURS, describeDate, feastOn, parseDate, weekday, type Block } from "../../core/calendar";
import { data } from "../../core/content";
import type { Address } from "../../core/address";
import type { Entity, Town } from "../../core/town";
import type { Module, PanelLink, PanelRow } from "../../core/types";
import routinesYaml from "./content/routines.yaml";
import { visitorsOn } from "../visitors";
import type { BuildingUse, Occupation } from "../uses";
import { isStreetPlan, nearestBuilding } from "../layout";
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
};

const DRINK = ["tavern", "town_alehouse", "alehouse", "inn"];
const PARISH = ["fane", "temple", "grand_temple", "chapel", "shrine"];
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
      if (!male) return headTemplate(occ, town) === "alehouse" ? "alehouse" : "housewife";
      return headTemplate(occ, town) === "alehouse" ? "alehouse" : isStreetPlan(town) ? "town_labourer" : "labourer";
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
        if (role === "cleric" || (role === "head" && /priest|provost|bishop|chaplain|prior|warden|master/.test(p.get<string>("occupation") ?? town.get(town.parentOf(p.address)!).get<string>("occupation")))) return home;
        return nearestBuilding(town, home, PARISH) ?? "place:streets";
      }
      case "alehouse": case "tavern": return nearestBuilding(town, home, DRINK) ?? "place:streets";
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
    case "tavern": return firstOfUse(town, "alehouse") ?? home;
    case "church": return firstOfUse(town, ["chapel", "shrine"]) ?? home;
    case "market": case "streets": return "place:green";
    case "river": return "place:fields";
  }
  return home;
}


// Errands: where people go to buy things, and what they're about there.
// `rank`: only households at least this well off; `sex`: who usually goes.
const ERRANDS: { uses: string[]; doing: string[]; weight: number; rank?: number; sex?: string }[] = [
  { uses: ["bakehouse"], doing: ["buying the day's bread", "taking the dough round to be baked"], weight: 5 },
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
  if (!r.chance(market ? 0.4 : 0.22)) return undefined;
  if (market && r.chance(0.5)) return { where: "place:market", doing: r.pick(["at the market, buying for the week", "at the market stalls, comparing prices", "at the market, mostly talking"]) };
  const here = usesHere(town);
  const hh = town.get(town.parentOf(p.address)!);
  const rank = town.registry<Tier>("tiers").find(hh.get<string>("tier") ?? "")?.rank ?? 4;
  const sex = p.get<string>("sex");
  const ok = ERRANDS.filter((e) => e.uses.some((u) => here.has(u)) && (e.rank === undefined || rank >= e.rank) && (!e.sex || e.sex === sex));
  if (!ok.length) return undefined;
  const e = r.weighted(ok, (x) => x.weight);
  const to = nearestBuilding(town, home, e.uses.filter((u) => here.has(u)));
  if (!to || to === home) return undefined;
  return { where: to, doing: r.pick(e.doing) };
}

/** A visit to someone they're close to, if one's due. */
function visit(town: Town, p: Entity, home: Address, date: string, block: Block, chance: number): { where: string; doing: string } | undefined {
  const r = town.rngFor(p.address, routines, `visit-friend:${date}:${block}`);
  if (!r.chance(chance)) return undefined;
  const ties = town.edges({ touching: p.address }).filter((e) => VISIT.has(e.kind) && e.from.includes("/building:") && e.to.includes("/building:"));
  const away = ties.map((e) => (e.from === p.address ? e.to : e.from)).filter((o) => buildingOfPerson(town, o) !== home);
  if (!away.length) return undefined;
  const who = r.pick(away);
  const kind = ties.find((e) => e.from === who || e.to === who)!.kind;
  const name = town.label(who);
  const doing = kind === "courting" || kind === "betrothed"
    ? r.pick([`walking out with ${name}, chaperoned, more or less`, `at ${name}'s house, being looked over by the family`])
    : block === "evening" || block === "night"
      ? r.pick([`round at ${name}'s, talking by the fire`, `at ${name}'s, sharing a jug and the news`, `sitting up with ${name}, putting the world right`])
      : r.pick([`calling on ${name}`, `at ${name}'s, helping with a job and talking the whole time`, `visiting ${name}, with a cake wrapped in a cloth`]);
  return { where: buildingOfPerson(town, who), doing };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function weekdayName(date: string): string {
  return WEEKDAYS[weekday(date) % 7];
}

function fill(text: string, month: number): string {
  const m = content.months[String(month)] ?? {};
  return text.replace(/\{(\w+)\}/g, (_, k) => m[k] ?? "at work");
}

export function whereabouts(town: Town, person: Address, date: string, block: Block): Whereabouts {
  town.society();
  const p = town.get(person);
  const role = p.get<string>("role");
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
  const tpl = content.templates[templateFor(town, p)];
  const month = parseDate(date).m;
  let slot: Slot = tpl[block];
  const r = town.rngFor(person, routines, `day:${date}:${block}`);
  const traits = p.get<string[]>("traits") ?? [];
  const age = p.get<number>("age");
  const feast = feastOn(date);
  const t = templateFor(town, p);
  const working = t === "alehouse" || t === "herdsman" && (block === "morning" || block === "evening");

  if (feast?.holy && age >= 5 && !working) {
    if (block === "morning" && slot.where !== "home") slot = { where: "home", doing: isStreetPlan(town) && /town|city/.test(town.settlement().get<string>("sizeClass")) ? "a late start; the shops stay shut on a holy day" : "seeing to the beasts, and nothing else: it's a holy day" };
    else if (block === "forenoon") slot = { where: "chapel", doing: feast.name === "Sunday" ? "at mass" : `at mass for ${feast.name}` };
    else if (block === "afternoon") slot = feast.festival
      ? { where: "green", doing: "feasting and games on the green" }
      : age < 30 && r.chance(0.6) ? { where: "green", doing: "football, wrestling, or watching" } : { where: "home", doing: "resting; no work today but what can't wait" };
    else if (block === "evening" && (feast.festival || (p.get("sex") === "m" && age >= 16 && r.chance(0.45)))) slot = { where: "alehouse", doing: feast.festival ? "the church-ale" : feast.name === "Sunday" ? "a Sunday drink" : "a holy-day drink" };
  } else if (t !== "alehouse") {
    if (block === "evening" && age >= 16 && traits.includes("drinker") && r.chance(0.55)) slot = { where: "alehouse", doing: "at the alehouse, again" };
    else if (block === "evening" && p.get("sex") === "m" && age >= 18 && r.chance(0.07)) slot = { where: "alehouse", doing: "a quick one at the alehouse" };
    else if (block === "afternoon" && traits.includes("gossip") && r.chance(0.35)) slot = { where: "green", doing: "at the well, talking" };
    else if (block === "morning" && traits.includes("pious") && r.chance(0.3) && age >= 12) slot = { where: "chapel", doing: "an early prayer before work" };
  }
  // Errands to the shops, and visits to friends and kin. Their own streams, so
  // nobody else's day moves. `direct` holds a building chosen here; any later
  // change of plan (week-work, visitors, the watch) drops it.
  let direct: { slot: Slot; where: string } | undefined;
  {
    const home = buildingOfPerson(town, person);
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
  const hh = town.get(town.parentOf(person)!);
  const labourDay = hh.get<number | undefined>("manor.labourDay");
  if (labourDay && !feast?.holy && (block === "forenoon" || block === "afternoon") && age >= 14 && p.get("sex") === "m" && (role === "head" || role === "child" || role === "servant")) {
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
      else if (v.kind === "tax" && block === "forenoon" && p.get("role") === "head" && rv.chance(0.7)) slot = { where: "alehouse", doing: `before ${v.who}, paying up or explaining` };
      else if (v.kind === "band" && block === "afternoon" && p.get("sex") === "m" && age >= 16 && rv.chance(0.2)) slot = { where: "pasture", doing: `haggling over horses with ${v.who}` };
      else if (v.kind === "friar" && block === "forenoon" && (traits.includes("pious") || rv.chance(0.3))) slot = { where: "chapel", doing: `hearing mass from ${v.who}` };
    }
  }
  // Towns: every able man takes his turn on the night watch (LF p.86).
  if (block === "night" && t !== "watch" && isStreetPlan(town) && role === "head" && p.get("sex") === "m" && age >= 18 && age <= 55
    && town.rngFor(person, routines, `watch:${date}`).chance(1 / 20)) {
    slot = { where: "streets", doing: "his turn on the watch, with a borrowed bill and a lantern" };
  }
  // Secret lovers are sometimes not where they say they are.
  if (block === "night" && town.edges({ touching: person, kind: "lover" }).length && town.rngFor(person, routines, `tryst:${date}`).chance(0.15)) {
    slot = { where: "away", doing: "out, and back before anyone wakes" };
  }
  const terrain = town.settlement().get<string>("terrain") ?? "farmland";
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
  return { where, label, doing: fill(slot.doing, month) };
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
        const rows: PanelRow[] = shared && here.length > 1 ? [{ label: "", value: `${here.length} here, ${shared}` }] : [];
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
