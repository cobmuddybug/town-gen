import type { Rng } from "../../core/rng";
import type { Ctx, EntityLike, Module, PanelRow } from "../../core/types";
import type { Base, Tier } from "../core";
import type { BuildingUse, Occupation } from "../uses";

export type Role = "head" | "spouse" | "child" | "parent" | "sibling" | "servant" | "official" | "lord"
  | "apprentice" | "cleric" | "retainer" | "inmate";

interface MemberSpec {
  role: Role;
  sex: "m" | "f";
  age: number;
  occupation?: string;
  marital: "married" | "widowed" | "single";
}

const SERVANT_FOR: Record<string, string> = {
  farmhouse: "farm_servant",
  carter: "farm_servant",
  mill: "mill_hand",
  chapel: "housekeeper",
};

/** Pennies as pounds, shillings and pence. */
export function lsd(d: number): string {
  d = Math.round(d);
  const l = Math.floor(d / 240), s = Math.floor((d % 240) / 12), p = d % 12;
  const parts: string[] = [];
  if (l) parts.push(`£${l}`);
  if (s) parts.push(`${s}s`);
  if (p || !parts.length) parts.push(`${p}d`);
  return parts.join(" ");
}

function members(r: Rng, occ: Occupation, servants: number, servantOcc: string): MemberSpec[] {
  const out: MemberSpec[] = [];
  const widowed = !occ.celibate && r.chance(occ.female ? 0.6 : 0.12);
  // `male` trades (journeymen, gatekeepers...) never have a widow at the head.
  const headSex = occ.female || (widowed && !occ.male && r.chance(0.7)) ? "f" : "m";
  const headAge = widowed ? r.int(34, 68) : occ.celibate ? r.int(26, 66) : r.int(22, 62);
  out.push({ role: "head", sex: headSex, age: headAge, occupation: occ.id, marital: widowed ? "widowed" : occ.celibate ? "single" : "married" });

  let motherAge: number | undefined;
  if (!occ.celibate && !widowed) {
    const spouseAge = Math.max(17, headSex === "m" ? headAge - r.int(-2, 9) : headAge + r.int(-2, 9));
    out.push({ role: "spouse", sex: headSex === "m" ? "f" : "m", age: spouseAge, marital: "married" });
    motherAge = headSex === "m" ? spouseAge : headAge;
  } else if (widowed && headSex === "f") {
    motherAge = headAge;
  } else if (widowed) {
    motherAge = headAge - r.int(0, 6);
  }
  if (motherAge !== undefined) {
    // Births from about 20 until about 42, every two to four years.
    let age = motherAge - r.int(19, 25);
    while (age >= 0) {
      // Many children died young; from twelve or so, many went into service elsewhere.
      const living = r.chance(0.58);
      const atHome = age <= 12 || r.chance(age <= 18 ? 0.45 : 0.15);
      if (living && atHome && motherAge - age <= 42) out.push({ role: "child", sex: r.chance(0.5) ? "m" : "f", age, marital: "single" });
      age -= r.int(2, 4);
    }
  }
  if (headAge < 46 && r.chance(0.18)) {
    out.push({ role: "parent", sex: r.chance(0.7) ? "f" : "m", age: Math.min(84, headAge + r.int(21, 30)), marital: "widowed" });
  }
  if (r.chance(0.07)) out.push({ role: "sibling", sex: r.chance(0.5) ? "m" : "f", age: Math.max(14, headAge + r.int(-8, 8)), marital: "single" });
  for (let i = 0; i < servants; i++) {
    const housekeeper = servantOcc === "housekeeper";
    out.push({
      role: "servant",
      sex: housekeeper ? "f" : r.chance(servantOcc === "farm_servant" || servantOcc === "mill_hand" ? 0.7 : 0.4) ? "m" : "f",
      age: housekeeper ? r.int(30, 56) : r.int(13, 24),
      occupation: servantOcc,
      marital: "single",
    });
  }
  // Town trades: apprentices lodge with the master (LF p.85); clergy, garrisons
  // and almsfolk live in. Only rows that ask for them draw at all.
  if (occ.apprentices) for (let i = 0, n = r.int(occ.apprentices[0], occ.apprentices[1]); i < n; i++) {
    out.push({ role: "apprentice", sex: "m", age: r.int(13, 20), occupation: "apprentice", marital: "single" });
  }
  for (const st of occ.staff ?? []) for (let i = 0, n = r.int(st.n[0], st.n[1]); i < n; i++) {
    const age = st.role === "inmate" ? r.int(st.occupation === "leper" ? 16 : 40, 82) : st.role === "retainer" ? r.int(18, 46) : r.int(20, 68);
    out.push({ role: st.role as Role, sex: st.sex ?? (st.role === "inmate" && r.chance(0.4) ? "f" : "m"), age, occupation: st.occupation, marital: st.role === "inmate" && r.chance(0.6) ? "widowed" : "single" });
  }
  return out;
}

