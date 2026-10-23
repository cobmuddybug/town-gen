# Dense Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every street plan fills real blocks (shop, ordinary, courtyard, well-off, church, green, precinct, croft) wall to wall, towns get tighter, every layout has height and contours, the radial plan becomes an organic plan, and towns gain greens, private gardens and graveyards.

**Architecture:** The grown engine (`layout/grown.ts`) stays the one pipeline: site → streets (per form) → **blocks (new, shared)** → lots → wards → placement → wall pull-in → output. A new `graph.ts` nodes the streets and finds the blocks between them; a new `blocks.ts` cuts each block (or a ribbon along a lone road) into lots and shapes buildings on them. The radial plan is replaced by an `organic` form whose streets are the edges of Voronoi cells. Forms switch to blocks one at a time behind a `BLOCKED` set until all have.

**Tech Stack:** TypeScript, Vite, Vitest; no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-23-dense-blocks-design.md` (read it first, then `docs/ideas/layout-lessons.md`).

## Global Constraints

- Clean-room: never open, copy or port watabou's (or any GPL) code. Every algorithm here is written fresh.
- `src/core` and `src/modules` use `dmath` only: no `Math.sin/cos/atan2/hypot/pow/exp/log`; `Math.sqrt/abs/min/max/floor` are fine. No `Math.random()`.
- No runtime dependencies.
- Same seed and settings give the same town; a DM choice overrides a roll but never skips its draw.
- The building plan (uses, households, people) does not change; only where buildings stand and their shape.
- Layout major version bumps to 3.0.0 (saves break, by the user's leave); CHANGELOG says so.
- Every layout within 2× its own 30,000-person time measured in Task 0, on the same machine (`PERF=1`).
- Density targets inside the walls of towns of 1,001+: building cover 40–65% in shop and ordinary blocks, 30–45% over the walled area; 110–220 people/ha; mean building 60–140 m².
- Corner lots: split between the two streets 60%, one L-shaped building 40%.
- Look at the map (tools/ui-smoke.sh with `URLHASH='#seed=…&pop=…&base=agricultural&era=high_medieval&layout=…'`) at the end of every task that changes a layout, and show the user after Tasks 6, 7, 8 and 9.

## Review Focus

1. The smallest street plans (701–1,000 people): blocks still fill, no town of three blocks and empty fields. Test in Task 6.
2. Water: a river, the sea or a quay cutting a block must never leave a lot or building in the water. Test in Task 7.
3. DM choices (walls none/palisade/wall, suburbs few/many, market small/large, shape) still change the map visibly. Test in Task 8.
4. Steep ground (hills terrain): blocks on a slope stay fillable; streets don't run up the steepest line except as lanes. Test in Task 6.
5. Edits rebuild from the layout cache: an edit to a person must not move any building (cache key unchanged). Test in Task 12.

---

### Task 0: Branch, baselines, ledger

**Files:** none in src.

- [ ] **Step 1:** `git checkout -b dense-blocks fix-flat-buildings`.
- [ ] **Step 2:** Measure today's 30,000-person layout time per plan (radial, river, ridge, castle, street, crossroads, abbey, harbour), median of 3 fresh seeds each, with a scratch test; write the numbers into the ledger as `Baseline 30k: <plan> <ms>`.
- [ ] **Step 3:** Record today's density table (people/ha, cover, mean building) for river/castle/radial at 1,500 / 6,000 / 25,000 in the ledger, for before-and-after.

### Task 1: Geometry for blocks

**Files:**
- Modify: `src/modules/layout/geom.ts`
- Test: `tests/geom.test.ts` (create)

**Interfaces:**
- Produces: `insetPoly(p: Poly, d: number): Poly` (offset every edge inward by d and meet neighbours; drops edges that vanish; works on mildly concave polygons), `clipHalfPlane(p: Poly, a: Pt, n: Pt): Poly` (keep the side where `dot(x-a, n) >= 0`), `voronoiCells(seeds: Pt[], clip: Poly): Poly[]` (cell i for seed i, clipped to `clip`; neighbours found by a grid so it scales to 2,000 seeds), `isConvex(p: Poly): boolean`.

- [ ] **Step 1: Failing tests:** `insetPoly` of a 100×80 rectangle by 10 has area 80×60 ± 0.5; of an L-shape by 5 stays inside the original (every vertex `pointInPoly`); `voronoiCells` of a 5×5 jittered grid in a 500×500 square: 25 cells, areas sum to 250,000 ± 1, no two cells overlap (`convexOverlap(a,b,-0.01)` false), each seed inside its own cell; 2,000 seeds finish under 1 s.
- [ ] **Step 2:** `npx vitest run tests/geom.test.ts` → FAIL (not exported).
- [ ] **Step 3:** Implement. Voronoi by half-plane clipping against the k nearest seeds (k grows until the cell's farthest vertex is nearer than half the next seed's distance).
- [ ] **Step 4:** Run → PASS. `npm run check` green.
- [ ] **Step 5:** Commit `Geometry: inset, half-plane clip, Voronoi cells`.

### Task 2: The street graph and its blocks

**Files:**
- Create: `src/modules/layout/graph.ts`
- Test: `tests/graph.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `interface Side { street: string; width: number; a: Pt; b: Pt }`
  - `interface Face { outline: Poly; sides: Side[]; open: boolean }` (`outline` is the block between the streets' edges, i.e. inset by each side's half width; `open` when part of its boundary is the closing edge, not a street)
  - `nodeStreets(streets: { id: string; width: number; points: Pt[] }[], snap = 3): StreetGraph` (split at crossings, snap ends within `snap`, keep dead ends)
  - `blockFaces(g: StreetGraph, close?: Poly): Face[]` (bounded faces of the planar graph; faces touching `close` are closed by it and marked `open`)
  - `deadEnds(g: StreetGraph): { street: string; points: Pt[] }[]`

