import { poss } from "../../core/text";
import { addDays, describeDate, easter } from "../../core/calendar";
import { data } from "../../core/content";
import type { Entity, Town } from "../../core/town";
import type { EdgeKind, Module, PanelRow, Sifter } from "../../core/types";
import { buildingsOfUse, isStreetPlan, nearestBuilding, type MapData } from "../layout";
import { centroid, dist, type Poly } from "../layout/geom";
import religionYaml from "./content/religion.yaml";

// The religious hierarchy in towns (LF p.85): seats from shrine to cathedral,
// parishes, tithes running up the chain, and a clergy who answer only to
// their own court (LF p.88).

interface Seat { id: string; label: string; clergy: string; supports: string; tithes: string }
interface ReligionData { seats: Seat[]; saints: string[]; friars: string[]; hospital: string[]; lazar: string[]; misdeeds: string[]; grudges: string[]; feasts: Record<string, string> }
const content = data<ReligionData>(religionYaml);

/** The saint a church is dedicated to, if it has one. */
export function patronOf(town: Town, church: string): string | undefined {
  const b = town.find(church);
  if (!b || b.type !== "building") return undefined;
  return town.settlement().get<Record<number, string> | undefined>("dedications")?.[(b as Entity).generated<number>("planIndex")];
}

/** The date of a church's patronal feast in a year ("MM-DD" resolved), if its saint has one. */
export function patronalDate(town: Town, church: string, year: number): string | undefined {
  const saint = patronOf(town, church);
  const md = saint ? content.feasts[saint] : undefined;
  if (!md) return undefined;
  if (md === "trinity") return addDays(easter(year), 56);
  return `${year}-${md}`;
}

const patronalMemo = new WeakMap<Town, Map<number, Map<string, string[]>>>();
/** The parish churches keeping their patron's feast on a date. */
export function patronalOn(town: Town, date: string): string[] {
  const y = Number(date.slice(0, 4));
  let byYear = patronalMemo.get(town);
  if (!byYear) patronalMemo.set(town, (byYear = new Map()));
  let m = byYear.get(y);
  if (!m) {
    byYear.set(y, (m = new Map()));
    if (isStreetPlan(town)) for (const b of town.children(town.root, "building")) {
      if (!PARISH.includes(b.get<string>("use"))) continue;
      const d = patronalDate(town, b.address, y);
      if (d) { const l = m.get(d); if (l) l.push(b.address); else m.set(d, [b.address]); }
    }
  }
  return m.get(date) ?? [];
}

export const WORSHIP = ["grand_temple", "temple", "fane", "chapel", "chantry", "shrine", "friary", "priory", "cell", "nunnery", "hospital", "lazar_house"];
const PARISH = ["grand_temple", "temple", "fane"];
const SEE = "see";

/** A worship building's name, e.g. "St Mary's" or "the Grey Friars". */
function dedicationName(use: string, d: string): string {
  const possd = d === "All Saints" || d === "Holy Trinity" ? d : poss(d);
  switch (use) {
    case "grand_temple": return `the Cathedral of ${d}`;
    case "temple": return `${possd} Minster`;
    case "fane": return `${possd}`;
    case "chapel": return `${possd} chapel`;
    case "chantry": return `the ${d} chantry`;
    case "shrine": return `the shrine of ${d}`;
    case "friary": return d;
    case "priory": return `${possd} Priory`;
    case "cell": return `${possd} Cell`;
    case "nunnery": return `the nunnery of ${d}`;
    case "hospital": return `the Hospital of ${d}`;
    case "lazar_house": return `${possd} lazar house`;
  }
  return d;
}

function worshipHeads(town: Town): { b: Entity; head: Entity; use: string }[] {
  const out: { b: Entity; head: Entity; use: string }[] = [];
  for (const b of town.children(town.root, "building")) {
    const use = b.get<string>("use");
    if (!WORSHIP.includes(use)) continue;
    const h = town.children(b.address, "household")[0];
    const head = h && town.children(h.address, "person")[0];
    if (head) out.push({ b, head, use });
  }
  return out;
}

