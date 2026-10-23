// Hirelings: the people a party can take on for pay (LFP, after Ross: a few
// in every settlement, more in towns), and the odd old soldier or travelled
// man who has seen more than the rest (LFP's "adventurers", about one in 3,000).
// Chosen in the society phase from people already living there, by what they
// are and what they can do.
import type { Address } from "../../core/address";
import type { Entity } from "../../core/town";
import type { Module, PanelRow } from "../../core/types";
import { isUrban, type Tier } from "../core";
import { lsd } from "../households";

interface Kind { id: string; label: string; rate: [number, number]; fits(p: Entity, x: { occ: string; rank: number; town: boolean; base: string }): number }
const KINDS: Kind[] = [
  { id: "guide", label: "a guide who knows the roads and the short ways", rate: [2, 4], fits: (p, x) => (/tracking|weather|horses/.test(p.get<string>("character.knack") ?? "") ? 4 : 0) + (/came here from|was robbed on the road|rode to/.test((p.get<string[]>("history") ?? []).join()) ? 2 : 0) + (["carter", "drover", "freighter", "herdsman", "shepherd"].includes(x.occ) ? 3 : 0) },
  { id: "porter", label: "a porter, to carry and fetch", rate: [1, 2], fits: (_p, x) => (["porter", "labourer", "town_labourer", "carter"].includes(x.occ) ? 3 : 0) },
  { id: "man_at_arms", label: "a man-at-arms, with his own cudgel or bill", rate: [3, 6], fits: (p) => ((p.get<string[]>("traits") ?? []).some((t) => ["bold", "quarrelsome", "brave", "hot_tempered"].includes(t)) ? 2 : 0) + (/levy|fought|soldier|garrison/.test((p.get<string[]>("history") ?? []).join()) ? 4 : 0) + (/wrestles|bow/.test(p.get<string>("character.knack") ?? "") ? 3 : 0) },
  { id: "linkboy", label: "a linkboy, to light the way at night for a farthing", rate: [0.25, 0.5], fits: (p, x) => (x.town && p.get<number>("age") <= 16 ? 2 : 0) },
  { id: "boatman", label: "a boatman, with his boat", rate: [2, 4], fits: (_p, x) => (x.occ === "fisherman" || x.base === "fishing" ? 3 : 0) },
  { id: "interpreter", label: "an interpreter, who has French and a little Latin", rate: [3, 6], fits: (p) => (/French/.test(p.get<string>("character.tongues") ?? "") ? 3 : 0) },
  { id: "local", label: "a local who knows everyone's business, for the price of a drink", rate: [1, 2], fits: (p) => ((p.get<string[]>("traits") ?? []).includes("gossip") ? 3 : 0) + (/never forgets a face|back way/.test(p.get<string>("character.knack") ?? "") ? 3 : 0) },
];

const PERSONAGES = [
  "went on crusade as a young man, and came back with a scar, a relic of doubtful worth, and no money",
  "served ten years as a man-at-arms in the king's wars across the sea, and still wakes at the night watch",
  "was a lord's huntsman until the lord died, and knows every wood for twenty miles",
  "travelled as a pedlar as far as the great fairs over the sea, and speaks of things nobody here believes",
  "was a sailor, until a storm broke his leg and his nerve, and still knows the coast",
  "went for an outlaw for three years in the forest, was pardoned, and doesn't talk about it",
];

export const hire: Module = {
  id: "hire",
  version: "1.0.0",
  requires: ["core", "households", "people", "character", "society"],
  hooks: {
    onSocietyResolved(ctx, s) {
      const town = ctx.town;
      const tiers = town.registry<Tier>("tiers");
      const r = ctx.rng(s, "hire");
      const urban = isUrban(town);
      const base = s.get<string>("base");
      const pop = s.get<number>("targetPop");
      const pool: { p: Entity; occ: string; rank: number; age: number }[] = [];
      for (const b of town.children(town.root, "building")) for (const h of town.children(b.address, "household")) {
        const rank = tiers.find(h.get<string>("tier"))?.rank ?? 3;
        if (rank > 5) continue;
        for (const p of town.children(h.address, "person")) {
          const age = p.get<number>("age");
          if (age < 12 || age > 55 || p.get("role") === "cleric") continue;
          pool.push({ p, occ: p.get<string>("occupation") ?? h.get<string>("occupation"), rank, age });
        }
      }
      // A few in a village, a few dozen in a city.
      const want = Math.min(30, Math.max(3, Math.round(pop / 300)));
      const taken = new Set<Address>();
      // How well each of the pool fits each kind of work, worked out once: a city's pool is thousands.
      const scores = new Map<Kind, Map<Entity, number>>();
      const scoreOf = (k: Kind) => {
        let m = scores.get(k);
        if (!m) scores.set(k, (m = new Map(pool.map((x) => [x.p, k.fits(x.p, { occ: x.occ, rank: x.rank, town: urban, base })]))));
        return m;
      };
      for (let n = 0; n < want * 3 && taken.size < want; n++) {
        const k = KINDS[n % KINDS.length];
        const score = scoreOf(k);
        const fit = pool.filter((x) => !taken.has(x.p.address) && (k.id === "linkboy" ? x.age <= 16 : x.age >= 16) && score.get(x.p)! > 0);
        if (!fit.length) continue;
        const x = r.weighted(fit, (y) => score.get(y.p)!);
        taken.add(x.p.address);
        ctx.set(x.p, "hire.as", k.id);
        ctx.set(x.p, "hire.rate", Math.round(r.range(k.rate[0], k.rate[1]) * 4) / 4);
      }
      // The travelled ones: about one in three thousand, at least one in a town.
      const old = pool.filter((x) => x.age >= 35 && x.p.get("sex") === "m" && !taken.has(x.p.address));
      const pasts = r.shuffle(PERSONAGES);
      for (let n = 0, m = Math.min(pasts.length, Math.max(urban ? 1 : 0, Math.round(pop / 3000))); n < m && old.length; n++) {
        const x = old.splice(r.int(0, old.length - 1), 1)[0];
        ctx.set(x.p, "hire.past", pasts[n]);
      }
    },
  },
  panels: [
    {
      id: "hire",
      title: "For hire",
      for: "person",
      order: 2.8,
      rows(_town, p) {
        const rows: PanelRow[] = [];
        const as = p.get<string | undefined>("hire.as");
        if (as) rows.push({ label: "Will hire out as", value: KINDS.find((k) => k.id === as)?.label ?? as, hint: `${hireRate(p.get<number>("hire.rate"))} a day, and food` });
        const past = p.get<string | undefined>("hire.past");
        if (past) rows.push({ label: "Has seen the world", value: past, hint: "worth a drink and an evening; might come along for the right cause" });
        return rows;
      },
    },
  ],
};

/** A day's hire in words: "a farthing", "three farthings", or pence and shillings. */
export function hireRate(d: number): string {
  return d < 1 ? (d <= 0.25 ? "a farthing" : d <= 0.5 ? "a halfpenny" : "three farthings") : lsd(Math.round(d));
}

export const HIRE_KINDS = KINDS.map((k) => ({ id: k.id, label: k.label }));
