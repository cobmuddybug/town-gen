// Guards for the town layouts: density in every form at every size, speed, and edits that leave the
// map alone. (The old river layout guard retired with the rows of plots; these replace it.)
import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { defaultModules, generate } from "../src/town-gen";
import { withEdit } from "../src/core/save";
import { capacityOf, clearLayoutCache, type MapData } from "../src/modules/layout";
import { hourOf, reach, talkAt } from "../src/modules/gossip";
import { renderMap } from "../src/ui/map";
import { density } from "./helpers/density";
import type { Pt } from "../src/modules/layout/geom";

const FORMS = ["radial", "river", "street", "crossroads", "castle", "abbey", "harbour", "ridge"] as const;

describe("every form, at every size, is a town of blocks, tight within its wall", () => {
  test.each(FORMS)("%s at 1,500, 6,000 and 25,000", (layout) => {
    for (const pop of [1500, 6000, 25000]) {
      const t = generate(`guard-${layout}-${pop}`, { pop, base: layout === "harbour" ? "fishing" : "agricultural", design: { layout, walls: "wall" } });
      const d = density(t, t.settlement().get<MapData>("map"));
      // Measured: at 6,000 and up, 91-197 people/ha and 19-35% cover; at 1,500 (six seeds a form)
      // 52-143 and 14-32%. The small towns are the loosest, ridge most: a castle, a precinct, a long
      // market or the gaps along a crest lie within their walls.
      expect(d.perHa, `${pop} people/ha`).toBeGreaterThanOrEqual(pop < 3000 ? 50 : 60);
      expect(d.perHa, `${pop} people/ha`).toBeLessThanOrEqual(220);
      expect(d.cover, `${pop} cover`).toBeGreaterThanOrEqual(pop < 3000 ? 0.13 : 0.15);
      expect(d.cover, `${pop} cover`).toBeLessThanOrEqual(0.45);
    }
  }, 900000);
});

describe("an edit leaves the map where it was", () => {
  test("renaming a person rebuilds the town with every building just where it stood", () => {
    const opts = { pop: 4000, design: { layout: "radial" as const } };
    const a = generate("guard-edit", opts);
    const before = a.children(a.root, "building").map((b) => JSON.stringify(b.get<Pt[]>("poly")));
    const person = a.children(a.root, "building").flatMap((b) => a.children(b.address, "household")).flatMap((h) => a.children(h.address, "person"))[0];
    const b = withEdit(a, defaultModules, person.address, "given", "Wat");
    expect(b.get(person.address).get("given")).toBe("Wat");
    expect(b.children(b.root, "building").map((x) => JSON.stringify(x.get<Pt[]>("poly")))).toEqual(before);
  }, 300000);
});

describe("frozen layouts", () => {
  // A change to these hashes is a change to the layouts: look at the maps, then update the hashes.
  const hash = (seed: string, layout: "radial" | "river") => {
    clearLayoutCache();
    const t = generate(seed, { pop: 5000, design: { layout } });
    const m = t.settlement().get<MapData>("map");
    const bs = t.children(t.root, "building").map((b) => [b.get("planIndex"), b.get("poly")]);
    return createHash("sha256").update(JSON.stringify({ bs, roads: m.roads, wall: m.wall })).digest("hex").slice(0, 12);
  };
  test("organic and river towns lay out as they did", () => {
    expect({ organic: hash("guard-frozen-a", "radial"), river: hash("guard-frozen-b", "river") }).toMatchSnapshot();
  }, 300000);
});

describe("what lives downstream of the layout", () => {
  test("no building holds more households than it has room for", () => {
    for (const [layout, pop] of [["radial", 12000], ["river", 6000], ["ridge", 9000]] as const) {
      const t = generate(`guard-cap-${layout}`, { pop, design: { layout } });
      const over = t.children(t.root, "building").filter((b) => t.children(b.address, "household").length > capacityOf(t, b.address));
      expect(over.map((b) => b.get("use")), `${layout} ${pop}`).toEqual([]);
    }
  }, 600000);
  test("in a tight town a debt still gets about, but not to everyone, in a week", () => {
    // Measured on the old layouts (3-70%, median 39%) and these (15-84%, median 50%): talk goes about as far.
    const t = generate("guard-gossip", { pop: 12000, design: { layout: "radial" } });
    t.society();
    const shares: number[] = [];
    for (const date of ["1203-09-29", "1204-03-10", "1205-06-20", "1206-01-15", "1204-07-02", "1205-11-11"]) {
      for (const r of talkAt(t, hourOf(date, "evening"))) {
        if (r.kind !== "secret" || r.topic !== "debtor_of") continue;
        const { heard, total } = reach(t, r, r.start + 168);
        shares.push(heard / total);
      }
    }
    shares.sort((a, b) => a - b);
    expect(shares.length).toBeGreaterThan(3);
    expect(shares[shares.length >> 1]).toBeGreaterThanOrEqual(0.1);
    expect(shares[shares.length >> 1]).toBeLessThanOrEqual(0.8);
  }, 600000);
});

