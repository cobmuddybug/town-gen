# River-Town Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second street-plan layout, the lopsided **river town** (a dominant bank plus a far bank of one of four kinds), selectable beside the existing radial plan, for settlements of 701–30,000 people.

**Architecture:** The `uses` module rolls the layout kind and the far-bank kind before the building plan is made, and adds the far bank's signature buildings to the plan. The `layout` module dispatches on the rolled kind: either the existing radial generator (`radial.ts`, moved unchanged from `town.ts`) or the new `river.ts`. The river generator builds a height field, a river, a grown street network and burgage plots, then hands the same `TownLayout` contract to the rest of the generator. Helpers both plans use move to `streets.ts`. Downstream modules (religion, civic, politics) read the additive fields `plan`, `farBank` and `WardGeo.bank`.

**Tech Stack:** TypeScript, Vite, Vitest, no runtime deps; `src/core/dmath.ts` for all trig in `src/modules`.

**Spec:** `docs/superpowers/specs/2026-10-23-river-town-layout-design.md` (approved 2026-10-23).

## Global Constraints

- **No randomness or float trig outside the project's helpers.** No `Math.random`. In `src/modules`, no `Math.sin/cos/atan2/hypot/pow/exp/log`: use `dmath`, which exports `sin`, `cos`, `atan2`, `hypot`, `PI`, `TAU`, `q`.
- **DM choices override a roll, never replace the draw.** Always draw `layout` and `farBank`, then apply the choice.
- **No all-pairs loops on big settlements.** Overlap and nearness checks use a spatial grid.
- **No runtime dependencies.** The layout is clean-room: never consult Settlemaker or watabou's MFCG.
- **The same seed and settings give byte-identical output.** The layout stays a pure function of `(rng stream, plan, opts)`, and the layout cache key includes `layout` and `farBank`.
- **Consumers get an unchanged `TownLayout` contract** (`kind: "town"`, `wards`, `wall`, `market`, `bridges`, `quay?`, `castle?`, `roads`, `buildings`, `fields`, `features`). Additive fields:
  - on `TownLayout`: `plan: "radial" | "river"` and `farBank?: FarBank`;
  - on `WardGeo`: `bank?: "near" | "far"`.
- **`FarBank` is `"village" | "bridgend" | "abbey" | "wharf"`.**
- **Dominant bank:** 75–85% of buildings, so the far bank holds 15–25%. One bridge, or two at city scale. The far bank is never walled.
- **Default rolls:**
  - river 2/3, radial 1/3;
  - far bank: village 35%, bridgend 30%, abbey 15%, wharf 20%;
  - the wharf is rolled only from 1,001 people (DM choice allowed at any size);
  - coast towns roll only radial when the DM leaves it to the dice.
- **Shape.** The `shape` choice applies to radial only.
- **Saves break.** `layout` and `uses` bump to `2.0.0`, the golden snapshot is updated, and a `CHANGELOG.md` line is added. Hamlets reseed (accepted).
- **Performance:** the river layout at 30,000 people takes at most 2× the radial layout's time for the same plan (`PERF=1`).
- **Tooling:** `npm run check` before every commit. After every task that changes output: `./install.sh`.

## Review Focus

1. **The smallest river towns (701–1,000 people):**
   - the far bank may only fit a handful of buildings;
   - the far-bank share must still be 15–25%;
   - the signature buildings must still all be placed;
   - the retry loop must terminate.
   
   Test: Task 5, "smallest river towns place everything and keep the far bank's share".
2. **The 30,000-person city:** a second bridge, performance, every footprint placed. Tests: Task 5's 30k placement test and Task 6's perf check.
3. **The DM forcing river on the coast:** the river must reach the sea along the downstream edge, and the quay must be on the dominant bank. Test: Task 5, "a coast river town has its quay on the near bank and the river reaches the sea".
4. **The DM forcing an unusual pairing:** wharf at 750 people, abbey at 750, castle with river. Each must still produce its signature buildings on the far bank. Test: Task 1's forced-kind case plus Task 5's signature test at 750.
5. **Edits and rerolls on a river town:** an overlay edit rebuilds the town from the cache. The layout must come back identical and the far-bank wards must keep their ids. Test: Task 6, "an edit keeps the river layout and ward ids".

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `src/core/types.ts` | modify | `Design.layout`, `Design.farBank`, `FarBank` type |
| `src/modules/uses/urban.ts` | modify | roll `layout` and `farBank`, add signature uses, return `far` plan indices |
| `src/modules/uses/index.ts` | modify | set settlement fields `layoutPlan`, `farBank`, `farUses`; version `2.0.0` |
| `src/modules/layout/town.ts` | rename → `radial.ts` | the radial plan, unchanged except imports |
| `src/modules/layout/streets.ts` | new | helpers both plans share, moved verbatim from `town.ts` |
| `src/modules/layout/height.ts` | new | the height field |
| `src/modules/layout/river.ts` | new | `layoutRiver()`: the site, streets, plots, wards, wall, uses, fields |
| `src/modules/layout/index.ts` | modify | dispatch, cache key, version `2.0.0` |
| `src/modules/religion/index.ts` | modify | in a river town, parish by bank |
| `src/modules/civic/index.ts` | modify | far-bank ward names |
| `src/modules/politics/index.ts` + content | modify | bank-versus-bank and town-versus-abbey quarrels |
| `src/ui/map.ts` | modify | bridges with chapel, high-ground tint |
| `src/ui/newtown.ts`, `src/ui/library.ts`, `src/ui/main.ts` | modify | the Layout and Far bank choices |
| `tests/river.test.ts` | new | river-layout tests |
| `tests/layout-radial.test.ts` | new | radial byte-identical guard for the file moves |

