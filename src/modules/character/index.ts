// Character: what a DM needs to play a person at the table. What they want and
// fear, how they talk, what they're good at, how they take to strangers, their
// faith, health, letters and tongues, and what they carry. Plus the secrets
// they hold as of the clock.
import { data } from "../../core/content";
import type { Address } from "../../core/address";
import type { Block } from "../../core/calendar";
import type { EntityLike, Module, PanelLink, PanelRow } from "../../core/types";
import type { Rng } from "../../core/rng";
import { lsd } from "../households";
import type { Tier } from "../core";
import type { Occupation } from "../uses";
import { edgeText } from "../people";
import { secretsOf } from "../gossip";
import characterYaml from "./content/character.yaml";

interface Line {
  id: string; text: string; weight: number;
  minAge?: number; maxAge?: number; sex?: string; roles?: string[]; occ?: string[];
  minRank?: number; maxRank?: number; setting?: "country" | "town";
}
type Lists = Record<"wants" | "fears" | "speech" | "habits" | "knacks" | "strangers" | "faith" | "health" | "pockets", Line[]>;
const content = data<Lists>(characterYaml);

// Trades that live by the pen, or by the Church.
const LEARNED = new Set(["clerk", "clerk_in_orders", "notary", "lawyer", "physician", "schoolmaster", "scrivener", "canon", "provost", "bishop", "parish_priest", "chantry_priest", "priest", "chaplain", "friar", "monk", "nun", "prior", "abbot"]);
const FOREIGN = ["Flemish", "Italian", "Gascon French", "German", "Breton"];

interface Who { age: number; sex: string; role: string; occ: string; rank: number; setting: "country" | "town"; cleric: boolean }

function fits(l: Line, w: Who): boolean {
  return w.age >= (l.minAge ?? 0) && w.age <= (l.maxAge ?? 200) && (!l.sex || l.sex === w.sex) &&
    (!l.roles || l.roles.includes(w.role)) && (!l.occ || l.occ.includes(w.occ)) &&
    (l.minRank === undefined || w.rank >= l.minRank) && (l.maxRank === undefined || w.rank <= l.maxRank) &&
    (!l.setting || l.setting === w.setting);
}

