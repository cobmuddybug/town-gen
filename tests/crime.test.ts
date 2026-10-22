import { describe, expect, test } from "vitest";
import { generate, defaultModules } from "../src/town-gen";
import { withEdit } from "../src/core/save";
import { crime, world, incidentsIn, prisoners, statusOf } from "../src/modules/crime";
import { whereabouts } from "../src/modules/routines";
import { rumoursIn } from "../src/modules/gossip";
import { findHooks } from "../src/modules/sifters";
import { centroid, type Poly } from "../src/modules/layout/geom";
import { encounter, jobBoard, report } from "../src/ui/party";
import { lensView } from "../src/ui/discover";

const town = (seed: string, pop: number, crimeLevel?: "quiet" | "usual" | "rife") => {
  const t = generate(seed, { pop, ...(crimeLevel ? { design: { crime: crimeLevel } } : {}) });
  t.society();
  return t;
};

describe("the underworld", () => {
  test("hamlets and small places have none", () => {
    const h = generate("crime-h", { pop: 300 });
    h.resolveAll();
    expect(world(h)).toBeUndefined();
    expect(h.allEntities().some((e) => [...e.fields.keys()].some((k) => k.startsWith("crime.")))).toBe(false);
    expect(world(town("crime-v", 900))).toBeUndefined();
  });

  test("a town has crews of its own people, each with a chief, a den and a turf", () => {
    const t = town("crime-t", 6000);
    const W = world(t)!;
    expect(W.gangs.length).toBeGreaterThanOrEqual(1);
    const seen = new Set<string>();
    for (const g of W.gangs) {
      expect(g.chief).toBeTruthy();
      expect(g.den && t.get(g.den).type).toBe("building");
      expect(g.turf.length).toBeGreaterThan(0);
      expect(g.members.length).toBeGreaterThanOrEqual(3);
      for (const m of g.members) {
        expect(seen.has(m.p)).toBe(false);
        seen.add(m.p);
        expect(t.get(m.p).type).toBe("person");
        expect(m.p.includes("/building:")).toBe(true);
        expect(t.get(m.p).get("crime.alias")).toBeTruthy();
      }
      expect(t.label(g.address)).not.toMatch(/\{|\}/);
    }
    // Street names are not shared.
    const aliases = [...seen].map((p) => t.get(p).get<string>("crime.alias"));
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  test("more crime means bigger crews and more crimes", () => {
    const q = town("crime-l", 12000, "quiet"), r = town("crime-l", 12000, "rife");
    const size = (t: typeof q) => world(t)!.crew.size;
    expect(size(r)).toBeGreaterThan(size(q));
    expect(incidentsIn(r, 1203).length).toBeGreaterThan(incidentsIn(q, 1203).length);
    expect(world(r)!.level).toBe("rife");
  });

  test("the DM can turn crime up or down from the town's panel", () => {
    const t = town("crime-k", 9000, "quiet");
    const up = withEdit(t, defaultModules, t.root, "crime.level", "rife");
    up.society();
    expect(world(up)!.level).toBe("rife");
    expect(world(up)!.crew.size).toBeGreaterThan(world(t)!.crew.size);
  });

  test("everything is the same for the same seed, whatever is asked first", () => {
    const a = town("crime-d", 8000), b = town("crime-d", 8000);
    expect(world(a)!.gangs.map((g) => g.members.map((m) => m.p))).toEqual(world(b)!.gangs.map((g) => g.members.map((m) => m.p)));
    incidentsIn(b, 1205);
    expect(incidentsIn(a, 1203)).toEqual(incidentsIn(b, 1203));
  });

  test("other modules' fields and edges don't move", () => {
    const without = generate("crime-i", { pop: 5000 }, defaultModules.filter((m) => m !== crime));
    const withIt = generate("crime-i", { pop: 5000 });
    const a = without.snapshot() as { entities: Record<string, { fields: Record<string, { module: string; value: unknown }> }>; edges: { module: string }[] };
    const b = withIt.snapshot() as typeof a;
    for (const [addr, e] of Object.entries(a.entities)) {
      for (const [k, f] of Object.entries(e.fields)) expect(b.entities[addr].fields[k], `${addr} ${k}`).toEqual(f);
    }
    expect(b.edges.filter((e) => e.module !== "crime")).toEqual(a.edges);
  });

  test("a DM's edit to one person doesn't reshuffle the crews", () => {
    const t = town("crime-e", 5000);
    const someone = t.allEntities().find((e) => e.type === "person" && e.get<number>("age") > 30 && !world(t)!.crew.has(e.address))!;
    const edited = withEdit(t, defaultModules, someone.address, "traits", ["sly", "grasping", "quarrelsome"]);
    edited.society();
    expect(world(edited)!.gangs.map((g) => g.members.map((m) => m.p))).toEqual(world(t)!.gangs.map((g) => g.members.map((m) => m.p)));
  });
});

describe("the crime calendar", () => {
  const t = town("crime-c", 10000, "rife");
  const year = incidentsIn(t, 1203);

  test("crimes happen, and their culprits are there when they do", () => {
    expect(year.length).toBeGreaterThan(50);
    for (const i of year.slice(0, 200)) {
      for (const c of i.culprits) {
        const w = whereabouts(t, c, i.date, i.block);
        expect(w.where, `${i.id} ${c}`).toBe(i.at);
      }
    }
  });

  test("the caught go to gaol or the pillory, the hanged to the grave", () => {
    const caught = year.filter((i) => i.caught && i.fate);
    expect(caught.length).toBeGreaterThan(0);
    for (const i of caught) {
      const s = statusOf(t, i.caught!.who, i.caught!.date);
      expect(s, i.id).toBeTruthy();
    }
    const hanged = [...year, ...incidentsIn(t, 1204)].find((i) => i.fate?.outcome === "hanged");
    if (hanged) {
      const after = new Date(Date.parse(hanged.fate!.on) + 3 * 86400000).toISOString().slice(0, 10);
      expect(whereabouts(t, hanged.caught!.who, after, "forenoon").where).toBe("place:grave");
    }
    const day = caught.find((i) => i.fate!.felony)?.caught!.date;
    if (day) expect(prisoners(t, day).length).toBeGreaterThan(0);
  });

  test("notable crimes are talked about, with no tokens left in", () => {
    const talk = rumoursIn(t, 1203).filter((r) => /^(crime|arrest|sentence)\//.test(r.id));
    expect(talk.length).toBeGreaterThan(5);
    for (const r of talk) for (const x of r.texts) expect(x, r.id).not.toMatch(/\{|\}/);
  });

  test("crime feeds the job board, the report, encounters, hooks and the map", () => {
    const W = world(t)!;
    const jobs = jobBoard(t, "1203-10-07");
    expect(jobs.some((j) => /^(stolen|racket|bounty|blackmail|knife|crew)\//.test(j.id))).toBe(true);
    const den = W.gangs.find((g) => g.den)!.den!;
    const at = centroid(t.get(den).get<Poly>("poly"));
    const r = report(t, at, "1203-10-07", "evening");
    expect(r.crime?.dens.some((d) => d.a === den)).toBe(true);
    let crew = 0;
    for (let n = 1; n <= 30; n++) if (encounter(t, at, "1203-10-07", "evening", n)?.crew) crew++;
    expect(crew).toBeGreaterThan(0);
    const hooks = findHooks(t).filter((h) => ["bought-and-paid", "alibi-cells", "thief-takers-thieves", "wont-pay", "neck-verse", "sanctuary", "price-on-a-head", "crossbitten", "the-nose", "turf-war", "wrong-man"].includes(h.sifter));
    expect(hooks.length).toBeGreaterThan(0);
    t.clock = { date: "1203-10-07", block: "evening" };
    expect(lensView(t, "crime").fills.size).toBeGreaterThan(0);
  });
});
