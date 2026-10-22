import sizes from "../modules/core/content/sizes.yaml";
import type { Design, Era } from "../core/types";
import { designFrom } from "./library";

/** A town of six thousand is not anybody's manor. */
export const MANOR_MAX = 6000;
/** Street plans (and so the Plan choices) start above this. */
export const PLAN_MIN = 700;

const SIZES = (sizes as { id: string; label: string; min: number; max: number }[]);
const LINES: Record<string, string> = {
  hamlet: "A hamlet: a few farmsteads round a green, a hedge and a lord.",
  thorp: "A village: a church, a mill, a council of elders.",
  village: "A market town: streets, wards, guilds and a market.",
  town: "A town: walls, gates, parishes, guilds and crews.",
  city: "A city: walls, a castle, many parishes, and every trade there is.",
};

/** What the dice will make of this many people (LF p.72). */
export function sizePreview(pop: number): { id: string; label: string; line: string } {
  const s = SIZES.find((c) => pop >= c.min && pop <= c.max) ?? SIZES[SIZES.length - 1];
  return { id: s.id, label: s.label, line: LINES[s.id] ?? "" };
}

export interface NewTownSettings { pop: number; era: Era; base: string; lordship: "manorial" | "free"; design?: Design }

/** The New town form (or a URL) as generator settings. `get` returns null for a missing field. */
export function settingsFromForm(get: (k: string) => string | null): { seed: string | undefined; settings: NewTownSettings } {
  const pop = Math.min(30000, Math.max(50, Number(get("pop")) || 200));
  const design = pop > PLAN_MIN ? designFrom(get) : undefined;
  const settings: NewTownSettings = {
    pop,
    era: (get("era") as Era) || "high_medieval",
    base: get("base") || "agricultural",
    lordship: get("manorial") && pop <= MANOR_MAX ? "manorial" : "free",
    ...(design ? { design } : {}),
  };
  return { seed: get("seed")?.trim() || undefined, settings };
}

const opt = (pairs: [string, string][]) => pairs.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
const ANY: [string, string] = ["", "any"];

/** The New town dialog's form body. Nothing applies until "Build town". */
export function newTownHtml(): string {
  return `<h2>New town</h2>
<div class="fields">
  <label class="field"><span>Name the seed</span><span class="row"><input name="seed" autocomplete="off" spellcheck="false" /><button type="button" id="reroll-seed" title="A new random seed">Reroll</button></span></label>
  <label class="field"><span>How many people?</span><input name="pop" type="number" min="50" max="30000" step="10" /></label>
  <p id="size-preview" class="preview" aria-live="polite"></p>
  <label class="field"><span>How do they live?</span><select name="base">${opt([["agricultural", "farming"], ["fishing", "fishing"], ["herding", "herding"], ["mining", "mining"], ["woodcutting", "woodcutting"]])}</select></label>
  <label class="field"><span>When?</span><select name="era">${opt([["early_medieval", "early medieval"], ["high_medieval", "high medieval"], ["late_medieval", "late medieval"], ["early_modern", "early modern"]])}</select></label>
  <label class="check" id="manor-field"><input type="checkbox" name="manorial" /> <span>Held as a manor <span class="sub">— owned outright by its lord; most people are villeins</span></span></label>
</div>
<fieldset id="plan">
  <legend>Street plan</legend>
  <label class="field"><span>Layout</span><select name="layout">${opt([ANY, ["river", "river town"], ["radial", "radial web"]])}</select></label>
  <label class="field" id="farbank-field"><span>Over the bridge</span><select name="farBank">${opt([ANY, ["village", "old village"], ["bridgend", "bridge-end"], ["abbey", "abbey's side"], ["wharf", "wharf side"]])}</select></label>
  <label class="field"><span>Walls</span><select name="walls">${opt([ANY, ["none", "none, open"], ["palisade", "bank and palisade"], ["wall", "stone wall"]])}</select></label>
  <label class="field"><span>Gates</span><select name="gates">${opt([ANY, ["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"], ["6", "6"]])}</select></label>
  <label class="field" id="shape-field"><span>Shape</span><select name="shape">${opt([ANY, ["round", "round"], ["oval", "oval"], ["long", "long, along the high street"]])}</select></label>
  <label class="field"><span>Castle</span><select name="castle">${opt([ANY, ["1", "yes"], ["0", "no"]])}</select></label>
  <label class="field"><span>Market</span><select name="market">${opt([ANY, ["small", "small"], ["large", "large"]])}</select></label>
  <label class="field"><span>Suburbs</span><select name="suburbs">${opt([ANY, ["few", "few"], ["many", "many"]])}</select></label>
  <label class="field"><span>Crime</span><select name="crime">${opt([ANY, ["quiet", "quiet"], ["usual", "the usual"], ["rife", "rife"]])}</select></label>
  <p class="plan-note">“Any” leaves it to the dice. Castles and gangs need 1,000 people or more.</p>
</fieldset>
<div class="actions"><button type="button" id="new-town-cancel">Cancel</button><button type="submit" class="primary">Build town</button></div>`;
}
