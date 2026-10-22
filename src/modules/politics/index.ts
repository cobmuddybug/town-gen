// Town politics: who runs the place, who wants to, and over what. Two
// factions (the great merchants and the crafts, as in most English towns of
// the time), a quarrel that divides them, the yearly choosing of officers at
// Michaelmas, and the officers who can be leaned on. Our own; LF p.86 for the
// offices themselves.
import { formatDate, parseDate } from "../../core/calendar";
import type { Address } from "../../core/address";
import type { Town } from "../../core/town";
import type { Module, PanelRow, Sifter } from "../../core/types";
import { isUrban } from "../core";
import { lsd } from "../households";
import type { MapData } from "../layout";

const ISSUES = [
  "a new murage, a tax for mending the wall, which falls hardest on the shops",
  "the lord's tolls at the bridge, which the merchants want bought out and the crafts can't afford",
  "the merchant guild's hold on selling cloth by retail, which the weavers and tailors want broken",
  "the market moved to a new day to suit the merchants' fairs, against the stallholders",
  "who pays for the bridge after the floods",
  "the charter: the merchants want to buy it from the lord, and the crafts fear what it will cost",
  "a stranger merchant let in to trade without paying the town's dues",
  "the common pasture outside the gate, which a rich man has begun to hedge in",
];
// A river town quarrels across its bridge as well.
const RIVER_ISSUES = [
  "the bridge toll the far bank pays to come to market, which its people call robbery",
  "who mends the bridge, the borough or the far bank, now the piers are cracked",
];
// With an abbey over the water, the abbot is the town's oldest grievance: it comes up three times as often.
const ABBEY_ISSUES = ["the abbot's mill over the river, where the town's bakers must grind and pay his multure"];
// Each kind of town has its own old quarrel, which comes up as often as the abbot's.
const FORM_ISSUES: Record<string, string[]> = {
  castle: [
    "castle-guard: the constable of the castle calls on the burgesses to stand watch on its walls, and they say their charter frees them",
    "the garrison's men drinking in the town on credit, and the constable's court that hears the town's complaints",
  ],
  abbey: [
    "the abbot's market tolls: every stall before the abbey gate pays the abbey, and the townsmen want a market of their own",
    "the abbey's court, which tries the town's quarrels and keeps the fines",
  ],
  harbour: [
    "harbour dues: who keeps the quay in repair, and who pockets what the ships pay to tie up at it",
    "a wreck on the rocks below the headland, and whether its cargo is the lord's, the finders' or the drowned men's kin's",
  ],
  street: [
    "the stalls that crowd the street on market days until a cart can't pass, and the shopkeepers whose doors they block",
    "the street's middle row of shambles and booths, which the lord lets out and the town wants pulled down",
  ],
  crossroads: [
    "the carriers who use the crossroads and won't pay to mend its roads",
    "which road the new market cross faces, and so which street's shops get the trade",
  ],
};

interface Faction { name: string; leader?: Address; members: Address[]; stands: string }
export interface Politics { factions: Faction[]; issue: string; election: string; holder?: Address; office?: string; bribable: { who: Address; office: string; owes: number }[] }

