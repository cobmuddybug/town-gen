import { data } from "../../core/content";
import type { Rng } from "../../core/rng";
import type { Entity, Town } from "../../core/town";
import type { Era, Module, PanelLink, PanelRow, Sifter } from "../../core/types";
import type { Tier } from "../core";
import { lsd } from "../households";
import { isStreetPlan, VALUE_CLASSES, wardId, type MapData } from "../layout";
import { centroid, dist, type Poly, type Pt } from "../layout/geom";
import civicYaml from "./content/civic.yaml";

// Towns govern, police and judge themselves (LF pp.85-104): wards and gates
// with names, a mayor and aldermen (or the lord's bailiff), the watch by
// night and the marshal by day, criers, and a ladder of courts. Offices are
// held by people who already live here, chosen in the society phase.

interface CivicData {
  compass: Record<string, string>;
  gates: string[];
  inner: string[];
  water: Record<Era, string>;
  fire: Record<Era, string>;
  literacy: Record<Era, [number, number]>;
  petty: string[];
  felonies: string[];
}
const content = data<CivicData>(civicYaml);

export const TOWN = "town";
export const WATCH = "watch";
export const JUSTICE = "justice";

const urbanOf = (town: Town) => /town|city/.test(town.settlement().get<string>("sizeClass"));

interface Head { p: Entity; h: Entity; b: Entity; rank: number; ward: number; quarter: number; occ: string; age: number; male: boolean; wealth: number }

function gatherHeads(town: Town): Head[] {
  const tiers = town.registry<Tier>("tiers");
  const map = town.settlement().get<MapData>("map");
  const out: Head[] = [];
  for (const b of town.children(town.root, "building")) {
    const ward = b.get<number>("ward") ?? 0;
    for (const h of town.children(b.address, "household")) {
      const p = town.children(h.address, "person")[0];
      if (!p) continue;
      out.push({
        p, h, b, rank: tiers.find(h.get("tier"))?.rank ?? 3, ward, quarter: map.wards?.[ward]?.quarter ?? 0, occ: h.get("occupation"),
        age: p.get("age"), male: p.get("sex") === "m", wealth: h.get<number>("income") + h.get<number>("savings") * 0.25,
      });
    }
  }
  return out;
}

