import type { Entity, Town } from "../../core/town";
import type { Module, PanelRow } from "../../core/types";
import type { Base } from "../core";
import { centroid, dist, type Poly } from "../layout/geom";

// Hamlet governance (LF pp.72-75): an elder and a small council, made of the
// biggest local holder, the trader, the tavern keeper and the wisest old
// person. The richest is usually the elder or the weightiest councillor.
// The council keeps stocks and hears petty matters plus the base's dispute.

export const COUNCIL = "council";

function heads(town: Town): { head: Entity; household: Entity; building: Entity }[] {
  const out: { head: Entity; household: Entity; building: Entity }[] = [];
  for (const b of town.children(town.root, "building")) {
    for (const h of town.children(b.address, "household")) {
      const head = town.children(h.address, "person")[0];
      if (head) out.push({ head, household: h, building: b });
    }
  }
  return out;
}

const wealth = (h: Entity) => h.get<number>("income") + h.get<number>("savings") * 0.25;

const BIG = [
  "a horse taken from the common in the night",
  "a fight at the alehouse that left a man's arm broken",
  "a will that two households both claim",
  "a barn that burned, and talk that it was set",
  "a sheep found butchered in a neighbour's outhouse",
];

const PETTY = [
  "a pig loose in a neighbour's garden",
  "words exchanged outside the alehouse",
  "a hen gone missing",
  "a broken hurdle and nobody owning to it",
  "a ditch left uncleared",
  "firewood taken from another's pile",
];