export const religion: Module = {
  id: "religion",
  version: "2.0.0",
  requires: ["core", "uses", "layout", "households", "names"],
  register(add) {
    add<EdgeKind>("edgeKinds", [{ id: "tithes_to", label: "pays tithes to", inverse: "receives tithes from" }]);
    add<Sifter>("sifters", [benefitOfClergy, titheUpTheChain]);
  },
  hooks: {
    onSettlementGenerated(ctx, s) {
      if (!isStreetPlan(ctx.town)) return;
      const plan = s.get<string[]>("plan");
      ctx.gen(s, "dedications", (r) => {
        const saints = r.shuffle(content.saints);
        const friars = r.shuffle(content.friars);
        let k = 0, fk = 0;
        const out: Record<number, string> = {};
        plan.forEach((u, i) => {
          if (!WORSHIP.includes(u)) return;
          if (u === "friary") out[i] = friars[fk++ % friars.length];
          else if (u === "hospital") out[i] = r.pick(content.hospital);
          else if (u === "lazar_house") out[i] = r.pick(content.lazar);
          else out[i] = saints[k++ % saints.length];
        });
        return out;
      });
      // Without a cathedral of its own, the town answers to one elsewhere.
      if (!plan.includes("grand_temple")) {
        const place = ctx.registry<{ id: string; place(r: import("../../core/rng").Rng): string }>("nameProviders").get("anglo-norman");
        ctx.gen(s, "see", (r) => place.place(r));
        ctx.create("institution", s.address, SEE, { kind: "see" });
      }
    },

    onHouseholdResolved(ctx, h) {
      if (!isStreetPlan(ctx.town)) return;
      const b = ctx.town.parentOf(h.address)!;
      const map = ctx.town.settlement().get<MapData>("map");
      if (map.plan === "river") {
        // A river town: the nearest parish church on your own side of the water. Over the bridge,
        // an old village or the abbey's tenants keep their own church, however small.
        const bankOf = (a: string) => map.wards?.[ctx.town.get(a).get<number>("ward")]?.bank;
        const mine = bankOf(b);
        const uses = mine === "far" && (map.farBank === "village" || map.farBank === "abbey") ? [...PARISH, "chapel"] : PARISH;
        const at = centroid(ctx.town.get(b).get<Poly>("poly"));
        let best: string | undefined, bd = Infinity;
        for (const x of buildingsOfUse(ctx.town, uses)) {
          if (bankOf(x.a) !== mine) continue;
          const d = dist(at, x.p);
          if (d < bd) { bd = d; best = x.a; }
        }
        ctx.set(h, "parish", best ?? nearestBuilding(ctx.town, b, PARISH) ?? null);
        return;
      }
      // Everyone belongs to the nearest parish church.
      ctx.set(h, "parish", nearestBuilding(ctx.town, b, PARISH) ?? null);
    },

    onSocietyResolved(ctx, s) {
      const town = ctx.town;
      if (!isStreetPlan(town)) return;
      const seats = worshipHeads(town);
      if (!seats.length) return;
      const r = ctx.rng(s, "tithes");
      const at = (x: { b: Entity }) => x.b.address;
      const cathedral = seats.find((x) => x.use === "grand_temple");
      const see = cathedral?.head.address ?? `${town.root}/institution:${SEE}`;
      const nearestOf = (from: Entity, uses: string[]) => {
        const a = nearestBuilding(town, from.address, uses);
        return seats.find((x) => at(x) === a);
      };
      for (const x of seats) {
        let up: string | undefined;
        if (x.use === "grand_temple") continue;
        if (x.use === "temple" || x.use === "priory" || x.use === "cell" || x.use === "nunnery" || x.use === "friary") up = see;
        else if (x.use === "chantry") up = (nearestOf(x.b, ["priory", "cell", "friary", "nunnery"]) ?? nearestOf(x.b, ["temple"]))?.head.address ?? see;
        else if (x.use === "shrine") up = (nearestOf(x.b, ["temple"]) ?? nearestOf(x.b, ["friary"]))?.head.address ?? see;
        else up = nearestOf(x.b, ["temple"])?.head.address ?? see;
        if (!up || up === x.head.address) continue;
        ctx.edge({ from: x.head.address, to: up, kind: "tithes_to", weight: 0.1, facts: { share: x.use === "hospital" || x.use === "lazar_house" ? "a token rent" : "a tenth" } });
        // Grievance runs up the same chain.
        if (x.use === "fane" && r.chance(0.3)) {
          ctx.edge({ from: x.head.address, to: up, kind: "grievance", weight: -0.4, facts: { about: r.pick(content.grudges) }, knownBy: r.chance(0.5) ? "public" : [x.head.address] });
        }
      }
      // One of the clergy has done something a lay court may not touch (LF p.88).
      const clergy: Entity[] = [];
      for (const x of seats) for (const p of town.children(town.parentOf(x.head.address)!, "person")) {
        if ((p.get("role") === "head" || p.get("role") === "cleric") && p.get<number>("age") >= 20 && p.get("sex") === "m") clergy.push(p);
      }
      if (clergy.length && r.chance(0.7)) {
        const cleric = r.pick(clergy);
        const victims: Entity[] = [];
        for (const b of town.children(town.root, "building")) {
          if (WORSHIP.includes(b.get("use"))) continue;
          const head = town.children(b.address, "household")[0];
          const p = head && town.children(head.address, "person")[0];
          if (p) victims.push(p);
        }
        if (victims.length) {
          const v = r.pick(victims);
          const deed = r.pick(content.misdeeds);
          ctx.set(town.get(cleric.address), "religion.misdeed", deed);
          ctx.edge({ from: v.address, to: cleric.address, kind: "grievance", weight: -0.8, facts: { about: deed, clerical: true }, knownBy: r.chance(0.5) ? "public" : [v.address, cleric.address] });
        }
      }
    },
  },
  label(town, e) {
    if (e.type === "institution" && e.get("kind") === SEE) return `the Cathedral at ${town.settlement().get<string>("see")}`;
    if (e.type !== "building") return undefined;
    const use = e.get<string>("use");
    if (!WORSHIP.includes(use)) return undefined;
    const d = town.settlement().get<Record<number, string> | undefined>("dedications")?.[(e as Entity).generated<number>("planIndex")];
    if (!d) return undefined;
    const n = dedicationName(use, d);
    return n[0].toUpperCase() + n.slice(1);
  },
  panels: [
    {
      id: "seat",
      title: "Church",
      for: "building",
      order: 1,
      rows(town, b) {
        const use = b.get<string>("use");
        if (!WORSHIP.includes(use) || !isStreetPlan(town)) return [];
        const seat = content.seats.find((x) => x.id === use);
        const h = town.children(b.address, "household")[0];
        const head = h && town.children(h.address, "person")[0];
        const rows: PanelRow[] = [];
        if (seat) rows.push({ label: "Seat", value: `${seat.label}: ${seat.clergy}`, hint: `supported by a congregation of ${seat.supports}` });
        if (h) {
          const clergy = town.children(h.address, "person").filter((p) => p.get("role") === "cleric").length;
          if (clergy) rows.push({ label: "Clergy", value: `${clergy + 1} in all, living in` });
        }
        const pd = patronalDate(town, b.address, Number(town.clock.date.slice(0, 4)));
        if (pd) rows.push({ label: "Patronal feast", value: `${poss(patronOf(town, b.address)!)} day, ${describeDate(pd)}: a procession round the parish, and a church-ale after` });
        // A parish church, or a chapel over a river town's bridge that its people use as one.
        if (PARISH.includes(use) || use === "chapel") {
          let n = 0, hh = 0;
          for (const x of town.children(town.root, "building")) for (const y of town.children(x.address, "household")) {
            if (y.get("parish") === b.address) { hh++; n += y.get<number>("size") ?? 0; }
          }
          if (PARISH.includes(use) || hh) rows.push({ label: "Parish", value: `${hh} households, ${n} souls` });
        }
        if (head) {
          for (const e of town.edges({ from: head.address, kind: "tithes_to" })) rows.push({ label: "Tithes to", value: [{ text: town.label(e.to), address: e.to }, ` (${e.facts?.share})`] });
          const from = town.edges({ to: head.address, kind: "tithes_to" });
          if (from.length) rows.push({ label: "Receives from", value: from.flatMap((e, i) => [...(i ? [", "] : []), { text: town.label(town.parentOf(town.parentOf(e.from)!)!), address: town.parentOf(town.parentOf(e.from)!)! }]) });
        }
        return rows;
      },
    },
    {
      id: "see",
      title: "The see",
      for: "institution",
      order: 0,
      rows(town, inst) {
        if (inst.get("kind") !== SEE) return [];
        const from = town.edges({ to: inst.address, kind: "tithes_to" });
        return [
          { label: "Where", value: `${town.settlement().get<string>("see")}, a day or two away` },
          { label: "Receives from", value: from.map((e, i) => [...(i ? [", "] : []), { text: town.label(town.parentOf(town.parentOf(e.from)!)!), address: town.parentOf(town.parentOf(e.from)!)! }]).flat() },
          { label: "Its court", value: "the bishop's consistory court tries any cleric, for any offence (LF p.88)" },
        ];
      },
    },
  ],
};

