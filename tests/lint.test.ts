// The text lint: render everything a DM reads for a few towns and look for the
// tell-tale signs of a template gone wrong: unfilled slots, doubled possessives,
// crime labels used as nouns, stacked name endings, words from the wrong century,
// and any line of character that too many people share.
import { describe, expect, test } from "vitest";
import { generate, defaultModules } from "../src/town-gen";
import type { Town } from "../src/core/town";
import type { PanelRow } from "../src/core/types";
import { findHooks } from "../src/modules/sifters";
import { rumoursIn } from "../src/modules/gossip";
import { jobBoard, report, encounter } from "../src/ui/party";
import { LISTS, almanac } from "../src/ui/discover";
import { centroid, type Poly } from "../src/modules/layout/geom";

const flat = (v: PanelRow["value"]): string => (Array.isArray(v) ? v.map((x) => (typeof x === "object" ? x.text : String(x))).join("") : typeof v === "object" ? v.text : String(v));
const panels = defaultModules.flatMap((m) => m.panels ?? []);

function texts(t: Town): string[] {
  const out: string[] = [];
  const all = t.allEntities();
  const step = Math.max(1, Math.floor(all.length / 400));
  for (let i = 0; i < all.length; i += step) {
    const e = all[i];
    for (const p of panels) if (p.for === e.type) for (const r of p.rows(t, e)) out.push(`${r.label}: ${flat(r.value)} ${r.hint ?? ""}`);
    out.push(t.label(e.address));
  }
  for (const h of findHooks(t)) out.push(h.summary);
  for (const r of rumoursIn(t, 1203)) out.push(...r.texts);
  const date = t.clock.date;
  for (const j of jobBoard(t, date)) out.push(flat(j.detail as PanelRow["value"]), flat(j.risk as PanelRow["value"]));
  for (const l of LISTS) for (const r of l.rows(t, date, "evening")) out.push(`${r.label}: ${flat(r.value)}`);
  for (const a of almanac(t, date, 60)) out.push(flat(a.text as PanelRow["value"]));
  const b = t.children(t.root, "building")[0];
  const at = centroid(b.get<Poly>("poly"));
  out.push(JSON.stringify(report(t, at, date, "evening")));
  for (let n = 0; n < 6; n++) out.push(JSON.stringify(encounter(t, at, date, "forenoon", n) ?? {}));
  return out;
}

const BAD: [RegExp, string][] = [
  [/\{[a-z]+\}/, "an unfilled slot"],
  [/s's\b/, "a doubled possessive"],
  [/\bfor (robbed in|house broken|purse cut|pocket picked|shop smashed|horse stolen|linen stolen)/, "a crime label used as a charge"],
  [/(kin|cock)(kin|cock)\b/, "stacked name endings"],
  [/[A-Z][a-z]{5,}(kin|cock)\b/, "an ending on a long name"],
  [/\b1 years\b/, "1 years"],
  [/\bpews?\b/, "pews in 1203"],
  [/\bbrick\b/i, "brick in 1203"],
  [/justice of the peace|magistrate/, "a JP or magistrate in 1203"],
  [/\bundefined\b|\bNaN\b|\[object/, "a leaked value"],
  [/ ,|,,|\.\./, "stray punctuation"],
];

describe("text lint", () => {
  const towns: [string, Town][] = [];
  for (const [seed, pop, base] of [["lint-h", 200, "agricultural"], ["lint-v", 650, "fishing"], ["lint-t", 3000, "agricultural"], ["lint-c", 12000, "agricultural"]] as const) {
    const t = generate(seed, { pop, base });
    t.society();
    towns.push([`${seed} (${pop})`, t]);
  }

  test("no broken templates, wrong-century words or leaked values", () => {
    for (const [name, t] of towns) {
      const all = texts(t);
      for (const [re, what] of BAD) {
        const hit = all.find((x) => re.test(x));
        expect(hit, `${name}: ${what}`).toBeUndefined();
      }
    }
  }, 300000);

  test("no line of character is worn by more than one person in twenty", () => {
    for (const [name, t] of towns) {
      const ps = t.allEntities().filter((e) => e.type === "person");
      if (ps.length < 400) continue;
      for (const k of ["character.want", "character.fear", "character.speech", "character.habit", "character.knack"]) {
        const n = new Map<string, number>();
        for (const p of ps) { const v = p.get<string | null>(k); if (v) n.set(v, (n.get(v) ?? 0) + 1); }
        const [top, count] = [...n].sort((a, b) => b[1] - a[1])[0];
        expect(count / ps.length, `${name} ${k}: "${top}"`).toBeLessThan(0.05);
      }
    }
  }, 300000);
});
