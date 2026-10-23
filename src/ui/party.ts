// When the players walk in: what's going on around them, who they bump into,
// who has work for them, and what the town is saying about them. All pure
// functions of the town, the clock and the party's marker.
import type { Address } from "../core/address";
import { addDays, fastOn, feastOn, parseDate, weekday, WEEKDAYS, type Block, whenOf } from "../core/calendar";
import { Rng } from "../core/rng";
import type { Town } from "../core/town";
import type { Edge, PanelLink } from "../core/types";
import { lsd } from "../modules/households";
import { buildingsOfUse, isStreetPlan } from "../modules/layout";
import { centroid, dist, type Poly, type Pt } from "../modules/layout/geom";
import { hourOf, partyName, reach, rumoursIn, spread, talkAt, tellingAt, voiceOf, type Rumour } from "../modules/gossip";
import { occupancy, whereabouts } from "../modules/routines";
import { visitsIn, visitorsOn } from "../modules/visitors";
import { looksOf } from "../modules/people";
import { lightOf, weatherOn } from "../modules/weather";
import { carriersOn } from "../modules/region";
import type { NameProvider } from "../modules/names";
import { crimeContent, happened, incidentsBetween, marksOn, prisoners, world, type Incident } from "../modules/crime";

export type Text = (string | PanelLink)[];

// Houses people live in; anything else is somewhere you can walk into.
const HOUSING = new Set(["tenement", "poor_row", "journeyman_house", "townhouse", "cottage", "farmhouse", "empty",
  "fisher_house", "herder_house", "miner_house", "logger_house", "slater", "carder", "charcoal_burner"]);
const DRINK = ["tavern", "town_alehouse", "alehouse", "inn"];
const OUTSIDE = new Set(["place:streets", "place:market", "place:green", "place:walls", "place:river", "place:quay"]);

const link = (town: Town, a: Address, text = town.label(a)): PanelLink => ({ text, address: a });

/** How far "nearby" reaches, in metres: a block or two in a town, the lane in a hamlet. */
export function reachOf(town: Town): number {
  return isStreetPlan(town) ? 75 : 120;
}

const posMemo = new WeakMap<Town, Map<Address, Pt>>();
function pos(town: Town): Map<Address, Pt> {
  let m = posMemo.get(town);
  if (!m) {
    m = new Map();
    for (const b of town.children(town.root, "building")) m.set(b.address, centroid(b.get<Poly>("poly")));
    posMemo.set(town, m);
  }
  return m;
}

/** Buildings within `r` of a point, nearest first. */
export function buildingsNear(town: Town, at: Pt, r = reachOf(town)): { a: Address; d: number }[] {
  const out: { a: Address; d: number }[] = [];
  for (const [a, p] of pos(town)) { const d = dist(at, p); if (d <= r) out.push({ a, d }); }
  return out.sort((x, y) => x.d - y.d);
}

/** The building nearest a point on the map. */
export function nearestBuildingTo(town: Town, at: Pt): Address | undefined {
  let best: Address | undefined, bd = Infinity;
  for (const [a, p] of pos(town)) { const d = dist(at, p); if (d < bd) { bd = d; best = a; } }
  return best;
}

const cap = (x: string) => (x ? x[0].toUpperCase() + x.slice(1) : x);
const isPublic = (town: Town, b: Address) => !HOUSING.has(town.get(b).get<string>("use"));
const homeOf = (town: Town, p: Address) => town.parentOf(town.parentOf(p)!)!;
const people = (town: Town) => town.allEntities().filter((e) => e.type === "person" && e.address.includes("/building:"));

// ---- where am I ----------------------------------------------------------

export function placeLine(town: Town, at: Pt): Text {
  const out: Text = [];
  const wards = town.children(town.root, "ward").filter((w) => w.get<Pt>("centre") && w.get<string>("name"));
  if (wards.length) {
    const w = wards.reduce((a, b) => (dist(at, a.get<Pt>("centre")) <= dist(at, b.get<Pt>("centre")) ? a : b));
    out.push("in ", link(town, w.address, w.get<string>("name")));
  } else out.push(`in ${town.label(town.root)}`);
  const landmark = buildingsNear(town, at, reachOf(town) * 1.5).find((x) => isPublic(town, x.a));
  if (landmark) out.push(", by ", link(town, landmark.a, town.label(landmark.a).replace(/^The /, "the ")));
  const g = town.settlement().get<{ wall?: { gates: { p: Pt }[] } }>("map").wall?.gates ?? [];
  if (g.some((x) => dist(x.p, at) < reachOf(town))) out.push(", at the gate");
  return out;
}

// ---- the street scene --------------------------------------------------------

// What a trade sounds and smells like from the street, by building use.
const SENSES: Record<string, string> = {
  town_tannery: "the reek of the tan pits hangs over everything", tannery: "the reek of the tan pits hangs over everything",
  butcher_shop: "blood in the gutter, and flies at the shambles", fishmonger: "the smell of fish, fresh and otherwise",
  brewhouse: "the warm smell of malt from the brewhouse", town_bakehouse: "new bread from the bakehouse", bakehouse: "new bread from the bakehouse",
  town_smithy: "the ring of a hammer from the smithy", smithy: "the ring of a hammer from the smithy", armourer: "steel being beaten out, steady as a bell",
  town_cooper: "the knock of the cooper's mallet on hoops", dyehouse: "the dye vats steaming, and a gutter running blue",
  fulling_mill: "the thump of the fulling stocks from down by the water", mill: "the creak and splash of the mill wheel", watermill: "the creak and splash of the mill wheel",
  cookshop: "hot pies and burnt fat from the cookshop", town_chandlery: "the stink of tallow from the chandler's", tallow_works: "the stink of rendering tallow",
  livery_stable: "horses, straw and dung from the livery stable", town_carpenter: "sawdust and the rasp of a saw", timber_yard: "fresh-sawn timber",
  spicer: "a breath of pepper and cloves from the spicer's door", apothecary: "something bitter and herbal from the apothecary's",
  school: "boys chanting Latin through an open window", town_potter: "wood smoke from the potter's kiln", bathhouse: "steam and laughter from the bathhouse",
};

