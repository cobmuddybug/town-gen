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
