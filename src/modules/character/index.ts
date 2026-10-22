// Character: what a DM needs to play a person at the table. What they want and
// fear, how they talk, what they're good at, how they take to strangers, their
// faith, health, letters and tongues, and what they carry. Plus the secrets
// they hold as of the clock.
import { data } from "../../core/content";
import type { Block } from "../../core/calendar";
import type { EntityLike, Module, PanelRow } from "../../core/types";
import type { Rng } from "../../core/rng";
import { lsd } from "../households";
import type { Tier } from "../core";
import type { Occupation } from "../uses";
import { say, settingOf } from "../people";
import type { NameProvider } from "../names";
import { edgeTold, secretsOf } from "../gossip";
import characterYaml from "./content/character.yaml";

interface Line {
  id: string; text: string; weight: number;
  minAge?: number; maxAge?: number; sex?: string; roles?: string[]; occ?: string[];
  minRank?: number; maxRank?: number; setting?: "country" | "town"; bases?: string[];
  /** field:id pairs that can't stand beside this line */
  clash?: string[];
}
type Field = "wants" | "fears" | "speech" | "habits" | "knacks" | "strangers" | "faith" | "health" | "pockets" | "babes";
type Lists = Record<Field, Line[]>;
const content = data<Lists>(characterYaml);

// Trades that live by the pen, or by the Church.
const LEARNED = new Set(["clerk", "clerk_in_orders", "notary", "lawyer", "physician", "schoolmaster", "scrivener", "canon", "provost", "bishop", "parish_priest", "chantry_priest", "priest", "chaplain", "friar", "monk", "nun", "prior", "abbot"]);
const FOREIGN = ["Flemish", "Italian", "Gascon French", "German", "Breton"];

interface Who {
  age: number; sex: string; role: string; occ: string; rank: number; setting: "country" | "town"; cleric: boolean; base: string;
  /** what's been drawn so far, as field:id, with traits as trait:id; for clashes */
  has: Set<string>;
  place: (r: Rng) => string;
}

const KEY: Record<Field, string> = { wants: "want", fears: "fear", speech: "speech", habits: "habit", knacks: "knack", strangers: "strangers", faith: "faith", health: "health", pockets: "pocket", babes: "babe" };
// Every line's clashes, both ways round: "fear:horses" -> ["want:horse", "knack:horses"].
const CLASH = new Map<string, Set<string>>();
for (const f of Object.keys(KEY) as Field[]) for (const l of content[f] ?? []) for (const c of l.clash ?? []) {
  const me = `${KEY[f]}:${l.id}`;
  (CLASH.get(me) ?? CLASH.set(me, new Set()).get(me)!).add(c);
  (CLASH.get(c) ?? CLASH.set(c, new Set()).get(c)!).add(me);
}

function fits(f: Field, l: Line, w: Who): boolean {
  return w.age >= (l.minAge ?? 0) && w.age <= (l.maxAge ?? 200) && (!l.sex || l.sex === w.sex) &&
    (!l.roles || l.roles.includes(w.role)) && (!l.occ || l.occ.includes(w.occ)) &&
    (l.minRank === undefined || w.rank >= l.minRank) && (l.maxRank === undefined || w.rank <= l.maxRank) &&
    (!l.setting || l.setting === w.setting) && (!l.bases || l.bases.includes(w.base)) &&
    ![...(CLASH.get(`${KEY[f]}:${l.id}`) ?? [])].some((c) => w.has.has(c));
}

function text(r: Rng, l: Line, w: Who): string {
  return say(l.text.replace(/\{place\}/g, () => w.place(r)), w.sex);
}

