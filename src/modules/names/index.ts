import { data } from "../../core/content";
import type { Row } from "../../core/registry";
import type { Rng } from "../../core/rng";
import type { Module } from "../../core/types";
import type { BuildingUse, Occupation } from "../uses";

// Buildings there is usually only one of are named for what they are.
const UNIQUE = new Set(["mill", "chapel", "shrine", "alehouse", "trader", "smithy", "bakehouse"]);
import anglo from "./content/anglo-norman.yaml";
import type { Town } from "../../core/town";

const countMemo = new WeakMap<Town, Map<string, number>>();
function countOf(town: Town, use: string): number {
  let m = countMemo.get(town);
  if (!m) {
    m = new Map();
    for (const b of town.children(town.root, "building")) { const u = b.get<string>("use"); m.set(u, (m.get(u) ?? 0) + 1); }
    countMemo.set(town, m);
  }
  return m.get(use) ?? 0;
}

// Inns and taverns hang a sign; a good many alehouses too. Each name once in a town.
const SIGNED = new Set(["inn", "tavern", "town_alehouse", "hostel"]);
const SIGNS = ["the Bell", "the Swan", "the Saracen's Head", "the Chequers", "the Star", "the Green Man", "the Bull", "the Cock",
  "the Angel", "the Crown", "the Ship", "the Plough", "the Lamb", "the Mitre", "the Pilgrim", "the Three Cups", "the Rose",
  "the Pelican", "the Dolphin", "the Boar's Head", "the Hart", "the Sun", "the Bush", "the Hoop", "the Wheatsheaf", "the Woolpack",
  "the Cross Keys", "the Bear", "the Fleece", "the George", "the Lion", "the Ram", "the Horseshoe", "the Bell and Book", "the Old Cock",
  "the Pied Bull", "the Unicorn", "the Antelope", "the Griffin", "the Mermaid", "the Salutation", "the Tabard", "the Eagle", "the Falcon",
  "the Castle", "the Gate", "the Two Brewers", "the Barley Mow", "the Sheaf", "the Pope's Head", "the Moon", "the Black Boy", "the Cardinal's Hat"];
const signMemo = new WeakMap<Town, Map<string, string>>();
/** The sign over a drinking house's door, if it has one. */
function signOf(town: Town, b: string): string | undefined {
  let m = signMemo.get(town);
  if (!m) {
    m = new Map();
    const street = town.settlement().get<{ kind?: string }>("map")?.kind === "town";
    if (street) {
      const pool = [...SIGNS];
      let seed = 0;
      for (const ch of town.seed) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
      for (const x of town.children(town.root, "building")) {
        const use = x.get<string>("use");
        if (!SIGNED.has(use) || !pool.length) continue;
        seed = (seed * 1103515245 + 12345) | 0;
        const k = Math.abs(seed) % 100;
        if (use === "town_alehouse" && k < 45) continue;
        const name = pool.splice(Math.abs(seed >> 7) % pool.length, 1)[0];
        m.set(x.address, name[0].toUpperCase() + name.slice(1));
      }
    }
    signMemo.set(town, m);
  }
  return m.get(b);
}

export interface NameProvider extends Row {
  cultures: string[];
  given(rng: Rng, o: { sex: "m" | "f" }): string;
  called(rng: Rng, given: string): string | undefined;
  /** A family byname: from a trade (often an old one), a place, a father, or a nickname. */
  family(rng: Rng, o: { occupation?: Occupation; settlement: string }): { name: string; kind: string };
  place(rng: Rng): string;
}

interface AngloData {
  male: Record<string, number>;
  female: Record<string, number>;
  called: Record<string, string[]>;
  nickname: string[];
  locative: string[];
  trades: string[];
  patronym_suffix: string[];
  place: { first: string[]; last: string[]; prefix: string[] };
}

const d = data<AngloData>(anglo);
const weighted = (rng: Rng, table: Record<string, number>) => rng.weighted(Object.entries(table), ([, w]) => w)[0];

