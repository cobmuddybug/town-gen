import { beforeAll, describe, expect, test } from "vitest";
import { generate } from "../src/town-gen";
import type { Town } from "../src/core/town";
import { load, serialize, withEdit } from "../src/core/save";
import { defaultModules } from "../src/town-gen";
import { hashHex } from "../src/core/rng";
import { stableStringify } from "../src/core/town";
import type { MapData } from "../src/modules/layout";
import { centroid, convexOverlap, pointInPoly, type Poly } from "../src/modules/layout/geom";
import { whereabouts } from "../src/modules/routines";
import { findHooks } from "../src/modules/sifters";
import { visitsIn } from "../src/modules/visitors";

let town: Town, village: Town, market: Town, port: Town;
beforeAll(() => {
  town = generate("burgh-a", { pop: 8000 });
  village = generate("vill-a", { pop: 900 });
  market = generate("vill-a", { pop: 2000 });
  port = generate("port-a", { pop: 9000, base: "fishing" });
  for (const t of [town, village, market, port]) t.society();
}, 120000);

const map = (t: Town) => t.settlement().get<MapData>("map");
const buildings = (t: Town) => t.children(t.root, "building");
const people = (t: Town) => t.allEntities().filter((e) => e.type === "person" && e.address.includes("/building:"));
const offices = (t: Town, office: string) => t.edges({ kind: "office_in" }).filter((e) => e.facts?.office === office);

