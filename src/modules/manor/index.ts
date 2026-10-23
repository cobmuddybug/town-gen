import { poss } from "../../core/text";
import { addDays, easter, formatDate } from "../../core/calendar";
import type { Rng } from "../../core/rng";
import type { Entity, Town } from "../../core/town";
import type { EdgeKind, EntityLike, Module, PanelRow, Sifter, SifterMatch } from "../../core/types";
import { lsd } from "../households";
import type { NameProvider } from "../names";
import type { Visit, VisitSource } from "../visitors";

// The manorial village (LF pp.77-78). The lord owns the land, the buildings
// and, legally, the villeins. Management runs lord -> steward -> regarder ->
// bailiff (visiting) -> reeve (resident), and every link is a chance to skim.
// Villeins owe one day's labour in seven and may not leave; some have bought
// their freedom and pay cash rent instead; a socman rents large tracts and
// sublets them.

export const MANOR = "manor";

export type Status = "villein" | "cottar" | "free" | "commuted" | "socman" | "lord's servant" | "lord's miller" | "clergy";

const STATUS_TEXT: Record<Status, string> = {
  villein: "villein: bound to the land",
  cottar: "cottar: a villein with a cottage and a croft, little more",
  free: "free tenant",
  commuted: "bought their freedom; pays rent in money now",
  socman: "socman: rents from the lord and sublets",
  "lord's servant": "the lord's servant",
  "lord's miller": "farms the lord's mill; everyone must grind there",
  clergy: "clergy, under the church's law",
};

const FARMERS = new Set(["large_tenant_farmer", "tenant_farmer", "small_farmer", "shepherd", "cowherd", "fisherman", "miner", "woodcutter"]);
const COTTAGERS = new Set(["labourer", "ploughman", "herdsman", "widow_spinster", "charcoal_burner", "carder"]);
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const SKIMS = {
  steward: "keeps two sets of accounts for the lord's manors",
  regarder: "takes a fee to look away from timber felled without leave",
  bailiff: "sells the lord's surplus hay and pockets the difference",
  reeve: "lets his friends off their week-work for a consideration",
};

/** Whether the town was built as a manor (the New town dialog's lordship). */
export const isManorial = (town: Town) => town.settings.lordship === "manorial";
const manorOf = (town: Town) => town.find(`${town.root}/institution:${MANOR}`);

function officials(town: Town): Record<string, Entity | undefined> {
  const m = manorOf(town);
  if (!m) return {};
  const out: Record<string, Entity | undefined> = {};
  for (const p of town.children(m.address, "person")) out[p.get<string>("occupation")] = p;
  const reeve = m.get<string | undefined>("reeve");
  if (reeve) out.reeve = town.get(reeve);
  return out;
}

function lordStyle(town: Town, lord: EntityLike): string {
  const kind = lord.get<string>("lordKind");
  const seat = lord.get<string>("seat");
  if (kind === "royal") return "the King";
  if (kind === "ecclesiastical") return `the Abbot of ${seat}`;
  void town;
  return `Sir ${lord.get<string>("given")} of ${seat}`;
}

function manorVisits(town: Town, year: number): Visit[] {
  if (!isManorial(town)) return [];
  const o = officials(town);
  const r = town.rngFor(town.root, manor, `visits:${year}`);
  const out: Visit[] = [];
  const bailiff = o.bailiff ? town.label(o.bailiff.address) : "the bailiff";
  const steward = o.steward ? town.label(o.steward.address) : "the steward";
  // The bailiff rides round the lord's manors, here every three weeks or so.
  for (let d = r.int(0, 20); d < 365; d += r.int(18, 25)) {
    out.push({ kind: "bailiff", start: addDays(formatDate({ y: year, m: 1, d: 1 }), d), days: 1, who: `${bailiff}, the bailiff`, note: "checks the reeve's tallies and sees the demesne worked" });
  }
  // The manor court, twice a year: after Easter and after Michaelmas.
  out.push({ kind: "manor_court", start: addDays(easter(year), r.int(14, 28)), days: 1, who: `${steward}, the steward`, note: "holds the manor court in the lord's hall: fines, heriots, holdings changing hands" });
  out.push({ kind: "manor_court", start: addDays(`${year}-10-05`, r.int(0, 14)), days: 1, who: `${steward}, the steward`, note: "holds the Michaelmas court, and audits the reeve's account" });
  return out;
}

const manorSource: VisitSource = {
  id: "manor",
  label: { bailiff: "Bailiff", manor_court: "Manor court" },
  visits: manorVisits,
};

function heads(town: Town): { head: Entity; h: Entity }[] {
  const out: { head: Entity; h: Entity }[] = [];
  for (const b of town.children(town.root, "building")) for (const h of town.children(b.address, "household")) {
    const head = town.children(h.address, "person")[0];
    if (head) out.push({ head, h });
  }
  return out;
}

