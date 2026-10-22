// Crime: the town's underworld, after the shape of Gygax's *The Canting Crew*
// (CC), translated for a mundane high-medieval town. Street plans of a
// thousand people or more get crews (nips, housebreakers, footpads, the
// beggars' fraternity, dice cheats, the stews, owlers, clippers, bullies,
// horse thieves), each with a den, a turf, ranked members drawn from the
// town's own poor, a fence, and often an officer on the payroll. Bigger
// places add a boss who takes a tenth from every crew, a thief-taker, and a
// knife for hire. The crimes themselves are a calendar, a pure function of the
// date (calendar.ts), and they reach every other part of the town through
// registries: talk (gossip), where people are (routines), visitors, sifters.
import type { Address } from "../../core/address";
import { addDays, describeDate, jdn, parseDate, type Block, whenOf } from "../../core/calendar";
import type { Rng } from "../../core/rng";
import type { Town } from "../../core/town";
import type { EdgeKind, EntityLike, Module, PanelLink, PanelRow, Sifter, SifterMatch } from "../../core/types";
import type { RumourSource, RumourTopic } from "../gossip";
import { hourOf, talkAt, spread } from "../gossip";
import { lsd } from "../households";
import { isStreetPlan, wardId, type MapData } from "../layout";
import type { NameProvider } from "../names";
import type { RoutineHook } from "../routines";
import type { Visit, VisitSource } from "../visitors";
import { visitsIn } from "../visitors";
import { crimeAt, crimeRumours, happened, incidentsBetween, marksOn, incidentsIn, prisoners, recordOf, REF_YEAR, statusOf, type Incident } from "./calendar";
import { found } from "./found";
import { content, LEVELS, layOf, roleText, self, UNDERWORLD, world, type Level } from "./world";

export { world, content as crimeContent, UNDERWORLD } from "./world";
export type { Gang, World, Member, Level } from "./world";
export { incidentsIn, incidentsBetween, marksOn, hangingsOn, prisoners, recordOf, statusOf, happened, type Incident } from "./calendar";

// Mid-sentence, a crew is "the Bell knot", not "The Bell knot".
const L = (town: Town, a: Address, text = town.label(a).replace(/^The /, a.includes("/institution:crew-") ? "the " : "The ")): PanelLink => ({ text, address: a });
const list = (town: Town, as: Address[]): (string | PanelLink)[] => as.flatMap((a, i) => [...(i ? [", "] : []), L(town, a)]);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const the = (town: Town, a: Address) => town.label(a).replace(/^The /, "the ");
const placeText = (town: Town, at: string) => (at.startsWith("place:") ? ({ "place:market": "the market place", "place:quay": "the quay", "place:river": "the riverside", "place:streets": "the streets" } as Record<string, string>)[at] ?? "the town" : the(town, at));
const wardName = (town: Town, i: number) => town.find(`${town.root}/ward:${wardId(i)}`)?.get<string>("name") ?? `ward ${i + 1}`;
const today = (town: Town) => town.clock.date;
/** Crimes between two dates that have happened by the clock (later tonight's haven't). */
const past = (town: Town, from: string) => incidentsBetween(town, from, town.clock.date).filter((i) => happened(i, town.clock.date, town.clock.block as Block));

/** Which lays a place gets: always the nips first, then by weight among those its streets can feed. */
function chooseLays(r: Rng, pop: number, level: Level, has: { water: boolean; bathhouse: boolean; inn: boolean; gates: boolean }): string[] {
  if (pop < content.gangsFrom) return [];
  let n = 1;
  for (let p = 3000; p <= pop; p *= 2) n++;
  n = Math.max(1, n + (level === "rife" ? 1 : level === "quiet" ? -1 : 0));
  const ok = content.lays.filter((l) => pop >= l.minPop && (l.needs ?? []).every((x) => has[x as keyof typeof has]));
  const out: string[] = [];
  if (ok.some((l) => l.id === "nips")) out.push("nips");
  const rest = ok.filter((l) => !out.includes(l.id));
  while (out.length < n && rest.length) {
    const l = r.weighted(rest, (x) => x.weight);
    out.push(l.id);
    rest.splice(rest.indexOf(l), 1);
  }
  // A big place can have two crews of the same kind, and they hate each other.
  while (out.length < n) out.push(r.pick(["nips", "crackers", "pads"].filter((x) => ok.some((l) => l.id === x))));
  return out;
}