export const benefitOfClergy: Sifter = {
  id: "benefit-of-clergy",
  title: "Benefit of clergy",
  source: "LF p.88 (clergy answer only to the clerical court)",
  match(town) {
    const out = [];
    for (const e of town.edges({ kind: "grievance" })) {
      if (!e.facts?.clerical) continue;
      const secret = e.knownBy !== "public";
      out.push({
        title: this.title,
        summary: `${town.label(e.to)} ${e.facts.about}. ${town.label(e.from)} wants justice, but no court in ${town.label(town.root)} may try a cleric: only the bishop's court can, and it is in no hurry.` +
          (secret ? " So far only the two of them know." : ""),
        involves: [e.to, e.from],
      });
    }
    return out;
  },
};

export const titheUpTheChain: Sifter = {
  id: "tithe-up-the-chain",
  title: "A tenth of too little",
  source: "LF p.85 (tithes run up the hierarchy)",
  match(town) {
    const out = [];
    for (const e of town.edges({ kind: "grievance" })) {
      if (!town.edges({ from: e.from, to: e.to, kind: "tithes_to" }).length) continue;
      out.push({
        title: this.title,
        summary: `${town.label(e.from)} pays a tithe up to ${town.label(e.to)} and resents ${e.facts?.about ?? "it"}.`,
        involves: [e.from, e.to],
      });
    }
    return out;
  },
};
