// The weather: a pure function of the town's seed and the date, so the clock
// can move freely and every module sees the same sky. Spells of three or four
// days set the run of it; each day varies within its spell. English weather,
// by month, in our own rough numbers.
import { jdn, parseDate, type Block } from "../../core/calendar";
import { Rng } from "../../core/rng";
import type { Town } from "../../core/town";
import type { Module, PanelRow } from "../../core/types";

export type Sky = "fair" | "bright" | "cloud" | "drizzle" | "rain" | "storm" | "fog" | "frost" | "snow" | "heat";

export interface Weather {
  sky: Sky;
  /** a line for the DM to read out */
  text: string;
  /** rain or snow: people keep indoors, the streets are mud */
  wet: boolean;
  cold: boolean;
  /** too rough for boats */
  rough: boolean;
}

// Per month: chances of a wet spell, of cold, of heat, of fog.
const CLIMATE: Record<number, { wet: number; cold: number; hot: number; fog: number }> = {
  1: { wet: 0.5, cold: 0.6, hot: 0, fog: 0.15 }, 2: { wet: 0.45, cold: 0.55, hot: 0, fog: 0.15 }, 3: { wet: 0.4, cold: 0.35, hot: 0, fog: 0.1 },
  4: { wet: 0.45, cold: 0.15, hot: 0, fog: 0.08 }, 5: { wet: 0.35, cold: 0.05, hot: 0.05, fog: 0.05 }, 6: { wet: 0.3, cold: 0, hot: 0.2, fog: 0.03 },
  7: { wet: 0.3, cold: 0, hot: 0.3, fog: 0.02 }, 8: { wet: 0.35, cold: 0, hot: 0.25, fog: 0.04 }, 9: { wet: 0.4, cold: 0.02, hot: 0.08, fog: 0.1 },
  10: { wet: 0.5, cold: 0.15, hot: 0, fog: 0.18 }, 11: { wet: 0.55, cold: 0.35, hot: 0, fog: 0.2 }, 12: { wet: 0.5, cold: 0.55, hot: 0, fog: 0.15 },
};

const TEXT: Record<Sky, string[]> = {
  fair: ["a fair day, high cloud and a light wind", "fine and mild; washing out on every hedge", "a soft grey morning clearing to sun"],
  bright: ["bright sun and a hard blue sky", "a clear, bright day; everyone out of doors", "sun all day, and dust in the streets"],
  cloud: ["overcast and still", "low grey cloud that never quite rains", "dull and cool, a wind from the east"],
  drizzle: ["a thin drizzle that soaks through everything", "mizzling rain on and off all day", "damp and grey; the streets slick with mud"],
  rain: ["steady rain; the gutters running and the lanes ankle-deep", "rain all day, hard at times; nobody out who needn't be", "a cold rain driven on the wind"],
  storm: ["a gale, with rain in sheets; shutters banging and tiles coming off", "thunder and heavy rain; the river rising", "a storm blowing; nobody puts out to sea"],
  fog: ["a thick fog; you can't see across the street", "fog off the river until noon, then a weak sun", "a white fog that muffles every sound"],
  frost: ["a hard frost; the puddles iced and the ground ringing", "frost and a low red sun; breath smoking", "bitter cold and still; ice on the water butts"],
  snow: ["snow falling, settling in the lanes", "snow on the roofs and trodden to slush in the streets", "a raw wind with sleet and snow"],
  heat: ["hot and close; flies everywhere and the streets stinking", "a heavy, airless heat; work stops at noon", "baking hot; the wells low and tempers short"],
};

const memo = new WeakMap<Town, Map<string, Weather>>();

export function weatherOn(town: Town, date: string): Weather {
  let m = memo.get(town);
  if (!m) memo.set(town, (m = new Map()));
  const hit = m.get(date);
  if (hit) return hit;
  const d = parseDate(date);
  const c = CLIMATE[d.m];
  const spell = Math.floor(jdn(d) / 4);
  const sr = new Rng(`weather-spell|${town.seed}|${spell}`);
  const wetSpell = sr.chance(c.wet), coldSpell = sr.chance(c.cold), hotSpell = !coldSpell && sr.chance(c.hot);
  const r = new Rng(`weather|${town.seed}|${date}`);
  const coast = town.settlement().get<string>("terrain") === "coast";
  let sky: Sky;
  if (r.chance(c.fog * (coast ? 1.6 : 1))) sky = "fog";
  else if (wetSpell) sky = coldSpell && r.chance(0.5) ? "snow" : r.chance(0.12) ? "storm" : r.chance(0.55) ? "rain" : r.chance(0.6) ? "drizzle" : "cloud";
  else if (coldSpell) sky = r.chance(0.6) ? "frost" : "cloud";
  else if (hotSpell) sky = r.chance(0.7) ? "heat" : "bright";
  else sky = r.chance(0.45) ? "fair" : r.chance(0.5) ? "bright" : "cloud";
  const w: Weather = {
    sky, text: r.pick(TEXT[sky]),
    wet: sky === "rain" || sky === "storm" || sky === "snow",
    cold: sky === "frost" || sky === "snow" || coldSpell,
    rough: sky === "storm" || (coast && sky === "rain" && r.chance(0.4)),
  };
  m.set(date, w);
  return w;
}

/** Light by block: what can be seen in the street. */
export function lightOf(block: Block, month: number): string {
  const winter = month <= 2 || month >= 11, summer = month >= 5 && month <= 8;
  switch (block) {
    case "morning": return winter ? "dark until near the end of it; lanterns and firelight" : summer ? "full light" : "grey first light";
    case "evening": return winter ? "dark by five; doors shut and shutters up" : summer ? "light until late" : "dusk coming on";
    case "night": case "late_night": return "dark, but for the watch's lanterns";
    default: return "daylight";
  }
}

export const weather: Module = {
  id: "weather",
  version: "1.0.0",
  requires: ["core"],
  panels: [
    {
      id: "weather",
      title: "Weather",
      for: "settlement",
      order: 1.1,
      rows(town) {
        const { date, block } = town.clock;
        const w = weatherOn(town, date);
        const rows: PanelRow[] = [{ label: "Today", value: w.text }, { label: "Light", value: lightOf(block as Block, parseDate(date).m) }];
        return rows;
      },
    },
  ],
};