export const civic: Module = {
  id: "civic",
  version: "1.0.0",
  requires: ["core", "uses", "layout", "households", "names", "people", "society", "religion"],
  register(add) {
    add<Sifter>("sifters", [whoWatchesTheWatch, townAirMakesFree, interestedBench]);
  },
  hooks: {
    onSettlementGenerated(ctx, s) {
      const town = ctx.town;
      if (!isStreetPlan(town)) return;
      const map = s.get<MapData>("map");
      const wards = map.wards ?? [];
      const urban = urbanOf(town);
      const plan = s.get<string[]>("plan");
      const dedications = s.get<Record<number, string> | undefined>("dedications") ?? {};

      // Gates take their names from the way they face, then from the old list.
      const gateNames = ctx.gen(s, "gateNames", (r) => {
        const used = new Set<string>();
        const spare = r.shuffle(content.gates);
        return (map.wall?.gates ?? []).map((g) => {
          let n = `${content.compass[compassOf(g.p)]}gate`;
          if (used.has(n)) n = spare.shift() ?? `${n} Postern`;
          used.add(n);
          return n;
        });
      }) as string[];

      // Which church stands in which ward, for "St Mary's Ward".
      const churchIn = new Map<number, string>();
      for (const a of town.peek(town.root)!.children) {
        const b = town.peek(a)!;
        if (b.type !== "building") continue;
        const d = dedications[b.generated<number>("planIndex")];
        const use = plan[b.generated<number>("planIndex")];
        if (d && (use === "fane" || use === "temple" || use === "grand_temple") && !churchIn.has(b.generated<number>("ward"))) churchIn.set(b.generated<number>("ward"), d);
      }

      const names = ctx.gen(s, "wardNames", (r) => {
        const used = new Set<string>();
        const inner = r.shuffle(content.inner);
        const gateFor = (w: (typeof wards)[number]) => {
          const gs = map.wall?.gates ?? [];
          let best = -1, bd = Infinity;
          gs.forEach((g, i) => { const d = dist(g.p, w.centre); if (d < bd) { bd = d; best = i; } });
          return best >= 0 ? gateNames[best] : undefined;
        };
        const out: string[] = [];
        for (const w of wards) {
          const cw = content.compass[w.compass] ?? "North";
          const cands: string[] = [];
          if (!urban) {
            // Villages have Ends, not wards.
            if (w.kind === "suburb") cands.push(`${cw} Town End`, `Over ${cw} End`, `Far ${cw} End`);
            else if (w.ring === 0) cands.push(w.near.includes("market") ? "Market End" : `${cw} End`, churchIn.has(w.id) ? "Church End" : `${cw} End`, `Cross End`, `Green End`);
            else cands.push(churchIn.has(w.id) ? "Church End" : w.near.includes("river") ? "Mill End" : `${cw} End`, `${cw} End`, `Far ${cw} End`, `Nether ${cw} End`);
            cands.push("Brook End", "Bridge End", "Town End", "Lane End", "Pound End", "Moor End", "Hill End", "Wood End", "Green End", "Cross End", "Upper End", "Lower End");
          } else if (w.kind === "suburb") {
            const g = gateFor(w);
            cands.push(g ? `Without ${g}` : `${cw} suburb`, `Beyond ${g ?? cw}`);
          } else if (w.ring === 0) {
            if (w.near.includes("castle")) cands.push("Castle Ward");
            if (w.near.includes("quay")) cands.push("Quay Ward");
            cands.push(`${cw} ${inner[out.length % inner.length]}`, `${cw}cheap`);
          } else {
            if (w.near.includes("castle")) cands.push("Castle Ward");
            const ch = churchIn.get(w.id);
            const g = gateFor(w);
            const chWard = ch && (ch === "All Saints" || ch === "Holy Trinity" ? `${ch} Ward` : `${ch}'s Ward`);
            if (chWard && r.chance(0.5)) cands.push(chWard);
            if (g) cands.push(`${g} Ward`);
            if (w.near.includes("bridge")) cands.push("Bridge Ward");
            if (w.near.includes("quay")) cands.push("Strand Ward");
            if (chWard) cands.push(chWard);
            cands.push(`${cw} Ward`, `Upper ${cw} Ward`, `Nether ${cw} Ward`);
          }
          let n = cands.find((c) => !used.has(c)) ?? (urban ? `${cands[0]} ${out.length}` : `${["First", "Second", "Third", "Fourth", "Fifth"][out.length % 5]} ${cw} End`);
          if (used.has(n)) n = `${n} (${out.length})`;
          used.add(n);
          out.push(n);
        }
        return out;
      }) as string[];
      wards.forEach((_w, i) => {
        const e = town.peek(`${s.address}/ward:${wardId(i)}`);
        if (e) ctx.set(e, "name", names[i]);
      });

      // The town's services.
      ctx.gen(s, "water", () => content.water[ctx.era]);
      ctx.gen(s, "fire", () => content.fire[ctx.era]);
      ctx.gen(s, "literacy", (r) => {
        const [lo, hi] = content.literacy[ctx.era];
        return Math.round(r.range(lo, hi) * (urban ? 1 : 0.6));
      });
      ctx.gen(s, "marketDays", (r) => {
        const days = r.shuffle(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
        return urban ? days.slice(0, 2).sort((a, b) => order(a) - order(b)) : days.slice(0, 1);
      });
      if (!urban) return;
      ctx.gen(s, "government", (r) => (s.get("charter") === "chartered" || r.chance(0.3) ? "mayor" : "bailiff"));
      ctx.create("institution", s.address, TOWN, { kind: TOWN });
      ctx.create("institution", s.address, WATCH, { kind: WATCH });
      ctx.create("institution", s.address, JUSTICE, { kind: JUSTICE });
    },

    onSocietyResolved(ctx, s) {
      const town = ctx.town;
      if (!isStreetPlan(town) || !urbanOf(town)) return;
      const map = s.get<MapData>("map");
      const wards = map.wards ?? [];
      const all = gatherHeads(town);
      const taken = new Set<string>();
      const r = ctx.rng(s, "offices");
      const T = `${s.address}/institution:${TOWN}`, W = `${s.address}/institution:${WATCH}`, J = `${s.address}/institution:${JUSTICE}`;
      const office = (x: Head, inst: string, name: string, facts: Record<string, unknown> = {}) => {
        taken.add(x.p.address);
        ctx.edge({ from: x.p.address, to: inst, kind: "office_in", weight: 0.4, facts: { office: name, ...facts } });
      };
      const choose = (pool: Head[], weight: (x: Head) => number): Head | undefined => {
        const c = pool.filter((x) => !taken.has(x.p.address) && weight(x) > 0);
        return c.length ? r.weighted(c, weight) : undefined;
      };
      const quarterName = (q: number) => {
        const ws = wards.filter((w) => w.kind === "intramural" && w.quarter === q);
        if (!ws.length) return `quarter ${q + 1}`;
        const c: Pt = [ws.reduce((a, w) => a + w.centre[0], 0) / ws.length, ws.reduce((a, w) => a + w.centre[1], 0) / ws.length];
        return `${QUARTER[compassOf(c)] ?? "north"} quarter`;
      };
      const quarters = s.get<number>("quarters") ?? 1;
      const qNames = Array.from({ length: quarters }, (_, q) => quarterName(q));
      // Two quarters can face the same way; tell them apart.
      qNames.forEach((n, q) => { if (qNames.indexOf(n) !== q) qNames[q] = `${n} (${q + 1})`; });
      ctx.set(town.get(W), "quarterNames", qNames);
      const male = (lo: number, hi: number) => (x: Head) => x.male && x.age >= lo && x.age <= hi;

      // Government (LF p.86): a mayor and aldermen in a chartered town; the lord's bailiff otherwise.
      const byWealth = (x: Head) => x.wealth;
      if (s.get("government") === "mayor") {
        const m = choose(all, (x) => (male(35, 75)(x) && x.rank >= 7 ? byWealth(x) : 0));
        if (m) office(m, T, "mayor");
        for (const w of wards) {
          if (w.kind !== "intramural") continue;
          const a = choose(all, (x) => (x.ward === w.id && male(30, 78)(x) && x.rank >= 6 ? byWealth(x) ** 1.5 : 0));
          if (a) office(a, T, "alderman", { ward: w.id });
        }
        for (const w of wards) {
          if (w.kind !== "intramural") continue;
          for (let k = 0; k < 2; k++) {
            const c = choose(all, (x) => (x.ward === w.id && male(28, 70)(x) && x.rank >= 5 && x.rank <= 7 ? 1 : 0));
            if (c) office(c, T, "common councilman", { ward: w.id });
          }
        }
      } else {
        const b = choose(all, (x) => (male(30, 65)(x) && x.rank >= 7 ? byWealth(x) : 0));
        if (b) office(b, T, "the lord's bailiff of the town");
        const pr = choose(all, (x) => (male(30, 70)(x) && x.rank >= 6 && x.rank <= 7 ? 1 : 0));
        if (pr) office(pr, T, "portreeve");
        for (let k = 0; k < 8; k++) {
          const c = choose(all, (x) => (male(30, 75)(x) && x.rank >= 6 ? byWealth(x) : 0));
          if (c) office(c, T, "burgess of the portmoot");
        }
      }
      const clerk = choose(all, (x) => (["scrivener", "notary", "clerk"].includes(x.occ) ? 1 : 0));
      if (clerk) office(clerk, T, "town clerk");
      const chamberlain = choose(all, (x) => (x.occ === "merchant" && x.male ? byWealth(x) : 0));
      if (chamberlain) office(chamberlain, T, "chamberlain, keeper of the town's purse");
      const recorder = choose(all, (x) => (x.occ === "lawyer" ? 1 : 0));
      if (recorder) office(recorder, T, "recorder");

      // Day policing (LF p.86): a marshal and deputies for the whole town,
      // a constable for each quarter, a beadle for each ward.
      const tough = (x: Head) => 1 + (x.p.get<string[]>("traits") ?? []).filter((t) => ["quarrelsome", "stern", "proud", "hardworking"].includes(t)).length * 2;
      const marshal = choose(all, (x) => (male(28, 55)(x) && x.rank >= 5 && x.rank <= 7 ? tough(x) : 0));
      if (marshal) office(marshal, T, "marshal");
      for (let k = 0, n = r.int(3, 5); k < n; k++) {
        const d = choose(all, (x) => (male(20, 45)(x) && x.rank >= 4 && x.rank <= 6 ? tough(x) : 0));
        if (d) office(d, T, "deputy marshal");
      }
      for (let q = 0; q < quarters; q++) {
        const c = choose(all, (x) => (x.quarter === q && map.wards?.[x.ward]?.kind === "intramural" && male(25, 60)(x) && x.rank >= 5 && x.rank <= 7 ? tough(x) : 0));
        if (c) office(c, T, "constable", { quarter: q });
      }
      for (const w of wards) {
        if (w.kind !== "intramural") continue;
        const b = choose(all, (x) => (x.ward === w.id && male(22, 60)(x) && x.rank >= 4 && x.rank <= 5 ? 1 : 0));
        if (b) office(b, T, "beadle", { ward: w.id });
      }

      // The watch (LF p.86): sergeants at the watch houses, about six paid
      // officers a quarter, and every able man in turn.
      for (const x of all) if (x.occ === "watch_sergeant") office(x, W, "sergeant of the watch", { quarter: x.quarter });
      for (let q = 0; q < quarters; q++) for (let k = 0; k < 6; k++) {
        const o = choose(all, (x) => (x.quarter === q && male(20, 50)(x) && x.rank >= 3 && x.rank <= 5 ? tough(x) : 0));
        if (o) office(o, W, "officer of the watch", { quarter: q });
      }
      // Gate guards: paid, at the gates by day and on the walls by night.
      const gateNames = s.get<string[]>("gateNames") ?? [];
      gateNames.forEach((_g, gi) => {
        for (let k = 0, n = r.int(2, 3); k < n; k++) {
          const o = choose(all, (x) => (male(18, 45)(x) && x.rank >= 3 && x.rank <= 4 ? 1 : 0));
          if (o) office(o, W, "gate guard", { gate: gi });
        }
      });
      // Criers: about one for every 5,000 people.
      for (let k = 0, n = Math.max(1, Math.round(s.get<number>("targetPop") / 5000)); k < n; k++) {
        const c = choose(all, (x) => (male(25, 60)(x) && x.rank >= 3 && x.rank <= 5 ? 1 : 0));
        if (c) office(c, T, "town crier");
      }

      // Justice (LF pp.86-89): justices of the peace for petty matters, a
      // magistrate for felonies and civil suits, the clergy's own court.
      for (let k = 0, n = Math.max(1, Math.round(s.get<number>("targetPop") / 7000)); k < n; k++) {
        const j = choose(all, (x) => (male(35, 75)(x) && x.rank === 7 ? 1 : 0));
        if (j) office(j, J, "justice of the peace");
      }
      const mag = choose(all, (x) => (male(35, 75)(x) && x.rank >= 8 ? (x.occ === "lawyer" ? 6 : 1) : 0));
      if (mag) office(mag, J, "magistrate");

      // The docket.
      const docket: { court: string; matter: string; parties: string[] }[] = [];
      const debts = town.edges({ kind: "debtor_of" }).filter((e) => (e.facts?.amount as number) >= 200);
      for (const e of r.shuffle(debts).slice(0, 2)) {
        docket.push({ court: "magistrate", matter: `a suit for ${lsd(e.facts!.amount as number)} owed, for ${e.facts?.reason ?? "a debt"}`, parties: [e.to, e.from] });
      }
      const rogues = all.filter((x) => ["cutpurse", "vagrant", "pauper"].includes(x.occ));
      for (let k = 0, n = r.int(1, 2); k < n; k++) {
        const accuser = r.pick(all);
        const accused = rogues.length ? r.pick(rogues) : r.pick(all);
        if (accuser !== accused) docket.push({ court: "magistrate", matter: r.pick(content.felonies), parties: [accuser.p.address, accused.p.address] });
      }
      // Town air makes free: a runaway villein, here less than a year and a day.
      const runaway = r.chance(0.4) ? choose(all, (x) => (["journeyman", "labourer", "porter"].includes(x.occ) && male(18, 35)(x) ? 1 : 0)) : undefined;
      if (runaway) {
        const months = r.int(3, 11);
        ctx.set(runaway.h, "civic.fledVillein", { months, lord: r.pick(["a knight", "an abbey", "a baron"]) });
        docket.push({ court: "magistrate", matter: `leaving villeinage: his lord's bailiff claims him back; he has been here ${months} months`, parties: [runaway.p.address] });
      }
      const taverns = all.filter((x) => ["tavern_keeper", "alehouse_keeper", "alewife", "innkeeper"].includes(x.occ));
      for (let k = 0, n = r.int(2, 3); k < n; k++) {
        const x = r.pick(all);
        const near = all.filter((y) => y !== x && dist(centroid(y.b.get<Poly>("poly")), centroid(x.b.get<Poly>("poly"))) < 80);
        const y = near.length ? r.pick(near) : r.pick(all);
        const tv = taverns.length ? town.label(r.pick(taverns).b.address).replace(/^The /, "the ") : "a tavern";
        const matter = r.pick(content.petty).replace("{tavern}", tv).replace("{house}", town.label(y.b.address).replace(/^The /, "the "));
        docket.push({ court: "justice of the peace", matter, parties: [x.p.address, y.p.address] });
      }
      ctx.set(town.get(J), "docket", docket);
    },
  },
  label(town, e) {
    if (e.type === "ward") return e.get<string>("name");
    if (e.type === "institution") {
      const k = e.get("kind");
      if (k === TOWN) return town.settlement().get("government") === "mayor" ? "The mayor and corporation" : "The town's officers";
      if (k === WATCH) return "The watch";
      if (k === JUSTICE) return "The courts";
      return undefined;
    }
    if (e.type !== "building" || !isStreetPlan(town)) return undefined;
    const use = e.get<string>("use");
    switch (use) {
      case "gatehouse": {
        const gates = town.settlement().get<MapData>("map").wall?.gates ?? [];
        const i = gates.findIndex((g) => g.road === e.get("road"));
        return town.settlement().get<string[]>("gateNames")?.[i] ?? "The gatehouse";
      }
      case "gaol": return "The gaol";
      case "guildhall": return "The Guildhall";
      case "market_hall": return "The market hall";
      case "courthouse": return "The court house";
      case "castle": return "The castle";
      case "school": return "The grammar school";
      case "watch_house": {
        const w = town.find(`${town.root}/ward:${wardId(e.get<number>("ward") ?? 0)}`);
        return w ? `The ${w.get<string>("name")} watch house` : "The watch house";
      }
    }
    return undefined;
  },
  panels: [
    {
      id: "town",
      title: "The town",
      for: "settlement",
      order: 0.5,
      rows(town, s) {
        if (!isStreetPlan(town)) return [];
        const urban = urbanOf(town);
        const rows: PanelRow[] = [];
        const wards = town.children(town.root, "ward");
        rows.push({ label: "Wards", value: wards.flatMap((w, i) => [...(i ? [", "] : []), { text: w.get<string>("name"), address: w.address }]) });
        const gates = s.get<string[]>("gateNames") ?? [];
        if (gates.length) rows.push({ label: "Gates", value: gates.join(", ") });
        rows.push({ label: "Market days", value: (s.get<string[]>("marketDays") ?? []).join(" and "), key: "marketDays", rerollable: true });
        if (urban) {
          for (const inst of [TOWN, WATCH, JUSTICE]) {
            const a = `${town.root}/institution:${inst}`;
            rows.push({ label: inst === TOWN ? "Governed by" : inst === WATCH ? "Kept by" : "Justice", value: { text: town.label(a), address: a } });
          }
        }
        rows.push({ label: "Water", value: s.get<string>("water") });
        rows.push({ label: "Fire", value: s.get<string>("fire") });
        rows.push({ label: "Refuse", value: urban ? "carted out weekly by the nightsoil men; the main streets swept by the rakers" : "middens behind the houses, carted to the fields" });
        const lit = wards.filter((w) => w.get<number>("valueClass") >= 5);
        if (lit.length) rows.push({ label: "After dark", value: [`householders must hang a lantern at the door in `, ...lit.flatMap((w, i) => [...(i ? [", "] : []), { text: w.get<string>("name"), address: w.address }]), "; elsewhere the streets are black"], hint: "LF Table 2:20" });
        const nSchools = (s.get<string[]>("plan") ?? []).filter((u) => u === "school").length;
        const parishes = (s.get<string[]>("plan") ?? []).filter((u) => u === "fane" || u === "temple").length;
        rows.push({ label: "Schools", value: `${nSchools ? `${nSchools} grammar school${nSchools > 1 ? "s" : ""}, ` : ""}${parishes} parish school${parishes === 1 ? "" : "s"} teaching letters and reckoning for four years; apprenticeship for most`, hint: "LF p.87" });
        rows.push({ label: "Can read", value: `about ${s.get<number>("literacy")} in 100`, key: "literacy", rerollable: true });
        if (urban) {
          let people = 0;
          for (const e of town.allEntities()) if (e.type === "person" && e.address.includes("/building:")) people++;
          rows.push({ label: "Counted", value: `${Math.round(people / 1.1)} on the rolls; about ${people} in truth`, hint: "the poorest are never counted (LF p.84)" });
        }
        return rows;
      },
    },
    {
      id: "ward",
      title: "Ward",
      for: "ward",
      order: 0,
      rows(town, w) {
        const rows: PanelRow[] = [];
        const idx = w.get<number>("index");
        const value = w.get<number>("valueClass");
        rows.push({ label: "Name", value: w.get<string>("name"), key: "name" });
        rows.push({ label: "Kind", value: w.get("kind") === "suburb" ? "a suburb outside the walls" : "within the walls" });
        rows.push({ label: "Value", value: VALUE_CLASSES[value], hint: "LF Table 2:20" });
        const quarterNames = town.find(`${town.root}/institution:${WATCH}`)?.get<string[]>("quarterNames");
        if (quarterNames) rows.push({ label: "Quarter", value: quarterNames[w.get<number>("quarter")] });
        let hh = 0, people = 0;
        const notable: PanelLink[] = [];
        for (const b of town.children(town.root, "building")) {
          if (b.get("ward") !== idx) continue;
          for (const h of town.children(b.address, "household")) { hh++; people += h.get<number>("size") ?? 0; }
          const use = b.get<string>("use");
          if (!["tenement", "poor_row", "journeyman_house", "townhouse", "cottage", "farmhouse", "empty"].includes(use) && notable.length < 24) {
            notable.push({ text: town.label(b.address), address: b.address });
          }
        }
        rows.push({ label: "Living here", value: `${hh} households, ${people} people` });
        if (notable.length) rows.push({ label: "Notable", value: notable.flatMap((n, i) => [...(i ? [", "] : []), n]) });
        for (const e of town.edges({ kind: "office_in" })) {
          if (e.facts?.ward !== idx) continue;
          rows.push({ label: String(e.facts.office), value: { text: town.label(e.from), address: e.from } });
        }
        for (const e of town.edges({ kind: "office_in" })) {
          if (e.facts?.office !== "constable" || e.facts.quarter !== w.get("quarter") || w.get("kind") !== "intramural") continue;
          rows.push({ label: "constable", value: [{ text: town.label(e.from), address: e.from }, " (for the whole quarter)"] });
        }
        if (value >= 5) rows.push({ label: "After dark", value: "a lantern at every door, by order" });
        else if (value <= 1) rows.push({ label: "After dark", value: "pitch black; the watch goes in pairs" });
        rows.push({ label: "Next to", value: (w.get<string[]>("adjacent") ?? []).flatMap((a, i) => [...(i ? [", "] : []), { text: town.label(a), address: a }]) });
        return rows;
      },
    },
    {
      id: "offices",
      title: "Offices",
      for: "institution",
      order: 0,
      rows(town, inst) {
        const k = inst.get("kind");
        if (k !== TOWN && k !== WATCH && k !== JUSTICE) return [];
        const rows: PanelRow[] = [];
        const qNames = town.find(`${town.root}/institution:${WATCH}`)?.get<string[]>("quarterNames") ?? [];
        const gates = town.settlement().get<string[]>("gateNames") ?? [];
        if (k === WATCH) rows.push({ label: "Hue and cry", value: "when it is raised, every able man must turn out armed and follow (LF p.86)" });
        const held = town.edges({ to: inst.address, kind: "office_in" });
        held.sort((a, b) => officeRank(a.facts?.office) - officeRank(b.facts?.office) || (a.facts?.quarter as number ?? 0) - (b.facts?.quarter as number ?? 0) || (a.facts?.ward as number ?? 0) - (b.facts?.ward as number ?? 0) || (a.id < b.id ? -1 : 1));
        for (const e of held) {
          const where = e.facts?.ward !== undefined ? `, ${town.label(`${town.root}/ward:${wardId(e.facts.ward as number)}`)}`
            : e.facts?.quarter !== undefined ? `, ${qNames[e.facts.quarter as number] ?? ""}` : e.facts?.gate !== undefined ? `, ${gates[e.facts.gate as number]}` : "";
          rows.push({ label: String(e.facts?.office), value: [{ text: town.label(e.from), address: e.from }, where] });
        }
        if (k === JUSTICE) {
          rows.push({ label: "Ladder", value: "justices of the peace for petty matters; the magistrate for felonies and suits; the king's justices at the assizes for the rest; clergy only before the bishop's court (LF pp.86-89)" });
          for (const d of inst.get<{ court: string; matter: string; parties: string[] }[]>("docket") ?? []) {
            rows.push({ label: `before the ${d.court}`, value: [d.matter + " — ", ...d.parties.flatMap((p, i) => [...(i ? [" against "] : []), { text: town.label(p), address: p }])] });
          }
        }
        return rows;
      },
    },
  ],
};

const QUARTER: Record<string, string> = { N: "north", NE: "north-east", E: "east", SE: "south-east", S: "south", SW: "south-west", W: "west", NW: "north-west" };
const OFFICE_ORDER = ["mayor", "the lord's bailiff of the town", "portreeve", "alderman", "common councilman", "burgess of the portmoot", "recorder", "town clerk",
  "chamberlain, keeper of the town's purse", "marshal", "deputy marshal", "constable", "beadle", "town crier", "sergeant of the watch", "officer of the watch",
  "gate guard", "magistrate", "justice of the peace"];
const officeRank = (o: unknown) => { const i = OFFICE_ORDER.indexOf(String(o)); return i < 0 ? 99 : i; };

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const order = (d: string) => DAYS.indexOf(d);

function compassOf(p: Pt): string {
  const v = p;
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1]) || 1;
  const x = v[0] / l, y = -v[1] / l; // screen y runs south
  const dirs: [string, number, number][] = [["E", 1, 0], ["NE", 0.707, 0.707], ["N", 0, 1], ["NW", -0.707, 0.707], ["W", -1, 0], ["SW", -0.707, -0.707], ["S", 0, -1], ["SE", 0.707, -0.707]];
  let best = "N", bd = -Infinity;
  for (const [n, dx, dy] of dirs) { const d = dx * x + dy * y; if (d > bd) { bd = d; best = n; } }
  return best;
}