// ---- sifters -------------------------------------------------------------

const boughtFreedom: Sifter = {
  id: "bought-freedom",
  title: "Bought freedom",
  source: "LF p.77 (villeins buying their freedom; reeves skimming labour)",
  match(town) {
    if (!isManorial(town)) return [];
    const reeve = manorOf(town)?.get<string>("reeve");
    if (!reeve) return [];
    return town.edges({ from: reeve, kind: "grievance" }).filter((e) => e.facts?.why === "commuted").map((e) => {
      const hh = town.get(town.parentOf(e.to)!);
      return {
        title: "Bought freedom",
        summary: `${poss(town.label(e.to))} family bought their freedom ${hh.get("manor.freedAgo")} years ago and now pay ${lsd(hh.get<number>("manor.rent"))} a year instead of working the demesne. ${town.label(reeve)}, the reeve, used to count on their labour, and on what he could squeeze from it.`,
        involves: [e.to, reeve],
      };
    });
  },
};

const socmanSqueeze: Sifter = {
  id: "socman-squeeze",
  title: "The socman squeeze",
  source: "LF p.78 (the socman as middleman)",
  match(town) {
    if (!isManorial(town)) return [];
    const out: SifterMatch[] = [];
    const lord = officials(town).lord;
    for (const { head, h } of heads(town)) {
      if (h.get("occupation") !== "socman") continue;
      const behind = town.edges({ to: head.address, kind: "debtor_of" }).filter((d) => d.facts?.reason === "rent arrears to the socman");
      const owes = lord ? town.edges({ from: head.address, to: lord.address, kind: "debtor_of" })[0] : undefined;
      if (!behind.length || !owes) continue;
      out.push({
        title: this.title,
        summary: `${town.label(head.address)} rents from ${town.label(lord!.address)} and sublets to ${behind.length} ${behind.length > 1 ? "households that are" : "household that is"} behind with the rent (${behind.map((b) => town.label(b.from)).join(", ")}). ${head.get("sex") === "f" ? "She" : "He"} owes the lord ${lsd(owes.facts?.amount as number)} ${head.get("sex") === "f" ? "herself" : "himself"}, due at ${owes.facts?.due}. Someone is going to be squeezed.`,
        involves: [head.address, ...behind.map((b) => b.from)],
      });
    }
    return out;
  },
};

const leavingTheLand: Sifter = {
  id: "leaving-the-land",
  title: "Leaving the land",
  source: "LF p.77 (villeins who leave are criminals under the lord's justice)",
  match(town) {
    if (!isManorial(town)) return [];
    const out: SifterMatch[] = [];
    for (const { h } of heads(town)) for (const p of town.children(h.address, "person")) {
      const fled = p.get<{ weeks: number; to: string } | undefined>("manor.fled");
      if (!fled) continue;
      const lord = officials(town).lord;
      out.push({
        title: this.title,
        summary: `${town.label(p.address)}, a villein's son, has been gone ${fled.weeks} weeks. ${lord ? `${poss(town.label(lord.address))}` : "The lord's"} steward wants him back. In ${fled.to}, a master has taken on a new apprentice who won't say where he's from.`,
        involves: [p.address, town.children(h.address, "person")[0].address],
      });
    }
    return out;
  },
};

const skimmingTheChain: Sifter = {
  id: "skimming-the-chain",
  title: "Everybody's skimming",
  source: "LF p.77 (each link in the chain is an opportunity)",
  match(town) {
    if (!isManorial(town)) return [];
    const skims = town.edges({ kind: "skims" });
    if (skims.length < 2) return [];
    return [{
      title: this.title,
      summary: skims.map((e) => `${town.label(e.from)}, the ${e.facts?.office}, ${e.facts?.how}`).join("; ") + ". Each could ruin the others, and none can afford to.",
      involves: skims.map((e) => e.from),
    }];
  },
};

// ---- the module ------------------------------------------------------------

