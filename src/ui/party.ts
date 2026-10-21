// When the players walk in: what's going on around them, who they bump into,
// who has work for them, and what the town is saying about them. All pure
// functions of the town, the clock and the party's marker.
import type { Address } from "../core/address";
import { addDays, parseDate, type Block } from "../core/calendar";
import { Rng } from "../core/rng";
import type { Town } from "../core/town";
import type { Edge, PanelLink } from "../core/types";
import { lsd } from "../modules/households";
import { isStreetPlan } from "../modules/layout";
import { centroid, dist, type Poly, type Pt } from "../modules/layout/geom";
import { hourOf, partyName, reach, rumoursIn, spread, talkAt, tellingAt, type Rumour } from "../modules/gossip";
import { occupancy, whereabouts } from "../modules/routines";
import { visitsIn, visitorsOn } from "../modules/visitors";
import type { Feature } from "../modules/people";

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

export function nearestBuildingTo(town: Town, at: Pt): Address | undefined {
  let best: Address | undefined, bd = Infinity;
  for (const [a, p] of pos(town)) { const d = dist(at, p); if (d < bd) { bd = d; best = a; } }
  return best;
}

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
}

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
  return { where: placeLine(town, at), buildings, street: street.slice(0, 12), talk: talk.slice(0, 6), deeds, visitors, jobs };
}

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
}

/** Roll someone the party runs into near the marker. `n` is the roll number, so each click gives the next. */
export function encounter(town: Town, at: Pt, date: string, block: Block, n: number): Encounter | undefined {
  const rep = report(town, at, date, block);
  const rng = new Rng(`encounter|${town.seed}|${date}|${block}|${at[0].toFixed(0)},${at[1].toFixed(0)}|${n}`);
  // Out of doors counts most; then customers and visitors in public places; then anyone at home nearby.
  const pool: { p: Address; w: number }[] = [];
  for (const s of rep.street) pool.push({ p: s.p, w: 4 });
  for (const b of rep.buildings) for (const x of b.inside) {
    const visiting = homeOf(town, x.p) !== b.a;
    pool.push({ p: x.p, w: visiting ? 3 : isPublic(town, b.a) ? 2 : 0.3 });
  }
  const awake = block !== "night" && block !== "late_night";
  const ok = pool.filter((x) => awake || x.w >= 3);
  if (!ok.length) return undefined;
  const p = rng.weighted(ok, (x) => x.w).p;
  const e = town.get(p);
  const w = whereabouts(town, p, date, block);
  const where: Text = w.where.startsWith("place:") ? [w.label] : ["at ", link(town, w.where, town.label(w.where).replace(/^The /, "the "))];
  const strangers = e.get<string | null>("character.strangers") ?? undefined;
  return {
    p, where, doing: w.doing,
    looks: town.registry<Feature>("features").find(e.get("feature"))?.label,
    speech: e.get<string | null>("character.speech") ?? undefined,
    habit: e.get<string | null>("character.habit") ?? undefined,
    want: e.get<string | null>("character.want") ?? undefined,
    strangers,
    opener: w.where === homeOf(town, p) && !isPublic(town, w.where)
      ? `(answers the door) ${opener(rng, strangers ?? "", e.get<number>("age"), awake, w.doing).replace("(hurries indoors and bars the door)", "(shuts it again, fast)")}`
      : opener(rng, strangers ?? "", e.get<number>("age"), awake, w.doing),
  };
}

function opener(r: Rng, strangers: string, age: number, awake: boolean, doing = ""): string {
  if (/watch|patrol/.test(doing)) return r.pick(["“Halt. Who goes there, and what's your business at this hour?”", "“Names. And show me your hands.”"]);
  if (!awake) return r.pick(["“Who's there? It's past curfew.”", "(stops dead, then hurries on without a word)"]);
  if (age < 12) return r.pick(["“Is that a real sword?”", "“Where've you come from? Have you seen the sea?”", "(stares, then runs off to tell someone)"]);
  if (/friendly|news|hungry for news/.test(strangers)) return r.pick(["“Come far? What's the news on the road?”", "“You'll be wanting the inn. I'll show you.”"]);
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
      const pay = Math.min(Math.round(amount / 3), Math.max(12, purse(e.to)));
      const kin = friendsOf(e.from);
      jobs.push({
        id: `debt/${e.id}`, title: "Collect a debt", patron: e.to, target: e.from, at: at(e.to), pay,
        detail: [named(e.to), ` wants the ${lsd(amount)} that `, named(e.from), ` owes${e.facts.reason ? ` for ${e.facts.reason}` : ""}, and will give a third of whatever comes back.`, e.knownBy !== "public" ? " Quietly: nobody else knows about the debt." : ""],
        risk: kin.length ? [named(e.from), " has people who'll take it badly: ", ...list(kin)] : [named(e.from), fierce(e.from) ? " has a temper." : " will plead poverty, and may mean it."],
        fact: `edge:${e.id}`,
      });
    } else if (e.kind === "rival") {
      const r = rngFor(e.id);
      const pay = Math.max(6, Math.min(Math.round(purse(e.from) * r.range(0.05, 0.15)), 480));
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

  // Wants and fears: a sick child, a strongbox, a journey.
  const everyone = people(town);
  for (const p of everyone) {
    const want = p.get<string | null>("character.want") ?? "";
    const fear = p.get<string | null>("character.fear") ?? "";
    const id = p.address;
    if (/cure for a sick child/.test(want)) {
      jobs.push({ id: `cure/${id}`, title: "Fetch a remedy", patron: id, at: at(id), pay: Math.max(4, Math.min(purse(id), 60)),
        detail: [named(id), " has a child sick at home and will pay what can be spared for a physician, or a remedy that works."],
        risk: ["The child may not last the journey there and back."] });
    } else if (/pilgrimage/.test(want) && p.get<number>("age") >= 50) {
      jobs.push({ id: `escort/${id}`, title: "Escort a pilgrim", patron: id, at: at(id), pay: Math.max(12, Math.min(purse(id), 240)),
        detail: [named(id), " wants to see a shrine before dying, and daren't take the roads alone."],
        risk: ["Slow going, and the roads are what they are."] });
    } else if (/thieves/.test(fear)) {
      jobs.push({ id: `guard/${id}`, title: "Guard a house by night", patron: id, at: at(id), pay: Math.max(6, Math.min(Math.round(purse(id) * 0.02), 60)),
        detail: [named(id), " sleeps on the strongbox and still doesn't sleep. A few nights' watch, and no questions."],
        risk: ["Probably nothing. Probably."] });
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
