// Filling a block: lots wall to wall round its edge, corners split between two streets or taken by
// one L-shaped house, and the middle by the kind of block. And ribbons of lots along a lone road.
import { describe, expect, test } from "vitest";
import { Rng } from "../src/core/rng";
import { blockFaces, nodeStreets, type Face } from "../src/modules/layout/graph";
import { area, convexOverlap, dist, pointInPoly, type Poly, type Pt } from "../src/modules/layout/geom";
import { cutRibbon, fillBlock, KIND_SPEC, shapeOn, type BlockKind, type Lot } from "../src/modules/layout/blocks";
import type { FrontKind } from "../src/modules/layout/streets";

const loop = (pts: Pt[], width = 6) => pts.map((p, i) => ({ id: `s${i}`, width, points: [p, pts[(i + 1) % pts.length]] }));
const faceOf = (pts: Pt[]): Face => {
  const f = blockFaces(nodeStreets(loop(pts)));
  expect(f.length).toBe(1);
  return f[0];
};
const QUAD: Pt[] = [[0, 0], [126, 6], [120, 106], [-4, 98]];
const front = (): FrontKind => "street";
const fill = (kind: BlockKind, seed: string, pts: Pt[] = QUAD) => fillBlock(new Rng(seed), faceOf(pts), kind, front, { next: 0, run: 0 });
const houses = (kind: BlockKind, lots: Lot[], seed = "h") => {
  const r = new Rng(seed);
  return lots.map((l, i) => shapeOn(r, i, { size: "house" }, [l], kind));
};
const overlaps = (ps: Poly[]) => {
  const out: [number, number][] = [];
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) if (ps[i].length === 4 && ps[j].length === 4 && convexOverlap(ps[i], ps[j], -0.2)) out.push([i, j]);
  return out;
};
const minAngle = (p: Poly) => {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
  let m = 180;
  for (let i = 0; i < p.length; i++) {
    const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length];
    const u = [a[0] - b[0], a[1] - b[1]], v = [c[0] - b[0], c[1] - b[1]];
    const cr = (v[0] * u[1] - v[1] * u[0]) * Math.sign(s);
    let ang = (Math.atan2(Math.abs(cr), u[0] * v[0] + u[1] * v[1]) * 180) / Math.PI;
    if (cr < 0) ang = 360 - ang;
    m = Math.min(m, ang);
  }
  return m;
};

describe("lots round a block", () => {
  const { lots } = fill("ordinary", "a");
  const face = faceOf(QUAD);
  test("every lot is inside the block, and no two overlap", () => {
    expect(lots.length).toBeGreaterThan(20);
    for (const l of lots) {
      const c: Pt = [l.poly.reduce((t, p) => t + p[0], 0) / l.poly.length, l.poly.reduce((t, p) => t + p[1], 0) / l.poly.length];
      expect(pointInPoly(c, face.outline)).toBe(true);
    }
    expect(overlaps(lots.map((l) => l.poly))).toEqual([]);
  });
  test("neighbours along a street share their side walls", () => {
    const runs = new Map<number, Lot[]>();
    for (const l of lots) runs.set(l.run, [...(runs.get(l.run) ?? []), l]);
    let shared = 0;
    for (const run of runs.values()) {
      run.sort((a, b) => a.idx - b.idx);
      for (let i = 0; i + 1 < run.length; i++) {
        const a = run[i], b = run[i + 1];
        // Corner pieces are half-depth or L-shaped by design: their backs don't meet the next lot's.
        if (a.corner || b.corner) continue;
        expect(dist(a.poly[1], b.poly[0])).toBeLessThan(0.05);
        expect(dist(a.poly[2], b.poly[3])).toBeLessThan(0.05);
        shared++;
      }
    }
    expect(shared).toBeGreaterThan(10);
  });
});