function kin(ctx: Ctx, from: string, to: string, rel: string, inv: string) {
  ctx.edge({ from, to, kind: "kin", weight: 0.6, facts: { rel, inv } });
}

export const households: Module = {
  id: "households",
  version: "1.0.0",
  requires: ["core", "uses"],
  hooks: {
    onBuildingResolved(ctx, b) {
      const use = ctx.registry<BuildingUse>("buildingUses").find(b.get("use"));
      const h = use?.households ?? 0;
      const n = Array.isArray(h) ? ctx.gen(b, "householdCount", (r) => r.int(h[0], h[1])) : h;
      for (let i = 0; i < n; i++) ctx.create("household", b.address, String(i));
    },

    onHouseholdResolved(ctx, h) {
      const town = ctx.town;
      const b = town.get(town.parentOf(h.address)!);
      const settlement = town.settlement();
      const useId = b.get<string>("use");
      const use = ctx.registry<BuildingUse>("buildingUses").find(useId);
      const occs = ctx.registry<Occupation>("occupations");
      const occId = ctx.gen(h, "occupation", (r) => {
        const choices = Object.entries(use?.occupations ?? {}).filter(([id]) => occs.has(id));
        return choices.length ? r.weighted(choices, ([, w]) => w)[0] : "labourer";
      }) as string;
      const occ = occs.find(occId) ?? occs.get("labourer");
      const tierId = ctx.gen(h, "tier", () => occ.tier) as string;
      const tier = ctx.registry<Tier>("tiers").get(tierId);

      const land = ctx.gen(h, "land", (r) => (occ.land ? r.int(occ.land[0], occ.land[1]) : 0));
      // What the "biggest local holder" holds (LF p.75): acres on farmland,
      // boats, sheep, ore shares or felling rights elsewhere.
      const base = ctx.registry<Base>("bases").get(settlement.get("base"));
      ctx.gen(h, "stake", (r) => (base.stake === "acres" ? land : occ.stake ? r.int(occ.stake[0], occ.stake[1]) : 0));
      const isRichest = occ.id === settlement.get("richestTrade");
      ctx.gen(h, "income", (r) => {
        let v = tier.income * r.range(0.75, 1.3) + (land as number) * 14;
        if (isRichest) v *= settlement.get("richestRuleHolds") ? 1.9 : 0.6;
        // In a town, fortunes run to a long tail: most merchants get by, a few
        // are rich enough to lend to the king (LFP: a great house for every 450 or so).
        if (tier.rank >= 7 && settlement.get<{ kind?: string }>("map")?.kind === "town") {
          const u = r.next();
          v *= u < 0.7 ? 1 : u < 0.93 ? r.range(1.5, 3) : r.range(3, 9);
        }
        return Math.round(v);
      });
      ctx.gen(h, "savings", (r) => Math.round((h.get<number>("income")) * r.range(0.05, isRichest && settlement.get("richestRuleHolds") ? 2.5 : 0.8)));

      const nServants = ctx.gen(h, "servantCount", (r) => (occ.servants ? r.int(occ.servants[0], occ.servants[1]) : 0)) as number;
      const specs = members(ctx.rng(h, "members"), occ, nServants, SERVANT_FOR[useId] ?? "servant");
      const addrs = specs.map((m, i) => ctx.create("person", h.address, String(i), {
        role: m.role, sex: m.sex, age: m.age, occupation: m.occupation, marital: m.marital,
      }).address);
      ctx.set(h, "size", specs.length);

      // Kin and service edges inside the household.
      const head = addrs[0];
      const headSex = specs[0].sex;
      const spouseIdx = specs.findIndex((m) => m.role === "spouse");
      if (spouseIdx >= 0) {
        const [husband, wife] = headSex === "m" ? [head, addrs[spouseIdx]] : [addrs[spouseIdx], head];
        ctx.edge({ from: husband, to: wife, kind: "spouse", weight: 0.4, facts: { rel: "husband", inv: "wife" } });
      }
      specs.forEach((m, i) => {
        const a = addrs[i];
        const child = m.sex === "m" ? "son" : "daughter";
        if (m.role === "child") {
          kin(ctx, a, head, child, headSex === "m" ? "father" : "mother");
          if (spouseIdx >= 0) kin(ctx, a, addrs[spouseIdx], child, specs[spouseIdx].sex === "m" ? "father" : "mother");
        } else if (m.role === "parent") {
          kin(ctx, head, a, headSex === "m" ? "son" : "daughter", m.sex === "m" ? "father" : "mother");
        } else if (m.role === "sibling") {
          kin(ctx, a, head, m.sex === "m" ? "brother" : "sister", headSex === "m" ? "brother" : "sister");
        } else if (m.role === "servant") {
          ctx.edge({ from: a, to: head, kind: "serves", weight: 0.1 });
        } else if (m.role === "apprentice") {
          ctx.edge({ from: a, to: head, kind: "apprentice_of", weight: 0.2, facts: { years: 1 + (i % 6), lodges: true } });
        } else if (m.role === "retainer") {
          ctx.edge({ from: a, to: head, kind: "serves", weight: 0.2, facts: { as: m.occupation } });
        }
      });
    },
  },
  panels: [
    {
      id: "household",
      title: "Household",
      for: "household",
      order: 0,
      rows(town, h) {
        const occs = town.registry<Occupation>("occupations");
        const occ = occs.find(h.get("occupation"));
        const tier = town.registry<Tier>("tiers").find(h.get("tier"));
        const people = town.children(h.address, "person");
        return [
          { label: "Trade", value: occ?.label ?? h.get<string>("occupation"), key: "occupation", options: occs.list(town.settings.era).map((o) => o.id) },
          { label: "Class", value: tier?.label ?? h.get<string>("tier"), key: "tier", options: town.registry<Tier>("tiers").list().map((t) => t.id) },
          ...(h.get<number>("land") ? [{ label: "Land", value: `${h.get<number>("land")} acres` }] : []),
          ...stakeRow(town, h),
          { label: "Income", value: `${lsd(h.get<number>("income"))} a year`, hint: "abstract value; compare, don't price" },
          { label: "Put by", value: lsd(h.get<number>("savings")) },
          { label: "People", value: people.map((p) => ({ text: `${town.label(p.address)} (${roleText(p)}, ${p.get<number>("age")})`, address: p.address })) },
        ];
      },
    },
  ],
};