export const politics: Module = {
  id: "politics",
  version: "1.0.0",
  requires: ["core", "civic", "guilds", "society"],
  register(add) {
    add<Sifter>("sifters", [theElection]);
  },
  hooks: {
    onSocietyResolved(ctx, s) {
      const town = ctx.town;
      if (!isUrban(town)) return;
      const T = town.find(`${s.address}/institution:town`);
      if (!T) return;
      const r = ctx.rng(s, "politics");
      // The merchants follow the merchant guild's alderman; the crafts the
      // richest master of a craft guild.
      const offices = town.edges({ kind: "office_in" });
      const merchants = offices.find((e) => e.facts?.office === "alderman of the guild")?.from;
      const crafts = offices.filter((e) => e.facts?.office === "master of the guild").map((e) => e.from)
        .sort((a, b) => wealth(town, b) - wealth(town, a) || (a < b ? -1 : 1))[0];
      const holder = offices.find((e) => e.facts?.office === "mayor" || e.facts?.office === "the lord's bailiff of the town")?.from;
      const memberOf = (g: string) => town.edges({ kind: "member_of" }).filter((e) => e.to.endsWith(`guild-${g}`)).map((e) => e.from);
      const crafty = town.edges({ kind: "member_of" }).filter((e) => !e.to.endsWith("guild-merchants") && e.facts?.as === "master").map((e) => e.from);
      ctx.set(T, "politics.factions", [
        { name: "the merchants", leader: merchants, members: memberOf("merchants").slice(0, 60), stands: "low tolls, the town's charter, and the merchant guild's rights" },
        { name: "the crafts", leader: crafts, members: crafty.slice(0, 60), stands: "fair dues, open markets, and a voice on the council for the guilds" },
      ]);
      const map = town.settlement().get<MapData>("map");
      const own = FORM_ISSUES[map.plan ?? ""] ?? [];
      const pool = map.farBank
        ? [...ISSUES, ...RIVER_ISSUES, ...(map.farBank === "abbey" ? [...ABBEY_ISSUES, ...ABBEY_ISSUES, ...ABBEY_ISSUES] : [])]
        : [...ISSUES, ...own, ...own, ...own];
      ctx.set(T, "politics.issue", r.pick(pool));
      // Officers who owe money are officers who can be leaned on.
      const bribable: { who: Address; office: string; owes: number }[] = [];
      for (const e of offices) {
        if (!/institution:(town|watch|justice)$/.test(e.to)) continue;
        const owes = town.edges({ from: e.from, kind: "debtor_of" }).reduce((n, d) => n + ((d.facts?.amount as number) ?? 0), 0);
        if (owes >= 60) bribable.push({ who: e.from, office: String(e.facts?.office), owes });
      }
      ctx.set(T, "politics.bribable", bribable.slice(0, 8));
      if (holder) ctx.set(T, "politics.holder", holder);
    },
  },
  panels: [
    {
      id: "politics",
      title: "Politics",
      for: "institution",
      order: 0.5,
      rows(town, i) {
        const factions = i.get<Faction[] | undefined>("politics.factions");
        if (!factions) return [];
        const rows: PanelRow[] = [];
        const y = parseDate(town.clock.date).y;
        const next = town.clock.date <= `${y}-09-29` ? `${y}-09-29` : `${y + 1}-09-29`;
        rows.push({ label: "Chosen", value: `every Michaelmas, by the burgesses; next on ${formatDate(parseDate(next))}` });
        const holder = i.get<Address | undefined>("politics.holder");
        if (holder) rows.push({ label: "Holds the chair", value: [{ text: town.label(holder), address: holder }] });
        for (const f of factions) rows.push({ label: f.name, value: f.leader ? [{ text: town.label(f.leader), address: f.leader }, `, for ${f.stands}; ${f.members.length} masters behind them`] : `${f.stands}; ${f.members.length} behind them` });
        rows.push({ label: "The quarrel", value: i.get<string>("politics.issue") });
        for (const b of i.get<{ who: Address; office: string; owes: number }[]>("politics.bribable") ?? []) rows.push({ label: "Can be leaned on", value: [{ text: town.label(b.who), address: b.who }, `, ${b.office}, who owes ${lsd(b.owes)}`] });
        return rows;
      },
    },
  ],
};

function wealth(town: Town, p: Address): number {
  const hh = town.find(town.parentOf(p) ?? "");
  return hh?.type === "household" ? (hh.get<number>("income") ?? 0) + (hh.get<number>("savings") ?? 0) / 4 : 0;
}

export const theElection: Sifter = {
  id: "the-election",
  title: "Michaelmas",
  source: "LF p.86 (the town's officers); our own",
  match(town) {
    const T = town.find(`${town.root}/institution:town`);
    const f = T?.get<Faction[] | undefined>("politics.factions");
    if (!T || !f || !f[0].leader || !f[1].leader) return [];
    const issue = T.get<string>("politics.issue");
    const bribable = T.get<{ who: Address }[]>("politics.bribable") ?? [];
    return [{
      title: this.title,
      summary: `At Michaelmas the burgesses choose their officers, and this year it turns on ${issue}. ${town.label(f[0].leader)} leads ${f[0].name}; ${town.label(f[1].leader)} leads ${f[1].name}. ${bribable.length ? `${bribable.length} of the town's officers are in debt, and votes are for sale.` : "It will be close."}`,
      involves: [f[0].leader, f[1].leader, ...bribable.map((b) => b.who)].slice(0, 8),
    }];
  },
};
