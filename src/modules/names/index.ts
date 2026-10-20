import { data } from "../../core/content";
import type { Row } from "../../core/registry";
import type { Rng } from "../../core/rng";
import type { Module } from "../../core/types";
import type { BuildingUse, Occupation } from "../uses";

// Buildings there is usually only one of are named for what they are.
const UNIQUE = new Set(["mill", "chapel", "shrine", "alehouse", "trader", "smithy", "bakehouse"]);
import anglo from "./content/anglo-norman.yaml";

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
      const base = rng.chance(0.5) ? (d.called[father] ? rng.pick(d.called[father]) : father) : father;
      return { name: base + rng.pick(d.patronym_suffix), kind: "a forefather's name" };
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
  version: "1.0.0",
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
      const h = town.children(e.address, "household")[0];
      if (UNIQUE.has(use.id) || !h) return `The ${use.label}`;
      const sur = h.get<{ name: string }>("surname").name.replace(/^of /, "");
      // "fisher's house" becomes "Grove's house", not "Grove's fisher's house".
      const what = use.label.includes("'s ") ? use.label.split("'s ")[1] : use.label;
      return `${sur}${sur.endsWith("s") ? "'" : "'s"} ${what}`;
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
