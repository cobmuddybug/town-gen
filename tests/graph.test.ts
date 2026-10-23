// The blocks between streets: streets are noded where they cross, and the faces between them are
// the blocks, inset by half of each street's width.
import { describe, expect, test } from "vitest";
import { blockFaces, deadEnds, nodeStreets } from "../src/modules/layout/graph";
import { area, pointInPoly, type Poly } from "../src/modules/layout/geom";

const hash = [
  { id: "h1", width: 6, points: [[-10, 30], [110, 30]] as [number, number][] },
  { id: "h2", width: 6, points: [[-10, 70], [110, 70]] as [number, number][] },
  { id: "v1", width: 6, points: [[30, -10], [30, 110]] as [number, number][] },
  { id: "v2", width: 6, points: [[70, -10], [70, 110]] as [number, number][] },
];
const square: Poly = [[0, 0], [100, 0], [100, 100], [0, 100]];

describe("blocks between streets", () => {
  test("a # of four streets in a square makes nine blocks, the middle one closed", () => {
    const faces = blockFaces(nodeStreets(hash), square);
    expect(faces.length).toBe(9);
    const middle = faces.find((f) => pointInPoly([50, 50], f.outline))!;
    expect(middle.open).toBe(false);
    // 40 between centre lines, less half of each 6 m street: 34 x 34.
    expect(area(middle.outline)).toBeCloseTo(34 * 34, 0);
    expect(middle.sides.map((s) => s.street).sort()).toEqual(["h1", "h2", "v1", "v2"]);
    const corner = faces.find((f) => pointInPoly([10, 10], f.outline))!;
    expect(corner.open).toBe(true);
    expect(corner.sides.map((s) => s.street).sort()).toEqual(["h1", "v1"]);
  });

  test("a dead-end lane splits no block and is reported", () => {
    const streets = [...hash, { id: "lane", width: 3, points: [[30, 50], [50, 50]] as [number, number][] }];
    const g = nodeStreets(streets);
    expect(blockFaces(g, square).length).toBe(9);
    expect(deadEnds(g, square).map((d) => d.street)).toEqual(["lane"]);
  });

  test("ends within the snap distance join", () => {
    const streets = [
      { id: "a", width: 4, points: [[0, 0], [100, 0]] as [number, number][] },
      { id: "b", width: 4, points: [[100, 2], [100, 100]] as [number, number][] },
      { id: "c", width: 4, points: [[100, 100], [0, 100]] as [number, number][] },
      { id: "d", width: 4, points: [[0, 100], [1.5, 1]] as [number, number][] },
    ];
    const faces = blockFaces(nodeStreets(streets, 3));
    expect(faces.length).toBe(1);
    expect(faces[0].open).toBe(false);
  });

  test("the same streets give the same blocks", () => {
    expect(JSON.stringify(blockFaces(nodeStreets(hash), square))).toBe(JSON.stringify(blockFaces(nodeStreets(hash), square)));
  });
});