---

### Task 1: Roll the layout and the far bank in `uses`; add the signature buildings

**Files:**
- Modify: `src/core/types.ts:37-49` (`Design`), `src/modules/uses/urban.ts`, `src/modules/uses/index.ts:105-111` (plan call site, version)
- Test: `tests/river.test.ts` (new)

**Interfaces:**
- Produces:
  - `export type FarBank = "village" | "bridgend" | "abbey" | "wharf";` and `export type LayoutPlan = "radial" | "river";` in `types.ts`.
  - `Design` gains `layout?: LayoutPlan; farBank?: FarBank`.
  - `UrbanPlan` gains `layout: LayoutPlan; farBank?: FarBank; far: number[]`. `far` holds the indices into `plan` reserved for the far bank, and is empty for radial.
  - Settlement fields set in `uses`: `layoutPlan: LayoutPlan`, `farBank: FarBank | undefined`, `farUses: number[]`.

**Draw order** (append at the very end of `planUrban`, after every existing draw, so radial plans keep their earlier draws):
1. `const rolledPlan = r.chance(2/3) ? "river" : "radial"`. On the coast, roll the same way, then force radial unless the DM chose.
2. Roll the far bank with weights village 0.35, bridgend 0.30, abbey 0.15, wharf 0.20. If pop < 1001 and the roll is wharf, take village.
3. Apply `design.layout` / `design.farBank`.
4. For river, append the signature uses that are missing and record their indices plus the moved ones in `far`.

Signature uses, by kind (ids from the `uses` content; "move" means pick existing plan entries of that id rather than add):

| Kind | Add or move |
|---|---|
| `village` | a `chapel` (a `fane` from 3,000 people); move 3–8 of the plan's base-fill housing (cottage or farmhouse ids from `base.fill`), adding cottages if fewer exist; add `town_alehouse` if none is reserved |
| `bridgend` | `town_tannery` ×1; `inn` (or `hostel` below 1,500 people) ×1; `livery_stable` or `town_carter` ×1; move up to 6 `poor_row` |
| `abbey` | the plan's `friary`/`priory` if present (move one), else add `priory`; a `chapel` for the tenants; move the plan's base mill, if any, else add none |
| `wharf` | `warehouse` ×1 (add even below its 2,500 floor); `boatwright` ×1; move up to 3 `rooming_house`/`tenement`; add `town_alehouse` |

- [ ] **Step 1: Write the failing tests** in `tests/river.test.ts`:

```ts
const plan = (seed: string, pop: number, design?: Design, base = "agricultural") => { const t = generate(seed, { pop, base, ...(design ? { design } : {}) }); return t.settlement(); };
test("about two in three street plans are river towns", () => {
  const n = Array.from({ length: 150 }, (_, i) => plan(`rv${i}`, 1500).get("layoutPlan")).filter((x) => x === "river").length;
  expect(n / 150).toBeGreaterThan(0.55); expect(n / 150).toBeLessThan(0.78);
});
test("coast towns are radial unless the DM chooses", () => {
  for (let i = 0; i < 20; i++) expect(plan(`cs${i}`, 2000, undefined, "fishing").get("layoutPlan")).toBe("radial");
  expect(plan("cs0", 2000, { layout: "river" }, "fishing").get("layoutPlan")).toBe("river");
});
test("choosing the layout moves no other draw", () => {
  const a = plan("same", 3000); const forced = plan("same", 3000, { layout: a.get("layoutPlan") as LayoutPlan });
  expect(forced.get("plan")).toEqual(a.get("plan"));
});
test("each far-bank kind brings its signature buildings, even at 750 people", () => {
  const sig: Record<FarBank, string[][]> = { village: [["chapel", "fane"]], bridgend: [["town_tannery"], ["inn", "hostel"]], abbey: [["priory", "friary"], ["chapel"]], wharf: [["warehouse"], ["boatwright"]] };
  for (const k of Object.keys(sig) as FarBank[]) for (const pop of [750, 3000, 12000]) {
    const s = plan(`sig-${k}`, pop, { layout: "river", farBank: k });
    const far = (s.get<number[]>("farUses")).map((i) => s.get<string[]>("plan")[i]);
    for (const any of sig[k]) expect(far.some((u) => any.includes(u))).toBe(true);
  }
});
test("radial plans reserve nothing for a far bank", () => {
  expect(plan("rad", 3000, { layout: "radial" }).get("farUses")).toEqual([]);
});
```

