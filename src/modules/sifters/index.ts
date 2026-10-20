import type { Town } from "../../core/town";
import type { Module, Sifter, SifterMatch } from "../../core/types";
import { COUNCIL } from "../council";
import { describeDate, jdn, parseDate } from "../../core/calendar";
import { visitsIn } from "../visitors";
import { centroid, dist, type Poly } from "../layout/geom";

// Plot hooks are found, not rolled: each sifter is a pattern over the graph.

const councilOf = (town: Town) => town.find(`${town.root}/institution:${COUNCIL}`);

export const thumbOnTheScale: Sifter = {
  id: "thumb-on-the-scale",
  title: "Thumb on the scale",
  source: "LF pp.72-75 (the base's richest trade)",
  match(town) {
    const c = councilOf(town);
    if (!c) return [];
    const richest = c.get<string>("richest");
    const elder = c.get<string>("elder");
    const richestHh = town.get(town.parentOf(richest)!);
    if (richestHh.get("occupation") !== town.settlement().get("richestTrade")) return [];
    const grudges = town.edges({ to: richest, kind: "grievance" });
    if (!grudges.length) return [];
    const name = town.label(richest);
    const place = town.label(town.root);
    const who = grudges.map((g) => town.label(g.from));
    const sitting = elder === richest ? "and sits as elder" : "and sits on the council";
    const quiet = grudges.filter((g) => g.knownBy !== "public").map((g) => town.label(g.from));
    return [{
      title: this.title,
      summary: `${name} is the richest in ${place} ${sitting}. ${list(who)} ${who.length > 1 ? "complain" : "complains"} of ${grudges[0].facts?.about ?? "sharp dealing"}.` +
        (quiet.length ? ` ${list(quiet)} ${quiet.length > 1 ? "have" : "has"} told nobody yet.` : ""),
      involves: [richest, ...grudges.map((g) => g.from)],
    }];
  },
};

export const judgeInOwnCause: Sifter = {
  id: "judge-in-own-cause",
  title: "Judge in his own cause",
  source: "LF pp.72-75 (councils hear the base's disputes)",
  match(town) {
    const c = councilOf(town);
    if (!c) return [];
    const seats = new Set((c.get<{ person: string }[]>("seats") ?? []).map((s) => s.person));
    const out: SifterMatch[] = [];
    for (const d of town.edges({ kind: "dispute" })) {
      const sitting = [d.from, d.to].filter((p) => seats.has(p));
      if (sitting.length !== 1) continue;
      const judge = sitting[0], other = judge === d.from ? d.to : d.from;
      out.push({
        title: this.title,
        summary: `${town.label(judge)} sits on the council that must settle ${town.label(other)}'s complaint over ${d.facts?.about ?? "their quarrel"}.`,
        involves: [judge, other],
      });
    }
    return out;
  },
};

const heads = (town: Town, hh: string) => town.children(hh, "person");
const householdOf = (town: Town, person: string) => town.parentOf(person)!;
const childrenOf = (town: Town, person: string) =>
  town.edges({ to: person, kind: "kin" }).filter((e) => ["son", "daughter"].includes(e.facts?.rel as string)).map((e) => e.from);
const money = (d: number) => (d >= 240 ? `£${Math.round(d / 24) / 10}` : d >= 12 ? `${Math.round(d / 12)}s` : `${d}d`);

export const paidInFull: Sifter = {
  id: "paid-in-full",
  title: "Paid in full",
  source: "DESIGN §9 (debt and courtship)",
  match(town) {
    const out: SifterMatch[] = [];
    for (const d of town.edges({ kind: "debtor_of" })) {
      const a = childrenOf(town, d.from), b = childrenOf(town, d.to);
      for (const kind of ["courting", "betrothed"]) for (const c of town.edges({ kind })) {
        const pair = [c.from, c.to];
        const x = pair.find((p) => a.includes(p)), y = pair.find((p) => b.includes(p));
        if (!x || !y) continue;
        out.push({
          title: this.title,
          summary: `${town.label(d.from)} owes ${town.label(d.to)} ${money(d.facts?.amount as number)} for ${d.facts?.reason}. ` +
            `${town.label(x)} and ${town.label(y)} are ${kind === "betrothed" ? "to be married" : "courting"}, and both fathers have done the arithmetic.`,
          involves: [d.from, d.to, x, y],
        });
      }
    }
    return out;
  },
};