export const crime: Module = {
  id: self.id,
  version: self.version,
  requires: ["core", "uses", "layout", "households", "names", "people", "character", "society", "visitors", "religion", "civic", "lodging", "routines", "gossip"],
  register(add) {
    add<EdgeKind>("edgeKinds", [
      { id: "in_gang", label: "runs with", inverse: "has in its crew" },
      { id: "fence_for", label: "fences for", inverse: "sells stolen goods to" },
      { id: "harbours", label: "keeps the den of", inverse: "meets at the house of" },
      { id: "pays_off", label: "pays off", inverse: "takes money from" },
      { id: "protection", label: "pays protection to", inverse: "takes protection from" },
      { id: "informs_on", label: "informs to", inverse: "has a nose in" },
      { id: "blackmails", label: "blackmails", inverse: "is blackmailed by" },
      { id: "tithe_to", label: "pays a tenth to", inverse: "takes a tenth from" },
      { id: "hired_knife", label: "has hired", inverse: "was hired by" },
      { id: "in_league", label: "in league with", symmetric: true },
    ]);
    add<RumourTopic>("rumourTopics", Object.entries(content.topics).map(([id, t]) => ({ id, tellings: t.tellings, leak: t.leak, source: "CC pp.39-71 (our own tellings)" })));
    add<RumourSource>("rumourSources", [{ id: "crime", rumours: crimeRumours, source: "our own" }]);
    add<RoutineHook>("routineHooks", [{ id: "crime", at: crimeAt, source: "our own" }]);
    add<VisitSource>("visitSources", [{ id: "crime", label: { flying_camp: "Beggars on the road", thief_taker: "Thief-taker" }, visits: crimeVisits, source: "CC pp.43-44 (flying camps), p.39 (thief-takers)" }]);
    add<Sifter>("sifters", [boughtAndPaid, alibiCells, thiefTakersThieves, wontPay, neckVerse, sanctuaryHook, priceOnAHead, crossbitten, theNose, turfWar, wrongMan, blameTheTinkers]);
  },
  hooks: {
    onSettlementGenerated(ctx, s) {
      const town = ctx.town;
      if (!isStreetPlan(town)) return;
      const pop = s.get<number>("targetPop");
      // Rolled, then the DM's plan has its say (the draw is made either way).
      const level = ctx.gen(s, "crime.level", (r) => {
        const rolled = r.weighted(LEVELS, (l) => content.levels[l].weight);
        return town.settings.design?.crime ?? rolled;
      }) as Level;
      const map = s.get<MapData>("map");
      const plan = s.get<string[]>("plan") ?? [];
      const has = {
        water: !!map.quay?.length || (map.wards ?? []).some((w) => w.near.includes("quay") || w.near.includes("river") || w.near.includes("bridge")),
        bathhouse: plan.includes("bathhouse"), inn: plan.includes("inn"), gates: !!map.wall?.gates.length,
      };
      const lays = ctx.gen(s, "crime.lays", (r) => chooseLays(r, pop, level, has)) as string[];
      if (pop < content.gangsFrom) return;
      const uw = ctx.create("institution", s.address, UNDERWORLD, { kind: UNDERWORLD });
      lays.forEach((lay, i) => ctx.create("institution", uw.address, `crew-${i}`, { kind: "gang", lay }));
    },
    onSocietyResolved(ctx, s) {
      if (!isStreetPlan(ctx.town)) return;
      found(ctx, s);
    },
  },
  label(town, e) {
    if (e.type !== "institution") return undefined;
    const k = e.get("kind");
    if (k === UNDERWORLD) return "The underworld";
    if (k === "gang") { town.society(); return cap(e.get<string>("name") ?? layOf(e.get<string>("lay")).label); }
    return undefined;
  },
  panels: [
    { id: "crime-town", title: "Crime", for: "settlement", order: 2.6, rows: settlementRows },
    { id: "crime-ward", title: "Crime in the ward", for: "ward", order: 2.5, rows: wardRows },
    { id: "crime-building", title: "Underneath", for: "building", order: 3.5, rows: buildingRows },
    { id: "crime-person", title: "Underneath", for: "person", order: 5.7, rows: personRows },
    { id: "crime-gang", title: "The crew", for: "institution", order: 0, rows: gangRows },
    { id: "crime-underworld", title: "The underworld", for: "institution", order: 0, rows: underworldRows },
    { id: "crime-cant", title: "The cant", for: "institution", order: 9, rows: cantRows },
    { id: "crime-law", title: "Crime and punishment", for: "institution", order: 1, rows: lawRows },
  ],
};

// ---- panels -------------------------------------------------------------