export function roleText(p: EntityLike): string {
  const role = p.get<Role>("role");
  const f = p.get<string>("sex") === "f";
  switch (role) {
    case "head": return p.get("marital") === "widowed" ? (f ? "head, widow" : "head, widower") : "head";
    case "spouse": return f ? "wife" : "husband";
    case "child": return f ? "daughter" : "son";
    case "parent": return f ? "mother of the head" : "father of the head";
    case "sibling": return f ? "sister of the head" : "brother of the head";
    case "servant": return "servant";
    case "official": return "an officer of the manor, living elsewhere";
    case "apprentice": return "apprentice";
    case "cleric": return p.get<string>("occupation")?.replace(/_/g, " ") ?? "cleric";
    case "retainer": return p.get<string>("occupation") === "soldier" ? "of the garrison" : "of the household";
    case "inmate": return p.get<string>("occupation") === "leper" ? "leper" : "bedesman";
    case "lord": return "lord of the manor";
  }
  return role;
}

const STAKE_TEXT: Record<string, (n: number) => string> = {
  boats: (n) => (n === 0 ? "crews in other men's boats" : n === 1 ? "owns a boat" : `owns ${n} boats`),
  sheep: (n) => (n === 0 ? "no beasts of their own" : `${n} sheep`),
  "ore shares": (n) => (n === 0 ? "digs for wages" : n === 1 ? "a share in a working" : `${n} shares in workings`),
  "felling rights": (n) => (n === 0 ? "fells for wages" : n === 1 ? "a felling right" : `${n} felling rights`),
};

function stakeRow(town: import("../../core/town").Town, h: EntityLike): PanelRow[] {
  const unit = town.registry<Base>("bases").get(town.settlement().get("base")).stake;
  if (unit === "acres" || !STAKE_TEXT[unit]) return [];
  const n = h.get<number>("stake");
  if (!n && !["fisherman", "miner", "woodcutter", "shepherd", "cowherd"].includes(h.get("occupation"))) return [];
  return [{ label: "Holds", value: STAKE_TEXT[unit](n) }];
}