export const owedOnTheBench: Sifter = {
  id: "owed-on-the-bench",
  title: "Owed on the bench",
  source: "LF pp.72-75 (councils hear local disputes)",
  match(town) {
    const c = councilOf(town);
    if (!c) return [];
    const seats = new Set((c.get<{ person: string }[]>("seats") ?? []).map((s) => s.person));
    const out: SifterMatch[] = [];
    for (const item of c.get<{ matter: string; parties: string[] }[]>("docket") ?? []) {
      for (const party of item.parties) {
        for (const d of town.edges({ from: party, kind: "debtor_of" })) {
          if (!seats.has(d.to) || (d.facts?.amount as number) < 60) continue;
          out.push({
            title: this.title,
            summary: `${town.label(party)} comes before the council over ${item.matter.replace(/ \(.*\)$/, "")}, and owes ${town.label(d.to)}, who sits on it, ${money(d.facts?.amount as number)}.` +
              (d.knownBy === "public" ? "" : " The rest of the council doesn't know about the debt."),
            involves: [party, d.to],
          });
        }
      }
    }
    return out;
  },
};

export const jumpedUp: Sifter = {
  id: "jumped-up",
  title: "Jumped up",
  source: "LF pp.58-60 (the showpiece room; resentment of climbers)",
  match(town) {
    const out: SifterMatch[] = [];
    for (const b of town.children(town.root, "building")) for (const h of town.children(b.address, "household")) {
      const room = h.get<string | null>("living.display");
      if (!room) continue;
      const head = heads(town, h.address)[0];
      if (!head) continue;
      const rivals = town.edges({ touching: head.address, kind: "rival" }).map((e) => (e.from === head.address ? e.to : e.from));
      // Envious neighbours count too.
      const at = centroid(b.get<Poly>("poly"));
      for (const ob of town.children(town.root, "building")) {
        if (ob === b || dist(centroid(ob.get<Poly>("poly")), at) > 70) continue;
        for (const oh of town.children(ob.address, "household")) {
          const oHead = heads(town, oh.address)[0];
          if (oHead && oHead.get<string[]>("traits").includes("envious") && !rivals.includes(oHead.address)) rivals.push(oHead.address);
        }
      }
      if (!rivals.length) continue;
      out.push({
        title: this.title,
        summary: `${town.label(h.address)} has ${room.replace(/^one room/, "a room")}. ${list(rivals.map((r) => town.label(r)))} can't stand it.`,
        involves: [head.address, ...rivals],
      });
    }
    return out;
  },
};

export const drinkingTheBreadMoney: Sifter = {
  id: "bread-money",
  title: "Drinking the bread money",
  source: "mundane",
  match(town) {
    const out: SifterMatch[] = [];
    for (const d of town.edges({ kind: "debtor_of" })) {
      if (d.facts?.reason !== "the ale slate" || (d.facts?.amount as number) < 18) continue;
      const hh = householdOf(town, d.from);
      const small = heads(town, hh).filter((p) => p.get<number>("age") < 10);
      if (!small.length) continue;
      out.push({
        title: this.title,
        summary: `${town.label(d.from)} has ${money(d.facts?.amount as number)} on the slate at the alehouse, and ${small.length} small ${small.length > 1 ? "children" : "child"} at home. ${d.knownBy === "public" ? "Everyone knows." : "The family doesn't know yet."}`,
        involves: [d.from, d.to],
      });
    }
    return out;
  },
};

export const whatTheNeighboursDontKnow: Sifter = {
  id: "neighbours-dont-know",
  title: "What the neighbours don't know",
  source: "mundane",
  match(town) {
    return town.edges({ kind: "lover" }).map((e) => {
      const spouses = [e.from, e.to].flatMap((p) => town.edges({ touching: p, kind: "spouse" }).map((s) => (s.from === p ? s.to : s.from)));
      return {
        title: this.title,
        summary: `${town.label(e.from)} and ${town.label(e.to)} are lovers. ${spouses.length ? `${list(spouses.map((s) => town.label(s)))} ${spouses.length > 1 ? "have" : "has"} no idea.` : ""}`,
        involves: [e.from, e.to, ...spouses],
      };
    });
  },
};