describe("street plans", () => {
  test("a town has walls, gates, wards and suburbs", () => {
    const m = map(town);
    expect(m.kind).toBe("town");
    const gates = m.wall!.gates.length;
    // Every gate has its gatehouse; a gatehouse with no road through the wall is a postern.
    expect(buildings(town).filter((b) => b.get("use") === "gatehouse" && b.get("road") !== "postern")).toHaveLength(gates);
    const wards = town.children(town.root, "ward");
    if (m.plan !== "radial" && m.plan !== "river") {
      // The other grown towns: a wall round the town, gates where its roads go through.
      expect(m.wall!.line.length).toBeGreaterThan(5);
      expect(gates).toBeGreaterThan(0);
      expect(wards.some((w) => w.get("kind") === "suburb")).toBe(true);
    } else if (m.plan === "river") {
      // A river town's wall runs bank to bank; the river closes it. Over the bridge is a suburb of its own.
      expect(m.wall!.closed).toBe(false);
      expect(m.wall!.line.length).toBeGreaterThan(5);
      expect(wards.some((w) => w.get("bank") === "far" && w.get("kind") === "suburb")).toBe(true);
    } else {
      expect(m.wall!.closed).toBe(true);
      expect(gates).toBe(town.settlement().get("mainRoads"));
      expect(wards.filter((w) => w.get("kind") === "suburb")).toHaveLength(gates);
    }
    // Adjacency goes both ways, and every building is in a ward.
    for (const w of wards) for (const a of w.get<string[]>("adjacent")) expect(town.get(a).get<string[]>("adjacent")).toContain(w.address);
    for (const b of buildings(town)) expect(b.get<number>("ward")).toBeLessThan(wards.length);
    expect(new Set(wards.map((w) => w.get("name"))).size).toBe(wards.length);
  });

  test("every planned building is placed, and no two buildings overlap", () => {
    for (const t of [town, village, port]) {
      const plan = t.settlement().get<string[]>("plan");
      const bs = buildings(t);
      expect(bs.length).toBe(plan.length);
      // A coarse grid keeps this from being quadratic.
      const grid = new Map<string, Poly[]>();
      const key = (x: number, y: number) => `${Math.floor(x / 30)},${Math.floor(y / 30)}`;
      let clashes = 0;
      for (const b of bs) {
        const poly = b.get<Poly>("poly");
        const [cx, cy] = centroid(poly);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          for (const o of grid.get(key(cx + dx * 30, cy + dy * 30)) ?? []) if (convexOverlap(poly, o, -0.15)) clashes++;
        }
        const k = key(cx, cy);
        grid.set(k, [...(grid.get(k) ?? []), poly]);
      }
      expect(clashes).toBe(0);
    }
  });

  test("the population comes out near what was asked for", () => {
    expect(people(town).length / 8000).toBeGreaterThan(0.95);
    expect(people(town).length / 8000).toBeLessThan(1.25);
    expect(people(market).length / 2000).toBeGreaterThan(0.85);
    expect(people(market).length / 2000).toBeLessThan(1.2);
  });

  test("ward values: suburbs are poor; somewhere is rich", () => {
    const wards = town.children(town.root, "ward");
    // Over a river town's bridge is a place of its own, with its own values; the suburbs along the roads are poor.
    for (const w of wards) if (w.get("kind") === "suburb" && w.get("bank") !== "far") expect(w.get<number>("valueClass")).toBeLessThanOrEqual(1);
    expect(Math.max(...wards.map((w) => w.get<number>("valueClass")))).toBeGreaterThanOrEqual(5);
  });

  test("the layout is stable for a seed", () => {
    const m = map(town);
    const geometry = hashHex(stableStringify(buildings(town).map((b) => [b.get("use"), b.get("poly")]), 0), 8);
    expect({
      buildings: buildings(town).length,
      wards: town.children(town.root, "ward").map((w) => w.get("name")),
      gates: town.settlement().get("gateNames"),
      wallPoints: m.wall!.line.length,
      geometry,
    }).toMatchSnapshot();
  });

  test("a coastal town has a quay and nothing built in the sea", () => {
    const m = map(port);
    expect(m.quay).toBeDefined();
    expect(buildings(port).some((b) => b.get("road") === "quay")).toBe(true);
    for (const b of buildings(port)) expect(pointInPoly(centroid(b.get<Poly>("poly")), m.sea!)).toBe(false);
  });

  test("a market town of 2,000 governs itself like a town: officers, a watch, a court, no elder", () => {
    expect(market.find(`${market.root}/institution:council`)).toBeUndefined();
    expect(market.find(`${market.root}/institution:watch`)).toBeDefined();
    expect(offices(market, "constable").length).toBeGreaterThanOrEqual(1);
    expect(market.settlement().get<string[]>("marketDays")).toHaveLength(2);
  });

  test("a big village keeps its council and has no watch, gatehouses or guildhall", () => {
    expect(village.find(`${village.root}/institution:council`)).toBeDefined();
    expect(village.find(`${village.root}/institution:watch`)).toBeUndefined();
    expect(buildings(village).some((b) => b.get("use") === "gatehouse")).toBe(false);
    expect(village.children(village.root, "ward").every((w) => / End$/.test(w.get<string>("name")))).toBe(true);
  });

  test("hamlets have none of it", () => {
    const h = generate("ashby");
    expect(map(h).kind).toBeUndefined();
    expect(h.children(h.root, "ward")).toHaveLength(0);
    expect(h.find(`${h.root}/institution:watch`)).toBeUndefined();
  });
});