function crimeLine(town: Town, i: Incident, about: Address | undefined, now: string): (string | PanelLink)[] {
  const C = content.crimes[i.kind];
  const v: (string | PanelLink)[] = [`${C.label}`];
  if (i.victim && i.victim !== about) v.push(": ", L(town, i.victim));
  v.push(` at ${placeText(town, i.at)}`);
  if (i.items) v.push(` — ${i.items}`);
  if (i.culprits.length && !i.culprits.includes(about ?? "")) v.push("; done by ", ...list(town, i.culprits));
  if (i.gang && about !== i.gang) v.push(" of ", L(town, i.gang));
  if (i.sanctuary) v.push(`; ${town.label(i.culprits[i.culprits.length - 1])} fled to sanctuary`);
  if (i.caught) {
    v.push(`; ${i.caught.date <= now ? "taken" : "will be taken"} ${describeDate(i.caught.date, now)}`);
    if (i.caught.by) v.push(" by ", L(town, i.caught.by));
    if (i.fate) v.push(i.fate.on <= now ? ` — ${i.fate.text}` : ` — to be tried ${describeDate(i.fate.on, now)}`);
  } else if (!i.sanctuary && i.date <= now) v.push("; nobody taken");
  return v;
}

function settlementRows(town: Town, s: EntityLike): PanelRow[] {
  if (!isStreetPlan(town)) return [];
  const level = s.get<Level>("crime.level");
  if (!level) return [];
  const rows: PanelRow[] = [{ label: "Crime", value: content.levels[level].label, key: "crime.level", options: LEVELS, hint: "change it and the town is rebuilt with more or fewer rogues" }];
  const W = world(town);
  if (!W) {
    rows.push({ label: "Rogues", value: "a cutpurse or two and the odd vagrant; too small a place for crews (CC p.11)" });
    return rows;
  }
  rows.push({ label: "Underworld", value: [L(town, W.address), ` — ${W.gangs.length} crew${W.gangs.length === 1 ? "" : "s"}, ${W.crew.size} in them`] });
  const now = today(town);
  const week = past(town, addDays(now, -6));
  if (week.length) {
    const n = new Map<string, number>();
    for (const i of week) n.set(i.kind, (n.get(i.kind) ?? 0) + 1);
    rows.push({ label: "This week", value: [...n].map(([k, c]) => (c > 1 ? `${c} ${content.crimes[k].plural}` : `1 ${content.crimes[k].label}`)).join(", ") });
  }
  const held = prisoners(town, now);
  if (held.length) rows.push({ label: "In gaol", value: list(town, held.map((x) => x.p)) });
  return rows;
}

function wardRows(town: Town, w: EntityLike): PanelRow[] {
  const W = world(town);
  if (!W) return [];
  const idx = w.get<number>("index");
  const rows: PanelRow[] = [];
  for (const g of W.gangs) if (g.turf.includes(idx)) rows.push({ label: g.den && town.get(g.den).get("ward") === idx ? "Den of" : "Worked by", value: [L(town, g.address), ` — ${g.lay.label}`] });
  const now = today(town);
  const here = past(town, addDays(now, -30)).filter((i) => !i.at.startsWith("place:") && town.get(i.at).get("ward") === idx);
  if (here.length) rows.push({ label: "Last 30 days", value: `${here.length} crime${here.length === 1 ? "" : "s"}: ${[...new Set(here.map((i) => content.crimes[i.kind].label))].join(", ")}`, highlight: here.map((i) => i.at) });
  const value = town.settlement().get<MapData>("map").wards?.[idx]?.value ?? 3;
  if (value <= 1) rows.push({ label: "After dark", value: "nobody with a full purse walks here alone" });
  return rows;
}

function buildingRows(town: Town, b: EntityLike): PanelRow[] {
  const W = world(town);
  if (!W) return [];
  const rows: PanelRow[] = [];
  const marks = marksOn(town, b.address, today(town));
  if (marks.length) rows.push({ label: "Chalked by the door", value: marks.map((m) => `${content.marks[m].glyph} ${content.marks[m].text}`).join("; "), hint: "beggars' marks, low on the doorpost, where nobody honest looks (CC p.130)" });
  for (const g of W.gangs) if (g.den === b.address) {
    rows.push({ label: "Den of", value: [L(town, g.address), ` — ${g.lay.label}; they meet in the back`], hint: `the word at the door is "${g.word}"` });
    if (g.keeper) rows.push({ label: "Kept by", value: [L(town, g.keeper), ", who takes their money and sees nothing"] });
  }
  const residents = new Set(town.children(b.address, "household").flatMap((h) => town.children(h.address, "person").map((p) => p.address)));
  for (const f of W.fences) if (residents.has(f)) {
    const gangs = W.gangs.filter((g) => g.fence === f);
    rows.push({ label: "A fence", value: [L(town, f), " buys stolen goods here, at the back", ...(gangs.length ? [" — for ", ...list(town, gangs.map((g) => g.address))] : [])] });
  }
  for (const e of W.edges.protection) if (residents.has(e.from)) rows.push({ label: "Pays protection", value: [L(town, e.to), ` — ${lsd(e.facts?.amount as number)} a week`], fact: `edge:${e.id}` });
  for (const g of W.gangs) for (const p of g.refusers) if (residents.has(p)) rows.push({ label: "Won't pay", value: [L(town, p), " has told ", L(town, g.address), " where to go"] });
  const now = today(town);
  const here = incidentsBetween(town, addDays(now, -60), addDays(now, 30)).filter((i) => i.at === b.address);
  for (const i of here.slice(-6)) {
    const coming = !happened(i, now, town.clock.block as Block);
    rows.push({ label: coming ? `coming ${whenOf(i.date, now)}` : whenOf(i.date, now), value: crimeLine(town, i, undefined, now), highlight: i.culprits, hint: coming ? `the DM's foreknowledge: it hasn't happened yet (${i.block.replace("_", " ")})` : undefined });
  }
  if (b.get("use") === "gaol" || b.get("use") === "watch_house") {
    const held = prisoners(town, now).filter((x) => x.where === b.address);
    for (const x of held) rows.push({ label: "Held here", value: [L(town, x.p), `: ${x.doing}`] });
  }
  return rows;
}