describe("each kind fills its block as it should", () => {
  // Cover depends on a block's size (a small block is nearly all house): a middling block, 90 x 70.
  const MID: Pt[] = [[0, 0], [92, 4], [90, 74], [-3, 70]];
  const cover = (kind: BlockKind, seed: string) => {
    const { lots } = fill(kind, seed, MID);
    const bs = houses(kind, lots);
    return bs.reduce((t, b) => t + area(b.poly) + b.parts.reduce((u, p) => u + area(p.poly), 0), 0) / area(faceOf(MID).outline);
  };
  test("shop streets are packed, their backlands built over", () => {
    for (const s of ["s1", "s2", "s3"]) { const c = cover("shop", s); expect(c, s).toBeGreaterThanOrEqual(0.55); expect(c, s).toBeLessThanOrEqual(0.9); }
    const { lots } = fill("shop", "s1");
    const widths = lots.filter((l) => !l.corner && l.kindOfBlock === "shop").map((l) => dist(l.poly[0], l.poly[1]));
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(KIND_SPEC.shop.lotW[0] * 0.5);
    expect(widths.filter((w) => w >= 4.5 && w <= 7).length / widths.length).toBeGreaterThan(0.8);
  });
  test("ordinary streets are less so", () => {
    for (const s of ["o1", "o2", "o3"]) { const c = cover("ordinary", s); expect(c, s).toBeGreaterThanOrEqual(0.4); expect(c, s).toBeLessThanOrEqual(0.8); }
  });
  test("a courtyard block leaves one common court", () => {
    const { open } = fill("courtyard", "c1");
    const court = open.filter((o) => o.kind === "court");
    expect(court.length).toBe(1);
    expect(area(court[0].poly) / area(faceOf(QUAD).outline)).toBeGreaterThanOrEqual(0.2);
  });
  test("the well-off keep private gardens", () => {
    const { open } = fill("wellOff", "w1");
    expect(open.some((o) => o.kind === "garden" && o.private)).toBe(true);
  });
});

describe("corners", () => {
  test("split between the two streets about three times in five, else one L-shaped house", () => {
    let split = 0, L = 0;
    for (let i = 0; i < 200; i++) {
      const { lots } = fill("ordinary", `k${i}`);
      // The street front's corners (the backland ring behind them has corners of its own).
      split += lots.filter((l) => l.corner === "split" && l.kindOfBlock === "ordinary").length / 2;
      L += lots.filter((l) => l.corner === "L" && l.kindOfBlock === "ordinary").length;
    }
    const share = split / (split + L);
    expect(share).toBeGreaterThanOrEqual(0.5);
    expect(share).toBeLessThanOrEqual(0.7);
  });
  test("no house has a corner sharper than 50 degrees", () => {
    for (let i = 0; i < 40; i++) {
      for (const kind of ["shop", "ordinary", "courtyard"] as const) {
        const { lots } = fill(kind, `a${i}`);
        for (const b of houses(kind, lots, `ah${i}`)) expect(minAngle(b.poly), `${kind} ${i}`).toBeGreaterThanOrEqual(50);
      }
    }
  });
});

describe("blocks that aren't square", () => {
  test("an L-shaped block keeps every lot inside and none overlapping", () => {
    const L: Pt[] = [[0, 0], [160, 0], [160, 70], [70, 70], [70, 160], [0, 160]];
    const face = faceOf(L);
    const { lots } = fill("ordinary", "L1", L);
    expect(lots.length).toBeGreaterThan(20);
    for (const l of lots) {
      const c: Pt = [l.poly.reduce((t, p) => t + p[0], 0) / l.poly.length, l.poly.reduce((t, p) => t + p[1], 0) / l.poly.length];
      expect(pointInPoly(c, face.outline)).toBe(true);
    }
    expect(overlaps(lots.map((l) => l.poly))).toEqual([]);
  });
});

