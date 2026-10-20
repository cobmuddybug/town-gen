// Dates as "YYYY-MM-DD" on the proleptic Gregorian calendar. Integer
// arithmetic only, so every engine agrees.

export interface Day {
  y: number;
  m: number;
  d: number;
}

export type Block = "morning" | "forenoon" | "afternoon" | "evening" | "night" | "late_night";
export const BLOCKS: Block[] = ["morning", "forenoon", "afternoon", "evening", "night", "late_night"];
export const BLOCK_HOURS: Record<Block, string> = {
  morning: "5–8", forenoon: "9–12", afternoon: "13–16", evening: "17–20", night: "21–24", late_night: "1–4",
};

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function parseDate(s: string): Day {
  const m = /^(-?\d+)-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad date "${s}"`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export function formatDate(d: Day): string {
  return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
}

/** Julian day number (Fliegel–Van Flandern). */
export function jdn({ y, m, d }: Day): number {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a, mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

export function fromJdn(j: number): Day {
  const a = j + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    d: e - Math.floor((153 * m + 2) / 5) + 1,
    m: m + 3 - 12 * Math.floor(m / 10),
    y: 100 * b + d - 4800 + Math.floor(m / 10),
  };
}

export function addDays(s: string, n: number): string {
  return formatDate(fromJdn(jdn(parseDate(s)) + n));
}

/** 0 = Sunday. */
export function weekday(s: string): number {
  return (jdn(parseDate(s)) + 1) % 7;
}

/** Easter Sunday (the anonymous Gregorian computus). */
export function easter(y: number): string {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return formatDate({ y, m: month, d: day });
}

export interface Feast {
  name: string;
  /** a holy day: no work but what can't wait */
  holy: boolean;
  /** a quarter-day: rents fall due */
  quarter?: boolean;
  /** one of the four seasonal festivals */
  festival?: boolean;
}

const FIXED: Record<string, Feast> = {
  "01-06": { name: "Epiphany", holy: true },
  "02-02": { name: "Candlemas", holy: true },
  "03-25": { name: "Lady Day", holy: true, quarter: true },
  "06-23": { name: "Midsummer Eve", holy: true, festival: true },
  "06-24": { name: "Midsummer (St John's Day)", holy: true, festival: true, quarter: true },
  "06-25": { name: "Midsummer, third day", holy: true, festival: true },
  "08-01": { name: "Lammas", holy: true },
  "09-29": { name: "Michaelmas", holy: true, quarter: true },
  "11-01": { name: "All Hallows", holy: true },
  "11-11": { name: "Martinmas", holy: true },
  "12-25": { name: "Christmas", holy: true, festival: true, quarter: true },
  "12-26": { name: "St Stephen's Day", holy: true, festival: true },
  "12-27": { name: "St John's Day (Christmas)", holy: true, festival: true },
};

/** The feast on a date, if any. Sundays are holy days too (one in seven). */
export function feastOn(s: string): Feast | undefined {
  const day = parseDate(s);
  const e = jdn(parseDate(easter(day.y)));
  const off = jdn(day) - e;
  if (off === -2) return { name: "Good Friday", holy: true };
  if (off >= 0 && off <= 2) return { name: off === 0 ? "Easter Day" : `Easter, day ${off + 1}`, holy: true, festival: true };
  if (off >= 49 && off <= 51) return { name: off === 49 ? "Whitsunday" : `Whitsun, day ${off - 48}`, holy: true, festival: true };
  const fixed = FIXED[s.slice(-5)];
  if (fixed) return fixed;
  if (weekday(s) === 0) return { name: "Sunday", holy: true };
  return undefined;
}

/** "Tuesday 24 June 1203 — Midsummer". Pass `relativeTo` to drop the year when it's the same one. */
export function describeDate(s: string, relativeTo?: string): string {
  const d = parseDate(s);
  const f = feastOn(s);
  const year = relativeTo && parseDate(relativeTo).y === d.y ? "" : ` ${d.y}`;
  const base = `${WEEKDAYS[weekday(s)]} ${d.d} ${MONTHS[d.m - 1]}${year}`;
  return f && f.name !== "Sunday" ? `${base} — ${f.name}` : base;
}