export const angloNorman: NameProvider = {
  id: "anglo-norman",
  cultures: ["default"],
  given: (rng, { sex }) => weighted(rng, sex === "m" ? d.male : d.female),
  called(rng, given) {
    const short = d.called[given];
    return short && rng.chance(0.6) ? rng.pick(short) : undefined;
  },
  family(rng, { occupation }) {
    const kind = rng.weighted(["trade", "place", "father", "nickname"], (k) => ({ trade: 35, place: 25, father: 25, nickname: 15 })[k]!);
    if (kind === "trade") {
      // A byname can be out of date: the Smiths may be coopers now.
      if (occupation?.byname && rng.chance(0.4)) return { name: occupation.byname, kind: "trade, and still the trade" };
      return { name: rng.pick(d.trades), kind: "trade, from an earlier generation" };
    }
    if (kind === "place") {
      if (rng.chance(0.25)) return { name: `of ${angloNorman.place(rng)}`, kind: "place they came from" };
      return { name: rng.pick(d.locative), kind: "where the family lived" };
    }
    if (kind === "father") {
      const father = weighted(rng, d.male);
      const suffix = rng.pick(d.patronym_suffix);
      // -kin and -cock go on a short pet name (Wilcock, Simkin, Hobkin), never on
      // a full name or one that already has an ending: no Bartholomewcock.
      if (suffix === "kin" || suffix === "cock") {
        const pets = (d.called[father] ?? []).filter((n) => n.length <= 5 && !/(kin|cock|on|ie|y)$/.test(n));
        const base = pets.length ? rng.pick(pets) : father.length <= 5 && !/(kin|cock)$/.test(father) ? father : undefined;
        if (base) return { name: base + suffix, kind: "a forefather's name" };
        return { name: father + (rng.chance(0.6) ? "son" : "s"), kind: "a forefather's name" };
      }
      const base = rng.chance(0.5) ? (d.called[father] ? rng.pick(d.called[father]) : father) : father;
      return { name: base + (base.endsWith("s") && suffix === "s" ? "on" : suffix), kind: "a forefather's name" };
    }
    return { name: rng.pick(d.nickname), kind: "a forefather's nickname" };
  },
  place(rng) {
    let n = rng.pick(d.place.first) + rng.pick(d.place.last);
    if (rng.chance(0.15)) n = `${rng.pick(d.place.prefix)} ${n}`;
    return n;
  },
};