describe("ribbons along a lone road", () => {
  const line: Pt[] = [[0, 0], [200, 0]];
  const ribbon = (kind: BlockKind, seed: string) => cutRibbon(new Rng(seed), line, 1, kind, "road0", "suburb", () => true, { next: 0, run: 0 });
  test("lots stand square to the road, their backs at the kind's depth", () => {
    const lots = ribbon("ordinary", "r1");
    expect(lots.length).toBeGreaterThan(15);
    for (const l of lots) {
      expect(Math.abs(l.poly[0][1])).toBeLessThan(0.01);
      expect(Math.abs(l.poly[1][1])).toBeLessThan(0.01);
      const d = Math.abs(l.poly[2][1]);
      expect(d).toBeGreaterThanOrEqual(KIND_SPEC.ordinary.depth[0]);
      expect(Math.abs(l.poly[2][0] - l.poly[1][0])).toBeLessThan(0.01);
    }
    expect(overlaps(lots.map((l) => l.poly))).toEqual([]);
  });
  test("crofts leave gaps; shops don't", () => {
    const gaps = (lots: Lot[]) => {
      const xs = lots.map((l) => [Math.min(l.poly[0][0], l.poly[1][0]), Math.max(l.poly[0][0], l.poly[1][0])]).sort((a, b) => a[0] - b[0]);
      let g = 0;
      for (let i = 0; i + 1 < xs.length; i++) if (xs[i + 1][0] - xs[i][1] > 1) g++;
      return g;
    };
    expect(gaps(ribbon("croft", "r2"))).toBeGreaterThan(0);
    expect(gaps(ribbon("shop", "r3"))).toBe(0);
  });
});

describe("blocks of every shape", () => {
  test("no two lots overlap in any block of a town's worth of irregular blocks", async () => {
    const { voronoiCells } = await import("../src/modules/layout/geom");
    const r = new Rng("fuzz");
    const seeds: Pt[] = [];
    for (let i = 0; i < 60; i++) seeds.push([r.range(0, 600), r.range(0, 500)]);
    const cells = voronoiCells(seeds, [[0, 0], [600, 0], [600, 500], [0, 500]]);
    const streets: { id: string; width: number; points: Pt[] }[] = [];
    cells.forEach((c, i) => c.forEach((p, k) => streets.push({ id: `c${i}e${k}`, width: 6, points: [p, c[(k + 1) % c.length]] })));
    const faces = blockFaces(nodeStreets(streets, 0.5));
    const bad: string[] = [];
    faces.forEach((f, i) => {
      for (const kind of ["shop", "ordinary", "courtyard", "wellOff"] as const) {
        const { lots } = fillBlock(new Rng(`fz${i}${kind}`), f, kind, () => "street", { next: 0, run: 0 });
        const quads = lots.filter((l) => l.poly.length === 4).map((l) => l.poly);
        for (const [a, b] of overlaps(quads)) bad.push(`${i} ${kind} ${a}x${b}`);
      }
    });
    expect(bad).toEqual([]);
  });
});

describe("big blocks are opened up by lanes", () => {
  test("a block over the size is split, every part under it, and no lot crosses the lane", async () => {
    const { splitBlock } = await import("../src/modules/layout/blocks");
    const big = faceOf([[0, 0], [160, 0], [160, 120], [0, 120]]);
    let n = 0;
    const { faces, lanes } = splitBlock(big, 3, 5000, () => `lane${n++}`);
    expect(faces.length).toBeGreaterThanOrEqual(4);
    expect(lanes.length).toBe(faces.length - 1);
    for (const f of faces) expect(area(f.outline)).toBeLessThanOrEqual(5000);
    for (const f of faces) expect(f.sides.some((s) => s.street.startsWith("lane"))).toBe(true);
    const lots = faces.flatMap((f, i) => fillBlock(new Rng(`sp${i}`), f, "ordinary", front, { next: 0, run: i * 100 }).lots);
    for (const l of lots) for (const ln of lanes) {
      const [a, b] = ln;
      const side = (p: Pt) => Math.sign((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
      const s = new Set(l.poly.map(side).filter((x) => x !== 0));
      const within = l.poly.some((p) => { const t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2); return t > 0 && t < 1; });
      if (within) expect(s.size, JSON.stringify(l.poly)).toBe(1);
    }
  });
});