function personRows(town: Town, p: EntityLike): PanelRow[] {
  const W = world(town);
  if (!W) return [];
  const rows: PanelRow[] = [];
  const now = today(town);
  const m = W.crew.get(p.address);
  if (m) {
    rows.push({ label: "Runs with", value: [L(town, m.gang.address), ` as ${m.rank.cant}`], hint: m.rank.plain });
    if (m.gang.den) rows.push({ label: "Den", value: [L(town, m.gang.den)] });
  }
  const alias = p.get<string | undefined>("crime.alias");
  if (alias) rows.push({ label: "Known as", value: alias, key: "crime.alias", rerollable: true });
  const hh = town.get(town.parentOf(p.address)!);
  const take = hh.type === "household" ? hh.get<number | undefined>("crime.take") : undefined;
  if (take && (m || (W.roles.get(p.address) ?? []).length) ) {
    const income = hh.get<number>("income") ?? 0;
    rows.push({ label: "Crew money", value: `about ${lsd(take)} a year that the trade doesn't explain${income ? `, beside ${lsd(income)} honest` : ""}`, hint: take > income ? "they live better than they should, and the neighbours have noticed" : "kept quiet, spent carefully" });
  }
  for (const r of W.roles.get(p.address) ?? []) {
    if (r === "informer") continue;
    rows.push({ label: "Also", value: roleText(r), hint: r === "keeper" || r === "fence" ? undefined : content.roles[r as "boss" | "knife" | "thiefTaker"]?.plain });
  }
  for (const e of W.edges.hired_knife) {
    if (e.to !== p.address && e.from !== p.address) continue;
    const day = addDays(`${REF_YEAR}-01-01`, e.facts?.day as number);
    const method = content.knifeMethods.find((x) => x.id === e.facts?.method);
    const target = e.facts?.target as Address;
    rows.push({ label: e.to === p.address ? "Paid to kill" : "Has paid to kill", value: [L(town, target), `, ${method?.text ?? "somehow"}, for ${lsd(e.facts?.price as number)}${e.to === p.address ? "; hired by " : ""}`, ...(e.to === p.address ? [L(town, e.from)] : [" — the knife is ", L(town, e.to)])], hint: day >= now ? `set for ${describeDate(day, now)}` : `due ${describeDate(day, now)}`, fact: `edge:${e.id}` });
  }
  const st = statusOf(town, p.address, now, town.clock.block as Block);
  if (st) rows.push({ label: "Now", value: st.doing });
  const rec = recordOf(town, p.address, now);
  const did = rec.filter((i) => i.culprits.includes(p.address)).slice(-6);
  for (const i of did) rows.push({ label: whenOf(i.date, now), value: crimeLine(town, i, p.address, now) });
  const done = rec.filter((i) => i.victim === p.address).slice(-4);
  for (const i of done) rows.push({ label: "robbed", value: [`${whenOf(i.date, now)}: `, ...crimeLine(town, i, p.address, now)] });
  return rows;
}