export const names: Module = {
  id: "names",
  version: "2.0.0",
  requires: ["core", "households"],
  register(add) {
    add("nameProviders", [angloNorman]);
  },
  hooks: {
    onSettlementGenerated(ctx, s) {
      const p = ctx.registry<NameProvider>("nameProviders").get("anglo-norman");
      ctx.gen(s, "name", (r) => p.place(r));
    },
    onHouseholdResolved(ctx, h) {
      const p = ctx.registry<NameProvider>("nameProviders").get("anglo-norman");
      // Names must not move when the DM edits a building's use, so the family's
      // trade byname comes from the settlement plan, never from overlaid fields.
      const town = ctx.town;
      const b = town.peek(town.parentOf(h.address)!)!;
      const planned = town.settlement().get<string[]>("plan")[b.generated<number>("planIndex")];
      const use = ctx.registry<BuildingUse>("buildingUses").find(planned);
      const choices = Object.entries(use?.occupations ?? {});
      const occId = choices.length ? ctx.rng(h, "byname-trade").weighted(choices, ([, w]) => w)[0] : undefined;
      const occupation = occId ? ctx.registry<Occupation>("occupations").find(occId) : undefined;
      ctx.gen(h, "surname", (r) => p.family(r, { occupation, settlement: ctx.town.settlement().get("name") }));
    },
    onPersonResolved(ctx, person) {
      const p = ctx.registry<NameProvider>("nameProviders").get("anglo-norman");
      const sex = person.get<"m" | "f">("sex");
      const given = ctx.gen(person, "given", (r) => p.given(r, { sex })) as string;
      ctx.gen(person, "called", (r) => p.called(r, given) ?? null);
      // Servants and in-laws bring their own family names.
      const role = person.get<string>("role");
      if (role === "official" || role === "lord") {
        ctx.gen(person, "birthname", (r) => p.family(r, { settlement: ctx.town.settlement().get("name") }).name);
      } else if (role === "cleric" || role === "retainer" || role === "inmate") {
        // Clergy, garrisons and almsfolk are not the head's family.
        ctx.gen(person, "birthname", (r) => p.family(r, { settlement: ctx.town.settlement().get("name") }).name);
      } else if (role === "servant" || (role === "spouse" && person.get("sex") === "f")) {
        const town = ctx.town;
        const own = town.parentOf(person.address)!;
        ctx.gen(person, "birthname", (r) => {
          // Most brides married within a few miles; many were born in the same place.
          if (r.chance(role === "spouse" ? 0.5 : 0.35)) {
            // A pick from every household but this one, without building the list.
            const all = localSurnames(town);
            const at = surnameIndex(town).get(own);
            const n = all.length - (at === undefined ? 0 : 1);
            if (n > 0) {
              const j = Math.floor(r.next() * n);
              return all[at !== undefined && j >= at ? j + 1 : j].name;
            }
          }
          return p.family(r, { settlement: town.settlement().get("name") }).name;
        });
      }
    },
  },
  label(town, e) {
    if (e.type === "settlement") return e.get<string>("name");
    if (e.type === "household") return `the ${e.get<{ name: string }>("surname").name.replace(/^of /, "")} household`;
    if (e.type === "person") return personName(town, e.address);
    if (e.type === "building") {
      const use = town.registry<BuildingUse>("buildingUses").find(e.get("use"));
      if (!use) return undefined;
      const sign = signOf(town, e.address);
      if (sign) return sign;
      const h = town.children(e.address, "household")[0];
      // "The alehouse" only where there is just the one.
      if ((UNIQUE.has(use.id) && countOf(town, use.id) === 1) || !h) return `The ${use.label}`;
      const raw = h.get<{ name: string }>("surname").name;
      const poss = (n: string) => `${n}${n.endsWith("s") ? "'" : "'s"}`;
      // "of Kingsbridge" is where they came from, not a name to hang a house on:
      // it's John of Kingsbridge's house.
      const head = town.children(h.address, "person")[0];
      const sur = raw.startsWith("of ") && head ? personName(town, head.address) : raw;
      // A shop goes by its master and his trade: "Ford the cordwainer's";
      // "fisher's house" becomes "Grove's house", not "Grove's fisher's house".
      if (use.label.includes("'s ")) {
        const [trade, what] = use.label.split("'s ");
        if (/shop|stall/.test(what) && sur.toLowerCase() !== trade.toLowerCase()) return `${sur} the ${trade}'s`;
        return `${poss(sur)} ${what}`;
      }
      return `${poss(sur)} ${use.label}`;
    }
    return undefined;
  },
  panels: [
    {
      id: "name",
      title: "Name",
      for: "person",
      order: 0,
      rows(town, p) {
        const sur = surnameOf(town, p.address);
        const rows = [
          { label: "Name", value: p.get<string>("given"), key: "given", rerollable: true },
          { label: "Called", value: p.get<string | null>("called") ?? "—", key: "called", rerollable: true },
          { label: "Family name", value: sur.name, hint: sur.kind },
        ];
        const born = p.get<string | undefined>("birthname");
        if (born && born !== sur.name) rows.push({ label: "Born", value: born, key: "birthname", rerollable: true });
        return rows;
      },
    },
    {
      id: "household-name",
      title: "Name",
      for: "household",
      order: -1,
      rows(_town, h) {
        const s = h.get<{ name: string; kind: string }>("surname");
        return [{ label: "Family name", value: s.name, hint: `from ${s.kind}` }];
      },
    },
  ],
};

// Every household's family name, in building order. A town's overlay never
// changes after it is made (edits build a new town), so this is safe to keep.
const surnameCache = new WeakMap<import("../../core/town").Town, { h: string; name: string }[]>();

function localSurnames(town: import("../../core/town").Town): { h: string; name: string }[] {
  let l = surnameCache.get(town);
  if (!l) {
    l = [];
    for (const b of town.children(town.root, "building")) for (const h of town.children(b.address, "household")) {
      l.push({ h: h.address, name: h.get<{ name: string }>("surname").name });
    }
    surnameCache.set(town, l);
  }
  return l;
}

const indexCache = new WeakMap<import("../../core/town").Town, Map<string, number>>();

function surnameIndex(town: import("../../core/town").Town): Map<string, number> {
  let m = indexCache.get(town);
  if (!m) indexCache.set(town, (m = new Map(localSurnames(town).map((x, i) => [x.h, i]))));
  return m;
}

/** The name a person goes by. Servants carry their own family name. */
export function surnameOf(town: import("../../core/town").Town, person: string): { name: string; kind: string } {
  const p = town.get(person);
  if (p.get("role") === "servant") return { name: p.get<string>("birthname"), kind: "their own family" };
  if (["official", "lord", "cleric", "retainer", "inmate"].includes(p.get("role"))) return { name: p.get<string>("birthname"), kind: "their own family" };
  const h = town.get(town.parentOf(person)!);
  return h.get<{ name: string; kind: string }>("surname");
}

export function personName(town: import("../../core/town").Town, person: string): string {
  const p = town.get(person);
  return `${p.get<string | null>("called") ?? p.get<string>("given")} ${surnameOf(town, person).name}`;
}