// ---- hooks ---------------------------------------------------------------

export const whoWatchesTheWatch: Sifter = {
  id: "who-watches-the-watch",
  title: "Who watches the watch",
  source: "LF p.86 (the watch is volunteers and a few paid officers)",
  match(town) {
    const out = [];
    for (const e of town.edges({ kind: "office_in" })) {
      if (e.facts?.office !== "officer of the watch" && e.facts?.office !== "sergeant of the watch") continue;
      for (const d of town.edges({ from: e.from, kind: "debtor_of" })) {
        const creditor = town.get(town.parentOf(d.to)!);
        const occ = creditor.get<string>("occupation");
        if (!["tavern_keeper", "alehouse_keeper", "alewife", "cutpurse", "nightsoil_man", "fripperer"].includes(occ)) continue;
        out.push({
          title: this.title,
          summary: `${town.label(e.from)}, ${e.facts.office}, owes ${town.label(d.to)} ${lsd(d.facts?.amount as number)}. A man who owes the ${occ.replace(/_/g, " ")} can be asked to look the other way at night.`,
          involves: [e.from, d.to],
        });
      }
    }
    return out;
  },
};

export const townAirMakesFree: Sifter = {
  id: "town-air-makes-free",
  title: "A year and a day",
  source: "LF pp.77-78, 88 (leaving villeinage is a felony)",
  match(town) {
    const out = [];
    for (const e of town.allEntities()) {
      if (e.type !== "household") continue;
      const f = e.generated<{ months: number; lord: string } | undefined>("civic.fledVillein");
      if (!f) continue;
      const head = town.children(e.address, "person")[0];
      if (!head) continue;
      out.push({
        title: this.title,
        summary: `${town.label(head.address)} ran from ${f.lord}'s manor ${f.months} months ago. If he lasts a year and a day in ${town.label(town.root)} he is free; his lord's bailiff has found him first, and the case is before the magistrate.`,
        involves: [head.address],
      });
    }
    return out;
  },
};

export const interestedBench: Sifter = {
  id: "interested-bench",
  title: "An interested bench",
  source: "LF p.86 (the magistrate hears suits for debt)",
  match(town) {
    const out = [];
    const bench = town.edges({ kind: "office_in" }).filter((e) => e.facts?.office === "magistrate" || e.facts?.office === "justice of the peace" || e.facts?.office === "mayor");
    for (const b of bench) {
      for (const d of town.edges({ touching: b.from, kind: "debtor_of" })) {
        const other = d.from === b.from ? d.to : d.from;
        const owes = d.from === b.from;
        out.push({
          title: this.title,
          summary: `${town.label(b.from)}, ${b.facts?.office}, ${owes ? "owes" : "is owed"} ${lsd(d.facts?.amount as number)} ${owes ? "to" : "by"} ${town.label(other)}. Anyone in a suit against ${town.label(other)} should know it.`,
          involves: [b.from, other],
        });
      }
    }
    return out;
  },
};

export type { Rng };