function gangRows(town: Town, g: EntityLike): PanelRow[] {
  if (g.get("kind") !== "gang") return [];
  const W = world(town);
  const gang = W?.byAddress.get(g.address);
  if (!W || !gang) return [];
  const lay = gang.lay;
  const rows: PanelRow[] = [
    { label: "Trade", value: `${lay.label}: ${lay.cant}`, hint: lay.source },
    ...(gang.den ? [{ label: "Den", value: [L(town, gang.den)] } as PanelRow] : []),
    { label: "Turf", value: gang.turf.flatMap((w, i) => [...(i ? [", "] : []), L(town, `${town.root}/ward:${wardId(w)}`, wardName(town, w))]) },
  ];
  for (const rk of lay.ranks) {
    const ms = gang.members.filter((m) => m.rank.id === rk.id);
    if (ms.length) rows.push({ label: rk.cant, value: list(town, ms.map((m) => m.p)), hint: rk.plain, highlight: ms.map((m) => m.p) });
  }
  const odd = gang.members.filter((m) => !lay.ranks.includes(m.rank));
  if (odd.length) rows.push({ label: "hangers-on", value: list(town, odd.map((m) => m.p)) });
  if (gang.fence) rows.push({ label: "Fence", value: [L(town, gang.fence)], hint: content.roles.fence.plain });
  if (gang.keeper) rows.push({ label: "Den kept by", value: [L(town, gang.keeper)] });
  for (const e of W.edges.pays_off) if (W.crew.get(e.from)?.gang === gang) rows.push({ label: "Pays", value: [L(town, e.to), `, ${e.facts?.office}, ${lsd(e.facts?.amount as number)} a quarter`], fact: `edge:${e.id}` });
  for (const e of W.edges.tithe_to) if (W.crew.get(e.from)?.gang === gang) rows.push({ label: "Tithes to", value: [L(town, e.to), " — a tenth of every take"], fact: `edge:${e.id}` });
  for (const n of gang.informers) {
    const e = W.edges.informs_on.find((x) => x.from === n)!;
    rows.push({ label: "A nose", value: [L(town, n), " tells ", L(town, e.to), " everything"], hint: "the crew doesn't know. Yet.", fact: `edge:${e.id}` });
  }
  if (gang.rivals.length) rows.push({ label: "At odds with", value: list(town, gang.rivals) });
  rows.push({ label: "The word", value: `"${gang.word}"`, hint: "said at the den's door; strangers who know it are let in" });
  rows.push({ label: "The sign", value: gang.sign });
  rows.push({ label: "Their mark", value: `${gang.emblem}, chalked where they've been` });
  rows.push({ label: "Their rules", value: gang.customs.join("; ") });
  const now = today(town);
  const recent = past(town, addDays(now, -45)).filter((i) => i.gang === gang.address);
  if (recent.length) {
    const take = recent.reduce((a, i) => a + i.loot, 0);
    rows.push({ label: "Last 45 days", value: `${recent.length} jobs, about ${lsd(take)} taken (worth a third of that from the fence)` });
    for (const i of recent.filter((x) => x.notable || x.caught).slice(-5)) rows.push({ label: whenOf(i.date, now), value: crimeLine(town, i, gang.address, now) });
  }
  const coming = incidentsBetween(town, now, addDays(now, 14)).filter((i) => i.gang === gang.address && i.notable && !happened(i, now, town.clock.block as Block));
  for (const i of coming.slice(0, 3)) rows.push({ label: `coming ${whenOf(i.date, now)}`, value: crimeLine(town, i, gang.address, now), hint: "the DM's foreknowledge" });
  return rows;
}

function underworldRows(town: Town, uw: EntityLike): PanelRow[] {
  if (uw.get("kind") !== UNDERWORLD) return [];
  const W = world(town);
  if (!W) return [];
  const rows: PanelRow[] = [{ label: "Crime", value: content.levels[W.level].label }];
  if (W.boss) rows.push({ label: "The boss", value: [L(town, W.boss), `, ${content.roles.boss.cant}`], hint: content.roles.boss.plain });
  for (const g of W.gangs) rows.push({ label: g.lay.label, value: [L(town, g.address), ` — ${g.members.length}, led by `, ...(g.chief ? [L(town, g.chief)] : ["nobody"]), ...(g.den ? [", at ", L(town, g.den)] : [])], highlight: g.members.map((m) => m.p) });
  if (W.fences.length) rows.push({ label: "Fences", value: list(town, W.fences), hint: content.roles.fence.plain });
  if (W.thiefTaker) rows.push({ label: "Thief-taker", value: [L(town, W.thiefTaker)], hint: content.roles.thiefTaker.plain });
  if (W.knives.length) rows.push({ label: "A knife for hire", value: list(town, W.knives), hint: content.roles.knife.plain });
  const paid = W.edges.pays_off;
  if (paid.length) rows.push({ label: "On the payroll", value: list(town, [...new Set(paid.map((e) => e.to))]), hint: "officers who take money to look away" });
  const informers = W.edges.informs_on;
  if (informers.length) rows.push({ label: "Noses", value: list(town, informers.map((e) => e.from)), hint: "informers; their crews don't know" });
  if (W.edges.protection.length) rows.push({ label: "Protection", value: `${W.edges.protection.length} shops pay every Saturday` });
  if (W.edges.usury.length) rows.push({ label: "Loans", value: `${W.edges.usury.length} people owe the dice-cheats' usurer` });
  if (W.edges.blackmails.length) rows.push({ label: "Blackmail", value: list(town, W.edges.blackmails.map((e) => e.to)), hint: "being bled for their secrets" });
  return rows;
}