export const manor: Module = {
  id: "manor",
  version: "1.0.0",
  requires: ["core", "uses", "households", "names", "people", "council", "society", "visitors"],
  register(add) {
    add<EdgeKind>("edgeKinds", [
      { id: "answers_to", label: "answers to", inverse: "over" },
      { id: "skims", label: "skims from", inverse: "is skimmed by" },
    ]);
    add("visitSources", [manorSource]);
    add("sifters", [boughtFreedom, socmanSqueeze, leavingTheLand, skimmingTheChain]);
  },
  hooks: {
    onSettlementGenerated(ctx, s) {
      if (!isManorial(ctx.town)) return;
      ctx.create("institution", s.address, MANOR, { kind: "manor" });
    },

    onInstitutionResolved(ctx, inst) {
      if (inst.get("kind") !== "manor") return;
      const town = ctx.town;
      const r = ctx.rng(inst, "officers");
      const names = ctx.registry<NameProvider>("nameProviders").get("anglo-norman");
      const lordKind = ctx.gen(inst, "lordKind", (rr) => rr.weighted(["noble", "ecclesiastical", "royal"], (k) => ({ noble: 5, ecclesiastical: 3, royal: 1 })[k]!)) as string;
      ctx.create("person", inst.address, "lord", { role: "lord", sex: "m", age: r.int(28, 66), occupation: "lord", lordKind, seat: names.place(r) });
      ctx.create("person", inst.address, "steward", { role: "official", sex: "m", age: r.int(35, 60), occupation: "steward" });
      ctx.create("person", inst.address, "regarder", { role: "official", sex: "m", age: r.int(30, 60), occupation: "regarder" });
      ctx.create("person", inst.address, "bailiff", { role: "official", sex: "m", age: r.int(28, 55), occupation: "bailiff" });

      // The reeve: a villein of substance, chosen by the vill (and approved by the lord).
      const villeins = heads(town).filter(({ head, h }) => h.get("manor.status") === "villein" && head.get("sex") === "m");
      const reeve = villeins.length ? r.weighted(villeins, ({ h }) => 1 + h.get<number>("stake")).head.address : undefined;
      if (reeve) ctx.set(inst, "reeve", reeve);

      const chain = [reeve, `${inst.address}/person:bailiff`, `${inst.address}/person:regarder`, `${inst.address}/person:steward`, `${inst.address}/person:lord`].filter(Boolean) as string[];
      for (let i = 0; i + 1 < chain.length; i++) ctx.edge({ from: chain[i], to: chain[i + 1], kind: "answers_to", weight: 0 });
      if (reeve) ctx.edge({ from: reeve, to: inst.address, kind: "office_in", weight: 0.3, facts: { office: "reeve" } });
      const roles: [string, keyof typeof SKIMS][] = [[`${inst.address}/person:steward`, "steward"], [`${inst.address}/person:regarder`, "regarder"], [`${inst.address}/person:bailiff`, "bailiff"]];
      if (reeve) roles.push([reeve, "reeve"]);
      const lordAddr = `${inst.address}/person:lord`;
      for (const [who, office] of roles) {
        if (r.chance(0.35)) ctx.edge({ from: who, to: lordAddr, kind: "skims", weight: -0.5, facts: { how: SKIMS[office], office }, knownBy: [who] });
      }
    },

    onHouseholdResolved(ctx, h) {
      if (!isManorial(ctx.town)) return;
      const occ = h.get<string>("occupation");
      const status = ctx.gen(h, "manor.status", (r) => statusFor(r, occ)) as Status;
      if (status === "villein") ctx.gen(h, "manor.labourDay", (r) => r.int(1, 6));
      if (status === "cottar") ctx.set(h, "manor.labourDay", 1); // the "Monday men"
      if (status === "commuted") {
        // Stored as years before the present, so moving the clock never changes it.
        ctx.gen(h, "manor.freedAgo", (r) => r.int(1, 25));
        ctx.gen(h, "manor.rent", (r) => Math.round(h.get<number>("income") * r.range(0.1, 0.18)));
      }
    },

    onSocietyResolved(ctx, s) {
      const town = ctx.town;
      if (!isManorial(town)) return;
      const m = manorOf(town);
      if (!m) return;
      const lord = `${m.address}/person:lord`;
      const reeve = m.get<string | undefined>("reeve");
      const r = ctx.rng(s, "manor-society");
      const all = heads(town);

      // Freed tenants pay the lord in money. The reeve misses their labour.
      for (const { head, h } of all) {
        if (h.get("manor.status") !== "commuted") continue;
        ctx.edge({ from: head.address, to: lord, kind: "tenant_of", weight: 0, facts: { rent: h.get("manor.rent") } });
        if (reeve && reeve !== head.address && r.chance(0.35)) {
          ctx.edge({ from: reeve, to: head.address, kind: "grievance", weight: -0.4, facts: { about: "the labour the manor no longer gets from them", why: "commuted" } });
        }
      }

      // The socman rents from the lord and sublets to free tenants.
      const socman = all.find(({ h }) => h.get("occupation") === "socman");
      if (socman) {
        ctx.edge({ from: socman.head.address, to: lord, kind: "tenant_of", weight: 0, facts: { holds: `${socman.h.get("land")} acres` } });
        const pool = all.filter(({ h }) => ["free", "commuted"].includes(h.get("manor.status")) && h !== socman.h);
        for (const t of r.shuffle(pool).slice(0, r.int(3, 6))) {
          ctx.edge({ from: t.head.address, to: socman.head.address, kind: "tenant_of", weight: -0.1 });
          if (r.chance(0.4)) {
            const amount = Math.round(t.h.get<number>("income") * r.range(0.05, 0.2));
            ctx.edge({ from: t.head.address, to: socman.head.address, kind: "debtor_of", weight: amount, facts: { amount, reason: "rent arrears to the socman" } });
          }
        }
        if (r.chance(0.55)) {
          const amount = Math.round(socman.h.get<number>("income") * r.range(0.2, 0.6));
          ctx.edge({ from: socman.head.address, to: lord, kind: "debtor_of", weight: amount, facts: { amount, reason: "the half-year's rent", due: r.pick(["Lady Day", "Michaelmas"]) }, knownBy: [socman.head.address, `${m.address}/person:steward`] });
        }
      }

      // Sometimes a villein's son has run off, which makes him a criminal (LF p.77).
      if (r.chance(0.55)) {
        const sons: Entity[] = [];
        for (const { h } of all) {
          if (h.get("manor.status") !== "villein" && h.get("manor.status") !== "cottar") continue;
          for (const p of town.children(h.address, "person")) if (p.get("role") === "child" && p.get("sex") === "m" && p.get<number>("age") >= 15 && p.get<number>("age") <= 25) sons.push(p);
        }
        if (sons.length) {
          const names = ctx.registry<NameProvider>("nameProviders").get("anglo-norman");
          ctx.set(r.pick(sons), "manor.fled", { weeks: r.int(2, 30), to: `the town of ${names.place(r)}` });
        }
      }
    },
  },
  label(town, e) {
    if (e.type === "institution" && e.get("kind") === "manor") return "The manor";
    if (e.type === "person" && e.get("role") === "lord") return lordStyle(town, e);
    if (e.type === "household" && e.get("occupation") === "hall_keeper") return undefined;
    return undefined;
  },
  panels: [
    {
      id: "manor",
      title: "The manor",
      for: "institution",
      order: 0,
      rows(town, inst) {
        if (inst.get("kind") !== "manor") return [];
        const o = officials(town);
        const link = (e: Entity | undefined, what: string): PanelRow => ({ label: what, value: e ? [{ text: town.label(e.address), address: e.address }] : "—" });
        const counts = new Map<string, number>();
        for (const { h } of heads(town)) counts.set(h.get("manor.status"), (counts.get(h.get("manor.status")) ?? 0) + 1);
        const kind = inst.get<string>("lordKind");
        return [
          { label: "Lord", value: [{ text: town.label(o.lord!.address), address: o.lord!.address }, kind === "royal" ? " (a royal manor, run through the sheriff)" : kind === "ecclesiastical" ? " (a church manor)" : ""], key: "lordKind", options: ["noble", "ecclesiastical", "royal"] },
          link(o.steward, "Steward"), link(o.regarder, "Regarder"), link(o.bailiff, "Bailiff"), link(o.reeve, "Reeve"),
          { label: "Owed", value: "week-work one day in seven; boon-work at harvest; heriot when a holder dies; merchet when a daughter marries" },
          { label: "Households", value: [...counts].map(([k, n]) => `${n} ${k}`).join(", ") },
        ];
      },
    },
    {
      id: "manor-status",
      title: "Under the lord",
      for: "household",
      order: 2,
      rows(town, h) {
        if (!isManorial(town)) return [];
        const status = h.get<Status>("manor.status");
        const rows: PanelRow[] = [{ label: "Status", value: STATUS_TEXT[status] ?? status, key: "manor.status", options: Object.keys(STATUS_TEXT) }];
        const day = h.get<number | undefined>("manor.labourDay");
        if (day) rows.push({ label: "Week-work", value: `${WEEKDAY[day]}s on the lord's demesne${status === "villein" ? ", and boon days at harvest" : ""}` });
        if (status === "commuted") rows.push({ label: "Freed", value: `in ${Number(town.clock.date.slice(0, 4)) - h.get<number>("manor.freedAgo")}; pays ${lsd(h.get<number>("manor.rent"))} a year` });
        return rows;
      },
    },
  ],
};

function statusFor(r: Rng, occ: string): Status {
  if (occ === "hall_keeper") return "lord's servant";
  if (occ === "socman") return "socman";
  if (occ === "miller") return "lord's miller";
  if (occ === "chaplain" || occ === "shrine_keeper") return "clergy";
  if (FARMERS.has(occ)) return r.weighted(["villein", "commuted", "free"] as Status[], (s) => ({ villein: 70, commuted: 15, free: 15 } as Record<string, number>)[s]);
  if (COTTAGERS.has(occ)) return r.chance(0.8) ? "cottar" : "free";
  return r.chance(0.65) ? "free" : "villein";
}
