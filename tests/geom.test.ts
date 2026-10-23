// The geometry blocks are cut with: insetting a block, clipping by a line, and the cells a town's
// blocks grow from.
import { describe, expect, test } from "vitest";
import { area, clipHalfPlane, convexOverlap, insetPoly, isConvex, pointInPoly, voronoiCells, type Poly, type Pt } from "../src/modules/layout/geom";
import { Rng } from "../src/core/rng";

describe("insetPoly", () => {
  test("a rectangle shrinks by the distance on every side", () => {
    const r: Poly = [[0, 0], [100, 0], [100, 80], [0, 80]];
    expect(area(insetPoly(r, 10))).toBeCloseTo(80 * 60, 0);
  });
  test("works either way round", () => {
    const r: Poly = [[0, 0], [0, 80], [100, 80], [100, 0]];
    expect(area(insetPoly(r, 10))).toBeCloseTo(80 * 60, 0);
  });
  test("an L-shaped block stays inside itself", () => {
    const L: Poly = [[0, 0], [100, 0], [100, 40], [40, 40], [40, 100], [0, 100]];
    const i = insetPoly(L, 5);
    expect(i.length).toBeGreaterThanOrEqual(6);
    for (const p of i) expect(pointInPoly(p, L)).toBe(true);
    expect(area(i)).toBeLessThan(area(L));
  });
  test("a polygon too small to inset comes back empty", () => {
    expect(insetPoly([[0, 0], [8, 0], [8, 8], [0, 8]], 5)).toEqual([]);
  });
});

describe("clipHalfPlane", () => {
  test("keeps the side the normal points to", () => {
    const sq: Poly = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const c = clipHalfPlane(sq, [4, 0], [1, 0]);
    expect(area(c)).toBeCloseTo(60, 6);
    for (const p of c) expect(p[0]).toBeGreaterThanOrEqual(4 - 1e-9);
  });
});

describe("voronoiCells", () => {
  const box: Poly = [[0, 0], [500, 0], [500, 500], [0, 500]];
  const r = new Rng("vor");
  const seeds: Pt[] = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) seeds.push([50 + i * 100 + r.range(-30, 30), 50 + j * 100 + r.range(-30, 30)]);
  const cells = voronoiCells(seeds, box);
  test("one convex cell per seed, tiling the clip", () => {
    expect(cells.length).toBe(25);
    expect(cells.reduce((t, c) => t + area(c), 0)).toBeCloseTo(250000, 0);
    cells.forEach((c, i) => { expect(isConvex(c)).toBe(true); expect(pointInPoly(seeds[i], c)).toBe(true); });
  });
  test("cells don't overlap", () => {
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) expect(convexOverlap(cells[i], cells[j], -0.01), `${i} ${j}`).toBe(false);
  });
  test("two thousand seeds take under a second", () => {
    const big: Pt[] = [];
    const rr = new Rng("vor-big");
    for (let i = 0; i < 2000; i++) big.push([rr.range(0, 3000), rr.range(0, 3000)]);
    const t0 = performance.now();
    const out = voronoiCells(big, [[0, 0], [3000, 0], [3000, 3000], [0, 3000]]);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(out.reduce((t, c) => t + area(c), 0)).toBeCloseTo(9e6, -1);
  });
});