export const council: Module = {
  id: "council",
  version: "1.0.0",
  requires: ["core", "households", "people", "layout"],
  hooks: {
    onSettlementGenerated(ctx, s) {
      // Towns and cities govern themselves differently (see the civic module).
      if (/town|city/.test(s.get<string>("sizeClass"))) return;
      ctx.create("institution", s.address, COUNCIL, { kind: "council" });
    },

    onInstitutionResolved(ctx, inst) {
      if (inst.get("kind") !== "council") return;
      const town = ctx.town;
      const all = heads(town);
      if (!all.length) return;
      const byWealth = [...all].sort((a, b) => wealth(b.household) - wealth(a.household) || (a.head.address < b.head.address ? -1 : 1));
      const richest = byWealth[0];
      const base = ctx.registry<Base>("bases").get(town.settlement().get("base"));
      const holder = [...all].sort((a, b) => b.household.get<number>("stake") - a.household.get<number>("stake") || (a.head.address < b.head.address ? -1 : 1))[0];
      const trader = all.find((x) => x.building.get("use") === "trader");
      const tavern = all.find((x) => x.building.get("use") === "alehouse");

      // The wisest old person: anyone over 55, the "wise" first, else the oldest.
      const elders: Entity[] = [];
      for (const b of town.children(town.root, "building")) for (const h of town.children(b.address, "household")) {
        for (const p of town.children(h.address, "person")) if (p.get<number>("age") >= 55) elders.push(p);
      }
      elders.sort((a, b) => {
        const wa = a.get<string[]>("traits").includes("wise") ? 1 : 0, wb = b.get<string[]>("traits").includes("wise") ? 1 : 0;
        return wb - wa || b.get<number>("age") - a.get<number>("age") || (a.address < b.address ? -1 : 1);
      });

      const seats: { person: string; why: string }[] = [];
      const seat = (person: string | undefined, why: string) => {
        if (!person) return;
        const s = seats.find((x) => x.person === person);
        if (s) s.why += `; ${why}`;
        else seats.push({ person, why });
      };
      seat(holder.head.address, `holds the most ${base.stake === "acres" ? "land" : base.stake}`);
      seat(trader?.head.address, "keeps the trader's");
      seat(tavern?.head.address, "keeps the alehouse");
      seat(elders[0]?.address, "the wisest of the old folk");
      seat(richest.head.address, "the richest in the place");

      const elder = ctx.gen(inst, "elder", (r) => (r.chance(0.65) ? richest.head.address : seats[0].person)) as string;
      ctx.set(inst, "richest", richest.head.address);
      ctx.set(inst, "seats", seats);
      for (const s of seats) {
        ctx.edge({ from: s.person, to: inst.address, kind: s.person === elder ? "office_in" : "member_of", weight: 0.5, facts: s.person === elder ? { office: "elder" } : { why: s.why } });
      }

      // Grievances about the richest trade's measures.
      const r = ctx.rng(inst, "grievances");
      const richestTrade = all.find((x) => x.household.get("occupation") === town.settlement().get("richestTrade"));
      if (richestTrade) {
        for (const s of seats) {
          if (s.person === richestTrade.head.address) continue;
          if (r.chance(0.3)) {
            ctx.edge({
              from: s.person, to: richestTrade.head.address, kind: "grievance", weight: -0.5,
              facts: { about: base.grievance },
              knownBy: r.chance(0.5) ? "public" : [s.person],
            });
          }
        }
      }

      // The docket: the base's own dispute between neighbouring holdings, and petty matters.
      const farms = all.filter((x) => x.household.get<number>("stake") >= (base.stake === "acres" ? 5 : 1));
      const docket: { matter: string; parties: string[]; waits?: boolean }[] = [];
      if (farms.length >= 2) {
        const a = r.pick(farms);
        const ca = centroid(a.building.get<Poly>("poly"));
        const near = farms.filter((x) => x !== a).sort((x, y) => dist(centroid(x.building.get<Poly>("poly")), ca) - dist(centroid(y.building.get<Poly>("poly")), ca))[0];
        const matter = `${r.pick(base.disputes)} (${base.dispute})`;
        docket.push({ matter, parties: [a.head.address, near.head.address] });
        ctx.edge({ from: a.head.address, to: near.head.address, kind: "dispute", weight: -0.4, facts: { about: matter.replace(/ \(.*\)$/, "") } });
      }
      const nPetty = r.int(1, 2);
      for (let i = 0; i < nPetty; i++) {
        const x = r.pick(all), y = r.pick(all);
        if (x === y) continue;
        docket.push({ matter: r.pick(PETTY), parties: [x.head.address, y.head.address] });
      }
      // Anything bigger waits for the officer who comes round for the taxes (LF p.75).
      if (r.chance(0.45) && all.length >= 2) {
        const x = r.pick(all);
        const y = r.pick(all.filter((z) => z !== x));
        docket.push({ matter: r.pick(BIG), parties: [x.head.address, y.head.address], waits: true });
      }
      ctx.set(inst, "docket", docket);
      ctx.gen(inst, "stocks", (rr) => rr.pick(["on the green, newly mended", "on the green, rotten at one end", "by the alehouse door", "on the green, and used last at Lammas"]));
    },
  },
  label(_town, e) {
    return e.type === "institution" && e.get("kind") === "council" ? "The council" : undefined;
  },
  panels: [
    {
      id: "council",
      title: "Council",
      for: "institution",
      order: 0,
      rows(town, inst) {
        if (inst.get("kind") !== "council") return [];
        const seats = inst.get<{ person: string; why: string }[]>("seats") ?? [];
        const elder = inst.get<string>("elder");
        const rows: PanelRow[] = [];
        if (elder) rows.push({ label: "Elder", value: { text: town.label(elder), address: elder }, key: "elder", rerollable: true });
        for (const s of seats) if (s.person !== elder) rows.push({ label: "Councillor", value: [{ text: town.label(s.person), address: s.person }, ` — ${s.why}`] });
        rows.push({ label: "Stocks", value: inst.get<string>("stocks"), key: "stocks", rerollable: true });
        for (const d of inst.get<{ matter: string; parties: string[]; waits?: boolean }[]>("docket") ?? []) {
          rows.push({ label: d.waits ? "Waiting for the sheriff's man" : "Before them", value: [d.matter + " — ", ...d.parties.flatMap((p, i) => [...(i ? [" and "] : []), { text: town.label(p), address: p }])] });
        }
        return rows;
      },
    },
  ],
};