function cantRows(_town: Town, uw: EntityLike): PanelRow[] {
  if (uw.get("kind") !== UNDERWORLD) return [];
  return content.cant.map((c) => ({ label: c.w, value: c.m }));
}

function lawRows(town: Town, inst: EntityLike): PanelRow[] {
  const k = inst.get("kind");
  if (k !== "justice" && k !== "watch") return [];
  const W = world(town);
  if (!W) return [];
  const now = today(town);
  const rows: PanelRow[] = [];
  if (k === "justice") {
    for (const x of prisoners(town, now)) rows.push({ label: "In gaol", value: [L(town, x.p), `: ${x.doing}`, ...(x.inc?.fate ? [`; to be tried ${describeDate(x.inc.fate.on, now)}`] : [])] });
    const y = parseDate(now).y;
    const next = [...visitsIn(town, y), ...visitsIn(town, y + 1)].find((v) => v.kind === "assize" && v.start >= now);
    if (next) rows.push({ label: "Next assizes", value: `${describeDate(next.start, now)}: ${next.who}` });
    const recent = incidentsBetween(town, addDays(now, -120), now).filter((i) => i.fate && i.fate.on <= now && i.fate.on >= addDays(now, -60));
    for (const i of recent.slice(-8)) rows.push({ label: `sentenced ${whenOf(i.fate!.on, now)}`, value: [L(town, i.caught!.who), `, for ${content.crimes[i.kind].charge}: ${i.fate!.text}`] });
    rows.push({ label: "The law", value: "under twelvepence is petty theft: the pillory, the stocks or the whip. Twelvepence and over is a felony for the king's justices, and a hanging matter, unless the felon can read the neck verse and claim clergy, or reaches a church first (CC pp.176-179, our version)" });
  } else {
    if (W.thiefTaker) rows.push({ label: "Thief-taker", value: [L(town, W.thiefTaker)], hint: content.roles.thiefTaker.plain });
    for (const e of W.edges.pays_off) if (e.facts?.office !== "gaoler") rows.push({ label: "On the take", value: [L(town, e.to), `, ${e.facts?.office}, from `, L(town, W.crew.get(e.from)?.gang.address ?? e.from)], fact: `edge:${e.id}` });
    const wanted = past(town, addDays(now, -30)).filter((i) => i.notable && !(i.caught && i.caught.date <= now) && !i.sanctuary && i.culprits.length);
    for (const i of wanted.slice(-6)) rows.push({ label: "Wanted", value: [`for ${content.crimes[i.kind].charge} at ${placeText(town, i.at)}, ${whenOf(i.date, now)}: `, ...list(town, i.culprits)], hint: "the watch doesn't know who; the DM does" });
  }
  return rows;
}

// ---- visitors -------------------------------------------------------------

function crimeVisits(town: Town, year: number): Visit[] {
  const W = world(town);
  if (!W) return [];
  const out: Visit[] = [];
  const names = town.registry<NameProvider>("nameProviders").get("anglo-norman");
  const r = town.rngFor(town.root, self, `visits:${year}`);
  const day = (from: number, to: number) => addDays(`${year}-01-01`, r.int(from, to));
  if (r.chance(0.5)) out.push({ kind: "flying_camp", start: day(90, 300), days: r.int(2, 4), who: `a flying camp of ${r.int(8, 20)} beggars`, note: "sores, crutches, forged licences and sharp eyes; they camp by the gate and spy for the crews" });
  if (!W.thiefTaker && r.chance(0.6)) out.push({ kind: "thief_taker", start: day(20, 340), days: r.int(2, 5), who: `${names.given(r, { sex: "m" })} ${names.family(r, { settlement: "" }).name}, a thief-taker from the shire town`, note: "asking at the alehouses about a stolen horse and the men who took it, and paying for names" });
  return out;
}

// ---- hooks ----------------------------------------------------------------

const S = (id: string, title: string, source: string, match: (town: Town) => SifterMatch[]): Sifter => ({ id, title, source, match });

const boughtAndPaid = S("bought-and-paid", "Bought and paid for", "CC p.46 (bribes paid out of the crews' treasuries)", (town) => {
  const W = world(town);
  if (!W) return [];
  return W.edges.pays_off.filter((e) => e.facts?.office !== "gaoler").map((e) => {
    const g = W.crew.get(e.from)?.gang;
    return { title: "Bought and paid for", summary: `${town.label(e.to)}, ${e.facts?.office}, takes ${lsd(e.facts?.amount as number)} a quarter from ${town.label(e.from)} of ${g?.name ?? "a crew"}. Anyone robbed in ${g ? g.turf.map((w) => wardName(town, w)).join(" or ") : "that ward"} who goes to him will be told nothing can be done.`, involves: [e.to, e.from] };
  });
});

