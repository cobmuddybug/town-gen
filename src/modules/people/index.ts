// People: their temper (traits that don't clash), their looks and a line or two
// of history; the Person and Relationships panels. say() agrees a line of text
// with its subject ("{they} {verb}" -> "she sings").
import { table } from "../../core/content";
import type { Row } from "../../core/registry";
import type { Edge, Module, PanelLink, PanelRow } from "../../core/types";
import type { Town } from "../../core/town";
import { lsd, roleText } from "../households";
import type { EdgeKind } from "../../core/types";
import type { Occupation } from "../uses";
import traitsYaml from "./content/traits.yaml";
import featuresYaml from "./content/features.yaml";
import historyYaml from "./content/history.yaml";
import type { NameProvider } from "../names";
import { isUrban, type Tier } from "../core";

export interface HistoryLine extends Row {
  text: string; weight: number; minAge?: number; maxAge?: number; sex?: string; roles?: string[]; occ?: string[]; maxRank?: number;
  minRank?: number; setting?: "country" | "town"; bases?: string[];
  /** only for people who are or were married */
  wed?: boolean;
  /** {n} years ago can be at most age minus this (default 12) */
  nBack?: number;
}

export interface Trait extends Row { label: string; weight: number; old?: number; minAge?: number; clash?: string[] }
export interface Feature extends Row { label: string; weight: number; minAge?: number; maxAge?: number }

/** "town" for a market town or bigger, else "country". */
export const settingOf = (town: Town): "town" | "country" => (isUrban(town) ? "town" : "country");

