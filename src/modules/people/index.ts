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
import type { Tier } from "../core";

export interface HistoryLine extends Row {
  text: string; weight: number; minAge?: number; maxAge?: number; sex?: string; roles?: string[]; occ?: string[]; maxRank?: number;
  minRank?: number; setting?: "country" | "town";
}

export interface Trait extends Row { label: string; weight: number; old?: number }
export interface Feature extends Row { label: string; weight: number; minAge?: number; maxAge?: number }

export const people: Module = {
  id: "people",
  version: "1.0.0",
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
      const traits = ctx.registry<Trait>("traits").list();
      ctx.gen(p, "traits", (r) => {
        if (age < 4) return [];
        const n = age < 12 ? 1 : r.chance(0.6) ? 2 : 1;
        const out: string[] = [];
        while (out.length < n) {
          const t = r.weighted(traits, (t) => (out.includes(t.id) ? 0 : age >= 50 && t.old ? t.old * t.weight : t.weight));
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
      const setting = /town|city/.test(town.settlement().get<string>("sizeClass")) ? "town" : "country";
      const fits = ctx.registry<HistoryLine>("history").list(ctx.era).filter((h) =>
        age >= (h.minAge ?? 0) && age <= (h.maxAge ?? 200) && (!h.sex || h.sex === s) &&
        (!h.roles || h.roles.includes(role)) && (!h.occ || h.occ.includes(occ)) && (h.maxRank === undefined || rank <= h.maxRank) &&
        (h.minRank === undefined || rank >= h.minRank) && (!h.setting || h.setting === setting));
      const names = ctx.registry<NameProvider>("nameProviders").get("anglo-norman");
      ctx.gen(p, "history", (r) => {
        const n = age < 16 ? 1 : r.chance(0.55) ? 1 : 2;
        const picked: HistoryLine[] = [];
        while (picked.length < n && picked.length < fits.length) {
          picked.push(r.weighted(fits, (h) => (picked.includes(h) ? 0 : h.weight)));
        }
        const [they, their, them] = s === "f" ? ["she", "her", "her"] : ["he", "his", "him"];
        return picked.map((h) => h.text
          .replace(/\{they\}/g, they).replace(/\{their\}/g, their).replace(/\{them\}/g, them)
          .replace(/\{place\}/g, () => names.place(r))
          .replace(/\{n\}/g, () => String(Math.max(1, Math.min(age - 12, r.int(2, 30))))));
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
        const traits = town.registry<Trait>("traits");
        const occ = town.registry<Occupation>("occupations").find(p.get("occupation"));
        const rows: PanelRow[] = [
          { label: "Age", value: p.get<number>("age") },
          { label: "Place", value: roleText(p) },
        ];
        if (occ) rows.push({ label: "Work", value: occ.label });
        rows.push(
          { label: "Temper", value: p.get<string[]>("traits").map((t) => traits.find(t)?.label ?? t).join(", ") || "—", key: "traits", rerollable: true },
          { label: "Looks", value: town.registry<Feature>("features").find(p.get("feature"))?.label ?? "—", key: "feature", rerollable: true },
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

export function edgeText(town: Town, e: Edge, from: string): string {
  const kind = town.registry<EdgeKind>("edgeKinds").find(e.kind);
  const outward = e.from === from;
  const facts = e.facts ?? {};
  if (outward) return (facts.rel as string | undefined) ? `${facts.rel} of` : kind?.label ?? e.kind;
  if (facts.inv) return `${facts.inv} of`;
  return kind?.symmetric ? kind.label : kind?.inverse ?? `${e.kind} (from)`;
}

export function relationshipRows(town: Town, address: string): PanelRow[] {
  const rows: PanelRow[] = [];
  for (const e of town.edges({ touching: address })) {
    const other = e.from === address ? e.to : e.from;
    const link: PanelLink = { text: town.label(other), address: other };
    const f = e.facts ?? {};
    let about = f.about ? ` — ${f.about}` : "";
    if (typeof f.amount === "number") about = ` — ${lsd(f.amount)}${f.reason ? ` for ${f.reason}` : ""}${f.due ? `, due at ${f.due}` : ""}`;
    else if (f.as) about = ` — as ${f.as}`;
    else if (f.office) about = ` — ${f.office}`;
    const secret = e.knownBy !== "public" ? " (not common knowledge)" : "";
    rows.push({ label: edgeText(town, e, address), value: [link, about + secret].filter(Boolean) as (string | PanelLink)[] });
  }
  if (!rows.length) rows.push({ label: "—", value: "nobody of note, yet" });
  return rows;
}