function pick(r: Rng, f: Field, w: Who): string | null {
  const ok = content[f].filter((l) => fits(f, l, w));
  if (!ok.length) return null;
  const l = r.weighted(ok, (l) => l.weight);
  w.has.add(`${KEY[f]}:${l.id}`);
  return text(r, l, w);
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
  const names = town.registry<NameProvider>("nameProviders").get("anglo-norman");
  const hhAddr = town.parentOf(p.address)!;
  const hh = town.get(hhAddr);
  const tier = hh.type === "household" ? hh.get<string>("tier") : undefined;
  const rank = (tier ? town.registry<Tier>("tiers").find(tier)?.rank : undefined) ?? 5;
  const occ = p.get<string>("occupation") ?? (hh.type === "household" ? hh.get<string>("occupation") : "") ?? "";
  const role = p.get<string>("role");
  const o = town.registry<Occupation>("occupations").find(occ);
  return {
    age: p.get<number>("age"), sex: p.get<string>("sex"), role, occ, rank,
    setting: settingOf(town), base: town.settlement().get<string>("base"),
    cleric: role === "cleric" || !!o?.celibate,
    // Generated traits, so a DM's edit to someone's temper doesn't reshuffle the rest.
    has: new Set((town.get(p.address).generated<string[]>("traits") ?? []).map((t) => `trait:${t}`)),
    place: (r) => names.place(r),
  };
}

export const character: Module = {
  id: "character",
  version: "2.0.0",
  requires: ["core", "households", "people"],
  hooks: {
    onPersonResolved(ctx, p) {
      const town = ctx.town;
      const w = whoIs(town, p);
      const hh = town.get(town.parentOf(p.address)!);
      const income = hh.type === "household" ? hh.get<number>("income") ?? 0 : 0;
      // Babies have a temper, not opinions: no wants, fears or ways of talking.
      const babe = w.age < 3;
      ctx.gen(p, "character.want", (r) => (babe ? null : pick(r, "wants", w)));
      ctx.gen(p, "character.fear", (r) => (babe ? null : pick(r, "fears", w)));
      ctx.gen(p, "character.speech", (r) => (babe ? null : pick(r, "speech", w)));
      ctx.gen(p, "character.habit", (r) => pick(r, babe ? "babes" : "habits", w));
      ctx.gen(p, "character.knack", (r) => (w.age < 4 ? null : pick(r, "knacks", w)));
      ctx.gen(p, "character.strangers", (r) => (w.age < 3 ? null : pick(r, "strangers", w)));
      ctx.gen(p, "character.faith", (r) => {
        if (w.cleric) return r.chance(0.75) ? "devout, as befits the cloth" : r.pick(["worldly: fonder of dinners than of the office", "privately troubled; prays harder for it"]);
        return w.age < 4 ? null : pick(r, "faith", w);
      });
      ctx.gen(p, "character.health", (r) => pick(r, "health", w));
      ctx.gen(p, "character.letters", (r) => letters(r, w, p.get<string[]>("history") ?? []));
      ctx.gen(p, "character.tongues", (r) => (w.age < 3 ? null : tongues(r, w)));
      ctx.gen(p, "character.purse", (r) => purse(r, w, income));
      ctx.gen(p, "character.pockets", (r) => {
        const ok = content.pockets.filter((l) => fits("pockets", l, w));
        const out: string[] = [];
        for (let n = w.age < 4 ? 0 : r.chance(0.5) ? 2 : 1; out.length < n && ok.length;) {
          const t = text(r, r.weighted(ok, (l) => (out.includes(say(l.text, w.sex)) ? 0 : l.weight)), w);
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
        row(p.get<number>("age") < 3 ? "As a baby" : "Habit", "habit");
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
        // Only what they hold close: their own secrets, and what they were told in
        // confidence. What reached them as talk is under "Has heard".
        const all = secretsOf(town, p.address, date, block as Block).filter((x) => x.how === "kept");
        const mine = (x: (typeof all)[number]) => x.edge.from === p.address || x.edge.to === p.address;
        all.sort((a, b) => Number(mine(b)) - Number(mine(a)));
        for (const s of all) {
          const e = s.edge;
          const theirs = mine(s);
          const others = Array.isArray(e.knownBy) ? e.knownBy.filter((x) => x !== p.address).length : 0;
          const hint = s.out ? "it's out: people are talking" : others ? `${others} other${others === 1 ? " knows" : "s know"}` : "nobody else knows";
          rows.push({ label: theirs ? "hides" : "was told", value: edgeTold(town, e), hint: theirs ? hint : `in confidence; ${hint}`, fact: `edge:${e.id}`, highlight: [e.from, e.to] });
        }
        return rows.length ? rows : [{ label: "—", value: "nothing worth hiding, or nothing anyone's found yet" }];
      },
    },
  ],
};