- [ ] **Step 2:** Run `npx vitest run tests/river.test.ts`. Expected: FAIL (`layoutPlan` undefined).
- [ ] **Step 3:** Implement as above. Bump `uses` to `2.0.0`.
- [ ] **Step 4:** Run `npx vitest run tests/river.test.ts`. Expected: PASS. Then `npm run check`. Golden and town snapshots will fail because of the version bump; update them with `npx vitest run -u` and say so in the commit.
- [ ] **Step 5:** Commit: `"Uses: roll the layout and far bank; far-bank signature buildings"`

### Task 2: Move the radial plan to `radial.ts`; shared helpers to `streets.ts`

**Files:**
- Rename: `src/modules/layout/town.ts` → `src/modules/layout/radial.ts`
- Create: `src/modules/layout/streets.ts`
- Test: `tests/layout-radial.test.ts` (new)

**Interfaces:**
- Produces, from `streets.ts` (moved verbatim from `town.ts`, exported):
  - `FrontKind`, `PRIORITY`, `WardGeo`, `VALUE_CLASSES`, `Scale`, `Enclosure`, `TownLayout`;
  - `compassOf(v: Pt): string`, `plotsFor(fp: Footprint): number`, `isSuburbFp(p, coast)`, `nearestWard(wards, p)`;
  - `building(r, i, fp, ps, urban)`, `insetOutline(p, d)`, `blob(r, c, rad)`, `boatPoly(c, u, l)`.
- `TownLayout` gains `plan: "radial" | "river"` and `farBank?: FarBank`. `WardGeo` gains `bank?: "near" | "far"`.
- `radial.ts` exports `layoutRadial(r, plan, o: TownOpts): TownLayout` (renamed from `layoutTown`), which sets `plan: "radial"`.

- [ ] **Step 1: Write a guard test** before moving anything. `tests/layout-radial.test.ts` lays out a fixed footprint plan with `layoutTown` for seeds `g1..g4` at the scales `thorp`, `village`, `town`, `city`. It snapshots a SHA-256 of `JSON.stringify(layout)` per case (`toMatchSnapshot`). Use `new Rng("radial-guard|" + seed)` directly, so the guard is independent of module versions.
- [ ] **Step 2:** Run it. Expected: PASS, writing the snapshot. This is a characterisation test.
- [ ] **Step 3:** Do the move and the rename. Update imports in `layout/index.ts` and in every consumer that imports `WardGeo`/`TownLayout` from `./town` (grep `layout/town`). Change the guard test to call `layoutRadial` and to compare JSON with the added `plan` key stripped.
- [ ] **Step 4:** Run `npx vitest run tests/layout-radial.test.ts && npm run check`. Expected: the guard passes against the old snapshot, byte-identical. Check passes.
- [ ] **Step 5:** Commit: `"Layout: radial plan in radial.ts, shared helpers in streets.ts"`

### Task 3: The river site, with a height field, a meandering river and the bridge site

**Files:**
- Create: `src/modules/layout/height.ts`, and the site part of `src/modules/layout/river.ts`
- Test: `tests/river.test.ts`