export const goneWithTheTinkers: Sifter = {
  id: "gone-with-the-tinkers",
  title: "Gone with the tinkers",
  source: "LF p.77 (tinkers come back later to steal)",
  match(town) {
    const date = town.clock.date, y = parseDate(date).y, j = jdn(parseDate(date));
    const all = [...visitsIn(town, y - 1), ...visitsIn(town, y), ...visitsIn(town, y + 1)];
    const out: SifterMatch[] = [];
    for (const t of all.filter((v) => v.kind === "thefts")) {
      const ago = j - jdn(parseDate(t.start));
      if (ago < 0 || ago > 90) continue;
      const tinkers = all.find((v) => v.kind === "tinkers" && v.start === t.after)!;
      const next = all.find((v) => v.kind === "tinkers" && v.start > date);
      out.push({
        title: this.title,
        summary: `${ago} days ago, ${t.note}. It started after ${tinkers.who} passed through on ${describeDate(tinkers.start, date)}.` +
          (next ? ` Tinkers are due again around ${describeDate(next.start, date)}${next.who === tinkers.who ? ", the same family" : ""}.` : ""),
        involves: [],
      });
    }
    return out;
  },
};

export const sameBandTooSoon: Sifter = {
  id: "same-band-too-soon",
  title: "Same band, too soon",
  source: "LF p.77 (the same band no more than once in five years)",
  match(town) {
    const date = town.clock.date, y = parseDate(date).y, j = jdn(parseDate(date));
    return [...visitsIn(town, y), ...visitsIn(town, y + 1)]
      .filter((v) => v.kind === "band" && v.tooSoon && Math.abs(jdn(parseDate(v.start)) - j) <= 120)
      .map((v) => ({
        title: this.title,
        summary: `${v.who} ${v.start >= date ? "are expected" : "came"} ${describeDate(v.start, date)}, only ${parseDate(v.start).y - v.tooSoon!.last} years after their last visit. Someone remembers what happened then.`,
        involves: [],
      }));
  },
};

export const waitingForTheSheriffsMan: Sifter = {
  id: "waiting-for-the-sheriffs-man",
  title: "Waiting for the sheriff's man",
  source: "LF p.75 (bigger matters wait for the visiting officer)",
  match(town) {
    const c = councilOf(town);
    if (!c) return [];
    const date = town.clock.date, y = parseDate(date).y;
    const next = [...visitsIn(town, y), ...visitsIn(town, y + 1)].find((v) => v.kind === "tax" && v.start >= date);
    if (!next) return [];
    return (c.get<{ matter: string; parties: string[]; waits?: boolean }[]>("docket") ?? []).filter((d) => d.waits).map((d) => ({
      title: this.title,
      summary: `${d.matter[0].toUpperCase()}${d.matter.slice(1)}: ${list(d.parties.map((p) => town.label(p)))} must wait for ${next.who}, due ${describeDate(next.start, date)}. Until then they live next to each other.`,
      involves: d.parties,
    }));
  },
};

function list(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

export const sifters: Module = {
  id: "sifters-hamlet",
  version: "1.0.0",
  requires: ["core", "council", "society", "visitors"],
  register(add) {
    add("sifters", [thumbOnTheScale, judgeInOwnCause, paidInFull, owedOnTheBench, jumpedUp, drinkingTheBreadMoney, whatTheNeighboursDontKnow, goneWithTheTinkers, sameBandTooSoon, waitingForTheSheriffsMan]);
  },
};

const MAX_PER_SIFTER = 2;

export function findHooks(town: Town): (SifterMatch & { sifter: string })[] {
  town.society();
  const out: (SifterMatch & { sifter: string })[] = [];
  for (const s of town.registry<Sifter>("sifters").list()) {
    // A couple of each at most: a hamlet with eight debt hooks reads like a ledger.
    for (const m of s.match(town).slice(0, MAX_PER_SIFTER)) out.push({ ...m, summary: m.summary[0].toUpperCase() + m.summary.slice(1), sifter: s.id });
  }
  return out;
}
