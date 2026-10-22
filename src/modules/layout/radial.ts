// Street-plan layout for big villages, towns and cities (L1). Our own
// generator, written from scratch.
//
// The model: a market place at the centre; main roads running out from it
// through the gates; rings of back streets between them, cut by lanes into
// blocks. Every block is cut into burgage plots, narrow and deep, each with a
// building on the street front and a yard or garden behind. Where two streets
// meet, the corner plot goes to the better street (market, then main road,
// then street, then lane). Churches and religious houses take whole blocks.
// Beyond the wall, suburbs string out along the roads; the river has the
// mills and, downstream, the tanneries; on the coast there is a quay instead.
// Beyond all that are the open fields.

import { PI, TAU, atan2, cos, sin, q } from "../../core/dmath";
import type { Rng } from "../../core/rng";
import {
  add, along, area, centroid, convexOverlap, dist, dot, len, mul, norm, perp, pointInPoly, nearLine, project,
  qp, qpoly, rect, sub, type Poly, type Pt,
} from "./geom";
import type { Feature, FieldPiece, Footprint, PlacedBuilding, Road, Terrain } from "./hamlet";
import {
  PRIORITY, blob, boatPoly, building, compassOf, dirOf, insetOutline, isSuburbFp, nearestWard, plotsFor,
  type Enclosure, type FrontKind, type Plot, type Scale, type TownLayout, type WardGeo,
} from "./streets";

export type { Enclosure, FrontKind, Scale, TownLayout, WardGeo } from "./streets";
export { VALUE_CLASSES } from "./streets";


export interface TownOpts {
  scale: Scale;
  enclosure: Enclosure;
  /** main roads, and so gates */
  roads: number;
  terrain: Terrain;
  /** more room than the estimate asks for: 1 unless an earlier try left buildings without plots */
  room?: number;
  /** the DM's choices; each is rolled when left out */
  shape?: "round" | "oval" | "long";
  market?: "small" | "large";
  suburbs?: "few" | "many";
}






interface Block {
  id: string;
  ring: number;
  sector: number;
  phiA: (rho: number) => number;
  phiB: (rho: number) => number;
  inner: number;
  outer: number;
  W: number;
  outline: Poly;
  plots: number[];
  core?: Poly;
  ward: number;
  centre: Pt;
  area: number;
}



const lerp = (a: number, b: number, t: number) => a + (b - a) * t;


const CHURCH_SIZE: Record<string, [number, number]> = {
  grand_temple: [64, 20], temple: [38, 13], fane: [26, 10], chapel: [16, 7.5], chantry: [11, 6], shrine: [5, 4],
};