const alibiCells = S("alibi-cells", "Alibi cells", "LF p.151 and CC p.30 (prisons where the gaoler is bribed)", (town) => {
  const W = world(town);
  if (!W) return [];
  return W.edges.pays_off.filter((e) => e.facts?.office === "gaoler").map((e) => ({
    title: "Alibi cells", summary: `${town.label(e.to)}, the gaoler, is paid ${lsd(e.facts?.amount as number)} a quarter by ${town.label(e.from)}. A thief can spend the night of a job "in gaol", on the books, and a door is sometimes left unbarred.`, involves: [e.to, e.from],
  }));
});

const thiefTakersThieves = S("thief-takers-thieves", "The thief-taker's thieves", "CC pp.39-40 (thief-takers with organisations and monopolies)", (town) => {
  const W = world(town);
  if (!W) return [];
  return W.edges.in_league.map((e) => {
    const gangs = W.gangs.filter((g) => g.fence === e.to).map((g) => g.name);
    return { title: "The thief-taker's thieves", summary: `${town.label(e.from)}, the thief-taker, splits the rewards for "recovered" goods with ${town.label(e.to)}, who fences for ${gangs.join(" and ") || "anyone"}. The thieves he catches are the ones who sell to somebody else.`, involves: [e.from, e.to] };
  });
});

const wontPay = S("wont-pay", "Won't pay", "CC p.51 (extortioners)", (town) => {
  const W = world(town);
  if (!W) return [];
  const now = today(town);
  const out: SifterMatch[] = [];
  for (const g of W.gangs) for (const p of g.refusers) {
    const hit = incidentsBetween(town, addDays(now, -20), addDays(now, 20)).find((i) => i.kind === "smash" && i.victim === p);
    out.push({ title: "Won't pay", summary: `${town.label(p)} won't pay ${g.name} for "protection". The rest of the street pays, and is watching.${hit ? ` ${hit.date <= now ? "The shop was smashed on" : "The shop will be smashed on"} ${describeDate(hit.date, now)}.` : ""}`, involves: [p, ...(g.chief ? [g.chief] : [])] });
  }
  return out;
});

const neckVerse = S("neck-verse", "The neck verse", "our own (benefit of clergy, for any man who can read)", (town) => {
  const now = today(town);
  return prisoners(town, now).filter((x) => x.inc?.fate?.felony && x.inc.fate.outcome === "clergy").map((x) => ({
    title: "The neck verse", summary: `${town.label(x.p)} is in gaol for ${content.crimes[x.inc!.kind].charge}, a hanging matter. But ${town.label(x.p)} can read, and will claim benefit of clergy at the assizes on ${describeDate(x.inc!.fate!.on, now)}: the victim will see the thief walk away with a branded thumb.`, involves: [x.p, ...(x.inc!.victim ? [x.inc!.victim] : [])],
  }));
});

const sanctuaryHook = S("sanctuary", "Sanctuary", "our own (forty days, then abjure the realm)", (town) => {
  const now = today(town);
  return incidentsBetween(town, addDays(now, -40), now).filter((i) => i.sanctuary && i.sanctuary.date <= now).map((i) => {
    const who = i.culprits[i.culprits.length - 1];
    const left = 40 - (jdn(parseDate(now)) - jdn(parseDate(i.sanctuary!.date)));
    return { title: "Sanctuary", summary: `${town.label(who)} is in sanctuary at ${the(town, i.sanctuary!.church)} after the ${content.crimes[i.kind].charge}, with ${left} days left before abjuring the realm. The watch sits outside the door. ${i.victim ? `${town.label(i.victim)} wants the goods back first.` : ""}`, involves: [who, i.sanctuary!.church, ...(i.victim ? [i.victim] : [])] };
  });
});

const priceOnAHead = S("price-on-a-head", "A price on a head", "CC pp.47-49 (hired killers), our own", (town) => {
  const W = world(town);
  if (!W) return [];
  const now = today(town);
  return W.edges.hired_knife.map((e) => ({ e, day: addDays(`${REF_YEAR}-01-01`, e.facts?.day as number) })).filter((x) => x.day >= now && x.day <= addDays(now, 60)).map(({ e, day }) => {
    const method = content.knifeMethods.find((m) => m.id === e.facts?.method);
    const target = e.facts?.target as Address;
    return { title: "A price on a head", summary: `${town.label(e.from)} has paid ${town.label(e.to)} ${lsd(e.facts?.price as number)} to see ${town.label(target)} dead: ${method?.text}. It happens on ${describeDate(day, now)}, unless somebody stops it.`, involves: [e.from, e.to, target] };
  });
});