**Interfaces:**
- Produces:
  - `heightField(r: Rng, extent: number): (p: Pt) => number`: a smooth sum of 3–5 broad Gaussian-like bumps, built from `dmath` only (no `exp`; use a rational falloff `1 / (1 + d²/s²)²`). Values roughly 0–1.
  - `riverSite(r: Rng, o: RiverOpts): RiverSite`, where
    - `RiverOpts = TownOpts & { farBank: FarBank; need: number }` (`need` = the dominant bank's plot count);
    - `RiverSite = { height: (p: Pt) => number; river: Pt[]; width: number; near: 1 | -1 /* which side of the river line is the dominant bank */; bridge: { p: Pt; t: Pt }; high: Pt /* the dominant bank's high point near the river */; extent: number; sea?: { n: Pt; d: number } }`.
  - River: a polyline across `[-extent, extent]` along a random bearing, with meanders of 2–3 sine terms (via `dmath.sin`), amplitude 0.08–0.15 × extent. Width: urban 12–18, otherwise 7–10. The dominant bank is the side whose height, averaged over sample points within 0.4 × extent, is higher. The bridge goes at the narrows nearest the projection of `high` onto the river.
  - Coast (only when the DM forced river): the sea is a half-plane beyond the river's downstream end, and the river is clipped there.

- [ ] **Step 1: Write the failing tests:**

```ts
test("the river crosses the site and the dominant bank is the higher one", () => {
  for (let i = 0; i < 20; i++) {
    const s = riverSite(new Rng(`site${i}`), { ...TOWN_OPTS, farBank: "village", need: 600 });
    expect(s.river.length).toBeGreaterThan(10);
    const side = (p: Pt) => sideOf(s.river, p); // test helper: sign of cross product to the nearest segment
    expect(side(s.high)).toBe(s.near);
    expect(dist(s.bridge.p, s.river[project(s.river, s.bridge.p) | 0] ?? s.bridge.p)).toBeLessThan(s.width * 2);
  }
});
test("the height field is deterministic and smooth", () => {
  const h = heightField(new Rng("h"), 800), g = heightField(new Rng("h"), 800);
  expect(h([10, 20])).toBe(g([10, 20]));
  expect(Math.abs(h([10, 20]) - h([11, 20]))).toBeLessThan(0.02);
});
```
(`TOWN_OPTS` is a test constant: `{ scale: "town", enclosure: "wall", roads: 4, terrain: "farmland" }`.)
- [ ] **Step 2:** Run. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS. Run `npm run check`.
- [ ] **Step 5:** Commit: `"Layout: river site, height field, bridge"`

### Task 4: The river street network

**Files:**
- Modify: `src/modules/layout/river.ts`
- Test: `tests/river.test.ts`

**Interfaces:**
- Consumes: `RiverSite` (Task 3).
- Produces `riverStreets(r: Rng, site: RiverSite, o: RiverOpts): StreetNet`, where
  - `StreetNet = { streets: Street[]; market: Poly; gates: { p: Pt; t: Pt; road: string }[]; wallLine?: Pt[] }`;
  - `Street = { id: string; kind: "high" | "main" | "back" | "cross" | "water" | "far"; width: number; points: Pt[]; bank: "near" | "far" }`.

**Algorithm.** The spec leaves the method to the builder. This is the method chosen, with each step's required property:
1. **High street:** from the bridge foot, walk uphill. At each step of about 20 units, take the heading within ±35° of the current one that most increases height, with a small rng jitter. Stop at about 0.25–0.35 × the town radius, where `town radius = sqrt(need × plotArea / π) × 1.25`.
2. **Market:** at the high street's end. Choose a triangle or a widened street (rng 50/50). Size it with the radial formula (`marketR` from `radial.ts`, computed in `streets.ts` as `marketSize(o, need)`, moved there). A triangle's long axis lies along the high street.
3. **Main roads** (`o.roads - 1` of them, plus the high street continuing over the bridge as the last): leave from the market's corners or ends. Initial bearings are rolled with **unequal gaps** (a Dirichlet-like split of the free arc, each gap at least 35°). Each road walks outward with gentle curvature, and its turn per step is biased toward lower slope (the gradient of `height`). Never cross the river: if a step would, turn along the bank.
4. **Wall:** if walled, a closed loop on the dominant bank at about 1.05 × the town radius around the market, wobbled, meeting the river at both ends. The river closes the loop. Gates go where main roads cross it, plus a bridge gate.
5. **Back lanes:** for every main or high street segment inside the wall, offset a polyline by `plotDepth + laneW/2` on each side, trimmed where it meets another street, the wall or the river.
6. **Cross lanes:** every 60–110 units along each back lane, join it to the nearest parallel street.
7. **Water lanes:** from the back lanes nearest the river, short perpendicular lanes to the bank, every 70–130 units.
8. **Far bank:** the road over the bridge, plus a kind-specific pattern:
   - `village`: a green (an ellipse 30–50 × 18–30) and a loop lane;
   - `bridgend`: the road only, as a ribbon;
   - `abbey`: the road plus a precinct rectangle beside it;
   - `wharf`: a strand street along the bank with short lanes behind.

- [ ] **Step 1: Write the failing tests:**

```ts
test("streets form one connected network, crossing the river only at the bridge", () => {
  for (let i = 0; i < 12; i++) {
    const s = riverSite(new Rng(`n${i}`), OPTS(1500)); const net = riverStreets(new Rng(`n${i}`), s, OPTS(1500));
    expect(connected(net.streets)).toBe(true); // test helper: graph over shared endpoints within 1 unit
    for (const st of net.streets) for (const [a, b] of pairs(st.points)) expect(crossesRiverAwayFromBridge(s, a, b)).toBe(false);
  }
});
test("the market meets at least two main roads and is not a disc", () => {
  const s = riverSite(new Rng("m"), OPTS(3000)); const net = riverStreets(new Rng("m"), s, OPTS(3000));
  const touching = net.streets.filter((st) => (st.kind === "main" || st.kind === "high") && polylinePolyDist(st.points, net.market) < 2);
  expect(touching.length).toBeGreaterThanOrEqual(2);
  expect(aspect(net.market)).toBeGreaterThan(1.3); // test helper: long side / short side of the bounding box in its principal axis
});
test("main roads do not radiate evenly", () => {
  let uneven = 0;
  for (let i = 0; i < 20; i++) {
    const s = riverSite(new Rng(`b${i}`), OPTS(5000)); const net = riverStreets(new Rng(`b${i}`), s, OPTS(5000));
    const gaps = bearingGaps(net); // test helper: sorted gaps between main-road bearings at 60 units from the market
    if (Math.max(...gaps) / Math.min(...gaps) > 1.6) uneven++;
  }
  expect(uneven).toBeGreaterThanOrEqual(14);
});
```
(Put the helpers `connected`, `pairs`, `crossesRiverAwayFromBridge`, `aspect`, `bearingGaps`, `sideOf` and `OPTS(pop)` at the top of `tests/river.test.ts`.)
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `"Layout: river-town street network"`

### Task 5: Plots, blocks, wards, suburbs, uses and fields: `layoutRiver()`

**Files:**
- Modify: `src/modules/layout/river.ts`, and `src/modules/layout/streets.ts` (move more radial helpers here only when needed, verbatim; the radial guard from Task 2 must stay green)
- Test: `tests/river.test.ts`

**Interfaces:**
- Consumes: `riverSite`, `riverStreets`, the `streets.ts` helpers.
- Produces `layoutRiver(r: Rng, plan: Footprint[], o: RiverOpts & { far: number[] }): TownLayout`, with `plan: "river"`, `farBank: o.farBank`, `bridges` (1, or 2 at `scale === "city"`), `wards` with `bank`, and `features` gaining `{ kind: "bridge_chapel", p }` when rolled (60%).

**Rules:**
- **Plots:** cut along both sides of every high, main, far and strand street, with the radial plan's widths and depths (`plotW`, `depth`, `PRIORITY` by front). Trim at back lanes. Drop any plot that overlaps another, a street, the wall or the river (use a uniform grid of 40-unit cells for the overlap test). Back-lane and cross-lane fronts are `"lane"`, the market's are `"market"`, the high street's and main streets' are `"main"`, the strand's are `"quay"`, and the far bank's are `"suburb"`.
- **Blocks:** group plots by the polygon they back onto (high/main/back-lane faces). Block ids are `"rv-<n>"`.
- **Wards:**
  - dominant bank inside the wall: 2–8 wards by k-means on plot centroids (deterministic seeding from the rng, 8 iterations, k = clamp(round(plots/120), 2, 8)), `kind: "intramural"`, `bank: "near"`;
  - suburbs: one ward per gate road with plots, `kind: "suburb"`, `bank: "near"`;
  - far bank: 1 ward (2 at city scale), `kind: "suburb"`, `bank: "far"`, `near` including `"bridge"` and the far-bank kind.
  
  `ring` is the distance band from the market (0 if under 0.35 × the town radius, 1 if under 0.7, else 2). `sector` is the index of the angular eighth around the market. `quarter` is assigned as in radial, from the sector. `compass` uses `compassOf`. Value classes are ranked as in radial (near market, chief church, castle up; near tanneries down). The far bank is capped by kind: village up to moderate residential (3), bridgend up to low commercial (2), abbey up to moderate residential (3), wharf up to moderate commercial (4).
- **Uses:** plan entries in `o.far` go only to far-bank plots or reserved far-bank slices. All others go to dominant-bank plots or suburbs. Reuse the radial plan's use-to-plot rules (`site`, `value`, `cluster`, keep-apart families) by extracting the assignment closure into `streets.ts` as `assignUses(ctx: AssignCtx)` **only if** the extraction keeps the radial guard byte-identical. Otherwise write a smaller river-only assignment that applies the same rules. The executor decides and records which in the ledger.
- **Reserved sites:**
  - the castle on `site.high` when the plan has a castle;
  - the chief church on high ground in the core;
  - the abbey precinct on the far bank (abbey kind);
  - the green on the far bank (village kind), with the chapel facing it.
- **Retries:** if buildings are left without plots, the existing room loop in `layout/index.ts` retries with `o.room` up to 1.5. The river plan must grow its town radius by `o.room`.
- **The far-bank share:** reserve far-bank capacity for 15–25% of the plan's buildings. Move housing (`tenement`, `poor_row`, `cottage`) into `far` in Task 1's `planUrban` only if needed. Prefer pulling extra ordinary housing to the far bank inside `layoutRiver` (a deterministic pick from the end of the plan) until the share reaches 15%, and stop at 25%.
- **Fields** beyond the town, as radial does: use the same `fields` construction moved to `streets.ts` if it is position-generic. Otherwise put rings of field pieces outside the built area on both banks.
- **Coast (forced):** the sea beyond the downstream end; `quay` on the dominant bank's downstream river front.

- [ ] **Step 1: Write the failing tests:**

```ts
const river = (seed: string, pop: number, farBank: FarBank = "village", base = "agricultural") => {
  const t = generate(seed, { pop, base, design: { layout: "river", farBank } }); return { t, map: t.settlement().get<MapData>("map") };
};
test.each([800, 3000, 8000, 30000])("every footprint is placed, with no overlaps, at %i people", (pop) => {
  const { t, map } = river(`place${pop}`, pop);
  expect(t.children(t.root, "building").length).toBe(t.settlement().get<string[]>("plan").length);
  expect(overlaps(t)).toEqual([]);   // test helper: building polys overlapping each other or the river, via a grid
});
test("smallest river towns place everything and keep the far bank's share", () => {
  for (const pop of [701, 750, 900, 1000]) for (const k of ["village", "bridgend", "abbey", "wharf"] as FarBank[]) {
    const { t, map } = river(`small${pop}${k}`, pop, k);
    expect(t.children(t.root, "building").length).toBe(t.settlement().get<string[]>("plan").length);
    const share = farShare(t); expect(share).toBeGreaterThanOrEqual(0.15); expect(share).toBeLessThanOrEqual(0.25);
  }
});
test("the far bank holds 15–25% of buildings across seeds", () => {
  for (let i = 0; i < 20; i++) for (const pop of [1500, 6000]) { const s = farShare(river(`share${i}`, pop).t); expect(s).toBeGreaterThanOrEqual(0.15); expect(s).toBeLessThanOrEqual(0.25); }
});
test("each far-bank kind's signature uses stand on the far bank, at 750 and 5000", () => {
  // same table as Task 1; assert the building's ward has bank "far"
});
test("far-bank wards are suburbs, never inside the wall", () => {
  const { map } = river("wall", 8000);
  for (const w of map.wards!.filter((w) => w.bank === "far")) expect(w.kind).toBe("suburb");
  expect(map.wall!.line.every((p) => sideOf(map.stream.points, p) === nearSide(map))).toBe(true);
});
test("a city has two bridges", () => expect(river("city", 30000).map.bridges!.length).toBe(2));
test("a coast river town has its quay on the near bank and the river reaches the sea", () => {
  const { map } = river("coastal", 4000, "wharf", "fishing");
  expect(map.quay?.length).toBeGreaterThan(0);
  expect(map.quay!.every((p) => sideOf(map.stream.points, p) === nearSide(map))).toBe(true);
  expect(map.coast?.length).toBeGreaterThan(0);
});
test("same seed, same map", () => expect(JSON.stringify(river("det", 5000).map)).toBe(JSON.stringify(river("det", 5000).map)));
```

Define the helpers `overlaps`, `farShare` (buildings whose ward has `bank === "far"` ÷ all buildings), `nearSide` and `sideOf`. In the signature test, write out the table from Task 1.

- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS. Then run `npx vitest run tests/layout-radial.test.ts` (still byte-identical) and `npm run check`.
- [ ] **Step 5:** Commit: `"Layout: river towns: plots, wards, far bank, uses"`

### Task 6: Dispatch, cache, version, performance

**Files:**
- Modify: `src/modules/layout/index.ts`, `tests/perf.test.ts`, `CHANGELOG.md`, `docs/DESIGN.md` (a short §6.8 note on the two plans)

**Interfaces:**
- Consumes: `layoutRadial`, `layoutRiver`, and the settlement fields `layoutPlan`, `farBank`, `farUses`.

**Changes:**
- `layout` `version: "2.0.0"`.
- The cache key adds `layoutPlan`, `farBank` and `JSON.stringify(farUses)`.
- The street branch calls `layoutRiver(ctx.rng(s, "river"), footprints, { ...opts, farBank, far: farUses })` when `layoutPlan === "river"`, else `layoutRadial(ctx.rng(s, "town"), …)`.
- Ward entities get `bank` copied.
- `isStreetPlan` is unchanged.

- [ ] **Step 1: Write the failing test** (in `tests/river.test.ts`):

```ts
test("an edit keeps the river layout and ward ids", () => {
  const { t, map } = river("edit", 3000, "bridgend");
  const p = t.allEntities().find((e) => e.type === "person")!.address;
  const t2 = withEdit(t, defaultModules, p, "name.given", "Wat");
  expect(JSON.stringify(t2.settlement().get("map"))).toBe(JSON.stringify(map));
  expect(t2.children(t2.root, "ward").map((w) => w.address)).toEqual(t.children(t.root, "ward").map((w) => w.address));
});
test("ward entities carry their bank", () => {
  const { t } = river("bank", 3000);
  expect(t.children(t.root, "ward").some((w) => w.get("bank") === "far")).toBe(true);
});
```
- [ ] **Step 2:** Run. Expected: FAIL (the layout still radial; `bank` missing).
- [ ] **Step 3:** Implement. Add `PERF=1` lines to `tests/perf.test.ts` that time `generate` for 30,000 people with each layout forced and assert `river ≤ 2 × radial`.
- [ ] **Step 4:** Run `npx vitest run tests/river.test.ts`, `PERF=1 npx vitest run tests/perf.test.ts`, then `npx vitest run -u` for the golden snapshot (say so in the commit), then `npm run check`. Expected: all pass, with the perf assertion holding.
- [ ] **Step 5:** Add the `CHANGELOG.md` line: "2.0.0 layout, uses: river towns; every street plan rolls its layout; saves from earlier versions regenerate differently". Run `./install.sh`. Commit: `"Layout 2.0: river towns selectable beside the radial plan"`

### Task 7: The rest of the town follows the banks

**Files:**
- Modify: `src/modules/religion/index.ts`, `src/modules/civic/index.ts` (ward naming), `src/modules/politics/index.ts` (+ its content), and the ward `note` in layout or civic
- Test: `tests/river.test.ts`

**Rules** (all gated on `map.plan === "river"`):
- **Religion:** a household's parish is the nearest parish church **on its own bank** (`ward.bank`). The far bank's chapel or fane is a parish church for an old village or the abbey's side.
- **Civic ward names:** for `bank === "far"`, the candidates come first:
  - `"Over the Bridge"`, `"Bridge End"`, `"Bridgefoot"`;
  - `"Abbey Fee"` (abbey);
  - `"the Strand"` (wharf);
  - `Old <place name>` (village): the place name comes from the names provider's place-name function with the ward as entity.
- **Politics:** for river towns, add to the quarrel pool:
  - "the bridge toll the far bank pays to come to market";
  - "who mends the bridge, the borough or the far bank";
  - for the abbey kind, "the abbot's mill, which the town's bakers must grind at".
  
  Content goes in the module's content YAML with `source: "our own"`.
- **Old village's lord:** the far ward's panel gets a row "Held by: <another lord's name>". Use the names provider for the lord. It is not a full manor.

- [ ] **Step 1: Write the failing tests:**

```ts
test("far-bank households go to a church on their own bank", () => {
  const { t } = river("parish", 4000, "village");
  for (const h of t.allEntities().filter((e) => e.type === "household").slice(0, 400)) {
    const ward = (a: string) => t.get(t.get(a).get<string>("wardAddress") ?? "").get?.("bank");
    // compare the household's bank with its parish church's bank, using whatever field religion stores the parish under
  }
});
test("the far ward is named for the far bank", () => {
  const names = ["village", "bridgend", "abbey", "wharf"].map((k) => river(`nm${k}`, 3000, k as FarBank).t.children(river(`nm${k}`, 3000, k as FarBank).t.root, "ward").filter((w) => w.get("bank") === "far").map((w) => w.get<string>("name")));
  expect(names.flat().every((n) => /Bridge|Strand|Abbey|^Old /.test(n))).toBe(true);
});
test("abbey towns can quarrel over the abbot's mill", () => {
  const found = Array.from({ length: 30 }, (_, i) => river(`q${i}`, 4000, "abbey").t).some((t) => JSON.stringify(t.settlement().get("politics.quarrel") ?? "").includes("abbot"));
  expect(found).toBe(true);
});
```
First read how religion stores a household's parish and how politics stores the quarrel. Then finish the first test with the real field names: assert that the parish church's building has the same `bank` as the household's ward.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run tests/river.test.ts` and `npm run check`. Expected: PASS. If radial or hamlet output moved, the change wasn't gated: fix it.
- [ ] **Step 5:** Commit: `"River towns: parishes by bank, far-bank ward names, bridge quarrels"`

### Task 8: The map and the New town dialog

**Files:**
- Modify: `src/ui/map.ts`, `src/ui/newtown.ts`, `src/ui/library.ts` (`designFrom`), `src/ui/main.ts` (`syncForm` and the plan-visibility logic), `src/ui/style.css`
- Test: `tests/ui.test.ts`, `tests/library.test.ts`

**Interfaces:**
- `designFrom` reads `layout` (`"radial" | "river"`) and `farBank` (the four ids).
- `townKey` already serialises every `Design` key: no change.
- `newTownHtml()` adds, inside `#plan`:
  - `<select name="layout">` with any / `river` "river town" / `radial` "radial web";
  - `<label id="farbank-field"><select name="farBank">` with any / `village` "old village" / `bridgend` "bridge-end" / `abbey` "abbey's side" / `wharf` "wharf side".
- **Visibility in `syncManor`:**
  - `#farbank-field` is hidden when layout = radial;
  - the `shape` field is hidden when layout = river.
- **Renderer:**
  - bridges as a deck rectangle across the river along the road (light stone fill, ink outline);
  - `bridge_chapel` as a small chapel glyph on the deck;
  - high ground as a soft tint: sample the height field? **No:** the renderer has no height field. The layout exports `TownLayout.high?: Poly[]`, iso-polygons of height > 0.6 made with marching squares on a 24-cell grid inside `layoutRiver`. The renderer fills them with `rgba(140,120,80,.08)` and a dashed hachure edge.

- [ ] **Step 1: Write the failing tests:**

```ts
test("designFrom reads the layout and the far bank", () => {
  expect(designFrom((k) => ({ layout: "river", farBank: "abbey" } as Record<string, string>)[k] ?? null)).toEqual({ layout: "river", farBank: "abbey" });
  expect(designFrom((k) => ({ layout: "spiral" } as Record<string, string>)[k] ?? null)).toBeUndefined();
});
test("the new town dialog offers the layout and the far bank", () => {
  const h = newTownHtml();
  for (const s of ['name="layout"', 'name="farBank"', "river town", "radial web", "bridge-end", "abbey's side", "wharf side", 'id="farbank-field"']) expect(h).toContain(s);
});
test("the map draws bridges and high ground for a river town", () => {
  const t = generate("draw", { pop: 3000, design: { layout: "river" } });
  const svg = renderMap(t);
  expect(svg).toContain('class="m-bridge');
  expect(svg).toContain('class="m-high');
});
```
- [ ] **Step 2:** Run `npx vitest run tests/ui.test.ts tests/library.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement (`high` is computed in `layoutRiver`; add it to `TownLayout` as optional).
- [ ] **Step 4:** Run. Expected: PASS. Smoke check: `tools/ui-smoke.sh` steps that open New town, set People to 3000, set Layout to river and assert `#farbank-field` is visible and the shape field is hidden, then Build town, wait 3 s, and assert `document.querySelector(".m-bridge")`. Run `npm run check` and `./install.sh`.
- [ ] **Step 5:** Commit: `"UI: layout and far-bank choices; bridges and high ground on the map"`

### Task 9: Visual review against the anti-goals

- [ ] **Step 1:** Render 6 river towns per far-bank kind at 1,500, 5,000 and 20,000 people. Use `BASE=agricultural tools/preview.sh OUTDIR seeds pop`, or `tools/look.mjs` against `#seed=…&pop=…&layout=river&farBank=…`.
- [ ] **Step 2:** Read every image. Check each against the anti-goals:
  - no spokes or rings;
  - no grid;
  - the banks clearly unequal in size and in character;
  - nothing in the river;
  - the market reads as a widened street or a triangle;
  - streets bend.
  
  Record findings in the ledger.
- [ ] **Step 3:** Fix each failure with a regression test where the property is measurable (e.g. the evenness of road bearings, the far-bank share), then re-render.
- [ ] **Step 4:** Update the README's feature list ("river towns with a far bank that varies") and the memory note. Run `npm run check` and `./install.sh`. Commit: `"River towns: visual pass"`
