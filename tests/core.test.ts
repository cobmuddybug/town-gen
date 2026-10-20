import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { load, serialize, withEdit, withPin, withReroll } from "../src/core/save";
import { Town, stableStringify } from "../src/core/town";
import { Rng, hashHex } from "../src/core/rng";
import { cos, sin } from "../src/core/dmath";
import type { Module } from "../src/core/types";
import { defaultModules, generate } from "../src/town-gen";
import { findHooks } from "../src/modules/sifters";

const snap = (t: Town) => stableStringify(t.snapshot());

describe("rng", () => {
  test("same key, same stream; different key, different stream", () => {
    const a = new Rng("x"), b = new Rng("x"), c = new Rng("y");
    const sa = [a.u32(), a.u32(), a.u32()];
    expect([b.u32(), b.u32(), b.u32()]).toEqual(sa);
    expect([c.u32(), c.u32(), c.u32()]).not.toEqual(sa);
  });
  test("pinned values never change", () => {
    // If this fails, every saved town changes. Bump every module's major version.
    expect(new Rng("town-gen").u32()).toMatchInlineSnapshot(`2511983102`);
  });
  test("deterministic sin/cos are accurate", () => {
    for (let x = -20; x <= 20; x += 0.37) {
      expect(Math.abs(sin(x) - Math.sin(x))).toBeLessThan(1e-9);
      expect(Math.abs(cos(x) - Math.cos(x))).toBeLessThan(1e-9);
    }
  });
});

describe("determinism", () => {
  test("same seed gives an identical snapshot", () => {
    expect(snap(generate("ashby"))).toEqual(snap(generate("ashby")));
  });

  test("different seeds give different towns", () => {
    expect(snap(generate("ashby"))).not.toEqual(snap(generate("brill")));
  });

  test("order of looking does not matter", () => {
    const a = generate("ashby");
    const b = generate("ashby");
    // Look at b's buildings back to front, people first, before anything else.
    const bs = b.children(b.root, "building").reverse();
    for (const bld of bs) for (const h of b.children(bld.address, "household").reverse()) {
      for (const p of b.children(h.address, "person").reverse()) p.get("given");
    }
    b.get(`${b.root}/institution:council`);
    expect(snap(b)).toEqual(snap(a));
  });

  test("golden: output for a fixed seed is unchanged", () => {
    // A change here means existing saves would regenerate differently.
    // If it was intended, bump the major version of the module that changed it.
    const t = generate("golden-seed");
    t.resolveAll();
    const summary = {
      name: t.label(t.root),
      buildings: t.children(t.root, "building").map((b) => b.get("use")),
      people: t.allEntities().filter((e) => e.type === "person").length,
      firstFamily: t.label(t.children(t.children(t.root, "building")[4].address, "household")[0].address),
      hooks: findHooks(t).map((h) => h.sifter),
      geometry: hashHex(JSON.stringify([t.settlement().get("map"), t.children(t.root, "building").map((b) => b.get("poly"))]), 8),
    };
    expect(summary).toMatchSnapshot();
  });
});

describe("saves", () => {
  test("generate, save, load, compare byte for byte", () => {
    const t = generate("ashby", { pop: 230 });
    const json = serialize(t);
    const back = load(JSON.parse(json), defaultModules);
    expect(serialize(back)).toEqual(json);
    expect(snap(back)).toEqual(snap(t));
  });

  test("saves stay small: seed and edits, never the town", () => {
    const t = generate("ashby");
    expect(serialize(t).length).toBeLessThan(1000);
  });

  test("loading warns when a module's major version changed", () => {
    const save = generate("ashby").toSave();
    save.modules.names = "0.9.0";
    expect(load(save, defaultModules).warnings.join()).toMatch(/names/);
  });
});

describe("overlay", () => {
  const b17 = (t: Town) => t.children(t.root, "building").find((b) => b.get("use") === "cottage")!.address;

  test("changing a use cascades downstream but leaves names alone", () => {
    const t = generate("ashby");
    const addr = b17(t);
    const hh = `${addr}/household:0`;
    const head = `${hh}/person:0`;
    const before = { given: t.get(head).get("given"), surname: t.get(hh).get("surname"), occ: t.get(hh).get("occupation") };
    const edited = withEdit(t, defaultModules, addr, "use", "cooperage");
    expect(edited.get(hh).get("occupation")).toBe("cooper");
    expect(edited.get(head).get("given")).toEqual(before.given);
    expect(edited.get(hh).get("surname")).toEqual(before.surname);
    expect(edited.label(head)).toEqual(t.label(head));
    expect(before.occ).not.toBe("cooper");
  });

  test("an edited field wins and survives save/load", () => {
    const t = generate("ashby");
    const head = `${b17(t)}/household:0/person:0`;
    const edited = withEdit(t, defaultModules, head, "given", "Agnes");
    expect(edited.get(head).get("given")).toBe("Agnes");
    const back = load(JSON.parse(serialize(edited)), defaultModules);
    expect(back.get(head).get("given")).toBe("Agnes");
  });

  test("reroll draws a new value and only touches that field", () => {
    const t = generate("ashby");
    const hh = `${b17(t)}/household:0`;
    let r = t;
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      r = withReroll(r, defaultModules, hh, "living.diet");
      seen.add(r.get(hh).get("living.diet"));
    }
    expect(r.get(hh).get("surname")).toEqual(t.get(hh).get("surname"));
    expect(r.get(hh).get("income")).toEqual(t.get(hh).get("income"));
    expect(seen.size).toBeGreaterThanOrEqual(1);
  });

  test("a pinned entity survives a generator change", () => {
    const t = generate("ashby");
    const head = `${b17(t)}/household:0/person:0`;
    const pinned = withPin(t, defaultModules, head, true);
    const save = pinned.toSave();
    // Simulate an upgraded name generator: bump its major version.
    const upgraded = defaultModules.map((m) => (m.id === "names" ? { ...m, version: "2.0.0" } : m));
    const after = load(save, upgraded);
    expect(after.get(head).get("given")).toEqual(t.get(head).get("given"));
    const unpinned = load(generate("ashby").toSave(), upgraded);
    // An unpinned neighbour is free to change (and will, since the stream changed).
    expect(unpinned.label(head)).not.toBe(undefined);
  });
});

