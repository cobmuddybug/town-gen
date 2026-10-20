import { data } from "../../core/content";
import type { Entity, Town } from "../../core/town";
import type { Module, PanelRow, Sifter } from "../../core/types";
import { isStreetPlan } from "../layout";
import { centroid, dist, type Poly } from "../layout/geom";
import type { BuildingUse, Occupation } from "../uses";
import guildsYaml from "./content/guilds.yaml";

// Merchant and craft guilds (LF p.85). Every merchant belongs to one; each
// craft with enough masters has its own, with wardens, a hall or a tavern to
// meet in, a saint, a feast, rules, and a box for widows. Journeymen live in
// their own lodgings and work for masters; apprentices lodge with them.

interface GuildData {
  names: Record<string, string>;
  extra_members: Record<string, string>;
  rules: string[];
  charity: string[];
  rights: { a: string; b: string; text: string }[];
}
const content = data<GuildData>(guildsYaml);
const MIN_MASTERS = 3;
const SAINTS = ["St Crispin", "St Eloi", "St Clement", "St Blaise", "St Anne", "St Martin", "St Luke", "St John the Baptist", "St Joseph",
  "St Nicholas", "St Bartholomew", "St Catherine", "St Dunstan", "St Lawrence", "St Thomas"];

const guildOf = (town: Town, occ: string): string | undefined =>
  town.registry<Occupation>("occupations").find(occ)?.guild ?? content.extra_members[occ];

/** The guilds this settlement has: those with enough masters in the plan. */
export function guildsIn(town: Town): { id: string; masters: number }[] {
  const s = town.settlement();
  const cached = s.get<{ id: string; masters: number }[] | undefined>("guilds");
  if (cached) return cached;
  return [];
}