// Third person singular: everyone here is he or she.
const VERB: Record<string, string> = { are: "is", have: "has", do: "does", go: "goes" };
function say(text: string, sex: string): string {
  const [they, their, them, self] = sex === "f" ? ["she", "her", "her", "herself"] : ["he", "his", "him", "himself"];
  return text.replace(/\{(\w+)\}/g, (_, w: string) =>
    w === "they" ? they : w === "their" ? their : w === "them" ? them : w === "themself" ? self
      : VERB[w] ?? (/(s|sh|ch|x)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`));
}

function pick(r: Rng, list: Line[], w: Who): string | null {
  const ok = list.filter((l) => fits(l, w));
  return ok.length ? say(r.weighted(ok, (l) => l.weight).text, w.sex) : null;
}

function letters(r: Rng, w: Who, history: string[]): string {
  if (w.age < 7) return "too young for letters";
  if (w.cleric || LEARNED.has(w.occ)) return "reads and writes Latin, and English besides";
  if (history.some((h) => /can read a little/.test(h))) return "reads a little, slowly, with a finger under the line";
  const town = w.setting === "town";
  if (w.age < 16 && w.rank >= 7 && r.chance(town ? 0.6 : 0.3)) return "at school, learning letters and hating it";
  if (w.rank >= 9) return r.chance(0.7) ? "reads well; keeps a clerk to write" : "can sign a name, and leaves the rest to a clerk";
  if (w.rank >= 7) return r.chance(town ? 0.5 : 0.25) ? "reads, and keeps accounts" : "can sign a name and read a bill, just";
  if (w.rank >= 5 && r.chance(town ? 0.15 : 0.05)) return "knows letters, a little";
  return "cannot read";
}

function tongues(r: Rng, w: Who): string {
  const out = ["English"];
  if (w.occ === "foreign_merchant") out.unshift(r.pick(FOREIGN));
  if (w.rank >= 9 || (w.rank >= 7 && r.chance(w.setting === "town" ? 0.4 : 0.15))) out.push("French");
  if (w.cleric || LEARNED.has(w.occ)) out.push("Latin");
  return out.length === 1 ? "English only" : out.slice(0, -1).join(", ") + " and " + out[out.length - 1];
}

/** Coin on them now, in pennies: a few days' share of the household's income. */
function purse(r: Rng, w: Who, income: number): number {
  if (w.age < 6) return 0;
  const daily = income / 365 / (w.role === "head" || w.role === "lord" ? 1 : w.role === "spouse" ? 2 : 4);
  if (w.age < 14) return r.chance(0.5) ? 0 : r.int(0, 2);
  return Math.max(0, Math.round(daily * r.range(0.2, 5) + (r.chance(0.15) ? r.int(0, 3) : 0)));
}

function whoIs(town: import("../../core/town").Town, p: EntityLike): Who {
  const hhAddr = town.parentOf(p.address)!;
  const hh = town.get(hhAddr);
  const tier = hh.type === "household" ? hh.get<string>("tier") : undefined;
  const rank = (tier ? town.registry<Tier>("tiers").find(tier)?.rank : undefined) ?? 5;
  const occ = p.get<string>("occupation") ?? (hh.type === "household" ? hh.get<string>("occupation") : "") ?? "";
  const role = p.get<string>("role");
  const o = town.registry<Occupation>("occupations").find(occ);
  return {
    age: p.get<number>("age"), sex: p.get<string>("sex"), role, occ, rank,
    setting: /town|city/.test(town.settlement().get<string>("sizeClass")) ? "town" : "country",
    cleric: role === "cleric" || !!o?.celibate,
  };
}

export const character: Module = {
  id: "character",
  version: "1.0.0",
  requires: ["core", "households", "people"],
  hooks: {
    onPersonResolved(ctx, p) {
      const town = ctx.town;
      const w = whoIs(town, p);
      const hh = town.get(town.parentOf(p.address)!);
      const income = hh.type === "household" ? hh.get<number>("income") ?? 0 : 0;
      ctx.gen(p, "character.want", (r) => pick(r, content.wants, w));
      ctx.gen(p, "character.fear", (r) => pick(r, content.fears, w));
      ctx.gen(p, "character.speech", (r) => pick(r, content.speech, w));
      ctx.gen(p, "character.habit", (r) => pick(r, content.habits, w));
      ctx.gen(p, "character.knack", (r) => (w.age < 6 ? null : pick(r, content.knacks, w)));
      ctx.gen(p, "character.strangers", (r) => (w.age < 4 ? null : pick(r, content.strangers, w)));
      ctx.gen(p, "character.faith", (r) => {
        if (w.cleric) return r.chance(0.75) ? "devout, as befits the cloth" : r.pick(["worldly: fonder of dinners than of the office", "privately troubled; prays harder for it"]);
        return w.age < 7 ? null : pick(r, content.faith, w);
      });
      ctx.gen(p, "character.health", (r) => pick(r, content.health, w));
      ctx.gen(p, "character.letters", (r) => letters(r, w, p.get<string[]>("history") ?? []));
      ctx.gen(p, "character.tongues", (r) => (w.age < 3 ? null : tongues(r, w)));
      ctx.gen(p, "character.purse", (r) => purse(r, w, income));
      ctx.gen(p, "character.pockets", (r) => {
        const ok = content.pockets.filter((l) => fits(l, w));
        const out: string[] = [];
        for (let n = w.age < 4 ? 0 : r.chance(0.5) ? 2 : 1; out.length < n && ok.length;) {
          const t = say(r.weighted(ok, (l) => (out.includes(say(l.text, w.sex)) ? 0 : l.weight)).text, w.sex);
          if (out.includes(t)) break;
          out.push(t);
        }
        return out;
      });
    },
  },
  panels: [
    {
      id: "character",
      title: "Character",
      for: "person",
      order: 2,
      rows(_town, p) {
        const rows: PanelRow[] = [];
        const row = (label: string, key: string, rerollable = true) => {
          const v = p.get<string | null>(`character.${key}`);
          if (v) rows.push({ label, value: v, key: `character.${key}`, rerollable });
        };
        row("Wants", "want");
        row("Fears", "fear");
        row("Talks", "speech");
        row("Habit", "habit");
        row("Knack", "knack");
        row("To strangers", "strangers");
        row("Faith", "faith");
        row("Health", "health");
        row("Letters", "letters");
        row("Tongues", "tongues");
        const coin = p.get<number>("character.purse");
        const pockets = p.get<string[]>("character.pockets") ?? [];
        const carried = [coin ? lsd(coin) : p.get<number>("age") < 6 ? "" : "not a penny", ...pockets].filter(Boolean);
        if (carried.length) rows.push({ label: "Carrying", value: carried.join("; "), key: "character.pockets", rerollable: true, noEdit: true });
        return rows;
      },
    },
    {
      id: "secrets",
      title: "Secrets",
      for: "person",
      order: 5.5,
      rows(town, p) {
        const { date, block } = town.clock;
        const rows: PanelRow[] = [];
        const name = (a: Address): PanelLink => ({ text: town.label(a), address: a });
        // Their own secrets first, then what they were told, then talk: the
        // talk about their own household and acquaintances, then the newest.
        // Everybody in a town has heard the big stories; those aren't news here.
        const hh = town.parentOf(p.address)!;
        const near = new Set<Address>(town.children(hh, "person").map((x) => x.address));
        for (const e of town.edges({ touching: p.address })) near.add(e.from === p.address ? e.to : e.from);
        const all = secretsOf(town, p.address, date, block as Block);
        const mine = (x: (typeof all)[number]) => x.edge.from === p.address || x.edge.to === p.address;
        const kept = all.filter((x) => x.how === "kept").sort((a, b) => Number(mine(b)) - Number(mine(a)));
        const heard = all.filter((x) => x.how === "heard")
          .map((x) => ({ x, close: near.has(x.edge.from) || near.has(x.edge.to) }))
          .sort((a, b) => Number(b.close) - Number(a.close) || (b.x.since ?? 0) - (a.x.since ?? 0));
        const HEARD = 4;
        for (const s of [...kept, ...heard.slice(0, HEARD).map((h) => h.x)]) {
          const e = s.edge;
          const theirs = mine(s);
          const value: (string | PanelLink)[] = [name(e.from), ` — ${edgeText(town, e, e.from)} — `, name(e.to)];
          const about = e.facts?.about ? `, over ${e.facts.about}` : typeof e.facts?.amount === "number" ? `, ${lsd(e.facts.amount as number)}` : "";
          if (about) value.push(about);
          const label = theirs ? "hides" : s.how === "kept" ? "keeps quiet" : "has heard";
          const others = Array.isArray(e.knownBy) ? e.knownBy.filter((x) => x !== p.address).length : 0;
          const close = !theirs && s.how === "heard" && (near.has(e.from) || near.has(e.to));
          const hint = theirs
            ? s.out ? "it's out: people are talking" : others ? `${others} other${others === 1 ? "" : "s"} know` : "nobody else knows"
            : s.how === "kept" ? "was told in confidence" : close ? "close to home" : "from the talk going round";
          rows.push({ label, value, hint, fact: `edge:${e.id}`, highlight: [e.from, e.to] });
        }
        if (heard.length > HEARD) rows.push({ label: "", value: `and ${heard.length - HEARD} more stories doing the rounds, like everyone else` });
        return rows.length ? rows : [{ label: "—", value: "nothing worth hiding, or nothing anyone's found yet" }];
      },
    },
  ],
};