describe("speed", () => {
  // Each form's 30,000-person layout against the time it took before the towns were cut into blocks
  // (Task 0's baselines, ms; the organic plan against the radial one it replaced).
  const BASE: Record<string, number> = { radial: 807, river: 1147, ridge: 1006, castle: 820, street: 775, crossroads: 1227, abbey: 926, harbour: 930 };
  test.skipIf(!process.env.PERF)("every form lays out a city within twice its old time", () => {
    generate("perf-warm", { pop: 3000 }).settlement().get("map");
    const slow: string[] = [];
    for (const [layout, base] of Object.entries(BASE)) {
      const t0 = performance.now();
      generate("perf-30k", { pop: 30000, base: layout === "harbour" ? "fishing" : "agricultural", design: { layout: layout as never } }).settlement().get("map");
      const ms = performance.now() - t0;
      console.log("30000", layout, ms.toFixed(0), "ms, baseline", base);
      if (ms > base * 2) slow.push(`${layout} ${ms.toFixed(0)} > 2 x ${base}`);
    }
    expect(slow).toEqual([]);
  }, 900000);
});

describe("review fixes", () => {
  const segD = (p: Pt, a: Pt, b: Pt) => { const ab = [b[0] - a[0], b[1] - a[1]], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / (ab[0] ** 2 + ab[1] ** 2 || 1))); return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t); };
  test.each(["radial", "abbey", "castle", "crossroads", "harbour", "street", "ridge", "river"] as const)("%s at 4,000: no house stands in a street", (layout) => {
    const t = generate(`rv-street-${layout}`, { pop: 4000, base: layout === "harbour" ? "fishing" : "agricultural", design: { layout } });
    const m = t.settlement().get<MapData>("map");
    const bad: string[] = [];
    for (const b of t.children(t.root, "building")) {
      if (["gatehouse", "castle"].includes(b.get<string>("use"))) continue;
      const poly = b.get<Pt[]>("poly");
      for (const rd of m.roads) {
        if (rd.kind === "track") continue;
        // A corner of the house more than half a metre into the street's way.
        if (poly.some((p) => rd.points.some((q, i) => i + 1 < rd.points.length && segD(p, q, rd.points[i + 1]) < rd.width / 2 - 0.5))) { bad.push(`${b.get("use")} in ${rd.id}`); break; }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  }, 300000);
  test.each(["river", "ridge", "castle", "abbey"] as const)("%s: no block is drawn over the fields or across the river", (layout) => {
    for (const pop of [750, 4000, 12000]) {
      const t = generate(`rv-block-${layout}-${pop}`, { pop, design: { layout } });
      const m = t.settlement().get<MapData>("map");
      const shoelace = (p: Pt[]) => { let a = 0; p.forEach((v, i) => { const w = p[(i + 1) % p.length]; a += v[0] * w[1] - w[0] * v[1]; }); return Math.abs(a) / 2; };
      expect((m.blocks ?? []).filter((b) => shoelace(b.outline) > 30000).length, `${pop} huge blocks`).toBe(0);
      const river = m.stream.points;
      expect((m.blocks ?? []).filter((b) => b.outline.some((p) => river.some((q, i) => i + 1 < river.length && segD(p, q, river[i + 1]) < m.stream.width / 2))).length, `${pop} blocks in the river`).toBe(0);
    }
  }, 600000);
  test("the Walls and Gates choices hold for a town already laid out with others", () => {
    const walled = generate("rv-walls", { pop: 3000, design: { layout: "radial", walls: "wall", gates: 4 } }).settlement().get<MapData>("map");
    const open = generate("rv-walls", { pop: 3000, design: { layout: "radial", walls: "none" } }).settlement().get<MapData>("map");
    expect(walled.wall!.gates.length).toBeGreaterThan(0);
    expect(open.enclosure).toBe("none");
    expect(open.wall!.gates.length).toBe(0);
    const six = generate("rv-walls", { pop: 3000, design: { layout: "radial", walls: "wall", gates: 6 } }).settlement().get<MapData>("map");
    expect(six.wall!.gates.length).not.toBe(walled.wall!.gates.length);
  }, 300000);
  test("a small town's spare lots are drawn as gardens, over the blocks, not hidden under them", () => {
    const svg = renderMap(generate("rv-spare", { pop: 900, design: { layout: "street" } }));
    const lastBlock = svg.lastIndexOf('class="m-block"'), firstGarden = svg.indexOf('class="m-garden"');
    expect(firstGarden).toBeGreaterThan(lastBlock);
  }, 300000);
});