const crossbitten = S("crossbitten", "Bled dry", "CC p.58 (blackmailers)", (town) => {
  const W = world(town);
  if (!W) return [];
  return W.edges.blackmails.map((e) => ({ title: "Bled dry", summary: `${town.label(e.from)} is blackmailing ${town.label(e.to)} over ${e.facts?.about}: ${lsd(e.facts?.amount as number)} a quarter. ${town.label(e.to)} would pay well to have the threat gone, one way or another.`, involves: [e.from, e.to] }));
});

const theNose = S("the-nose", "The nose", "CC p.39 (informers are pardoned and paid)", (town) => {
  const W = world(town);
  if (!W) return [];
  return W.edges.informs_on.map((e) => {
    const g = W.crew.get(e.from)?.gang;
    // A nose is worth more free than hanged: his own jobs go unpunished.
    const now = today(town);
    const own = incidentsBetween(town, addDays(now, -90), now).filter((i) => i.culprits.includes(e.from) && !i.caught);
    const shield = own.length >= 2 ? ` Meanwhile ${town.label(e.from)} has done ${own.length} jobs of his own in three months and never been taken: ${town.label(e.to)} sees to that.` : "";
    return { title: "The nose", summary: `${town.label(e.from)} of ${g?.name ?? "a crew"} has been informing to ${town.label(e.to)}. ${g?.chief ? town.label(g.chief) : "The chief"} has noticed the watch is always waiting, and is asking who.${shield}`, involves: [e.from, e.to, ...(g?.chief ? [g.chief] : [])] };
  });
});

const turfWar = S("turf-war", "Turf war", "CC p.44 (disputes between crews over precedence)", (town) => {
  const W = world(town);
  if (!W) return [];
  return W.edges.rival.map((e) => ({ title: "Turf war", summary: `${(e.facts?.crews as string[] | undefined)?.join(" and ") ?? "Two crews"} are at odds over ${e.facts?.about}. ${town.label(e.from)} and ${town.label(e.to)} each want the other gone, and would pay strangers to see to it.`, involves: [e.from, e.to] }));
});

const blameTheTinkers = S("blame-the-tinkers", "Blame the tinkers", "LF p.77 (tinkers are blamed for thefts after they pass); CC p.58", (town) => {
  const W = world(town);
  if (!W) return [];
  const now = today(town), y = parseDate(now).y;
  const out: SifterMatch[] = [];
  for (const t of [...visitsIn(town, y - 1), ...visitsIn(town, y)].filter((v) => v.kind === "tinkers")) {
    const end = addDays(t.start, 45);
    if (end < addDays(now, -30) || t.start > now) continue;
    const jobs = incidentsBetween(town, t.start, end < now ? end : now).filter((i) => i.kind === "burglary" || i.kind === "linen");
    if (jobs.length < 2) continue;
    const crews = [...new Set(jobs.map((i) => (i.gang ? W.byAddress.get(i.gang)?.name : undefined)).filter(Boolean))];
    out.push({ title: "Blame the tinkers", summary: `Since ${t.who} came through on ${describeDate(t.start, now)}, ${jobs.length} houses have been robbed, and the town says it was them. It wasn't: it was ${crews.join(" and ") || "local men"}, glad of the cover. ${t.who[0].toUpperCase() + t.who.slice(1)} will get a rough welcome next time.`, involves: [...new Set(jobs.flatMap((i) => i.culprits))].slice(0, 6) });
  }
  return out;
});

const wrongMan = S("wrong-man", "The wrong man", "CC p.44 (the crews let others take the blame); our own", (town) => {
  const now = hourOf(today(town), town.clock.block as Block);
  const out: SifterMatch[] = [];
  for (const r of talkAt(town, now)) {
    if (!r.id.startsWith("crime/") || !r.who?.c) continue;
    const garbled = [...spread(town, r)].filter(([, s]) => s.telling === 2 && s.at <= now).length;
    if (!garbled) continue;
    const inc = incidentsIn(town, parseDate(today(town)).y).concat(incidentsIn(town, parseDate(today(town)).y - 1)).find((i) => `crime/${i.id}` === r.id);
    if (!inc || inc.caught) continue;
    out.push({ title: "The wrong man", summary: `Some of the town is saying ${r.texts[2]}. It wasn't ${town.label(r.who.c)}: it was ${inc.culprits.map((c) => town.label(c)).join(" and ")}${inc.gang ? ` of ${world(town)?.byAddress.get(inc.gang)?.name}` : ""}.`, involves: [r.who.c, ...inc.culprits] });
  }
  return out;
});