// Third person singular: everyone here is he or she.
const VERB: Record<string, string> = { are: "is", have: "has", do: "does", go: "goes" };
/** Fill {they}/{their}/{them}/{themself} and make {verb} agree with them. */
export function say(text: string, sex: string): string {
  const [they, their, them, self] = sex === "f" ? ["she", "her", "her", "herself"] : ["he", "his", "him", "himself"];
  return text.replace(/\{(\w+)\}/g, (_, w: string) =>
    w === "they" ? they : w === "their" ? their : w === "them" ? them : w === "themself" ? self
      : VERB[w] ?? (/(s|sh|ch|x)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`));
}

/** How a person looks, in words that agree with them. */
export function looksOf(town: Town, p: { get<T>(k: string): T }): string | undefined {
  const f = town.registry<Feature>("features").find(p.get("feature"));
  return f && say(f.label, p.get<string>("sex"));
}

/** Their temper, in words that agree with them. */
export function temperOf(town: Town, p: { get<T>(k: string): T }): string {
  const traits = town.registry<Trait>("traits");
  return (p.get<string[]>("traits") ?? []).map((t) => say(traits.find(t)?.label ?? t, p.get<string>("sex"))).join(", ");
}

export const people: Module = {
  id: "people",
  version: "2.0.0",
  requires: ["core", "households", "names"],
  provides: ["traits", "features", "history"],
  register(add) {
    add("traits", table<Trait>(traitsYaml, "traits"));
    add("features", table<Feature>(featuresYaml, "features"));
    add("history", table<HistoryLine>(historyYaml, "history"));
  },
  hooks: {
    onPersonResolved(ctx, p) {
      const age = p.get<number>("age");
      const reg = ctx.registry<Trait>("traits"), traits = reg.list();
      ctx.gen(p, "traits", (r) => {
        if (age < 4) return [];
        const n = age < 12 ? 1 : r.chance(0.6) ? 2 : 1;
        const out: string[] = [];
        // Two traits that can't live in one person ("cheerful, melancholy") never come together.
        const clashes = (a: Trait, b: string) => a.clash?.includes(b) || reg.find(b)?.clash?.includes(a.id);
        while (out.length < n) {
          const t = r.weighted(traits, (t) => (out.includes(t.id) || (t.minAge ?? 0) > age || out.some((o) => clashes(t, o)) ? 0 : age >= 50 && t.old ? t.old * t.weight : t.weight));
          out.push(t.id);
        }
        return out;
      });
      const feats = ctx.registry<Feature>("features").list().filter((f) => (!f.minAge || age >= f.minAge) && (f.maxAge === undefined || age <= f.maxAge));
      ctx.gen(p, "feature", (r) => r.weighted(feats, (f) => f.weight).id);

      const town = ctx.town;
      const hh = town.get(town.parentOf(p.address)!);
      const rank = town.registry<Tier>("tiers").find(hh.get("tier"))?.rank ?? 3;
      const role = p.get<string>("role"), s = p.get<string>("sex"), occ = hh.get<string>("occupation");
      const setting = settingOf(town);
      const base = town.settlement().get<string>("base");
      const fits = ctx.registry<HistoryLine>("history").list(ctx.era).filter((h) =>
        age >= (h.minAge ?? 0) && age <= (h.maxAge ?? 200) && (!h.sex || h.sex === s) &&
        (!h.roles || h.roles.includes(role)) && (!h.occ || h.occ.includes(occ)) && (h.maxRank === undefined || rank <= h.maxRank) &&
        (h.minRank === undefined || rank >= h.minRank) && (!h.setting || h.setting === setting) && (!h.bases || h.bases.includes(base)) &&
        (!h.wed || (p.get<string>("marital") !== "single" && p.get<string>("marital") !== undefined)));
      const names = ctx.registry<NameProvider>("nameProviders").get("anglo-norman");
      ctx.gen(p, "history", (r) => {
        const n = age < 16 ? 1 : r.chance(0.55) ? 1 : 2;
        const picked: HistoryLine[] = [];
        while (picked.length < n && picked.length < fits.length) {
          picked.push(r.weighted(fits, (h) => (picked.includes(h) ? 0 : h.weight)));
        }
        // {n} years ago stays inside the life: a son who left 20 years ago needs a parent of 50.
        return picked.map((h) => say(h.text
          .replace(/\{place\}/g, () => names.place(r))
          .replace(/\{n\}/g, () => String(Math.max(1, Math.min(age - (h.nBack ?? 12), r.int(2, 30))))), s));
      });
    },
  },
  panels: [
    {
      id: "person",
      title: "Person",
      for: "person",
      order: 1,
      rows(town, p) {
        const occ = town.registry<Occupation>("occupations").find(p.get("occupation"));
        const rows: PanelRow[] = [
          { label: "Age", value: p.get<number>("age") },
          { label: "Place", value: roleText(p) },
        ];
        if (occ) rows.push({ label: "Work", value: occ.label });
        rows.push(
          { label: "Temper", value: temperOf(town, p) || "—", key: "traits", rerollable: true },
          { label: "Looks", value: looksOf(town, p) ?? "—", key: "feature", rerollable: true },
        );
        p.get<string[]>("history").forEach((h, i) => rows.push({ label: i ? "\u00a0" : "History", value: h, ...(i ? {} : { key: "history", rerollable: true, noEdit: true }) }));
        return rows;
      },
    },
    {
      id: "relationships",
      title: "Relationships",
      for: "person",
      order: 5,
      rows(town, p) {
        return relationshipRows(town, p.address);
      },
    },
  ],
};

/** An edge in words from one end: "wife of", "owes money to", "friend of". */
export function edgeText(town: Town, e: Edge, from: string): string {
  const kind = town.registry<EdgeKind>("edgeKinds").find(e.kind);
  const outward = e.from === from;
  const facts = e.facts ?? {};
  if (outward) return (facts.rel as string | undefined) ? `${facts.rel} of` : kind?.label ?? e.kind;
  if (facts.inv) return `${facts.inv} of`;
  return kind?.symmetric ? kind.label : kind?.inverse ?? `${e.kind} (from)`;
}

// Relationships in the order a DM wants them: the house, the family, work,
// friends, quarrels, then money.
const GROUP: Record<string, number> = {
  spouse: 0, kin: 1, godparent: 1, betrothed: 2, courting: 2, lover: 2, serves: 3, apprentice_of: 3, employer: 3, member_of: 4, office_in: 4,
  tenant_of: 4, vassal_of: 4, owes_service: 4, friend: 5, rival: 6, dispute: 6, grievance: 6, debtor_of: 7,
};
const KIN_ORDER = ["husband", "wife", "father", "mother", "son", "daughter", "brother", "sister", "cousin"];

/** The Relationships panel: family first, then everyone else they are tied to. */
export function relationshipRows(town: Town, address: string): PanelRow[] {
  const rows: PanelRow[] = [];
  const home = town.parentOf(address);
  const edges = [...town.edges({ touching: address })];
  const key = (e: Edge) => {
    const other = e.from === address ? e.to : e.from;
    const sameHouse = town.parentOf(other) === home ? 0 : 1;
    const label = edgeText(town, e, address);
    const kin = KIN_ORDER.findIndex((k) => label.startsWith(k));
    return [GROUP[e.kind] ?? 8, e.kind === "kin" ? sameHouse : 0, kin < 0 ? 99 : kin, label, town.label(other)] as const;
  };
  edges.sort((a, b) => {
    const x = key(a), y = key(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  });
  for (const e of edges) {
    const other = e.from === address ? e.to : e.from;
    const link: PanelLink = { text: town.label(other), address: other };
    const f = e.facts ?? {};
    let about = f.about ? ` — ${f.about}` : "";
    if (typeof f.amount === "number") about = ` — ${lsd(f.amount)}${f.reason ? ` for ${f.reason}` : ""}${f.due ? `, due at ${f.due}` : ""}`;
    else if (f.as) about = ` — as ${f.as}`;
    else if (f.office) about = ` — ${f.office}`;
    const secret = e.knownBy !== "public" ? " (not common knowledge)" : "";
    rows.push({ label: edgeText(town, e, address), value: [link, about + secret].filter(Boolean) as (string | PanelLink)[], fact: `edge:${e.id}` });
  }
  if (!rows.length) rows.push({ label: "—", value: "nobody of note, yet" });
  return rows;
}