export function layoutRadial(r: Rng, plan: Footprint[], o: TownOpts): TownLayout {
  const urban = o.scale === "town" || o.scale === "city";
  const walled = o.enclosure === "wall" || o.enclosure === "palisade";
  const C: Pt = [0, 0];

  // ---- what has to fit -------------------------------------------------
  const GEO = new Set(["church", "precinct", "castle", "gate", "stream", "downstream", "river", "market_place"]);
  const coast = o.terrain === "coast";
  let needIn = 0, needOut = 0, churches = 0, precincts = 0;
  plan.forEach((p) => {
    const site = p.site === "green" ? "church" : p.site;
    if (site === "church") churches++;
    else if (site === "precinct") precincts++;
    else if (site === "suburb" || site === "edge" || (site === "shore" && !coast)) needOut += plotsFor(p);
    else if (!GEO.has(site ?? "") || (site === "gate" && !walled)) needIn += plotsFor(p);
  });
  // Some ordinary folk always live outside the gates.
  // On a roomier retry, fewer go outside: suburbs only grow along the roads,
  // and a town with two gates hasn't road enough for them.
  const retry = Math.max(0, 1 - ((o.room ?? 1) - 1) * 2.5);
  const spillShare = (urban ? 0.12 : 0.06) * (o.suburbs === "few" ? 0.25 : o.suburbs === "many" ? 2.5 : 1) * retry;
  const spill = Math.round(needIn * spillShare);
  needIn -= spill;
  needOut += spill;

  // ---- dimensions --------------------------------------------------------
  const plotW: [number, number] = urban ? [5.5, 8] : o.scale === "village" ? [10, 15] : [11, 16];
  const depth = urban ? r.range(17, 23) : r.range(30, 40);
  const street = urban ? 4.5 : 5;
  const mainW = urban ? 7 : 6;
  const laneW = urban ? 3 : 3.5;
  const blockLen: [number, number] = urban ? [55, 100] : [90, 160];
  // The market grows with the town: on market day a fifth of the place is in it.
  const marketR = (urban ? 20 + 0.55 * Math.sqrt(needIn * 6) : o.scale === "village" ? 20 + 0.42 * Math.sqrt(needIn * 6) : 18 + 0.3 * Math.sqrt(needIn * 6)) * (o.market === "small" ? 0.7 : o.market === "large" ? 1.5 : 1);

  // The whole plan is drawn in (angle, radius) and bent by a wobble, so the
  // town is not a circle. The finer terms drift with the radius, so the rings
  // of streets are not copies of each other.
  // One draw each whatever the shape, so choosing a shape moves nothing else.
  const [lo1, hi1, k2] = o.shape === "round" ? [0.02, 0.05, 0.5] : o.shape === "long" ? [0.03, 0.08, 0.5] : [0.13, 0.24, 1];
  // p1 is let: a long town turns to lie along its first main road, once the roads are known.
  const a1 = r.range(lo1, hi1), a2 = r.range(0.035, 0.07) * k2;
  let p1 = r.range(0, TAU);
  const p2 = r.range(0, TAU);
  const a3 = r.range(0.025, 0.05), a4 = r.range(0.02, 0.04), p3 = r.range(0, TAU), p4 = r.range(0, TAU);
  const l3 = r.range(90, 160), l4 = r.range(60, 110);
  // A long town is an ellipse about its high street (`axis`, set once the roads
  // are known), the same area as the circle, wobbled as usual.
  const LONG = 1.8;
  let axis = 0;
  const ell = (phi: number) => {
    if (o.shape !== "long") return 1;
    const c = cos(phi - axis), sn = sin(phi - axis);
    return 1 / Math.sqrt(LONG) / Math.sqrt((c * c) / (LONG * LONG) + sn * sn);
  };
  const f = (phi: number, rho: number) =>
    ell(phi) * (1 + a1 * sin(2 * phi + p1) + a2 * sin(3 * phi + p2) + a3 * sin(5 * phi + p3 + rho / l3) + a4 * sin(7 * phi + p4 - rho / l4));
  const P = (phi: number, rho: number): Pt => { const k = rho * f(phi, rho); return [C[0] + cos(phi) * k, C[1] + sin(phi) * k]; };
  /** How far outside the wall line a point is (negative inside), in metres. */
  let wallR = 0;
  const outside = (v: Pt): number => {
    const d = sub(v, C);
    return len(d) - wallR * f(atan2(d[1], d[0]), wallR);
  };

  // The sea, as a half-plane: everything beyond `seaD` along `seaN`.
  const seaPhi = r.range(0, TAU);
  const seaN = dirOf(seaPhi);
  let seaD = Infinity;
  const quayW = 7;
  const beyond = (p: Pt) => dot(sub(p, C), seaN);

  // Main roads: on the coast, only on the landward side.
  const k = Math.max(2, o.roads);
  const base = coast ? seaPhi + PI / 2 + 0.35 : r.range(0, TAU);
  const spread = coast ? PI - 0.7 : TAU;
  const theta0: number[] = [];
  for (let i = 0; i < k; i++) {
    const step = coast ? spread / Math.max(1, k - 1) : spread / k;
    theta0.push(base + i * step + r.range(-0.22, 0.22) * step * (coast && (i === 0 || i === k - 1) ? 0.3 : 1));
  }
  if (o.shape === "long") { axis = theta0[0]; p1 = PI / 2 - 2 * axis; }
  const curve = theta0.map(() => ({ k: r.range(0.03, 0.08) * (r.chance(0.5) ? 1 : -1), l: r.range(120, 260), ph: r.range(0, TAU) }));
  const theta = (i: number, rho: number): number => {
    const n = ((i % k) + k) % k;
    const c = curve[n];
    const wrap = Math.floor(i / k) * TAU;
    return theta0[n] + wrap + c.k * (sin(rho / c.l + c.ph) - sin(marketR / c.l + c.ph));
  };

  // ---- rings and blocks ----------------------------------------------------
  const plots: Plot[] = [];
  const blocks: Block[] = [];
  let runs = 0;
  const ringStreet: number[] = [marketR]; // centre radius of the street at the inside of each ring
  const ringOut: number[] = [];

  const sectorEnd = (i: number, rho: number) => {
    let b = theta(i + 1, rho);
    const a = theta(i, rho);
    while (b <= a) b += TAU;
    return b;
  };

  const makePlot = (poly: Poly, kind: FrontKind, run: number, idx: number, block: string, ring: number, order: number): number => {
    plots.push({ id: plots.length, poly, kind, ward: -1, run, idx, block, ring, used: false, order });
    return plots.length - 1;
  };

  // Cut the run between fractions into plots of jittered width.
  const cutRun = (length: number, wr: [number, number]): number[] => {
    const n = Math.floor(length / ((wr[0] + wr[1]) / 2));
    if (n < 1) return [];
    const ws: number[] = [];
    for (let i = 0; i < n; i++) ws.push(r.range(0.8, 1.25));
    const tot = ws.reduce((a, b) => a + b, 0);
    const out = [0];
    let acc = 0;
    for (const w of ws) { acc += w; out.push(acc / tot); }
    return out;
  };

  let capacity = 0;
  const reserveGuess = churches * (urban ? 9 : 5) + precincts * 20 + (urban && o.scale === "city" ? 40 : 0);
  for (let ring = 0; ring < 40; ring++) {
    const inner = ring === 0 ? marketR : ringStreet[ring] + street / 2;
    const bandH = 2 * depth * r.range(1.08, 1.4);
    const outer = inner + bandH;
    ringOut.push(outer);
    ringStreet.push(outer + street / 2);
    const mid = (inner + outer) / 2;
    for (let i = 0; i < k; i++) {
      // On the coast the last sector is the one that faces the sea.
      const span = (sectorEnd(i, mid) - theta(i, mid)) * mid;
      const m = Math.max(1, Math.round(span / r.range(blockLen[0], blockLen[1])));
      const t: number[] = [0];
      for (let l = 1; l < m; l++) t.push((l + r.range(-0.22, 0.22)) / m);
      t.push(1);
      for (let l = 0; l < m; l++) {
        const id = `k${ring}-${i}-${l}`;
        const hwA = l === 0 ? mainW / 2 : laneW / 2;
        const hwB = l === m - 1 ? mainW / 2 : laneW / 2;
        const kA: FrontKind = l === 0 ? "main" : "lane";
        const kB: FrontKind = l === m - 1 ? "main" : "lane";
        const kI: FrontKind = ring === 0 ? "market" : "street";
        // The outermost ring is decided only after we know it is the last; mark it later.
        const kO: FrontKind = "street";
        const phiA = (rho: number) => lerp(theta(i, rho), sectorEnd(i, rho), t[l]) + hwA / (rho * f(theta(i, rho), rho));
        const phiB = (rho: number) => lerp(theta(i, rho), sectorEnd(i, rho), t[l + 1]) - hwB / (rho * f(theta(i, rho), rho));
        const H = outer - inner;
        const W = (phiB(mid) - phiA(mid)) * mid;
        if (W < 9 || H < 9) continue;
        const dI = Math.min(depth, H * 0.48), dO = Math.min(depth, H * 0.48);
        const dA = Math.min(depth, W * 0.48), dB = Math.min(depth, W * 0.48);
        const block: Block = { id, ring, sector: i, phiA, phiB, inner, outer, W, outline: [], plots: [], ward: -1, centre: P((phiA(mid) + phiB(mid)) / 2, mid), area: W * H };
        // Outline, for churchyards and precincts.
        for (let s = 0; s <= 6; s++) { const rho = inner; block.outline.push(P(lerp(phiA(rho), phiB(rho), s / 6), rho)); }
        for (let s = 6; s >= 0; s--) { const rho = outer; block.outline.push(P(lerp(phiA(rho), phiB(rho), s / 6), rho)); }
        block.outline = qpoly(block.outline);

        const order0 = ring * 10 + r.range(0, 6);
        // Arc rows along the inner and outer streets.
        const arcRow = (front: number, back: number, kind: FrontKind, aWins: boolean, bWins: boolean, rowDepth: number) => {
          const sAt = (rho: number) => (aWins ? phiA(rho) + dA / rho : phiA(rho));
          const eAt = (rho: number) => (bWins ? phiB(rho) - dB / rho : phiB(rho));
          const length = (eAt(front) - sAt(front)) * front;
          const cuts = cutRun(length, plotW);
          const run = runs++;
          for (let c = 0; c + 1 < cuts.length; c++) {
            const poly = qpoly([
              P(lerp(sAt(front), eAt(front), cuts[c]), front),
              P(lerp(sAt(front), eAt(front), cuts[c + 1]), front),
              P(lerp(sAt(back), eAt(back), cuts[c + 1]), back),
              P(lerp(sAt(back), eAt(back), cuts[c]), back),
            ]);
            block.plots.push(makePlot(poly, kind, run, c, id, ring, order0));
          }
          void rowDepth;
        };
        // Side rows along the lanes or main roads.
        const sideRow = (atA: boolean, r0: number, r1: number, kind: FrontKind, d: number) => {
          const cuts = cutRun(r1 - r0, plotW);
          const run = runs++;
          for (let c = 0; c + 1 < cuts.length; c++) {
            const ra = lerp(r0, r1, cuts[c]), rb = lerp(r0, r1, cuts[c + 1]);
            const fr = (rho: number) => (atA ? phiA(rho) : phiB(rho));
            const bk = (rho: number) => (atA ? phiA(rho) + d / rho : phiB(rho) - d / rho);
            const poly = qpoly([P(fr(ra), ra), P(fr(rb), rb), P(bk(rb), rb), P(bk(ra), ra)]);
            block.plots.push(makePlot(poly, kind, run, c, id, ring, order0));
          }
        };
        // Who gets each corner: the better street; arcs win ties.
        const aOverI = PRIORITY[kA] > PRIORITY[kI], aOverO = PRIORITY[kA] > PRIORITY[kO];
        const bOverI = PRIORITY[kB] > PRIORITY[kI], bOverO = PRIORITY[kB] > PRIORITY[kO];
        arcRow(inner, inner + dI, kI, aOverI, bOverI, dI);
        arcRow(outer, outer - dO, kO, aOverO, bOverO, dO);
        sideRow(true, aOverI ? inner : inner + dI, aOverO ? outer : outer - dO, kA, dA);
        sideRow(false, bOverI ? inner : inner + dI, bOverO ? outer : outer - dO, kB, dB);
        // The middle of the block: gardens and back yards.
        const ci = inner + dI, co = outer - dO;
        if (co - ci > 4 && W - dA - dB > 4) {
          const core: Poly = [];
          for (let s = 0; s <= 4; s++) { const rho = ci; core.push(P(lerp(phiA(rho) + dA / rho, phiB(rho) - dB / rho, s / 4), rho)); }
          for (let s = 4; s >= 0; s--) { const rho = co; core.push(P(lerp(phiA(rho) + dA / rho, phiB(rho) - dB / rho, s / 4), rho)); }
          block.core = qpoly(core);
        }
        blocks.push(block);
      }
    }
    // How much room do we have, after the sea takes its share?
    if (coast && seaD === Infinity) seaD = (marketR + depth * 2.5) * r.range(1.3, 2.2);
    capacity = plots.filter((p) => !coast || p.poly.every((v) => beyond(v) < seaD - quayW - depth - 2)).length;
    if (capacity - reserveGuess >= needIn * 1.04 * (o.room ?? 1) && ring >= 1) break;
  }
  const lastRing = ringOut.length - 1;
  wallR = ringStreet[ringStreet.length - 1] + street / 2 + 2;
  // The outer rows of the last ring face the lane under the wall.
  const blockOf = new Map(blocks.map((b) => [b.id, b]));
  for (const p of plots) {
    if (p.ring !== lastRing || p.kind !== "street") continue;
    const blk = blockOf.get(p.block)!;
    if (len(sub(centroid(p.poly), C)) > len(sub(blk.centre, C))) p.kind = "wall";
  }

  // The sea takes what lies beyond the quay.
  const dropped = new Set<number>();
  if (coast) {
    for (const p of plots) if (p.poly.some((v) => beyond(v) > seaD - quayW - depth - 2)) dropped.add(p.id);
    for (const b of blocks) if (b.core && b.core.some((v) => beyond(v) > seaD - quayW - depth - 2)) b.core = undefined;
  }

  // ---- wall ---------------------------------------------------------------
  const wallPts: Pt[] = [];
  for (let s = 0; s < 180; s++) {
    const phi = (s / 180) * TAU;
    wallPts.push(qp(P(phi, wallR)));
  }
  let wallLine: Pt[] = wallPts;
  let wallClosed = true;
  if (coast) {
    // Only the landward arc: start just past the shore, walk round.
    const onLand = wallPts.map((p) => beyond(p) < seaD - 2);
    let start = onLand.findIndex((v, i) => v && !onLand[(i + wallPts.length - 1) % wallPts.length]);
    if (start < 0) start = 0;
    wallLine = [];
    for (let s = 0; s < wallPts.length; s++) {
      const i = (start + s) % wallPts.length;
      if (!onLand[i]) break;
      wallLine.push(wallPts[i]);
    }
    wallClosed = onLand.every((v) => v);
  }
  const towers: Pt[] = [];
  if (o.enclosure === "wall") {
    let acc = 0;
    for (let i = 1; i < wallLine.length; i++) {
      acc += dist(wallLine[i - 1], wallLine[i]);
      if (acc >= 46) { towers.push(wallLine[i]); acc = 0; }
    }
  }

  // ---- roads ---------------------------------------------------------------
  const roadFar = wallR * 1.15 + (urban ? 360 : 300) + Math.sqrt(needOut) * 18;
  const roads: Road[] = [];
  for (let i = 0; i < k; i++) {
    const pts: Pt[] = [];
    for (let rho = marketR - 1; rho <= roadFar; rho += 8) pts.push(qp(P(theta(i, rho), rho)));
    roads.push({ id: `road${i}`, kind: "road", width: mainW, points: pts });
  }
  const gates = walled
    ? roads.map((rd, i) => ({ p: qp(P(theta(i, wallR), wallR)), t: norm(sub(P(theta(i, wallR + 5), wallR + 5), P(theta(i, wallR - 5), wallR - 5))), road: rd.id }))
    : [];
  // A gatehouse straddles the road under the wall, a tower either side.
  const gateParts = (g: { p: Pt; t: Pt }) => {
    const across = perp(g.t);
    return {
      body: rect(g.p, across, mainW + 6, 8),
      towers: [rect(add(g.p, mul(across, (mainW + 6) / 2 + 2.5)), across, 5, 7), rect(add(g.p, mul(across, -(mainW + 6) / 2 - 2.5)), across, 5, 7)],
    };
  };
  // Clear any plot it would stand on.
  if (plan.some((p) => p.site === "gate")) for (const g of gates) {
    const { body, towers } = gateParts(g);
    for (const p of plots) if ([body, ...towers].some((x) => convexOverlap(p.poly, x, 0.3))) { dropped.add(p.id); p.used = true; }
  }

  // ---- river ----------------------------------------------------------------
  const riverW = urban ? r.range(9, 14) : r.range(4, 6);
  const riverPhi = coast ? seaPhi + PI * r.range(0.6, 1.4) : r.range(0, TAU);
  // The river runs hard under the wall on one side, as at most river towns: the
  // town grew at the crossing. Clear of its furthest point that way, which for
  // a lobed or long town is not the radius at that angle.
  let reach = wallR * f(riverPhi, wallR);
  const ru0 = dirOf(riverPhi);
  for (let k = 0; k < 120; k++) reach = Math.max(reach, dot(sub(P((k / 120) * TAU, wallR * 1.04), C), ru0));
  const riverOff = reach + r.range(9, 15);
  const rv0 = add(C, mul(dirOf(riverPhi), riverOff));
  const ru = perp(dirOf(riverPhi));
  const riverPts: Pt[] = [];
  const rph = r.range(0, TAU), rwl = r.range(90, 160), ramp = r.range(6, 12);
  for (let s = -roadFar * 1.4; s <= roadFar * 1.4; s += 8) {
    const lateral = ramp * (sin(s / rwl + rph) - sin(rph));
    riverPts.push(qp(add(add(rv0, mul(ru, s)), mul(dirOf(riverPhi), lateral))));
  }
  // On the coast the river runs down into the sea and stops there.
  const river = coast ? riverPts.filter((p) => beyond(p) < seaD + 4) : riverPts;
  const riverS0 = project(river, C);
  const bridges: Pt[] = [];
  for (const rd of roads) {
    let best = Infinity, at: Pt | undefined;
    for (const p of rd.points) {
      const s = project(river, p);
      const d = dist(p, along(river, s).p);
      if (d < best) { best = d; at = p; }
    }
    if (at && best < 6) bridges.push(at);
  }

  // ---- solids outside the wall: mills, tanneries ---------------------------
  const solids: Poly[] = [];
  const result: (PlacedBuilding | undefined)[] = [];
  const clearOutside = (poly: Poly, ofRiver = true): boolean => {
    for (const rd of roads) if (nearLine(rd.points, poly, rd.width / 2 + 1)) return false;
    if (ofRiver && nearLine(river, poly, riverW / 2 + 0.8)) return false;
    for (const s of solids) if (convexOverlap(poly, s, 1)) return false;
    if (poly.some((v) => outside(v) < 8)) return false;
    if (coast && poly.some((v) => beyond(v) > seaD - 3)) return false;
    return true;
  };
  const byRiver = (i: number, startOff: number, wheel: boolean): PlacedBuilding | undefined => {
    // The town side of the river is the side facing C.
    for (let n = 0; n < 60; n++) {
      const off = (n % 2 ? -1 : 1) * (startOff + 6 * Math.floor(n / 2));
      const a = along(river, riverS0 + off);
      let nn = perp(a.t);
      if (dot(nn, sub(C, a.p)) < 0) nn = mul(nn, -1);
      if (n >= 30) nn = mul(nn, -1); // try the far bank if the near one is full
      const w = r.range(10, 13), d = r.range(7.5, 9);
      const c = add(a.p, mul(nn, riverW / 2 + 2 + d / 2));
      const body = rect(c, a.t, w, d);
      if (!clearOutside(body)) continue;
      const yard = rect(add(c, mul(nn, 5)), a.t, w + 10, d + 14);
      if (!clearOutside(yard, false)) continue;
      solids.push(yard);
      const parts = wheel
        ? [{ kind: "wheel", poly: qpoly(rect(add(a.p, mul(nn, riverW / 2 - 0.4)), a.t, 4.5, 1.6)) }]
        : [{ kind: "vats", poly: qpoly(rect(add(c, mul(nn, d / 2 + 3)), a.t, w * 0.6, 3)) }];
      return { planIndex: i, poly: qpoly(body), parts, plot: qpoly(yard), plotKind: "yard", front: qp(a.p), road: "river" };
    }
    return undefined;
  };
  const downstream = r.chance(0.5) ? 1 : -1;
  plan.forEach((p, i) => {
    if (p.site === "stream") result[i] = byRiver(i, 18 + r.range(0, 40), true);
  });
  let dsAt = wallR * 0.9;
  plan.forEach((p, i) => {
    if (p.site === "downstream" || p.site === "river") {
      result[i] = byRiver(i, downstream * (p.site === "downstream" ? dsAt : dsAt * 0.5), false);
      dsAt += 22;
    }
  });

  // ---- suburbs: ribbons along the roads beyond the gates ------------------
  const subPlots: number[] = [];
  const nSub = roads.length;
  const shares = roads.map(() => r.range(0.5, 1.5));
  const shareTot = shares.reduce((a, b) => a + b, 0);
  const sw: [number, number] = [plotW[0] * 1.2, plotW[1] * 1.35];
  const sd = depth * 1.3;
  const laid: Poly[] = [];
  for (let i = 0; i < nSub; i++) {
    const want = Math.ceil((needOut * 1.12 * (o.room ?? 1) * shares[i]) / shareTot) + 2;
    const rd = roads[i];
    const s0 = project(rd.points, P(theta(i, wallR), wallR)) + (walled ? 18 : 10);
    for (const side of [1, -1]) {
      // A gap in the ribbon starts a new run, so a wide use never spans it.
      let run = runs++, idx = 0;
      const gap = () => { run = runs++; idx = 0; };
      let s = s0 + r.range(0, 6), made = 0, tries = 0;
      const sMax = Math.min(roadFar - 20, s0 + (want / 2) * ((sw[0] + sw[1]) / 2) * 1.6 + 40);
      while (made < Math.ceil(want / 2) && tries < want * 4 && s < sMax) {
        tries++;
        const w = r.range(sw[0], sw[1]);
        const a = along(rd.points, s), b = along(rd.points, s + w);
        const na = mul(perp(a.t), side), nb = mul(perp(b.t), side);
        const off = rd.width / 2 + 0.8;
        const poly = qpoly([add(a.p, mul(na, off)), add(b.p, mul(nb, off)), add(b.p, mul(nb, off + sd)), add(a.p, mul(na, off + sd))]);
        s += w;
        if (nearLine(river, poly, riverW / 2 + 1.5)) { s += 4; gap(); continue; }
        if (solids.some((x) => convexOverlap(poly, x, 0.5))) { gap(); continue; }
        // Where the road bends hard, a plot can swing across one already laid.
        if (laid.some((x) => convexOverlap(poly, x, 0.3))) { gap(); continue; }
        if (coast && poly.some((v) => beyond(v) > seaD - 3)) { gap(); continue; }
        laid.push(poly);
        const id = makePlot(poly, "suburb", run, idx++, `sub${i}`, 99, s);
        subPlots.push(id);
        made++;
        if (r.chance(0.06)) { s += r.range(5, 18); gap(); }
      }
    }
  }

  // ---- the quay -------------------------------------------------------------
  let quay: Pt[] | undefined;
  if (coast) {
    const u = perp(seaN);
    const base0 = add(C, mul(seaN, seaD - quayW));
    const reach = wallR * 1.2;
    quay = [qp(add(base0, mul(u, -reach))), qp(add(base0, mul(u, reach)))];
    let run = runs++;
    let t = -reach, idx = 0;
    while (t < reach) {
      const w = r.range(plotW[0] * 1.1, plotW[1] * 1.2);
      const a = add(base0, mul(u, t)), b = add(base0, mul(u, t + w));
      t += w;
      const poly = qpoly([a, b, add(b, mul(seaN, -depth)), add(a, mul(seaN, -depth))]);
      if (poly.some((v) => outside(v) > -street - 2) || roads.some((rd) => nearLine(rd.points, poly, rd.width / 2 + 0.5))) {
        run = runs++; idx = 0;
        continue;
      }
      makePlot(poly, "quay", run, idx++, "quay", 0, 5);
    }
  }

  // ---- wards -----------------------------------------------------------------
  // Intramural wards are a sector between two main roads and a band of rings.
  const nRings = ringOut.length;
  const groups = nRings >= 7 ? 3 : nRings >= 3 ? 2 : 1;
  const groupOf = (ring: number) => Math.min(groups - 1, Math.floor((ring * groups) / nRings));
  const wards: WardGeo[] = [];
  const wardIx = new Map<string, number>();
  const quarters = urban ? Math.min(4, k) : 1;
  const quarterOf = (sector: number) => Math.floor((sector * quarters) / k);
  for (let i = 0; i < k; i++) for (let g = 0; g < groups; g++) {
    wardIx.set(`${i}:${g}`, wards.length);
    wards.push({ id: wards.length, kind: "intramural", value: 0, quarter: quarterOf(i), centre: [0, 0], compass: "", sector: i, ring: g, adj: [], near: [] });
  }
  for (let i = 0; i < nSub; i++) {
    wardIx.set(`sub${i}`, wards.length);
    wards.push({ id: wards.length, kind: "suburb", value: 0, quarter: quarterOf(i), centre: [0, 0], compass: "", sector: i, ring: groups, adj: [], near: [] });
  }
  for (const b of blocks) b.ward = wardIx.get(`${b.sector}:${groupOf(b.ring)}`)!;
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  for (const p of plots) {
    if (p.block.startsWith("sub")) p.ward = wardIx.get(p.block)!;
    else if (p.block === "quay") p.ward = -2;
    else p.ward = blockById.get(p.block)!.ward;
  }
  // Quay plots join whichever intramural ward is nearest.
  const wardSum = wards.map(() => ({ x: 0, y: 0, n: 0 }));
  for (const p of plots) {
    if (p.ward < 0) continue;
    const c = centroid(p.poly);
    wardSum[p.ward].x += c[0]; wardSum[p.ward].y += c[1]; wardSum[p.ward].n++;
  }
  wards.forEach((w, i) => {
    const s = wardSum[i];
    w.centre = s.n ? qp([s.x / s.n, s.y / s.n]) : qp(P(theta(w.sector, wallR) + 0.3, wallR * 0.7));
  });
  for (const p of plots) if (p.ward === -2) {
    const c = centroid(p.poly);
    let best = 0, bd = Infinity;
    wards.forEach((w, i) => { if (w.kind === "intramural") { const d = dist(c, w.centre); if (d < bd) { bd = d; best = i; } } });
    p.ward = best;
  }
  // Adjacency: neighbouring bands and sectors; suburbs touch the outer wards beside their gate.
  const link = (a: number, b: number) => {
    if (a === b || a === undefined || b === undefined) return;
    if (!wards[a].adj.includes(b)) wards[a].adj.push(b);
    if (!wards[b].adj.includes(a)) wards[b].adj.push(a);
  };
  for (let i = 0; i < k; i++) for (let g = 0; g < groups; g++) {
    const w = wardIx.get(`${i}:${g}`)!;
    if (g + 1 < groups) link(w, wardIx.get(`${i}:${g + 1}`)!);
    if (!coast || i + 1 < k) link(w, wardIx.get(`${(i + 1) % k}:${g}`)!);
  }
  for (let i = 0; i < nSub; i++) {
    const s = wardIx.get(`sub${i}`)!;
    link(s, wardIx.get(`${i}:${groups - 1}`)!);
    link(s, wardIx.get(`${(i + k - 1) % k}:${groups - 1}`)!);
  }
  for (const w of wards) w.adj.sort((a, b) => a - b);

  // ---- reserved blocks: churches, precincts, a castle ----------------------
  const reserved = new Map<number, { block: Block; kind: string; size?: string; yard: Poly }>();
  const churchPlan = plan.map((p, i) => ({ p, i })).filter(({ p }) => p.site === "church" || p.site === "green");
  churchPlan.sort((a, b) => (CHURCH_SIZE[b.p.size]?.[0] ?? 10) - (CHURCH_SIZE[a.p.size]?.[0] ?? 10) || a.i - b.i);
  const churchAt: Pt[] = [];
  const sliced = new Set<string>();
  const freeBlock = (b: Block) => b.plots.length > 0 && !sliced.has(b.id) && b.plots.every((id) => !dropped.has(id));
  for (const { p, i } of churchPlan) {
    const [cw, cd] = CHURCH_SIZE[p.size] ?? [16, 7.5];
    if (p.size === "shrine") continue; // shrines stand in the street or market; placed with the rest
    const fits = blocks.filter((b) => freeBlock(b) && b.outer - b.inner >= cd + 12 && b.W >= cw + 14);
    if (!fits.length) continue;
    let pick: Block;
    if (!churchAt.length) {
      // The chief church stands just off the market.
      fits.sort((a, b) => a.ring - b.ring || dist(a.centre, C) - dist(b.centre, C));
      pick = fits[Math.min(fits.length - 1, r.int(0, 2))];
    } else {
      // The rest spread out: furthest from any church so far, with some noise.
      pick = fits.reduce((best, b) => {
        const s = Math.min(...churchAt.map((c) => dist(c, b.centre))) * r.range(0.8, 1.2);
        return s > best.s ? { b, s } : best;
      }, { b: fits[0], s: -1 }).b;
    }
    const yard = sliceBlock(pick, (cw + 14) / pick.W, r);
    reserved.set(i, { block: pick, kind: "church", size: p.size, yard });
    sliced.add(pick.id);
    churchAt.push(centroid(yard));
  }
  plan.forEach((p, i) => {
    if (p.site !== "precinct") return;
    const fits = blocks.filter((b) => freeBlock(b) && b.ring >= Math.max(0, nRings - 2) && b.outer - b.inner >= 30 && b.W >= 50);
    if (!fits.length) return;
    const pick = fits[r.int(0, fits.length - 1)];
    reserved.set(i, { block: pick, kind: "precinct", yard: sliceBlock(pick, 58 / pick.W, r) });
    sliced.add(pick.id);
  });

  // Take a slice of a block for a churchyard: every plot it touches goes, and
  // the slice grows to cover them, so nothing overlaps.
  function sliceBlock(b: Block, frac: number, rr: Rng): Poly {
    const tOf = (v: Pt): number => {
      const d = sub(v, C);
      let phi = atan2(d[1], d[0]);
      const l = len(d);
      const rho = l / f(phi, l);
      const a = b.phiA(rho), bb = b.phiB(rho);
      while (phi < a - PI) phi += TAU;
      while (phi > a + PI) phi -= TAU;
      return (phi - a) / (bb - a);
    };
    let u0: number, u1: number;
    if (frac >= 0.8) { u0 = 0; u1 = 1; } else {
      const c = rr.range(frac / 2, 1 - frac / 2);
      u0 = c - frac / 2; u1 = c + frac / 2;
    }
    for (let pass = 0; pass < 4; pass++) {
      let grew = false;
      for (const id of b.plots) {
        if (plots[id].used) continue;
        const ts = plots[id].poly.map(tOf);
        const lo = Math.min(...ts), hi = Math.max(...ts);
        if (hi <= u0 + 1e-6 || lo >= u1 - 1e-6) continue;
        plots[id].used = true;
        if (lo < u0) { u0 = Math.max(0, lo); grew = true; }
        if (hi > u1) { u1 = Math.min(1, hi); grew = true; }
      }
      if (!grew) break;
    }
    const out: Poly = [];
    for (let s2 = 0; s2 <= 6; s2++) { const rho = b.inner; out.push(P(lerp(b.phiA(rho), b.phiB(rho), lerp(u0, u1, s2 / 6)), rho)); }
    for (let s2 = 6; s2 >= 0; s2--) { const rho = b.outer; out.push(P(lerp(b.phiA(rho), b.phiB(rho), lerp(u0, u1, s2 / 6)), rho)); }
    if (b.core && u0 < 0.05 && u1 > 0.95) b.core = undefined;
    return qpoly(out);
  }

  let castle: Poly | undefined;
  const castleIdx = plan.findIndex((p) => p.site === "castle");
  if (castleIdx >= 0) {
    let at = -1, tries = 0;
    let cc: Pt = C;
    const cr = urban ? r.range(38, 55) : 28;
    while (tries++ < 40) {
      const sct = r.int(0, k - 1);
      const phi = lerp(theta(sct, wallR), sectorEnd(sct, wallR), r.range(0.35, 0.65));
      cc = P(phi, wallR + cr * 0.25);
      if (coast && beyond(cc) > seaD - cr - 10) continue;
      if (nearLine(river, rect(cc, [1, 0], cr * 2, cr * 2), riverW)) continue;
      at = sct;
      break;
    }
    if (at >= 0) {
      const curtain: Poly = [];
      for (let s = 0; s < 9; s++) curtain.push(add(cc, mul(dirOf((s / 9) * TAU + r.range(-0.1, 0.1)), cr * r.range(0.85, 1.1))));
      castle = qpoly(curtain);
      for (const p of plots) if (dist(centroid(p.poly), cc) < cr + 6) { p.used = true; dropped.add(p.id); }
      for (const b of blocks) if (b.core && dist(centroid(b.core), cc) < cr + 10) b.core = undefined;
      const keepU = norm(sub(cc, C));
      const keep = rect(add(cc, mul(keepU, cr * 0.25)), perp(keepU), 16, 16);
      const hall = rect(add(cc, mul(keepU, -cr * 0.35)), perp(keepU), 20, 8);
      result[castleIdx] = {
        planIndex: castleIdx, poly: qpoly(keep), parts: [{ kind: "hall", poly: qpoly(hall) }], plot: castle, plotKind: "bailey",
        front: qp(cc), road: "castle", ward: wardIx.get(`${at}:${groups - 1}`), block: "castle",
      };
      wards[wardIx.get(`${at}:${groups - 1}`)!].near.push("castle");
    }
  }
  for (const id of dropped) plots[id].used = true;

  // ---- ward values (LF Table 2:20) --------------------------------------
  // Rank the wards by how good an address they are (near the market, the
  // chief church or the castle is best; near the tanneries, worst), then hand
  // out value classes so each class has about as much room as the plan wants.
  const tanAt = river.length ? along(river, riverS0 + downstream * wallR).p : C;
  const chief = churchAt[0];
  const wardPlots = wards.map(() => 0);
  for (const p of plots) if (!p.used && p.ward >= 0) wardPlots[p.ward]++;
  const score = (w: WardGeo) => {
    let sc = -w.ring + r.range(-0.6, 0.6);
    if (chief && dist(w.centre, chief) < wallR * 0.45) sc += 0.7;
    if (w.near.includes("castle")) sc += 0.6;
    if (dist(w.centre, tanAt) < wallR * 0.7) sc -= 0.9;
    return sc;
  };
  const intra = wards.filter((w) => w.kind === "intramural");
  const scored = intra.map((w) => ({ w, s: score(w) })).sort((a, b) => b.s - a.s || a.w.id - b.w.id);
  const demand: number[] = [];
  plan.forEach((p, i) => {
    if (result[i] || reserved.has(i) || isSuburbFp(p, coast) || GEO.has(p.site ?? "")) return;
    const mid = p.value ? (p.value[0] + p.value[1]) / 2 : 4;
    for (let k = 0; k < plotsFor(p); k++) demand.push(mid);
  });
  demand.sort((a, b) => b - a);
  const total = scored.reduce((a, x) => a + wardPlots[x.w.id], 0) || 1;
  let acc = 0;
  for (const { w } of scored) {
    const at = Math.min(demand.length - 1, Math.floor(((acc + wardPlots[w.id] / 2) / total) * demand.length));
    acc += wardPlots[w.id];
    let v = Math.round(demand[Math.max(0, at)] ?? 3);
    // Wards on the market trade; wards under the wall live (odd classes are residential).
    const commercial = w.ring === 0;
    if (commercial && v % 2 === 1) v = Math.min(8, v + 1);
    if (!commercial && v % 2 === 0 && v > 0) v = v - 1;
    w.value = Math.max(0, Math.min(urban ? 8 : 4, v));
  }
  for (const w of wards) if (w.kind === "suburb") w.value = r.chance(0.55) ? 0 : 1;
  for (const w of wards) {
    const v = sub(w.centre, C);
    w.compass = compassOf(len(v) < 1 ? [0, -1] : v);
    if (dist(w.centre, C) < marketR + depth * 3 && w.kind === "intramural") w.near.push("market");
    if (bridges.some((b) => dist(b, w.centre) < wallR * 0.6)) w.near.push("bridge");
    if (river.length && nearLine(river, [w.centre, add(w.centre, [1, 0]), add(w.centre, [0, 1])], wallR * 0.45)) w.near.push("river");
    if (coast && beyond(w.centre) > seaD - wallR * 0.5) w.near.push("quay");
    if (chief && dist(w.centre, chief) < depth * 4) w.near.push("church");
  }

  // ---- assign uses to plots --------------------------------------------
  const gardenOnly = new Set<number>();
  const free = (id: number) => !plots[id].used && !gardenOnly.has(id);
  const runIx = new Map<number, number[]>();
  for (const p of plots) { const l = runIx.get(p.run); if (l) l.push(p.id); else runIx.set(p.run, [p.id]); }
  for (const l of runIx.values()) l.sort((a, b) => plots[a].idx - plots[b].idx);
  const buckets = new Map<string, { ids: number[]; ptr: number; left: number }>();
  const bucketOf = new Map<number, { left: number }>();
  for (const p of plots) {
    if (p.used) continue;
    const key = `${p.kind}:${wards[p.ward]?.value ?? 0}`;
    let bk = buckets.get(key);
    if (bk) { bk.ids.push(p.id); bk.left++; } else buckets.set(key, bk = { ids: [p.id], ptr: 0, left: 1 });
    bucketOf.set(p.id, bk);
  }
  const use = (id: number) => { plots[id].used = true; const bk = bucketOf.get(id); if (bk) bk.left--; };
  const room = (v: number, fronts: FrontKind[]) => fronts.reduce((a, fr) => a + (buckets.get(`${fr}:${v}`)?.left ?? 0), 0);
  for (const bk of buckets.values()) bk.ids.sort((a, b) => plots[a].order - plots[b].order || a - b);

  // Where each use has gone so far, so the next copy can keep away (or close).
  const placedAt = new Map<string, Pt[]>();
  let placing: Footprint | undefined;
  // Uses that compete for the same custom keep apart from each other too.
  const FAMILY: Record<string, string> = { tavern: "drink", town_alehouse: "drink", alehouse: "drink", inn: "drink", cookshop: "food", bakehouse: "food" };
  const familyOf = (k: string) => FAMILY[k] ?? k;
  const runOf = (id: number, n: number): number[] | undefined => {
    if (n === 1) return [id];
    const run = runIx.get(plots[id].run)!;
    const at = run.indexOf(id);
    const seq = run.slice(at, at + n);
    return seq.length === n && seq.every(free) ? seq : undefined;
  };
  const take = (front: FrontKind, v: number, n: number): number[] | undefined => {
    const bk = buckets.get(`${front}:${v}`);
    if (!bk) return undefined;
    while (bk.ptr < bk.ids.length && !free(bk.ids[bk.ptr])) bk.ptr++;
    const prior = placing?.kind ? placedAt.get(familyOf(placing.kind)) : undefined;
    if (!prior?.length) {
      for (let j = bk.ptr; j < Math.min(bk.ids.length, bk.ptr + 400); j++) {
        const id = bk.ids[j];
        if (!free(id)) continue;
        const seq = runOf(id, n);
        if (seq) return seq;
      }
      return undefined;
    }
    // Look at candidates across the whole queue, not just the next few, and
    // take the one furthest from the copies already placed (or nearest, for
    // trades that keep together).
    const stride = Math.max(1, Math.floor((bk.ids.length - bk.ptr) / 80));
    let best: number[] | undefined, bestScore = -Infinity;
    for (let j = bk.ptr; j < bk.ids.length; j += stride) {
      const id = bk.ids[j];
      if (!free(id)) continue;
      const seq = runOf(id, n);
      if (!seq) continue;
      const c = centroid(plots[id].poly);
      let near = Infinity;
      for (const q2 of prior) near = Math.min(near, dist(c, q2));
      const score = placing!.cluster ? -near : Math.min(near, 500) - plots[id].order * 0.5;
      if (score > bestScore) { bestScore = score; best = seq; }
    }
    return best;
  };
  const peek = (front: FrontKind, v: number): number | undefined => {
    const bk = buckets.get(`${front}:${v}`);
    if (!bk) return undefined;
    while (bk.ptr < bk.ids.length && !free(bk.ids[bk.ptr])) bk.ptr++;
    return bk.ptr < bk.ids.length ? bk.ids[bk.ptr] : undefined;
  };
  const FRONTS: Record<string, FrontKind[]> = {
    market: ["market", "main", "street", "quay"],
    main_road: ["main", "market", "street", "quay"],
    junction: ["main", "street", "market"],
    street: ["street", "main", "lane", "quay"],
    lane: ["lane", "wall", "street"],
    quay: ["quay", "main", "street"],
    shore: ["quay", "lane", "wall", "street"],
    housing: ["street", "lane", "main", "wall", "quay", "market"],
    suburb: ["suburb"],
  };
  const order = plan.map((_, i) => i).filter((i) => result[i] === undefined && !reserved.has(i));
  const isSuburb = (p: Footprint) => p.site === "suburb" || p.site === "edge" || (p.site === "shore" && !coast);
  const rank = (p: Footprint) => (p.site && !isSuburb(p) && p.site !== "gate" ? 0 : 1);
  const width = (p: Footprint) => (p.value ? p.value[1] - p.value[0] : 9);
  order.sort((a, b) => rank(plan[a]) - rank(plan[b]) || plotsFor(plan[b]) - plotsFor(plan[a]) || width(plan[a]) - width(plan[b]) || a - b);

  // The poorest housing spills out beyond the gates (LF p.84).
  const poorHousing = order.filter((i) => !plan[i].site && (plan[i].value?.[0] ?? 9) <= 1 || plan[i].site === "lane" && (plan[i].value?.[1] ?? 9) <= 1);
  const poorPlots = poorHousing.reduce((a, i) => a + plotsFor(plan[i]), 0);
  const spillFrac = poorPlots ? Math.min(0.9, spill / poorPlots) : 0;
  const spillOut = new Set(poorHousing.filter(() => r.chance(spillFrac)));
  // Room to spare inside the walls becomes gardens and orchards under the
  // wall, not gaps in the middle of town.
  {
    let needed = 0;
    for (const i of order) {
      const p = plan[i];
      if (isSuburb(p) || spillOut.has(i) || p.site === "market_place" || (p.site === "gate" && walled)) continue;
      needed += plotsFor(p);
    }
    const freeIn = plots.filter((p) => !p.used && p.kind !== "suburb");
    let surplus = freeIn.length - Math.ceil(needed * 1.03);
    freeIn.sort((a, b) => b.order - a.order || b.id - a.id);
    for (const p of freeIn) {
      if (surplus <= 0) break;
      if (p.kind === "main" || p.kind === "market" || p.kind === "quay") continue;
      use(p.id);
      p.used = false; // still free for drawing as a garden...
      gardenOnly.add(p.id); // ...but never built on
      surplus--;
    }
  }
  const gateQueue = gates.map((g, gi) => ({ g, gi }));
  const spillQueue: number[] = [];
  for (const i of order) {
    const p = plan[i];
    // Ordinary housing fills in order; everything else spreads out (or keeps together).
    placing = p.site || p.kind && !["tenement", "poor_row", "journeyman_house", "townhouse", "cottage", "farmhouse", "empty"].includes(p.kind) ? p : undefined;
    if (p.site === "gate" && gateQueue.length) {
      const { g, gi } = gateQueue.shift()!;
      const { body, towers: [tA, tB] } = gateParts(g);
      result[i] = {
        planIndex: i, poly: qpoly(body), parts: [{ kind: "tower", poly: qpoly(tA) }, { kind: "tower", poly: qpoly(tB) }],
        front: g.p, road: g.road, ward: wardIx.get(`${gi}:${groups - 1}`), block: "gate",
      };
      continue;
    }
    if (p.site === "market_place") {
      const u = dirOf(r.range(0, TAU));
      const at = add(C, mul(u, marketR * r.range(0.15, 0.35)));
      const hall = rect(at, perp(u), p.size === "hall" ? 18 : 12, p.size === "hall" ? 9 : 7);
      result[i] = { planIndex: i, poly: qpoly(hall), parts: [], front: qp(at), road: "market", ward: wardIx.get(`0:0`), block: "market" };
      continue;
    }
    const n = plotsFor(p);
    const lo = p.value?.[0] ?? 0, hi = p.value?.[1] ?? 8;
    const fronts = isSuburb(p) ? FRONTS.suburb : spillOut.has(i) ? ["suburb", ...FRONTS.housing] as FrontKind[] : FRONTS[p.site ?? "housing"] ?? FRONTS.housing;
    let got: number[] | undefined;
    const housing = !p.site && n === 1 && !spillOut.has(i);
    for (let widen = 0; !got && widen <= 8; widen++) {
      if (housing) {
        // Ordinary houses fill from the centre out, whatever street they face,
        // trading a ring or two of distance against a class of value. The
        // empty plots end up under the wall, as gardens.
        let best: number | undefined, bestCost = Infinity;
        for (const fr of fronts) for (let v = 0; v <= 8; v++) {
          const c = peek(fr, v);
          if (c === undefined) continue;
          const cost = plots[c].order + 10 * (v < lo ? lo - v : v > hi ? v - hi : 0);
          if (cost < bestCost) { bestCost = cost; best = c; }
        }
        if (best !== undefined) got = [best];
        break;
      }
      // Spread over the classes the use suits: the roomiest first.
      const vs: number[] = [];
      for (let v = Math.max(0, lo - widen); v <= Math.min(8, hi + widen); v++) if (!widen || v < lo || v > hi) vs.push(v);
      vs.sort((a, b) => room(b, fronts) - room(a, fronts) || a - b);
      for (const fr of fronts) {
        for (const v of vs) { got = take(fr, v, n); if (got) break; }
        if (got) break;
      }
      if (!got && isSuburb(p) && widen === 0) {
        // Suburban trades that find no room outside go to the back lanes.
        for (const fr of ["wall", "lane"] as FrontKind[]) for (let v = 0; v <= 8 && !got; v++) got = take(fr, v, n);
      }
    }
    if (!got && !isSuburb(p)) {
      // The town is full: out to the suburbs.
      for (let v = 0; v <= 8 && !got; v++) got = take("suburb", v, n);
    }
    if (!got && n > 1) {
      // No run long enough anywhere: settle for one plot.
      for (const fr of fronts) for (let v = 0; v <= 8 && !got; v++) got = take(fr, v, 1);
    }
    if (!got) { spillQueue.push(i); continue; }
    for (const id of got) use(id);
    if (p.kind) { const k = familyOf(p.kind); const l = placedAt.get(k) ?? []; l.push(centroid(plots[got[0]].poly)); placedAt.set(k, l); }
    result[i] = building(r, i, p, got.map((id) => plots[id]), urban);
  }

  // Churches, chapels and precincts in their blocks.
  for (const [i, x] of reserved) {
    const b = x.block;
    const p = plan[i];
    const yard = insetOutline(x.yard, 1.2);
    const c = centroid(yard);
    // Shrink to fit: a small block gets a small church, never one that spills
    // over the street into its neighbours.
    const fits = (polys: Poly[]) => polys.every((pl) => pl.every((pt) => pointInPoly(pt, yard)));
    let k = 1;
    if (x.kind === "church") {
      const [cw0, cd0] = CHURCH_SIZE[x.size ?? "chapel"] ?? [16, 7.5];
      for (; k > 0.35; k -= 0.08) if (fits([rect(add(c, [-cw0 * k * 0.12, 0]), [1, 0], cw0 * k * 0.76, cd0 * k), rect(add(c, [cw0 * k * 0.38, 0]), [1, 0], cw0 * k * 0.24, cd0 * k * 0.72)])) break;
      const cw = cw0 * k, cd = cd0 * k;
      // Facing east whatever the street does: chancel on the +x end.
      const nave = rect(add(c, [-cw * 0.12, 0]), [1, 0], cw * 0.76, cd);
      const chancel = rect(add(c, [cw * 0.38, 0]), [1, 0], cw * 0.24, cd * 0.72);
      const parts = [{ kind: "chancel", poly: qpoly(chancel) }];
      if (x.size === "grand_temple" || x.size === "temple") {
        parts.push({ kind: "transept", poly: qpoly(rect(add(c, [cw * 0.14, 0]), [1, 0], cd * 0.9, cd * 2.3)) });
        parts.push({ kind: "tower", poly: qpoly(rect(add(c, [-cw * 0.47, 0]), [1, 0], cd * 0.8, cd * 0.8)) });
      }
      result[i] = { planIndex: i, poly: qpoly(nave), parts, plot: yard, plotKind: "churchyard", front: qp(c), road: b.id, ward: b.ward, block: b.id };
      for (const w of wards) if (w.id === b.ward && !w.near.includes(p.size)) w.near.push(p.size);
    } else {
      // A religious house: its church along one side, a cloister beside it.
      for (; k > 0.3; k -= 0.07) if (fits([rect(add(c, [0, -9 * k]), [1, 0], 30 * k, 9 * k), rect(add(c, [0, 8 * k]), [1, 0], 20 * k, 16 * k)])) break;
      const ch = rect(add(c, [0, -9 * k]), [1, 0], 30 * k, 9 * k);
      const cl = rect(add(c, [0, 8 * k]), [1, 0], 20 * k, 16 * k);
      result[i] = { planIndex: i, poly: qpoly(ch), parts: [{ kind: "cloister", poly: qpoly(cl) }], plot: yard, plotKind: "precinct", front: qp(c), road: b.id, ward: b.ward, block: b.id };
    }
  }

  // Shrines, and anything that found no plot: in the street or on the market.
  for (const i of spillQueue) result[i] = undefined;
  plan.forEach((p, i) => {
    if (p.size !== "shrine" || result[i]) return;
    const u = dirOf(r.range(0, TAU));
    const at = add(C, mul(u, marketR * 0.7));
    result[i] = { planIndex: i, poly: qpoly(rect(at, [1, 0], 3.5, 3.5)), parts: [], front: qp(at), road: "market", ward: wardIx.get("0:0"), block: "market" };
  });

  const buildings = result.filter((b): b is PlacedBuilding => !!b);
  for (const b of buildings) if (b.ward === undefined) b.ward = nearestWard(wards, b.front);

  // Gardens: block cores and plots nobody took.
  const gardens: Poly[] = [];
  for (const b of blocks) if (b.core) gardens.push(b.core);
  for (const p of plots) if (!p.used && p.kind !== "suburb" && !dropped.has(p.id)) gardens.push(p.poly);

  // ---- the country round about -------------------------------------------
  let subMax = wallR * 1.16;
  for (const id of subPlots) if (plots[id].used) for (const v of plots[id].poly) subMax = Math.max(subMax, len(sub(v, C)));
  // Fields begin a little beyond the wall; pieces that would sit on a suburb are left out.
  const fieldIn = Math.min(subMax + 25, wallR * 1.18 + 45);
  const subCorners: Pt[] = [];
  for (const id of subPlots) if (plots[id].used) subCorners.push(...plots[id].poly);
  for (const sb of solids) subCorners.push(...sb);
  const open = o.terrain === "farmland";
  const nFields = open ? 3 : 2;
  const crops = open ? r.shuffle(["wheat", "barley and oats", "fallow"]) : r.shuffle(["oats", "barley"]);
  const cuts = [r.range(0, TAU)];
  for (let fi = 1; fi < nFields; fi++) cuts.push(cuts[fi - 1] + r.range(0.85, 1.15) * (TAU / nFields));
  const band = (open ? r.range(120, 170) : r.range(70, 100)) * (urban ? 1.2 : 1);
  const fields: FieldPiece[] = [];
  const greatFields: { crop: string; label: Pt }[] = [];
  const inSea = (p: Pt) => coast && beyond(p) > seaD;
  for (let fi = 0; fi < nFields; fi++) {
    const a0 = cuts[fi], a1f = fi === nFields - 1 ? cuts[0] + TAU : cuts[fi + 1];
    const nf = Math.max(3, Math.round(((a1f - a0) * (fieldIn + band)) / 140));
    for (let j = 0; j < nf; j++) {
      const s0 = a0 + ((a1f - a0) * j) / nf + 0.006, s1 = a0 + ((a1f - a0) * (j + 1)) / nf - 0.006;
      for (let ring = 0; ring < 2; ring++) {
        const rIn = fieldIn + ring * band * 0.55, rOut = fieldIn + (ring + 1) * band * 0.55 - 3;
        const poly: Poly = [];
        for (let s = 0; s <= 5; s++) poly.push(add(C, mul(dirOf(lerp(s0, s1, s / 5)), rIn)));
        for (let s = 5; s >= 0; s--) poly.push(add(C, mul(dirOf(lerp(s0, s1, s / 5)), rOut)));
        if (poly.some(inSea) || nearLine(river, poly, riverW / 2 + 2)) continue;
        if (subCorners.some((c) => pointInPoly(c, poly))) continue;
        if (roads.some((rd) => nearLine(rd.points, poly, rd.width / 2 + 1))) continue;
        const mida = (s0 + s1) / 2;
        fields.push({ field: fi, poly: qpoly(poly), stripes: q(((r.chance(0.5) ? mida : mida + PI / 2) * 180) / PI + r.range(-12, 12)) });
      }
    }
    const la = (a0 + a1f) / 2;
    greatFields.push({ crop: crops[fi], label: qp(add(C, mul(dirOf(la), fieldIn + band * 0.55))) });
  }
  const outerR = fieldIn + band * 1.1;
  const woods: Poly[] = [];
  const features: Feature[] = [];
  const nw = o.terrain === "forest" ? 14 : r.int(2, 4);
  for (let j = 0; j < nw; j++) {
    const a = o.terrain === "forest" ? (j / nw) * TAU + r.range(-0.1, 0.1) : r.range(0, TAU);
    const c = add(C, mul(dirOf(a), outerR + r.range(30, 80)));
    if (inSea(c)) continue;
    woods.push(blob(r, c, r.range(50, 85)));
  }
  let contours: Poly[] | undefined;
  if (o.terrain === "moor") for (let j = 0; j < 5; j++) features.push({ kind: "fold", p: qp(add(C, mul(dirOf(r.range(0, TAU)), outerR + r.range(10, 120)))) });
  if (o.terrain === "hills") {
    const ah = r.range(0, TAU);
    const hill = add(C, mul(dirOf(ah), outerR + 120));
    const shape = blob(r, [0, 0], 1);
    contours = [60, 110, 160, 210].map((rad) => qpoly(shape.map((p) => add(hill, mul(p, rad)))));
    for (let j = 0; j < 3; j++) {
      const p = add(hill, mul(dirOf(ah + PI + r.range(-0.9, 0.9)), r.range(80, 140)));
      features.push({ kind: "adit", p: qp(p) });
      features.push({ kind: "spoil", p: qp(p), poly: blob(r, add(p, mul(dirOf(r.range(0, TAU)), 9)), r.range(7, 12)) });
    }
  }
  if (o.terrain === "forest") for (let j = 0; j < 6 && woods.length; j++) {
    const w = woods[r.int(0, woods.length - 1)];
    features.push({ kind: "clamp", p: qp(add(centroid(w), mul(dirOf(r.range(0, TAU)), r.range(0, 25)))) });
  }
  // The market's furniture.
  const market_town = urban || o.scale === "village";
  features.push({ kind: market_town ? "cross" : "well", p: qp(add(C, [marketR * 0.1, -marketR * 0.2])) });
  features.push({ kind: "well", p: qp(add(C, [-marketR * 0.35, marketR * 0.3])) });
  features.push({ kind: "stocks", p: qp(add(C, [marketR * 0.4, marketR * 0.25])) });
  for (const b of bridges) features.push({ kind: "bridge", p: b });
  if (market_town) {
    // The town's furniture of law and order, and the butts where the men practise on Sundays.
    features.push({ kind: "pillory", p: qp(add(C, [-marketR * 0.1, -marketR * 0.5])) });
    if (urban) features.push({ kind: "conduit", p: qp(add(C, [marketR * 0.35, -marketR * 0.45])) });
    const outRoad = (i: number, rho: number, side: number): Pt => {
      const a = P(theta(i, rho), rho), b = P(theta(i, rho + 6), rho + 6);
      return qp(add(a, mul(perp(norm(sub(b, a))), side * (mainW + 14))));
    };
    features.push({ kind: "gallows", p: outRoad(0, wallR + 110, 1) });
    features.push({ kind: "butts", p: outRoad(k > 1 ? 1 : 0, wallR + 70, -1) });
    if (bridges.length && urban) features.push({ kind: "bridge_chapel", p: bridges[0] });
  }

  const market: Poly = [];
  for (let s = 0; s < 24; s++) market.push(P((s / 24) * TAU, marketR));
  let sea: Poly | undefined, coastLine: Pt[] | undefined;
  const extent = outerR + 140;
  if (coast) {
    const u = perp(seaN);
    const b0 = add(C, mul(seaN, seaD));
    coastLine = [qp(add(b0, mul(u, -extent * 1.5))), qp(add(b0, mul(u, extent * 1.5)))];
    sea = qpoly([coastLine[0], coastLine[1], add(coastLine[1], mul(seaN, extent * 3)), add(coastLine[0], mul(seaN, extent * 3))]);
    // Boats at the quay.
    for (let j = 0; j < 10; j++) {
      const t = r.range(-wallR * 0.8, wallR * 0.8);
      const p = add(add(C, mul(seaN, seaD + r.range(4, 14))), mul(u, t));
      features.push({ kind: "boat", p: qp(p), poly: qpoly(boatPoly(p, norm(add(u, mul(seaN, r.range(-0.2, 0.2)))), r.range(8, 16))) });
    }
  }

  return {
    kind: "town",
    plan: "radial",
    scale: o.scale,
    enclosure: o.enclosure,
    bounds: [q(C[0] - extent), q(C[1] - extent), q(extent * 2), q(extent * 2)],
    roads,
    stream: { width: q(riverW), points: river },
    ford: bridges[0] ?? qp(rv0),
    green: qpoly(market),
    hedge: wallPts,
    fields,
    greatFields,
    meadow: river,
    woods,
    features,
    terrain: o.terrain,
    ...(coastLine ? { coast: coastLine, sea } : {}),
    ...(contours ? { contours } : {}),
    buildings,
    wall: { line: wallLine, closed: wallClosed, towers, gates: gates.map((g) => ({ p: g.p, t: qp(g.t), road: g.road })) },
    market: qpoly(market),
    gardens,
    wards,
    bridges,
    ...(quay ? { quay } : {}),
    ...(castle ? { castle } : {}),
  };
}

export { area };