/** A few lines to read out: the weather, the light, what's smelt and heard, the crowd, the day. */
export function scene(town: Town, at: Pt, date: string, block: Block, near: { a: Address; d: number }[], crowd: number): string[] {
  const out: string[] = [];
  const w = weatherOn(town, date);
  const m = parseDate(date).m;
  out.push(`${cap(w.text)}; ${lightOf(block, m)}.`);
  const awake = block !== "night" && block !== "late_night";
  const senses: string[] = [];
  for (const x of near.slice(0, 18)) {
    const use = town.get(x.a).get<string>("use");
    const line = SENSES[use];
    if (line && !senses.includes(line) && (awake || /tan pits|mill wheel/.test(line))) senses.push(line);
  }
  if (senses.length) out.push(`${cap(senses.slice(0, 3).join("; "))}.`);
  const signs = near.filter((x) => DRINK.includes(town.get(x.a).get<string>("use"))).map((x) => town.label(x.a)).filter((l) => /^The [A-Z]/.test(l) && !/'s /.test(l));
  if (signs.length) out.push(`The sign of ${signs[0].replace(/^The /, "the ")} hangs over the street${!awake ? ", with a lantern under it" : block === "evening" ? ", and the noise of drinking under it" : ""}.`);
  for (const c of carriersOn(town, date)) if (c.from && (block === "morning" || block === "forenoon") && near.some((x) => x.a === c.from)) out.push(`The carrier's wagon for ${c.to} is loading outside ${town.label(c.from).replace(/^The /, "the ")}: bales, a coop of hens, two passengers arguing about the fare.`);
  const lore = near.slice(0, 10).map((x) => town.get(x.a).get<string | undefined>("lore.tale")).find(Boolean);
  if (lore && awake) out.push(`${cap(lore)}.`);
  const feast = feastOn(date);
  if (feast && feast.name !== "Sunday" && awake) out.push(`It's ${feast.name}${feast.custom ? `: ${feast.custom}` : feast.holy ? ": the shops are shut and the bells keep ringing" : ""}.`);
  else if (feast?.name === "Sunday" && awake) out.push("Sunday: the shops shut, the bells for mass, everyone in their best.");
  const fast = fastOn(date);
  if (fast && awake && !/^Friday/.test(fast)) out.push(`${cap(fast)}.`);
  const market = isStreetPlan(town) && (town.settlement().get<string[]>("marketDays") ?? []).includes(WEEKDAYS[weekday(date)]);
  const nearMarket = dist(at, marketPoint(town)) < reachOf(town) * 2;
  if (market && nearMarket && (block === "forenoon" || block === "afternoon")) out.push("Market day: stalls under awnings, criers, carts jammed at the gate, and pickpockets in the press.");
  if (!awake) {
    const ward = near[0] ? town.get(near[0].a).get<number>("ward") : undefined;
    const value = ward === undefined ? 2 : town.settlement().get<{ wards?: { value: number }[] }>("map").wards?.[ward]?.value ?? 2;
    out.push(isStreetPlan(town) ? (value >= 5 ? "A lantern hangs at every door, by order; the watch's footsteps somewhere near." : "Black dark between the houses; the curfew has rung, and anyone abroad needs a reason.") : "No light anywhere but a glow under a door or two.");
  } else out.push(crowd >= 60 ? "The street is crowded; you have to push." : crowd >= 20 ? "People coming and going, busy with their own business." : crowd >= 5 ? "A few people about." : "Hardly a soul about.");
  return out;
}

// ---- the report ------------------------------------------------------------

export interface Report {
  where: Text;
  /** buildings near the marker, with who's in now */
  buildings: { a: Address; d: number; inside: { p: Address; doing: string }[]; total: number }[];
  /** people out of doors near the marker */
  street: { p: Address; doing: string; where: string }[];
  /** what's being said in the nearest drinking house, and in the houses round about */
  talk: { text: Text; at: Address; fact: string }[];
  /** what's being said about the party, and how far it has got */
  deeds: { text: Text; heard: number; total: number; fact: string }[];
  visitors: string[];
  jobs: Job[];
  /** the underworld round about: whose turf, dens, fences, marks, recent crimes, rogues about now */
  crime?: CrimeNear;
  /** what the party sees, hears and smells: a few lines to read out */
  scene: string[];
}

export interface CrimeNear {
  turf: Address[];
  dark: boolean;
  dens: { a: Address; gang: Address }[];
  fences: Address[];
  marks: { a: Address; marks: string[] }[];
  recent: Incident[];
  active: { p: Address; gang: Address; doing: string }[];
}

/** What the party finds where they stand: the scene, the buildings near and who is in them, who is about, the talk, work going and visitors. */
export function report(town: Town, at: Pt, date: string, block: Block): Report {
  const r = reachOf(town);
  const near = buildingsNear(town, at, r);
  const occ = occupancy(town, date, block);
  const buildings = near.slice(0, 14).map(({ a, d }) => {
    const here = occ.get(a) ?? [];
    // Strangers to the house first: customers, visitors, drinkers.
    const visiting = (x: Address) => Number(homeOf(town, x) !== a);
    const sorted = [...here].sort((x, y) => visiting(y) - visiting(x));
    return { a, d, total: here.length, inside: sorted.slice(0, 4).map((p) => ({ p, doing: whereabouts(town, p, date, block).doing })) };
  }).filter((b) => b.total > 0 || isPublic(town, b.a));

  const nearSet = new Set(near.map((x) => x.a));
  const street: Report["street"] = [];
  for (const [where, ps] of occ) {
    if (!OUTSIDE.has(where)) continue;
    for (const p of ps) {
      const home = homeOf(town, p);
      const close = where === "place:streets" || where === "place:walls" ? nearSet.has(home) : where === "place:market" || where === "place:green" ? dist(at, marketPoint(town)) < r * 1.6 : false;
      if (close) street.push({ p, where, doing: whereabouts(town, p, date, block).doing });
    }
  }

  const now = hourOf(date, block);
  const talk: Report["talk"] = [];
  const pub = near.find((x) => DRINK.includes(town.get(x.a).get<string>("use")))?.a;
  const told = new Set<string>();
  for (const rm of talkAt(town, now)) {
    if (rm.topic === "deed") continue;
    const spot = (pub && reached(town, rm, pub, now) ? pub : undefined) ?? near.map((x) => x.a).find((a) => reached(town, rm, a, now));
    // The same story can be both news and old talk; say it once.
    if (!spot || told.has(rm.texts[0])) continue;
    told.add(rm.texts[0]);
    talk.push({ text: tellingAt(town, rm, spot, now), at: spot, fact: `rumour:${rm.id}` });
  }

  const deeds: Report["deeds"] = [];
  const y = parseDate(date).y;
  for (const rm of [...rumoursIn(town, y - 1), ...rumoursIn(town, y)]) {
    if (rm.topic !== "deed" || rm.start > now) continue;
    const spot = near.map((x) => x.a).find((a) => reached(town, rm, a, now));
    const { heard, total } = reach(town, rm, now);
    deeds.push({ text: spot ? tellingAt(town, rm, spot, now) : [`not heard round here yet: ${rm.texts[0]}`], heard, total, fact: `rumour:${rm.id}` });
  }

  const visitors = visitorsOn(town, date).filter((v) => v.kind !== "thefts").map((v) => `${v.who} — ${v.note}`);
  const jobs = jobBoard(town, date).filter((j) => nearSet.has(j.at)).slice(0, 5);
  const crime = crimeNear(town, at, date, block, near, [...near.flatMap((x) => occ.get(x.a) ?? []), ...street.map((x) => x.p)]);
  const crowd = buildings.reduce((n, b) => n + (isPublic(town, b.a) ? b.total : 0), 0) + street.length;
  return { where: placeLine(town, at), buildings, street: street.slice(0, 12), talk: talk.slice(0, 6), deeds, visitors, jobs, ...(crime ? { crime } : {}), scene: scene(town, at, date, block, near, crowd) };
}

/** The underworld near the marker. Undefined where there is none. */
export function crimeNear(town: Town, at: Pt, date: string, block: Block, near: { a: Address; d: number }[], about: Address[]): CrimeNear | undefined {
  const W = world(town);
  if (!W) return undefined;
  const wide = new Set(buildingsNear(town, at, reachOf(town) * 1.5).map((x) => x.a));
  const closest = near[0]?.a ?? nearestBuildingTo(town, at);
  const ward = closest ? town.get(closest).get<number>("ward") : undefined;
  const value = ward === undefined ? 3 : town.settlement().get<{ wards?: { value: number }[] }>("map").wards?.[ward]?.value ?? 3;
  const turf = W.gangs.filter((g) => ward !== undefined && g.turf.includes(ward)).map((g) => g.address);
  const dens = W.gangs.filter((g) => g.den && wide.has(g.den)).map((g) => ({ a: g.den!, gang: g.address }));
  const fences = W.fences.filter((f) => wide.has(homeOf(town, f)));
  const marks = near.map((x) => ({ a: x.a, marks: marksOn(town, x.a, date) })).filter((x) => x.marks.length).slice(0, 6);
  const nearSet = new Set(near.map((x) => x.a));
  const recent = incidentsBetween(town, addDays(date, -14), date).filter((i) => happened(i, date, block) && (nearSet.has(i.at) || (i.at === "place:market" && dist(at, marketPoint(town)) < reachOf(town) * 1.6))).slice(-8);
  const seen = new Set<Address>();
  const active: CrimeNear["active"] = [];
  for (const p of about) {
    const m = W.crew.get(p);
    if (!m || seen.has(p)) continue;
    seen.add(p);
    // Only rogues about their business count: at work, or at the den. A cutpurse
    // at mass with his mother is just a man at mass.
    const w = whereabouts(town, p, date, block);
    if (w.where !== m.gang.den && !WORK_DOINGS().has(w.doing) && !/lying low|holding court|the crew|the den|running errands for/.test(w.doing)) continue;
    active.push({ p, gang: m.gang.address, doing: w.doing });
  }
  return { turf, dark: value <= 1, dens, fences, marks, recent, active: active.slice(0, 10) };
}

let workDoings: Set<string> | undefined;
const WORK_DOINGS = () => (workDoings ??= new Set(Object.values(crimeContent.crimes).map((c) => c.doing)));

function reached(town: Town, rm: Rumour, b: Address, now: number): boolean {
  const s = spread(town, rm).get(b);
  return !!s && s.at <= now;
}

function marketPoint(town: Town): Pt {
  const m = town.settlement().get<{ market?: Poly; green: Poly }>("map");
  return centroid(m.market ?? m.green);
}

// ---- who do we bump into ---------------------------------------------------

export interface Encounter {
  p: Address;
  where: Text;
  doing: string;
  looks?: string;
  speech?: string;
  habit?: string;
  want?: string;
  strangers?: string;
  opener: string;
  /** things they might say, in their own voice */
  lines?: string[];
  /** what they are underneath, for the DM */
  crew?: Text;
}

/** Roll someone the party runs into near the marker. `n` is the roll number, so each click gives the next. */
export function encounter(town: Town, at: Pt, date: string, block: Block, n: number): Encounter | undefined {
  const rep = report(town, at, date, block);
  const spot = `${town.seed}|${date}|${block}|${at[0].toFixed(0)},${at[1].toFixed(0)}`;
  const rng = new Rng(`encounter|${spot}|${n}`);
  // Out of doors counts most; then customers and visitors in public places; then anyone at home nearby.
  const pool: { p: Address; w: number }[] = [];
  // Rogues at work go looking for strangers.
  const W = world(town);
  // Rogues go looking for strangers, and a crew at its own den notices them first.
  const working = (p: Address) => {
    const m = W?.crew.get(p);
    if (!m) return 1;
    return m.gang.den && whereabouts(town, p, date, block).where === m.gang.den ? 5 : 1.6;
  };
  // Nobody under ten is met on their own, and nobody asleep: children out of
  // doors count, at play, but a baby only comes with the woman carrying it.
  const age = (p: Address) => town.get(p).get<number>("age");
  const asleep = (doing: string) => /\basleep\b|swaddled|with mother/.test(doing);
  for (const s of rep.street) if (age(s.p) >= 6 && !asleep(s.doing)) pool.push({ p: s.p, w: (age(s.p) < 10 ? 1 : 4) * working(s.p) });
  // Everyone in the buildings round about, not just the few the report names.
  const occ = occupancy(town, date, block);
  for (const b of rep.buildings) for (const x of occ.get(b.a) ?? []) {
    if (age(x) < 10) continue;
    const doing = whereabouts(town, x, date, block).doing;
    if (asleep(doing)) continue;
    const visiting = homeOf(town, x) !== b.a;
    pool.push({ p: x, w: (visiting ? 3 : isPublic(town, b.a) ? 2 : 0.3) * working(x) });
  }
  const awake = block !== "night" && block !== "late_night";
  const ok = pool.filter((x) => awake || x.w >= 3);
  if (!ok.length) return undefined;
  // One order for this spot and hour, drawn without replacement, so each
  // click meets someone new until everyone about has been met.
  const order: Address[] = [];
  const left = [...ok];
  const shuffle = new Rng(`encounter-order|${spot}`);
  while (left.length) {
    const i = left.indexOf(shuffle.weighted(left, (x) => x.w));
    order.push(left[i].p);
    left.splice(i, 1);
  }
  const p = order[n % order.length];
  const e = town.get(p);
  const w = whereabouts(town, p, date, block);
  const where: Text = w.where.startsWith("place:") ? [w.label] : ["at ", link(town, w.where, town.label(w.where).replace(/^The /, "the "))];
  const strangers = e.get<string | null>("character.strangers") ?? undefined;
  const under = crewNote(town, p, rng, w.doing);
  if (under) return {
    p, where, doing: w.doing,
    looks: looksOf(town, e),
    speech: e.get<string | null>("character.speech") ?? undefined,
    habit: e.get<string | null>("character.habit") ?? undefined,
    want: e.get<string | null>("character.want") ?? undefined,
    strangers, opener: under.opener, crew: under.note, lines: voiceOf(town, p, date, block),
  };
  const hasInn = buildingsOfUse(town, ["inn"]).length > 0;
  // Word of the party travels: someone who's heard what they did says so first.
  const lines = voiceOf(town, p, date, block);
  const known = lines.find((l) => l.startsWith("“You're the ones who"));
  return {
    lines: known ? lines.filter((l) => l !== known) : lines,
    p, where, doing: w.doing,
    looks: looksOf(town, e),
    speech: e.get<string | null>("character.speech") ?? undefined,
    habit: e.get<string | null>("character.habit") ?? undefined,
    want: e.get<string | null>("character.want") ?? undefined,
    strangers,
    opener: known && awake ? known : w.where === homeOf(town, p) && !isPublic(town, w.where)
      ? `(answers the door) ${opener(rng, strangers ?? "", e.get<number>("age"), awake, w.doing, hasInn).replace("(hurries indoors and bars the door)", "(shuts it again, fast)")}`
      : opener(rng, strangers ?? "", e.get<number>("age"), awake, w.doing, hasInn),
  };
}

/** If they are one of the town's rogues: what they say to strangers, and what the DM should know. */
function crewNote(town: Town, p: Address, r: Rng, doing: string): { opener: string; note: Text } | undefined {
  const W = world(town);
  if (!W) return undefined;
  const m = W.crew.get(p);
  const roles = W.roles.get(p) ?? [];
  const alias = town.get(p).get<string | undefined>("crime.alias");
  const known = alias ? ` ("${alias}")` : "";
  const O = crimeContent.openers;
  if (m) {
    const note: Text = [`${m.rank.cant} of `, link(town, m.gang.address, town.label(m.gang.address).replace(/^The /, "the ")), `${known}: ${m.rank.plain}.`];
    if (/crowd|purse|press of people|dice|stews|smashing|lane/.test(doing)) note.push(" At work right now.");
    if (m.gang.informers.includes(p)) note.push(" Also a nose for the law.");
    return { opener: r.chance(0.75) ? r.pick(O[m.gang.lay.id] ?? O.nips) : r.pick(O.nips), note };
  }
  const role = (["boss", "knife", "thiefTaker", "fence"] as const).find((x) => roles.includes(x));
  if (!role) return undefined;
  const plain = crimeContent.roles[role];
  return { opener: r.pick(O[role]), note: [`${plain.cant}${known}: ${plain.plain}.`] };
}

function opener(r: Rng, strangers: string, age: number, awake: boolean, doing = "", inn = true): string {
  if (/watch|patrol/.test(doing)) return r.pick(["“Halt. Who goes there, and what's your business at this hour?”", "“Names. And show me your hands.”"]);
  if (!awake) return r.pick(["“Who's there? It's past curfew.”", "(stops dead, then hurries on without a word)"]);
  if (age < 12) return r.pick(["“Is that a real sword?”", "“Where've you come from? Have you seen the sea?”", "(stares, then runs off to tell someone)"]);
  if (/friendly|news|hungry for news/.test(strangers)) return r.pick(["“Come far? What's the news on the road?”", inn ? "“You'll be wanting the inn. I'll show you.”" : "“You'll be wanting the alehouse. It's that way, with the bush over the door.”"]);
  if (/wary/.test(strangers)) return r.pick(["“And who might you be?”", "“Business here, is it?”"]);
  if (/cold|trouble/.test(strangers)) return r.pick(["“We've no need of your sort here.”", "(looks you up and down and spits)"]);
  if (/purse/.test(strangers)) return r.pick(["“Lost, are you? I know a short way through.”", "“Let me carry that for you, master.”"]);
  if (/jug of ale/.test(strangers)) return r.pick(["“Thirsty work, travelling. I know a place.”", "“Buy a man a drink and he'll tell you anything worth knowing.”"]);
  if (/polite and distant/.test(strangers)) return r.pick(["“Good day. You'll be staying with…?”", "“Strangers, I see. Whose guests are you?”"]);
  if (/customer/.test(strangers)) return r.pick(["“Best in the town, and fair prices! Step in, step in.”", "“You'll not find better this side of the river.”"]);
  if (/frightened/.test(strangers)) return "(hurries indoors and bars the door)";
  if (/curious/.test(strangers)) return "(falls in a few paces behind you, pretending not to)";
  return r.pick(["“Morning.”", "(nods, and goes on)"]);
}

// ---- the job board ---------------------------------------------------------

export interface Job {
  id: string;
  title: string;
  patron: Address;
  target?: Address;
  /** the patron's building: where to ask */
  at: Address;
  pay: number;
  detail: Text;
  risk: Text;
  fact?: string;
}

const jobMemo = new WeakMap<Town, Map<string, Job[]>>();

/** Work for adventurers: the town's debts, quarrels, wants and fears, made into jobs with a patron who can pay. */
export function jobBoard(town: Town, date: string): Job[] {
  let m = jobMemo.get(town);
  if (!m) jobMemo.set(town, (m = new Map()));
  const hit = m.get(date);
  if (hit) return hit;
  const jobs = makeJobs(town, date);
  m.set(date, jobs);
  return jobs;
}

function makeJobs(town: Town, date: string): Job[] {
  town.society();
  const jobs: Job[] = [];
  const at = (p: Address) => homeOf(town, p);
  const purse = (p: Address) => {
    const hh = town.get(town.parentOf(p)!);
    return hh.type === "household" ? (hh.get<number>("savings") ?? 0) : 0;
  };
  const named = (a: Address) => link(town, a);
  const list = (as: Address[]): Text => as.flatMap((k, i) => [...(i ? [", "] : []), named(k)]);
  const friendsOf = (p: Address) => town.edges({ touching: p }).filter((e) => e.kind === "friend" || e.kind === "kin").map((e) => (e.from === p ? e.to : e.from)).filter((x) => x.includes("/building:")).slice(0, 3);
  const fierce = (p: Address) => /quarrel|violent|hot|brawl|temper/.test((town.get(p).get<string[]>("traits") ?? []).join(" "));
  const rngFor = (id: string) => new Rng(`job|${town.seed}|${id}`);
  const inTown = (e: Edge) => e.from.includes("/building:") && e.to.includes("/building:");

  for (const e of town.edges()) {
    if (!inTown(e)) continue;
    if (e.kind === "debtor_of" && typeof e.facts?.amount === "number" && (e.facts.amount as number) >= 60) {
      const amount = e.facts.amount as number;
      // A third of what comes back, as a rule; but nobody pays strangers more than
      // a season's living to squeeze a neighbour, and what can be squeezed is what they have.
      const debtor = town.get(town.parentOf(e.from)!);
      const can = debtor.type === "household" ? (debtor.get<number>("savings") ?? 0) + (debtor.get<number>("income") ?? 0) / 4 : amount;
      const third = Math.round(Math.min(amount, can) / 3);
      const pay = Math.max(12, Math.min(third, purse(e.to), 720));
      const kin = friendsOf(e.from);
      jobs.push({
        id: `debt/${e.id}`, title: "Collect a debt", patron: e.to, target: e.from, at: at(e.to), pay,
        detail: [named(e.to), ` wants the ${lsd(amount)} that `, named(e.from), ` owes${e.facts.reason ? ` for ${e.facts.reason}` : ""}, and ${pay < third ? `will pay ${lsd(pay)} to see it back` : "will give a third of whatever comes back"}.`, can < amount ? ` There isn't ${lsd(amount)} in that house to find.` : "", e.knownBy !== "public" ? " Quietly: nobody else knows about the debt." : ""],
        risk: kin.length ? [named(e.from), " has people who'll take it badly: ", ...list(kin)] : [named(e.from), fierce(e.from) ? " has a temper." : " will plead poverty, and may mean it."],
        fact: `edge:${e.id}`,
      });
    } else if (e.kind === "rival") {
      const r = rngFor(e.id);
      const pay = Math.max(6, Math.min(Math.round(purse(e.from) * r.range(0.03, 0.2)), r.int(180, 600)));
      jobs.push({
        id: `rival/${e.id}`, title: r.pick(["Dig up dirt", "Teach someone a lesson", "Spoil a rival's plans"]), patron: e.from, target: e.to, at: at(e.from), pay,
        detail: [named(e.from), " wants something that will bring ", named(e.to), " low", e.facts?.about ? `, over ${e.facts.about}` : "", ". Nothing that can be traced back."],
        risk: [named(e.to), " will know who sent you, sooner or later", ...(friendsOf(e.to).length ? [", and has friends: ", ...list(friendsOf(e.to))] : []), "."],
        fact: `edge:${e.id}`,
      });
    } else if (e.kind === "lover" || e.kind === "courting") {
      const secret = e.knownBy !== "public";
      jobs.push({
        id: `letter/${e.id}`, title: secret ? "Carry a letter, unseen" : "Carry a love token", patron: e.from, target: e.to, at: at(e.from), pay: secret ? 12 : 3,
        detail: [named(e.from), " has something for ", named(e.to), secret ? ", and nobody, nobody at all, must see it delivered." : ". It's sweet, and harmless, and pays in pennies."],
        risk: secret ? ["If it gets out, both households will want someone to blame."] : ["None, unless the family disapproves."],
        fact: `edge:${e.id}`,
      });
    } else if (e.kind === "dispute" || e.kind === "grievance") {
      const pay = Math.max(6, Math.min(Math.round(purse(e.from) * 0.05), 240));
      jobs.push({
        id: `dispute/${e.id}`, title: "Find proof", patron: e.from, target: e.to, at: at(e.from), pay,
        detail: [named(e.from), " needs proof against ", named(e.to), e.facts?.about ? ` over ${e.facts.about}` : "", ", before it comes before the court or the council."],
        risk: ["Witnesses here have long memories, and longer grudges."],
        fact: `edge:${e.id}`,
      });
    }
  }

  // Wants and fears: a sick child, a strongbox, a journey. One job a house.
  const everyone = people(town);
  const names = town.registry<NameProvider>("nameProviders").get("anglo-norman");
  const asked = new Set<string>();
  for (const p of everyone) {
    const want = p.get<string | null>("character.want") ?? "";
    const fear = p.get<string | null>("character.fear") ?? "";
    const id = p.address;
    const house = at(id);
    const r = rngFor(`want|${id}`);
    const spare = (lo: number, hi: number, f: number) => Math.max(lo, Math.min(Math.round(purse(id) * f * r.range(0.6, 1.4)), Math.round(hi * r.range(0.45, 1))));
    if (/cure for a sick child/.test(want) && !asked.has(`cure|${house}`)) {
      asked.add(`cure|${house}`);
      const ill = r.pick(SICK), cure = r.pick(CURES);
      jobs.push({ id: `cure/${id}`, title: "Fetch a remedy", patron: id, at: house, pay: spare(4, 90, 0.3),
        detail: [named(id), `${/s$/.test(town.label(id)) ? "'" : "'s"} child ${ill}. ${cure.replace("{place}", names.place(r))}`],
        risk: [r.pick(["The child may not last the journey there and back.", "The remedy may be worse than the sickness.", "The mother has already sold the good cloak for the last one."])] });
    } else if (/pilgrimage/.test(want) && p.get<number>("age") >= 50 && !asked.has(`escort|${house}`)) {
      asked.add(`escort|${house}`);
      const days = r.int(3, 14);
      jobs.push({ id: `escort/${id}`, title: "Escort a pilgrim", patron: id, at: house, pay: spare(12, 300, 0.4) + days * 2,
        detail: [named(id), ` means to see the shrine of ${r.pick(PILGRIM_SAINTS)} at ${names.place(r)}, ${days} days on foot, ${r.pick(["before dying", "to keep a vow made in a fever", "for a dead son's soul", "for the indulgence, and the badge"])}, and daren't take the roads alone.`],
        risk: [r.pick(["Slow going, and the roads are what they are.", "The pilgrim road has its own thieves, dressed as pilgrims.", "An old body, a long road, and winter coming."])] });
    } else if (/thieves/.test(fear) && !asked.has(`guard|${house}`)) {
      asked.add(`guard|${house}`);
      jobs.push({ id: `guard/${id}`, title: "Guard a house by night", patron: id, at: house, pay: spare(6, 90, 0.03),
        detail: [named(id), ` ${r.pick(GUARD_WHY)} A few nights' watch, and no questions.`],
        risk: [r.pick(["Probably nothing. Probably.", "Somebody has been chalking marks by the door.", "The last man they hired fell asleep, and was blamed."])] });
    }
  }

  // Thefts after the tinkers: in the month after, somebody wants their things back.
  const y = parseDate(date).y;
  for (const v of visitsIn(town, y)) {
    if (v.kind !== "thefts" || v.start > date || addDays(v.start, 30) < date) continue;
    const r = new Rng(`theft|${town.seed}|${v.start}`);
    const victims = everyone.filter((p) => p.get("role") === "head");
    if (!victims.length) continue;
    const who = r.pick(victims).address;
    jobs.push({ id: `theft/${v.start}`, title: "Find the thief", patron: who, at: at(who), pay: Math.max(12, Math.min(purse(who), 120)),
      detail: [named(who), ` is one of those robbed on ${v.start}: ${v.note}. Everyone blames the tinkers. Not everyone is right.`],
      risk: ["Whoever did it lives here, if it wasn't the tinkers."] });
  }

  jobs.push(...crimeJobs(town, date, purse));

  // The best-paid first; at most a few of each kind, so it reads like a notice board.
  const byKind = new Map<string, number>();
  return jobs.sort((a, b) => b.pay - a.pay || (a.id < b.id ? -1 : 1)).filter((j) => {
    const k = j.id.split("/")[0];
    const n = byKind.get(k) ?? 0;
    byKind.set(k, n + 1);
    return n < 6;
  });
}

export { partyName };

const SICK = ["has the bloody flux and can keep nothing down", "is burning with a fever three days now", "has a cough that rattles like a cart",
  "fell from the loft and won't wake properly", "has the spotted sickness, and the neighbours are keeping away", "was bitten by a dog, and the wound has gone black at the edges",
  "has fits at night, and the priest's prayers haven't helped", "is wasting, and nobody can say why"];
const CURES = ["The physician won't come for less than a shilling; the apothecary sells a syrup that might serve.",
  "The wise woman at {place} knows the remedy, but won't come into the town.",
  "Water from the holy well at {place} cured a child last year, they say.",
  "The only man who can set it right is the bonesetter at {place}, a day's walk.",
  "The friars keep a herb garden, and owe the family a favour."];
const PILGRIM_SAINTS = ["St Thomas the Martyr", "Our Lady", "St Edmund", "St Cuthbert", "St Swithun", "St Etheldreda", "St Oswald", "St William", "St Wite", "St Frideswide"];
const GUARD_WHY = ["sleeps on the strongbox and still doesn't sleep.", "has a delivery of silver coming, and has told too many people.",
  "heard footsteps on the roof two nights running.", "has been sent a warning, and won't say by whom.", "has a daughter's dowry in the house until the wedding.",
  "was robbed once, ten years ago, and has never got over it."];

// ---- work from the underworld -------------------------------------------

/** Work the crime calendar and the crews make: stolen goods to recover, rackets to break,
 *  bounties, blackmail, and shady errands for the crews themselves. */
function crimeJobs(town: Town, date: string, purse: (p: Address) => number): Job[] {
  const W = world(town);
  if (!W) return [];
  const out: Job[] = [];
  const named = (a: Address) => link(town, a, town.label(a).replace(/^The /, a.includes("/institution:crew-") ? "the " : "The "));
  const list = (as: Address[]): Text => as.flatMap((k, i) => [...(i ? [", "] : []), named(k)]);
  const C = crimeContent.crimes;
  const at = (p: Address) => homeOf(town, p);
  const alive = (p: Address) => !/dead|abjured/.test(prisonerOrDead(town, p, date));
  // Stolen goods: in the month after, the victim wants them back.
  for (const i of incidentsBetween(town, addDays(date, -30), addDays(date, -1))) {
    if (!i.victim || i.loot < 24 || i.caught?.date && i.caught.date <= date || !["burglary", "robbery", "horse", "cutpurse", "pickpocket", "dice", "crossbite"].includes(i.kind)) continue;
    if (!alive(i.victim)) continue;
    const g = i.gang ? W.byAddress.get(i.gang) : undefined;
    const pay = Math.max(6, Math.min(Math.round(i.loot / 3), Math.max(12, purse(i.victim))));
    out.push({
      id: `stolen/${i.id}`, title: i.kind === "dice" ? "Win it back" : i.kind === "crossbite" ? "Get it back, quietly" : "Recover what was stolen", patron: i.victim, target: i.culprits[0], at: at(i.victim), pay,
      detail: [named(i.victim), ` lost ${i.items} ${whenOf(i.date, date)} (${C[i.kind].label}) and will give a third of its worth to have it back, and more for the names.`],
      risk: ["The DM knows: ", ...list(i.culprits), ...(g ? [" of ", named(g.address), ...(g.fence ? ["; the goods went to ", named(g.fence)] : []), ...(g.paid.length ? ["; the watch here is paid not to look"] : [])] : [])],
    });
  }
  // The rackets: the street's biggest payer speaks for the rest, and they club together.
  for (const g of W.gangs) {
    const paying = W.edges.protection.filter((e) => W.crew.get(e.to)?.gang === g);
    if (!paying.length) continue;
    const lead = [...paying].sort((a, b) => (b.facts?.amount as number) - (a.facts?.amount as number) || (a.id < b.id ? -1 : 1))[0];
    const weekly = paying.reduce((n, e) => n + (e.facts?.amount as number), 0);
    out.push({
      id: `racket/${g.address}`, title: "Break the racket", patron: lead.from, target: lead.to, at: at(lead.from), pay: Math.max(24, Math.min(weekly * 13, 720)),
      detail: [named(lead.from), ` and ${paying.length - 1} other shops pay `, named(g.address), ` ${lsd(weekly)} a week between them. A quarter's money to whoever makes it stop.`],
      risk: [link(town, g.address), ` are ${g.members.length} strong, with `, ...(g.paid.length ? ["the watch in their pocket."] : ["a den at ", ...(g.den ? [named(g.den)] : ["somewhere close"]), "."])],
      fact: `edge:${lead.id}`,
    });
  }
  // The thief-taker pays for crews he can't catch himself.
  if (W.thiefTaker) {
    for (const g of W.gangs) {
      // Not the crews whose fence splits the rewards with him: those he leaves alone.
      if (!g.chief || W.edges.in_league.some((e) => e.from === W.thiefTaker && e.to === g.fence)) continue;
      out.push({
        id: `bounty/${g.address}`, title: "A thief-taker's bounty", patron: W.thiefTaker, target: g.chief, at: at(W.thiefTaker), pay: 40 + g.members.length * 6,
        detail: [named(W.thiefTaker), " will pay for proof to hang ", named(g.chief), ", who runs ", named(g.address), ": names, a witness, goods found where they shouldn't be."],
        risk: [`${g.members.length} of them, and the thief-taker keeps most of the reward.`, ...(W.edges.in_league.some((e) => e.from === W.thiefTaker) ? [" He's also in league with a fence, and some crews he leaves alone."] : [])],
      });
    }
  }
  // Blackmail victims want their secret back.
  for (const e of W.edges.blackmails) {
    out.push({
      id: `blackmail/${e.id}`, title: "Make the blackmailer stop", patron: e.to, target: e.from, at: at(e.to), pay: Math.max(24, Math.min(Math.round((e.facts?.amount as number) * 6), Math.round(purse(e.to) / 5), 480)),
      detail: [named(e.to), " is being bled by ", named(e.from), ` over ${e.facts?.about}, and wants it ended, by whatever means, without the secret getting out.`],
      risk: ["If the secret gets out on the way, the patron will blame the party."], fact: `edge:${e.id}`,
    });
  }
  // A price on a head: somebody who knows would pay to have it stopped (DM: the target, once warned).
  for (const e of W.edges.hired_knife) {
    const target = e.facts?.target as Address;
    if (!alive(target)) continue;
    const day = addDays("1203-01-01", e.facts?.day as number);
    if (day < date || day > addDays(date, 45)) continue;
    out.push({
      id: `knife/${e.id}`, title: "Someone means to kill you", patron: target, target: e.to, at: at(target), pay: Math.max(60, Math.min(purse(target), 600)),
      detail: [named(target), " has heard a whisper that someone has been paid to kill them, and would pay well for protection, and more for the name."],
      risk: ["The DM knows: ", named(e.to), " was hired by ", named(e.from), ` for ${day}.`], fact: `edge:${e.id}`,
    });
  }
  // The crews have work too, for strangers who don't ask questions.
  const r = new Rng(`crew-jobs|${town.seed}|${date.slice(0, 7)}`);
  const ERRAND: Record<string, [string, string]> = {
    nips: ["Make a scene in the market", "start a loud quarrel in the market on market day, and keep it going while the knot works the crowd"],
    crackers: ["Stand lookout one night", "stand at the end of a lane one night and whistle if the watch comes. No questions about the house"],
    pads: ["Carry a cudgel, one night", "walk with the lads one night, to make up the numbers. Nobody need get hurt"],
    mumpers: ["Carry a message out of town", "carry a sealed letter to a beggar camp a day's walk off, and bring back what they give you"],
    cheats: ["Sit in at the dice", "sit in at a game as a stranger with money to lose, and lose it, loudly, then win it all back"],
    stews: ["Collect from a gentleman", "deliver a letter to a respectable man and bring back his answer, and his purse"],
    owlers: ["Row a boat, no lantern", "help row bales downriver one dark night, past the customs"],
    clippers: ["Change some money", "buy small things all over the market with a bag of pennies, and bring back the change"],
    bullies: ["Lean on a shopkeeper", "visit a shop that won't pay, and make the owner understand"],
    prancers: ["Ride a horse to the next fair", "ride a horse with new marks on it to a fair two days off, and sell it"],
  };
  for (const g of W.gangs) {
    if (!g.chief || !g.den || !r.chance(0.6)) continue;
    const [title, what] = ERRAND[g.lay.id] ?? ["Do a job, no questions", "do a small job and forget it after"];
    const target = g.lay.id === "bullies" && g.refusers.length ? r.pick(g.refusers) : undefined;
    out.push({
      id: `crew/${g.address}`, title, patron: g.chief, ...(target ? { target } : {}), at: g.den, pay: r.int(6, 30) * (g.lay.id === "owlers" || g.lay.id === "prancers" ? 4 : 1),
      detail: [named(g.chief), " of ", named(g.address), ` will pay to ${what}${target ? ": " : "."}`, ...(target ? [named(target), "."] : []), " Ask at the den, and know the word."],
      risk: ["It's a crime, and the watch hangs strangers as readily as locals.", ...(g.informers.length ? [" Someone in the crew talks to the law."] : [])],
    });
  }
  return out;
}

function prisonerOrDead(town: Town, p: Address, date: string): string {
  const held = prisoners(town, date).find((x) => x.p === p);
  if (held) return "held";
  const w = whereabouts(town, p, date, "forenoon");
  return w.where === "place:grave" ? "dead" : w.doing;
}