- [ ] **Step 1: Failing tests:** two horizontal and two vertical streets crossing (a `#`, width 6) with `close` = the bounding square → 9 faces, the centre one not `open`, its outline 4 sides each inset 3 from the street lines; a T junction plus a dead-end lane: the lane appears in `deadEnds` and splits no face; same input twice → identical output (deep equal).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with a half-edge structure: at each node sort outgoing edges by angle (`atan2` from dmath), walk next-edge-clockwise to trace faces, drop the unbounded one.
- [ ] **Step 4:** Run → PASS; `npm run check`.
- [ ] **Step 5:** Commit `Street graph: node streets, find the blocks between them`.

### Task 3: Cutting blocks and ribbons into lots

**Files:**
- Create: `src/modules/layout/blocks.ts`
- Modify: `src/modules/layout/streets.ts` (export `Lot`; `building()` stays for hamlets and untouched forms until Task 8)
- Test: `tests/blocks.test.ts`

**Interfaces:**
- Consumes: `Face`, `Side` (Task 2); `leftToRight` (streets.ts).
- Produces:
  - `type BlockKind = "shop" | "ordinary" | "courtyard" | "wellOff" | "church" | "green" | "precinct" | "croft"`
  - `const KIND_SPEC: Record<BlockKind, { lotW: [number, number]; depth: [number, number]; yard: "sliver" | "small" | "court" | "garden" | "none" }>` with shop `{ lotW: [4.5, 7], depth: [12, 20] }`, ordinary `{ [5, 9], [9, 14] }`, courtyard `{ [12, 22], [9, 13] }`, wellOff `{ [14, 24], [10, 15] }`, croft `{ [8, 12], [5, 7] }` (church, green, precinct have no lots of their own beyond the edge houses the yard leaves)
  - `interface Lot extends Plot { street: string; kindOfBlock: BlockKind; corner?: "split" | "L"; far: boolean; suburb: boolean }` (`poly` is front-left, front-right, back-right, back-left; `run` = one block edge or ribbon; `idx` along it, left to right as the lots face the street)
  - `interface Open { kind: "yard" | "court" | "green" | "garden" | "graveyard"; poly: Poly; private?: boolean }`
  - `fillBlock(r: Rng, face: Face, kind: BlockKind, front: (s: Side) => FrontKind, ids: { next: number; run: number }): { lots: Lot[]; open: Open[] }`
  - `cutRibbon(r: Rng, line: Pt[], side: 1 | -1, kind: BlockKind, street: string, front: FrontKind, clear: (p: Poly) => boolean, ids: { next: number; run: number }): Lot[]` (lots square to the road; plot ends at a back fence one lot deep; denser near `line[0]`, gaps further out for croft)
  - `shapeOn(r: Rng, i: number, fp: Footprint, lots: Lot[], kind: BlockKind): PlacedBuilding` (house to the kind's depth across all its lots, sharing side walls; two or more lots of an inn/merchant/warehouse/yard make an L or a range round a yard; uses `leftToRight`)

- [ ] **Step 1: Failing tests** (a 120×100 quadrilateral face with four 6 m streets; seeds fixed):
  - lots of one edge share side walls: consecutive lots' back-left/back-right and front corners coincide (≤ 0.05 m); no two lots overlap (`convexOverlap(a, b, -0.2)` false); every lot inside the outline;
  - shop block: lots 4.5–7 m wide, buildings (via `shapeOn` with a 1-lot footprint on every lot) cover 55–80% of the outline; ordinary 40–65%; courtyard leaves one `court` open of at least 20% of the outline; wellOff leaves `garden` opens with `private: true`;
  - corners: over 200 seeded blocks, 50–70% of corners `split`, the rest `L`; no building has an interior angle under 50°;
  - an L-shaped (concave) face: every lot inside, no overlaps;
  - `cutRibbon` along a 200 m straight road: lots square to it (front edge parallel within 2°), back fence at the kind's depth, croft lots have gaps, shop lots none.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Corners first (the corner square at each block corner, split or L), then each edge's straight stretch between corners cut left to right; the middle is what's left of `insetPoly(outline, depth)`, filled per `yard`.
- [ ] **Step 4:** Run → PASS; `npm run check`.
- [ ] **Step 5:** Commit `Blocks: lots wall to wall round a block, ribbons along a road`.

### Task 4: Height and contours for every plan

**Files:**
- Modify: `src/modules/layout/height.ts` (move `contourLines` here from `grown.ts:1762`), `src/modules/layout/hamlet.ts`, `src/modules/layout/streets.ts` (`TownLayout.contourLines`), `src/modules/layout/hamlet.ts` (`HamletLayout.contourLines?: Pt[][]`), `src/ui/map.ts`
- Test: `tests/height.test.ts`

**Interfaces:**
- Produces: `contourLines(height: (p: Pt) => number, c: Pt, half: number, n: number): Pt[][]` (exported from height.ts); `HamletLayout.contourLines?: Pt[][]` drawn by map.ts as `m-contour` open paths. The hamlet's decorative `contours` rings go when a height field is present.

- [ ] **Step 1: Failing tests:** a hamlet (pop 120, farmland) and a village (pop 600, hills) both have `contourLines.length >= 3`; the hamlet's houses all stand where the height slope is under 0.35 per 100 m (no house on the steepest ground); `renderMap` of each contains `class="m-contour"`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Hamlet: draw a height field (`heightField(r, extent)`) after its existing draws (append, so earlier draws keep their values), place the green on easy ground, emit contours. Grown: import `contourLines` from height.ts, output `contourLines`.
- [ ] **Step 4:** Run → PASS; `npm run check` (hamlet golden moves: update with `-u` per file and say so in the commit).
- [ ] **Step 5:** Commit `Height and contours for villages; contours shared`.

### Task 5: Blocks in the grown engine

**Files:**
- Modify: `src/modules/layout/grown.ts` (the "plots along every street front" section, wards, churches/precincts, placement's run lookups, output)
- Test: `tests/forms.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: `const BLOCKED: Form[]` (forms that use blocks; starts `[]`, grows in Tasks 6–8); `TownLayout.blocks: { outline: Poly; kind: BlockKind; ward: number }[]` and `TownLayout.opens: Open[]` (empty for forms not yet blocked).
  - For a blocked form: `nodeStreets(net.streets)` → `blockFaces(g, closeLine)` where `closeLine` is the wall line if walled, else `insetPoly` of the outer streets' hull grown by one block depth; open faces wider than 2× the ordinary depth are not filled: their street edges become ribbons (`cutRibbon`, `croft` beyond the wall, `ordinary` within).
  - Block kind: from the ward value class of its centre and its fronts (market or high street front and value ≥ 4 → shop; value ≥ 7 → wellOff; a fifth of value 2–4 blocks over 60 m across → courtyard; else ordinary); church and green kinds are assigned in Task 9.
  - Lots become the engine's `RPlot`s (Lot is assignment-compatible); multi-plot uses take runs from `runFrom` as now; buildings are shaped by `shapeOn` (blocked forms) or `building` (not yet).
  - Wards: k-means over block centres instead of plot centres for blocked forms.

- [ ] **Step 1: Failing test:** with a test-only form flag `BLOCKED` forced to include `river` through a module-level setter `setBlockedForTest(forms: Form[])`, a 3,000-person river town: `map.blocks.length >= 20`, every lot belongs to a block or a ribbon, the no-overlap and in-the-water tests (existing `trouble()`) find nothing, and the flat-building test passes.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the blocks step behind `BLOCKED`.
- [ ] **Step 4:** Run → PASS; with `BLOCKED` empty the river guard (`tests/layout-river-guard.test.ts`) still passes byte for byte.
- [ ] **Step 5:** Commit `Grown engine: blocks behind a switch`.

### Task 6: The organic plan replaces radial

**Files:**
- Create: `src/modules/layout/organic.ts`
- Modify: `grown.ts` (`Form` gains `"organic"`; `BLOCKED = ["organic"]`), `layout/index.ts` (plan `radial` → `layoutGrown(…, { form: "organic" })`), `uses/urban.ts` (LAYOUT_ODDS: `radial` keeps its weight), `ui/newtown.ts` and `ui/library.ts` (label "organic" for value `radial`)
- Delete: `src/modules/layout/radial.ts`, `tests/layout-radial.test.ts` (the radial guard retires; note it in the commit)
- Test: `tests/forms.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5; `riverSite`/height from grown.ts; `growRoad` (move it to `streets.ts` if it is not exported).
- Produces: `organicStreets(r: Rng, site: RiverSite, o: RiverOpts): StreetNet` (market on easy ground near the high point; 3–5 roads out at uneven bearings via `growRoad`; seeds in pairs half a block either side of each road every block length, the rest in jittered rings with spacing growing from 35–60 m at the core to 70–110 m at the edge; cells clipped to the town disc; streets = cell edges, widths: road chains as main, edges round the market as market, cell edges whose slope exceeds 0.25 per 10 m as lanes of width 2.5; the wall round the inner cells).

- [ ] **Step 1: Failing tests** (`describe("organic towns")`), for pops 800, 3,000, 12,000 and terrains farmland and hills:
  - blocks are irregular: vertex counts span at least 4 different values; block areas' coefficient of variation ≥ 0.3; the core's median block is smaller than the edge's;
  - roads out bend: each main road's direction changes by ≥ 8° somewhere along it;
  - every block of an intramural ward is filled (`opens` of kind yard/court are inside a block with lots);
  - 800 people: at least 6 blocks with lots and building cover in the walled area ≥ 30% (Review Focus 1);
  - hills: no main street segment longer than 30 m climbs more than 0.3 per 10 m (Review Focus 4);
  - `contourLines.length >= 3`; same seed twice → same map.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `organic.ts`; wire the plan id; delete radial.ts and its guard; fix the tests that named radial (river.test roll odds, perf.test, town.test plan-aware snapshots: update with `-u` per file).
- [ ] **Step 4:** `npm run check` green. Look at 800, 3,000, 12,000 and 30,000 in the browser; screenshots to `~/Downloads/organic-*.png`.
- [ ] **Step 5:** Commit `Organic plan: Voronoi blocks replace the radial web (layout 3.0.0)`. Show the user.

### Task 7: River towns on blocks

**Files:** `grown.ts` (`BLOCKED` += `"river"`; back lanes close blocks at two lots' depth; fewer side streets for the same people), `tests/forms.test.ts`, `tests/river.test.ts`.

- [ ] **Step 1: Failing tests:** river at 1,500 / 6,000 / 25,000: inside the wall 110–220 people/ha and cover 30–45%; shop and ordinary blocks 40–65% each (median); no lot or building within half the river's width of its line or in the sea, coast seeds included (Review Focus 2); the far bank still holds its share and its signature buildings; the existing river tests still pass.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Enable; tune side-street count and back-lane depth until the densities hold.
- [ ] **Step 4:** `npm run check`; retire `tests/layout-river-guard.test.ts` and its fixture (note it in the commit); look in the browser; screenshots to Downloads.
- [ ] **Step 5:** Commit `River towns on blocks`. Show the user.

### Task 8: The other six forms on blocks

**Files:** `grown.ts` (`BLOCKED` = all forms; delete the old plots-along-fronts path and `streets.ts` `building()`'s street-plan use), `tests/forms.test.ts`.

- [ ] **Step 1: Failing tests:** for ridge, castle, street, crossroads, abbey, harbour at 1,500 and 6,000: the density targets as in Task 7; each form's shape tests (existing `describe("each form's own shape")`) still pass; DM choices still bite: walls `none` vs `wall`, suburbs `few` vs `many` (built area beyond the wall differs by ≥ 2×), market `small` vs `large` (market area differs by ≥ 1.5×) (Review Focus 3).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Enable form by form, one commit each, looking at each in the browser.
- [ ] **Step 4:** `npm run check`; the 120-town wall sweep still passes.
- [ ] **Step 5:** Commits `<Form> towns on blocks` ×6, then `Grown engine: blocks only`. Show the user.

### Task 9: Greens, gardens and graveyards

**Files:** `grown.ts` (church and green block assignment), `blocks.ts` (church and green fills), `streets.ts` (`TownLayout.greens: { poly: Poly; kind: "common" | "garden" | "graveyard"; name?: string; church?: number }[]`), `modules/routines/index.ts` (`place:green` in towns → the nearest common), `modules/civic/index.ts` (greens named: "the Green", "St Mary's Green", "the Bowling Green"…, own words), `tests/forms.test.ts`, `tests/town.test.ts`.

- [ ] **Step 1: Failing tests:** every parish church and chapel stands in a block of kind `church` with a `graveyard` open touching its building; towns over 3,000 have ≥ 1 `common` (one per ~4,000 people, at least one inside the wall); well-off blocks have private `garden`s; a person sent to `place:green` at 12,000 in an organic town is placed at a common's centre (`placePoint`); `renderMap` contains `m-graveyard` and `m-common`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: churches choose whole blocks sized to the church (graveyard = the block's middle and the church's yard; edge houses where the yard leaves frontage); commons take a block near a gate or the market edge; names from a short list in `civic` content.
- [ ] **Step 4:** `npm run check`.
- [ ] **Step 5:** Commit `Greens, gardens and graveyards`. Show the user.

### Task 10: Villages get a churchyard and a real green

**Files:** `hamlet.ts`, `tests/town.test.ts` (or a new `tests/hamlet.test.ts`).

- [ ] **Step 1: Failing tests:** a village's chapel (or shrine) has a graveyard poly touching it; the green is on ground no steeper than its surroundings' median; golden hamlet still generates the same households (only geometry moves).
- [ ] **Step 2–4:** fail, implement, pass; update the golden snapshot with `-u` and say so.
- [ ] **Step 5:** Commit `Villages: a churchyard, a green on the level`.

### Task 11: Drawing the new town

**Files:** `src/ui/map.ts`, `src/ui/style.css` (palette tokens for yards, commons, graveyards, gardens), `tests/ui.test.ts`.

- [ ] **Step 1: Failing tests:** `renderMap` of a 3,000 organic town: buildings still one `g[data-address]` each; blocks drawn as `m-block` fills under buildings; party walls as the buildings' own strokes (no `m-plot` outlines inside blocks); commons get `m-tree` circles and an `m-path`; graveyards `m-grave` marks inside an `m-graveyard` wall; gardens `m-garden` with a hedge stroke; dark mode tokens exist for each new class.
- [ ] **Step 2–4:** fail, implement, pass. Look in light and dark.
- [ ] **Step 5:** Commit `Map: blocks, yards, greens, graveyards and gardens`.

### Task 12: Tighter towns, downstream, guards and docs

**Files:** `grown.ts` (`townRadius` from the density targets), `layout/index.ts` (version 3.0.0), `modules/layout/index.ts` `capacityOf`, `modules/uses/index.ts` storeys check, `modules/gossip/index.ts` (`SPEED`, `scopeOf` checked against the new distances), `tests/perf.test.ts`, new `tests/layout-guard.test.ts` + fixture, `docs/ideas/layout-lessons.md`, `docs/DESIGN.md` §6.8, `CLAUDE.md` module map, `CHANGELOG.md`, `README.md`.

- [ ] **Step 1: Failing tests:**
  - the density table for every form at 1,500 / 6,000 / 25,000 inside the targets (one test, all forms);
  - `PERF=1`: each form's 30,000 time ≤ 2× its Task 0 baseline (organic against radial's);
  - an edit to a person's name rebuilds the town with every building's `poly` identical (Review Focus 5);
  - a gossip spread check: a labourer's debt in a 12,000 town reaches between 5% and 40% of households in a week (today's behaviour range; adjust `scopeOf` bases if the tighter town breaks it);
  - storeys: no building's household count exceeds `capacityOf` by more than today's worst case.
- [ ] **Step 2:** Run → FAIL where it does.
- [ ] **Step 3:** Tune and fix; freeze a new layout guard (frozen inputs → output hash) for organic and river.
- [ ] **Step 4:** `npm run check`; `tools/ui-smoke.sh` at 800 / 6,000 / 26,000; `./install.sh`.
- [ ] **Step 5:** Commit `Tighter towns, downstream, new guards, docs`. Then the final whole-branch review, and ask the user before merging or pushing.
