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

// A day's routines parse the same few dates for every soul in town, so parsed dates are kept.
// They are frozen: a caller that wants to change one makes its own.
const parsed = new Map<string, Readonly<Day>>();

/** "1203-10-01" as numbers. Kept and frozen: copy it before changing it. */
export function parseDate(s: string): Readonly<Day> {
  const hit = parsed.get(s);
  if (hit) return hit;
  const m = /^(-?\d+)-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad date "${s}"`);
  if (parsed.size > 5000) parsed.clear();
  const d = Object.freeze({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) });
  parsed.set(s, d);
  return d;
}

/** Numbers back to "YYYY-MM-DD". */
export function formatDate(d: Day): string {
  return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
}

/** Julian day number (Fliegel–Van Flandern). */
export function jdn({ y, m, d }: Day): number {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a, mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

/** A Julian day number back to a date (the inverse of jdn). */
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

/** The date n days on (or back, if n is negative). */
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
  /** what people do that day besides mass: games, a procession, a custom */
  custom?: string;
}

// The church year, after the English use around 1200: the great feasts are
// holy days, when no work is done but what can't wait; the lesser saints get a
// mass and no more, though some bring a custom with them.
const FIXED: Record<string, Feast> = {
  "01-01": { name: "the Circumcision (New Year's Day)", holy: true, custom: "gifts exchanged, and the wassail bowl" },
  "01-06": { name: "Epiphany", holy: true, festival: true, custom: "Twelfth Night: the bean-king's cake and the last of Christmas" },
  "01-25": { name: "St Paul's Day", holy: false, custom: "the weather today foretells the year, they say" },
  "02-02": { name: "Candlemas", holy: true, custom: "a procession with candles, blessed and taken home against storms" },
  "02-14": { name: "St Valentine's Day", holy: false },
  "03-25": { name: "Lady Day", holy: true, quarter: true },
  "04-23": { name: "St George's Day", holy: false },
  "04-25": { name: "St Mark's Day", holy: false, custom: "the young sit up in the church porch to see who will die this year" },
  "05-01": { name: "May Day", holy: false, festival: true, custom: "the maypole on the green, greenery over every door, and the young out in the woods all night" },
  "05-03": { name: "Holy Cross Day", holy: false },
  "06-23": { name: "Midsummer Eve", holy: true, festival: true, custom: "bonfires in the streets, and the watch hung with greenery and lamps" },
  "06-24": { name: "Midsummer (St John's Day)", holy: true, festival: true, quarter: true },
  "06-25": { name: "Midsummer, third day", holy: true, festival: true },
  "06-29": { name: "St Peter and St Paul", holy: true, custom: "the fishermen's saint: boats blessed, and a bonfire" },
  "07-15": { name: "St Swithun's Day", holy: false, custom: "if it rains today it rains for forty days" },
  "07-22": { name: "St Mary Magdalene", holy: false },
  "07-25": { name: "St James' Day", holy: false, custom: "oyster day; children build grottoes of shells and beg a penny" },
  "08-01": { name: "Lammas", holy: true, custom: "the first loaf of the new wheat blessed at mass, and common fields thrown open" },
  "08-15": { name: "the Assumption of Our Lady", holy: true },
  "08-24": { name: "St Bartholomew's Day", holy: false, custom: "fair day in many places" },
  "09-08": { name: "the Nativity of Our Lady", holy: true },
  "09-14": { name: "Holy Rood Day", holy: false, custom: "the young go nutting in the woods" },
  "09-29": { name: "Michaelmas", holy: true, quarter: true, custom: "a goose for dinner; new officers chosen in many towns" },
  "10-18": { name: "St Luke's Day", holy: false },
  "10-28": { name: "St Simon and St Jude", holy: false },
  "11-01": { name: "All Hallows", holy: true },
  "11-02": { name: "All Souls", holy: false, custom: "the bells rung for the dead, and soul-cakes begged at doors" },
  "11-11": { name: "Martinmas", holy: true, custom: "the pigs killed and salted; the hiring of servants for the year" },
  "11-23": { name: "St Clement's Day", holy: false, custom: "the smiths' feast: anvils struck all morning, and ale after" },
  "11-25": { name: "St Catherine's Day", holy: false, custom: "the spinners' and spinsters' saint; cattern cakes" },
  "11-30": { name: "St Andrew's Day", holy: true },
  "12-06": { name: "St Nicholas' Day", holy: false, custom: "the boy bishop chosen from the choir, to rule the church until Holy Innocents" },
  "12-21": { name: "St Thomas' Day", holy: false, custom: "the poor go a-Thomasing, begging corn for Christmas" },
  "12-25": { name: "Christmas", holy: true, festival: true, quarter: true },
  "12-26": { name: "St Stephen's Day", holy: true, festival: true, custom: "the horses bled for their health; boxes for the servants" },
  "12-27": { name: "St John's Day (Christmas)", holy: true, festival: true },
  "12-28": { name: "Holy Innocents", holy: true, festival: true, custom: "an unlucky day: nothing new begun; the boy bishop's last day" },
};

/** The feast on a date, if any. Sundays are holy days too (one in seven),
 * whatever lesser custom falls on them. */
export function feastOn(s: string): Readonly<Feast> | undefined {
  if (feasts.has(s)) return feasts.get(s);
  const f = feastOf(s);
  const out = f && Object.freeze(!f.holy && weekday(s) === 0 ? { ...f, holy: true } : f);
  if (feasts.size > 5000) feasts.clear();
  feasts.set(s, out);
  return out;
}
const feasts = new Map<string, Readonly<Feast> | undefined>();

function feastOf(s: string): Feast | undefined {
  const day = parseDate(s);
  const e = jdn(parseDate(easter(day.y)));
  const off = jdn(day) - e;
  if (off === -48) return { name: "Shrove Monday", holy: false, custom: "collops of bacon and eggs; the last meat before Lent" };
  if (off === -47) return { name: "Shrove Tuesday", holy: false, festival: true, custom: "football through the streets, cock-throwing, pancakes; the apprentices half-wild" };
  if (off === -46) return { name: "Ash Wednesday", holy: false, custom: "ashes on every forehead at mass; Lent begins: no meat, no weddings" };
  if (off === -7) return { name: "Palm Sunday", holy: true, custom: "a procession with willow and yew for palms" };
  if (off === -3) return { name: "Maundy Thursday", holy: false, custom: "the poor's feet washed, and alms given" };
  if (off === -2) return { name: "Good Friday", holy: true, custom: "the cross crept to on knees; no bells" };
  if (off >= 0 && off <= 2) return { name: off === 0 ? "Easter Day" : `Easter, day ${off + 1}`, holy: true, festival: true, ...(off === 0 ? { custom: "the bells back, the fast broken, eggs given" } : {}) };
  if (off === 15 || off === 16) return { name: off === 15 ? "Hock Monday" : "Hock Tuesday", holy: false, festival: true, custom: "the women tie up the men and let them go for a coin, then the men the women; the money goes to the church" };
  if (off >= 35 && off <= 37) return { name: "Rogationtide", holy: false, custom: "beating the bounds: the priest and the parish walk the boundary, and boys are bumped on the marker stones so they remember" };
  if (off === 39) return { name: "Ascension Day", holy: true };
  if (off >= 49 && off <= 51) return { name: off === 49 ? "Whitsunday" : `Whitsun, day ${off - 48}`, holy: true, festival: true, ...(off === 49 ? { custom: "the Whitsun ale: dancing, games and a lord of misrule" } : {}) };
  if (off === 56) return { name: "Trinity Sunday", holy: true };
  const fixed = FIXED[s.slice(-5)];
  if (fixed) return fixed;
  // Plough Monday: the first Monday after Epiphany.
  if (day.m === 1 && day.d >= 7 && day.d <= 13 && weekday(s) === 1) return { name: "Plough Monday", holy: false, custom: "the ploughboys drag a plough from door to door, and plough up the step of anyone who won't pay" };
  if (weekday(s) === 0) return { name: "Sunday", holy: true };
  return undefined;
}

/** A fast day: no flesh, only fish. Fridays, Lent, and the eves of the great feasts. */
export function fastOn(s: string): string | undefined {
  const day = parseDate(s);
  const off = jdn(day) - jdn(parseDate(easter(day.y)));
  const wd = weekday(s);
  if (off >= -46 && off < 0 && wd !== 0) return "Lent: fish, bread and ale, no flesh";
  if (wd === 5) return "Friday: a fish day";
  const tomorrow = feastOn(addDays(s, 1));
  if (tomorrow?.holy && tomorrow.name !== "Sunday" && wd !== 6) return `the eve of ${tomorrow.name}: a fast until the evening`;
  return undefined;
}

/** The season of the church year, for the almanac and the street. */
export function seasonOf(s: string): string {
  const day = parseDate(s);
  const off = jdn(day) - jdn(parseDate(easter(day.y)));
  const md = s.slice(-5);
  if (off >= -46 && off < 0) return "Lent";
  if (off >= 0 && off < 50) return "Eastertide";
  if (md >= "12-25" || md <= "01-06") return "Christmastide";
  // Advent: the four Sundays before Christmas, from about 27 November.
  if (md >= "11-27") return "Advent";
  return "";
}

/** "Tuesday 24 June 1203 — Midsummer". Pass `relativeTo` to drop the year when it's the same one. */
export function describeDate(s: string, relativeTo?: string): string {
  const d = parseDate(s);
  const f = feastOn(s);
  const year = relativeTo && parseDate(relativeTo).y === d.y ? "" : ` ${d.y}`;
  const base = `${WEEKDAYS[weekday(s)]} ${d.d} ${MONTHS[d.m - 1]}${year}`;
  return f && f.name !== "Sunday" ? `${base} — ${f.name}` : base;
}

/** A date as people say it, from where the clock stands: "today", "yesterday
 *  evening", "Tuesday last", "this Thursday", "Martinmas", "14 October",
 *  "14 October 1201". `block` adds the time of day when it's near. */
export function whenOf(date: string, now: string, block?: string): string {
  const diff = jdn(parseDate(date)) - jdn(parseDate(now));
  const d = parseDate(date);
  const part = block ? ({ morning: "morning", forenoon: "forenoon", afternoon: "afternoon", evening: "evening", night: "night", late_night: "small hours" } as Record<string, string>)[block] : undefined;
  const wd = WEEKDAYS[weekday(date)];
  if (diff === 0) return part ? (part === "night" ? "tonight" : `this ${part}`) : "today";
  if (diff === -1) return part ? (part === "night" ? "last night" : `yesterday ${part}`) : "yesterday";
  if (diff === 1) return part ? `tomorrow ${part}` : "tomorrow";
  if (diff < 0 && diff >= -6) return `${wd} last`;
  if (diff > 0 && diff <= 6) return `this ${wd}`;
  const f = feastOf(date);
  if (f && f.name !== "Sunday" && !/, day /.test(f.name)) return f.name.replace(/^the /, "") + (d.y !== parseDate(now).y ? ` ${d.y}` : "");
  return `${d.d} ${MONTHS[d.m - 1]}${d.y !== parseDate(now).y ? ` ${d.y}` : ""}`;
}