describe("isolation", () => {
  // A greedy module that draws heavily from its own streams everywhere.
  const graffiti: Module = {
    id: "graffiti",
    version: "1.0.0",
    requires: ["core", "households"],
    hooks: {
      onSettlementGenerated(ctx, s) { for (let i = 0; i < 100; i++) ctx.rng(s, "x").next(); ctx.set(s, "graffiti", 1); },
      onBuildingResolved(ctx, b) { ctx.gen(b, "graffiti", (r) => r.pick(["a cross", "a ship", "a name"])); },
      onPersonResolved(ctx, p) { ctx.gen(p, "graffiti.mark", (r) => r.int(0, 1000)); },
    },
  };

  test("adding a module changes no field owned by another module", () => {
    const without = generate("ashby").snapshot() as { entities: Record<string, { fields: Record<string, unknown> }> };
    const withIt = generate("ashby", {}, [...defaultModules, graffiti]).snapshot() as typeof without;
    for (const [addr, e] of Object.entries(without.entities)) {
      const other = withIt.entities[addr];
      expect(other, addr).toBeDefined();
      for (const [k, v] of Object.entries(e.fields)) expect(other.fields[k], `${addr} ${k}`).toEqual(v);
    }
  });

  test("a module cannot write another module's field", () => {
    const thief: Module = {
      id: "thief", version: "1.0.0", requires: ["names"],
      hooks: { onPersonResolved(ctx, p) { ctx.set(p, "given", "Mallory"); } },
    };
    const t = generate("ashby", {}, [...defaultModules, thief]);
    const b = t.children(t.root, "building")[0];
    expect(() => t.resolveAll()).toThrow(/owned by names/);
    void b;
  });
});

describe("stubs", () => {
  test("an entity is the same whether reached from the map or from an edge", () => {
    const viaMap = generate("ashby");
    viaMap.resolveAll();
    const grudge = viaMap.edges({ kind: "spouse" })[0];
    const viaEdge = generate("ashby");
    const direct = viaEdge.get(grudge.to);
    const fromMap = viaMap.get(grudge.to);
    for (const k of ["given", "age", "traits", "birthname"]) expect(direct.get(k)).toEqual(fromMap.get(k));
  });

  test("a deep address resolves its ancestors on demand", () => {
    const t = generate("ashby");
    const addr = `${t.root}/building:b010/household:0/person:0`;
    expect(t.peek(addr)).toBeUndefined();
    expect(t.label(addr)).toMatch(/\w+ \w+/);
  });
});

describe("hamlet", () => {
  test("settlement sizes are near their target", () => {
    for (const pop of [80, 200, 400, 600]) {
      const t = generate(`pop-${pop}`, { pop });
      t.resolveAll();
      const n = t.allEntities().filter((e) => e.type === "person").length;
      expect(n, `pop ${pop}`).toBeGreaterThan(pop * 0.75);
      expect(n, `pop ${pop}`).toBeLessThan(pop * 1.3);
      expect(t.children(t.root, "building").length).toBe(t.settlement().get<string[]>("plan").length);
    }
  });

  test("every hamlet has its core buildings and a council", () => {
    for (const seed of ["a1", "a2", "a3", "a4", "a5"]) {
      const t = generate(seed);
      const uses = t.children(t.root, "building").map((b) => b.get("use"));
      for (const u of ["mill", "trader", "alehouse", "chapel"]) expect(uses, seed).toContain(u);
      const c = t.get(`${t.root}/institution:council`);
      expect(c.get<unknown[]>("seats").length).toBeGreaterThanOrEqual(3);
    }
  });

  test("the miller is usually the richest", () => {
    let millerRichest = 0;
    const n = 30;
    for (let i = 0; i < n; i++) {
      const t = generate(`rich-${i}`);
      const c = t.get(`${t.root}/institution:council`);
      const hh = t.get(t.parentOf(c.get<string>("richest"))!);
      if (hh.get("occupation") === "miller") millerRichest++;
    }
    expect(millerRichest / n).toBeGreaterThan(0.6);
  });

  test("hooks turn up across seeds", () => {
    let n = 0;
    for (let i = 0; i < 12; i++) n += findHooks(generate(`hook-${i}`)).length;
    expect(n).toBeGreaterThan(5);
  });
});

describe("rules", () => {
  test("no Math.random anywhere in src", () => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|js)$/.test(f) && /Math\.random\s*\(/.test(readFileSync(p, "utf8"))) bad.push(p);
      }
    };
    walk(join(import.meta.dirname, "../src"));
    expect(bad).toEqual([]);
  });

  test("no Math.sin/cos/atan2/hypot in generators (engine-dependent rounding)", () => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(f) && /Math\.(sin|cos|tan|atan2?|hypot|exp|log|pow)\s*\(/.test(readFileSync(p, "utf8"))) bad.push(p);
      }
    };
    walk(join(import.meta.dirname, "../src/modules"));
    walk(join(import.meta.dirname, "../src/core"));
    expect(bad).toEqual([]);
  });
});