function plannedGuilds(town: Town, plan: string[]): { id: string; masters: number }[] {
  const uses = town.registry<BuildingUse>("buildingUses");
  const n = new Map<string, number>();
  for (const u of plan) {
    const row = uses.find(u);
    if (!row) continue;
    // The trade most likely to keep the shop.
    const occ = Object.entries(row.occupations ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
    const g = occ && guildOf(town, occ);
    if (g && !["tenement", "townhouse", "journeyman_house", "poor_row"].includes(u)) n.set(g, (n.get(g) ?? 0) + 1);
  }
  return [...n].filter(([, c]) => c >= MIN_MASTERS).map(([id, masters]) => ({ id, masters })).sort((a, b) => b.masters - a.masters || (a.id < b.id ? -1 : 1));
}

const inst = (town: Town, id: string) => `${town.root}/institution:guild-${id}`;

export const guilds: Module = {
  id: "guilds",
  version: "1.0.0",
  requires: ["core", "uses", "layout", "households", "names", "people", "society"],
  register(add) {
    add<Sifter>("sifters", [masterpieceRefused, whoseRight]);
  },
  hooks: {
    onSettlementGenerated(ctx, s) {
      // Guilds are a town thing; a big village may have one or two.
      if (!isStreetPlan(ctx.town) || s.get<number>("targetPop") < 2500) return;
      const list = plannedGuilds(ctx.town, s.get<string[]>("plan"));
      ctx.set(s, "guilds", list);
      for (const g of list) ctx.create("institution", s.address, `guild-${g.id}`, { kind: "guild", guild: g.id });
    },

    onInstitutionResolved(ctx, i) {
      if (i.get("kind") !== "guild") return;
      ctx.gen(i, "saint", (r) => r.pick(SAINTS));
      ctx.gen(i, "rules", (r) => r.shuffle(content.rules).slice(0, r.int(2, 3)));
      ctx.gen(i, "charity", (r) => r.pick(content.charity));
      ctx.gen(i, "dues", (r) => r.pick(["a penny a week to the box", "fourpence a quarter", "a shilling a year, and a fine for missing the feast"]));
    },

    onHouseholdResolved(ctx, h) {
      if (h.get("occupation") !== "journeyman") return;
      const list = guildsIn(ctx.town);
      if (!list.length) return;
      ctx.gen(h, "guild.craft", (r) => r.weighted(list, (g) => (g.id === "merchants" ? 0 : g.masters)).id);
    },

    onSocietyResolved(ctx, s) {
      const town = ctx.town;
      const list = guildsIn(town);
      if (!list.length) return;
      const formed = new Set(list.map((g) => g.id));
      const r = ctx.rng(s, "guilds");
      interface M { p: Entity; h: Entity; b: Entity; wealth: number; age: number }
      const masters = new Map<string, M[]>();
      const journeymen = new Map<string, M[]>();
      for (const b of town.children(town.root, "building")) for (const h of town.children(b.address, "household")) {
        const p = town.children(h.address, "person")[0];
        if (!p) continue;
        const m: M = { p, h, b, wealth: h.get<number>("income") + h.get<number>("savings") * 0.25, age: p.get("age") };
        const occ = h.get<string>("occupation");
        if (occ === "journeyman") {
          const g = h.get<string | undefined>("guild.craft");
          if (g && formed.has(g)) (journeymen.get(g) ?? journeymen.set(g, []).get(g)!).push(m);
          continue;
        }
        const g = guildOf(town, occ);
        if (g && formed.has(g)) (masters.get(g) ?? masters.set(g, []).get(g)!).push(m);
      }
      const halls = town.children(town.root, "building").filter((b) => b.get("use") === "craft_hall");
      const guildhall = town.children(town.root, "building").find((b) => b.get("use") === "guildhall");
      const taverns = town.children(town.root, "building").filter((b) => ["tavern", "inn", "town_alehouse"].includes(b.get("use")));
      let hallAt = 0;
      for (const g of list) {
        const I = inst(town, g.id);
        const ms = masters.get(g.id) ?? [];
        const js = journeymen.get(g.id) ?? [];
        for (const m of ms) ctx.edge({ from: m.p.address, to: I, kind: "member_of", weight: 0.4, facts: { as: "master" } });
        // The master of the guild and two wardens: wealth and years.
        const senior = [...ms].sort((a, b) => b.wealth * (1 + b.age / 60) - a.wealth * (1 + a.age / 60) || (a.p.address < b.p.address ? -1 : 1));
        if (senior[0]) ctx.edge({ from: senior[0].p.address, to: I, kind: "office_in", weight: 0.5, facts: { office: g.id === "merchants" ? "alderman of the guild" : "master of the guild" } });
        for (const w of senior.slice(1, 3)) ctx.edge({ from: w.p.address, to: I, kind: "office_in", weight: 0.5, facts: { office: "warden" } });
        // Journeymen work for a master of their craft, near at hand.
        for (const j of js) {
          ctx.edge({ from: j.p.address, to: I, kind: "member_of", weight: 0.2, facts: { as: "journeyman" } });
          if (!ms.length) continue;
          const at = centroid(j.b.get<Poly>("poly"));
          const m = r.weighted(ms, (x) => x.wealth / (1 + dist(at, centroid(x.b.get<Poly>("poly"))) / 150));
          ctx.edge({ from: m.p.address, to: j.p.address, kind: "employer", weight: r.range(-0.3, 0.5), facts: { as: "journeyman" } });
        }
        // Where they meet.
        let meets: string | undefined;
        if (g.id === "merchants" && guildhall) meets = guildhall.address;
        else if (hallAt < halls.length) meets = halls[hallAt++].address;
        else if (taverns.length && ms.length) {
          const c = centroid(ms[0].b.get<Poly>("poly"));
          meets = [...taverns].sort((a, b) => dist(c, centroid(a.get<Poly>("poly"))) - dist(c, centroid(b.get<Poly>("poly"))) || (a.address < b.address ? -1 : 1))[0].address;
        }
        if (meets) ctx.set(town.get(I), "meets", meets);
        // A masterpiece refused (LF p.85): the wardens judge who may become a master.
        const wardens = senior.slice(1, 3);
        const ripe = js.filter((j) => j.age >= 22 && j.p.get("sex") === "m");
        if (wardens.length && ripe.length && r.chance(0.4)) {
          const j = r.pick(ripe), w = r.pick(wardens);
          ctx.edge({ from: j.p.address, to: w.p.address, kind: "grievance", weight: -0.6, facts: { about: "the wardens refused his masterpiece, and passed a warden's nephew the same month", guild: g.id }, knownBy: "public" });
        }
      }
      // Whose right is it? Trades quarrel over where one craft ends.
      for (const q of content.rights) {
        const a = masters.get(q.a)?.[0];
        const bGuild = formed.has(q.b) ? masters.get(q.b)?.[0] : undefined;
        let b = bGuild;
        if (!b) {
          // the other side may be a trade with no guild of its own
          for (const bb of town.children(town.root, "building")) {
            const h = town.children(bb.address, "household")[0];
            if (h && h.get("occupation") === q.b) { const p = town.children(h.address, "person")[0]; if (p) b = { p, h, b: bb, wealth: 0, age: 0 }; break; }
          }
        }
        if (!a || !b || a.p === b.p || !r.chance(0.5)) continue;
        const aHead = town.edges({ to: inst(town, q.a), kind: "office_in" }).find((e) => /master|alderman/.test(String(e.facts?.office)))?.from ?? a.p.address;
        ctx.edge({ from: aHead, to: b.p.address, kind: "dispute", weight: -0.5, facts: { about: q.text, guild: q.a } });
      }
    },
  },
  label(_town, e) {
    if (e.type !== "institution" || e.get("kind") !== "guild") return undefined;
    const n = content.names[e.get<string>("guild")] ?? `the ${e.get<string>("guild")} guild`;
    return n[0].toUpperCase() + n.slice(1);
  },
  panels: [
    {
      id: "guild",
      title: "Guild",
      for: "institution",
      order: 0,
      rows(town, i) {
        if (i.get("kind") !== "guild") return [];
        const rows: PanelRow[] = [];
        const members = town.edges({ to: i.address, kind: "member_of" });
        const nm = members.filter((e) => e.facts?.as === "master").length, nj = members.length - nm;
        rows.push({ label: "Members", value: `${nm} masters, ${nj} journeymen, and their apprentices` });
        for (const e of town.edges({ to: i.address, kind: "office_in" })) rows.push({ label: String(e.facts?.office), value: { text: town.label(e.from), address: e.from } });
        const meets = i.get<string | undefined>("meets");
        rows.push({ label: "Meets", value: meets ? { text: town.label(meets), address: meets } : "in the back room of a member's house" });
        rows.push({ label: "Saint", value: `${i.get<string>("saint")}, whose feast is the guild's great day: mass, a procession, and a dinner`, key: "saint", rerollable: true });
        rows.push({ label: "Dues", value: i.get<string>("dues"), key: "dues", rerollable: true });
        rows.push({ label: "Charity", value: i.get<string>("charity"), key: "charity", rerollable: true });
        for (const rule of i.get<string[]>("rules") ?? []) rows.push({ label: "Rule", value: rule });
        rows.push({ label: "Masters", value: members.filter((e) => e.facts?.as === "master").slice(0, 40).flatMap((e, k) => [...(k ? [", "] : []), { text: town.label(e.from), address: e.from }]) });
        return rows;
      },
    },
    {
      id: "guilds",
      title: "Guilds",
      for: "settlement",
      order: 0.6,
      rows(town) {
        const list = guildsIn(town);
        if (!list.length) return [];
        return [{ label: "Guilds", value: list.flatMap((g, k) => [...(k ? [", "] : []), { text: town.label(inst(town, g.id)), address: inst(town, g.id) }]) }];
      },
    },
  ],
};

export const masterpieceRefused: Sifter = {
  id: "masterpiece-refused",
  title: "The masterpiece",
  source: "LF p.85 (craft guilds: masters, journeymen, apprentices)",
  match(town) {
    return town.edges({ kind: "grievance" }).filter((e) => e.facts?.guild && /masterpiece/.test(String(e.facts.about))).map((e) => ({
      title: this.title,
      summary: `${town.label(e.from)}, a journeyman of ${town.label(inst(town, String(e.facts!.guild)))}, says ${e.facts!.about}. The warden was ${town.label(e.to)}.`,
      involves: [e.from, e.to],
    }));
  },
};

export const whoseRight: Sifter = {
  id: "whose-right",
  title: "Whose right is it?",
  source: "LF p.85 (each guild guards its own work)",
  match(town) {
    return town.edges({ kind: "dispute" }).filter((e) => e.facts?.guild).map((e) => ({
      title: this.title,
      summary: `${town.label(inst(town, String(e.facts!.guild)))} complains that ${e.facts!.about}. ${town.label(e.from)} speaks for the guild; ${town.label(e.to)} is the one they mean.`,
      involves: [e.from, e.to],
    }));
  },
};