describe("town institutions", () => {
  test("offices are filled: government, constables, watch, gates, criers, courts", () => {
    const quarters = town.settlement().get<number>("quarters");
    expect(offices(town, "mayor").length + offices(town, "the lord's bailiff of the town").length).toBe(1);
    expect(offices(town, "constable")).toHaveLength(quarters);
    expect(offices(town, "officer of the watch").length).toBeGreaterThanOrEqual(quarters * 4);
    expect(offices(town, "gate guard").length).toBeGreaterThanOrEqual(map(town).wall!.gates.length * 2);
    expect(offices(town, "town crier").length).toBeGreaterThanOrEqual(1);
    // 1203: the coroner holds felonies for the king's justices; no magistrates yet.
    expect(offices(town, "coroner")).toHaveLength(1);
    expect(offices(town, "magistrate")).toHaveLength(0);
    // Nobody holds two town offices.
    const holders = town.edges({ kind: "office_in" }).filter((e) => /institution:(town|watch|justice)$/.test(e.to)).map((e) => e.from);
    expect(new Set(holders).size).toBe(holders.length);
    expect(town.get(`${town.root}/institution:justice`).get<unknown[]>("docket").length).toBeGreaterThan(2);
  });

  test("the watch walks the streets at night", () => {
    const officer = offices(town, "officer of the watch")[0].from;
    expect(whereabouts(town, officer, "1203-05-14", "night").where).toBe("place:streets");
    expect(whereabouts(town, officer, "1203-05-14", "forenoon").where).not.toBe("place:streets");
  });

  test("guilds: masters belong, wardens hold office, journeymen work for a master of their craft", () => {
    const guilds = town.settlement().get<{ id: string }[]>("guilds");
    expect(guilds.length).toBeGreaterThan(3);
    for (const g of guilds) {
      const inst = `${town.root}/institution:guild-${g.id}`;
      const members = town.edges({ to: inst, kind: "member_of" });
      expect(members.length).toBeGreaterThanOrEqual(3);
      expect(town.edges({ to: inst, kind: "office_in" }).length).toBeGreaterThanOrEqual(2);
    }
    const j = town.allEntities().find((e) => e.type === "household" && e.get("occupation") === "journeyman" && e.get("guild.craft"))!;
    const head = town.children(j.address, "person")[0];
    const boss = town.edges({ to: head.address, kind: "employer" }).find((e) => e.facts?.as === "journeyman");
    if (boss) expect(town.edges({ from: boss.from, kind: "member_of" }).some((e) => e.to.endsWith(`guild-${j.get("guild.craft")}`))).toBe(true);
  });

  test("tithes run up the chain to the see, and every household has a parish", () => {
    const see = `${town.root}/institution:see`;
    const cathedral = buildings(town).find((b) => b.get("use") === "grand_temple");
    for (const b of buildings(town).filter((x) => x.get("use") === "fane")) {
      let at = town.children(town.children(b.address, "household")[0].address, "person")[0].address;
      for (let hops = 0; hops < 4; hops++) {
        const up = town.edges({ from: at, kind: "tithes_to" })[0];
        if (!up) break;
        at = up.to;
      }
      if (cathedral) expect(at.startsWith(cathedral.address)).toBe(true);
      else expect(at).toBe(see);
    }
    for (const h of town.allEntities().filter((e) => e.type === "household")) expect(h.get("parish")).toBeTruthy();
  });

  test("a town holds its own fair, and the king's justices come twice a year", () => {
    const v = visitsIn(town, 1204);
    expect(v.find((x) => x.kind === "fair")?.local).toBe(true);
    expect(v.filter((x) => x.kind === "assize")).toHaveLength(2);
  });

  test("town hooks turn up across a few towns", () => {
    const seen = new Set<string>();
    for (const t of [town, port]) for (const h of findHooks(t)) seen.add(h.title);
    for (const seed of ["burgh-b", "burgh-c"]) for (const h of findHooks(generate(seed, { pop: 7000 }))) seen.add(h.title);
    const towny = ["Benefit of clergy", "A tenth of too little", "The masterpiece", "Whose right is it?", "A year and a day", "An interested bench", "Who watches the watch"];
    expect(towny.filter((t) => seen.has(t)).length).toBeGreaterThanOrEqual(4);
  }, 60000);

  test("edits and saves work on a town: rename a ward", () => {
    const w = town.children(town.root, "ward")[0];
    const edited = withEdit(town, defaultModules, w.address, "name", "Cheapside");
    expect(edited.get(w.address).get("name")).toBe("Cheapside");
    expect(edited.label(w.address)).toBe("Cheapside");
    const again = load(JSON.parse(serialize(edited)), defaultModules);
    expect(again.get(w.address).get("name")).toBe("Cheapside");
    expect(serialize(again)).toBe(serialize(edited));
  }, 60000);
});
