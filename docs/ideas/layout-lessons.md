# Lessons from the river town, for the next layouts

Notes to myself (Claude), written 2026-10-23 after building `river.ts`, for the six layouts in
[next-layouts.md](next-layouts.md). Read this before brainstorming or planning any of them.

## How the user works

- They want to see and react, not decide every detail. For river towns they set the big things
  (asymmetric, one bank dominant, the far bank varies, choices in the New town dialog) and then
  said "I trust you". Bring one visual mockup per layout and a short list of questions only they can
  answer. Make the rest of the calls yourself and list them in the final report.
- They judge by looking. A town that passes every test can still look wrong (an empty walled middle,
  spokes round a market, trades in rows). Look at the map before you call a layout done: the smoke
  harness with `URLHASH="#seed=…&pop=…&base=…&era=high_medieval&layout=…"` (the hash needs `#` and
  `era`, or it is ignored and you get a random hamlet).
- They notice behaviour, not code: "single professions are all clustering", "the river should always
  connect with the ocean". Turn each such remark into a measurement before touching code.

## Pipeline shape that worked (river.ts)

1. Site: a height field, the water, the crossing, the high point. Keep it pure and testable
   (`riverSite`). Each new layout needs its own "site" step: a ridge line, a bailey, a precinct, a harbour.
2. Streets grown, not drawn: high street → market → main roads on easy ground at uneven bearings →
   side streets that follow contours (15% run downhill) → back, cross and water lanes. The streets grow
   until there is enough frontage for the plan (`wantFront = need × plotW × 2.6`). Contour-following side
   streets were what finally made it look organic. Plain grids or rays always looked wrong.
3. Plots cut along street fronts (`cutAlong`): burgage plots, a run index per unbroken frontage.
4. Wards by k-means of plots, from seeds spread by bearing (quarters need at least one ward each).
5. Reserved sites first: gates, castle, churches, precincts, mills and tanneries. Then trades, by score.
   Then housing, from the middle out by value class.
6. The wall is fitted to the streets before plots, then pulled in after placement to what was built.
   The pull-in eases out to the ends and stays put at the gates.
7. Fields beyond the built hull; map bounds from what was built.

Reuse, don't copy: move shared pieces into `streets.ts`, `geom.ts`, `height.ts`. `river.ts` is about
1,450 lines. A second layout written by copy-paste would double every bug fixed below.

## Bugs I made that a new layout will make again

- **Overlap margins.** `convexOverlap(a, b, gap)` with a positive gap means they must be that far
  apart, so neighbours sharing an edge always "overlap". This silently broke every plot run into runs
  of one: no two-plot yards, and trades fell back to the next free plot, so they formed rows. Allow the
  run's previous plot to touch (`gap -0.2`). **Test it:** assert runs of length ≥2 exist, and that
  copies of a trade aren't mostly next door to each other.
- **Sampling candidates.** A fixed stride over a list that fills up runs out of free candidates. Sample
  the first free item in each stride window.
- **Fallbacks hide bugs.** Every "if nothing found, take the next free plot" fallback turned a scoring
  bug into a plausible-looking but wrong map. Count how often each fallback fires on a big town while
  developing. If it's more than rare, something upstream is broken.
- **Taking all of one kind.** Filling a quota kind by kind took every tenement over the bridge.
  Cap each kind's share (60%) so both sides keep a mix.
- **Site filters.** `!plan[i].site` silently excluded `poor_row` (site: lane) from the poor spill.
  Check what the YAML actually says before writing a filter on it.
- **Cut lines need the crossing point.** Clipping a polyline by `filter(p => inside)` stops short of
  the boundary and can split it. Walk to the first point outside and add the exact crossing point.
  The river stopped 20 yards short of the sea this way.
- **Water everywhere.** Every "is this dry?" check needs the sea as well as the river (`inSea` in
  `wet`, `farWet`, `riverClear`), or coast towns build in the water.
- **The wall is a street.** Put the wall line in the segment grid, or plots straddle it.
- **Choices must be real.** Every DM choice (suburbs, walls, gates) needs a test where few and many
  produce clearly different maps. The Suburbs choice did nothing at first.
- **Spokes.** Main roads counted as "town" for their full length make small towns look like spokes
  round a market with an empty middle. Only the inner ~0.55R counts as town; beyond it is roadside
  ribbon.

## Determinism rules (easy to break)

- `dmath` only in `src/modules` (no `Math.sin/cos/hypot/atan2/pow/exp/log`). `Math.abs/min/max/sqrt` are fine.
- A DM choice overrides the roll but never skips the draw: draw first, then apply the choice. Test it
  by forcing each *different* choice and checking the plan prefix and settlement facts don't move.
  (Forcing the value the dice already rolled proves nothing.)
- Changing radial must not move radial towns. `tests/layout-radial.test.ts` is the guard. When moving
  code, prove the guard against the old code in a worktree (done 2026-10-23: inland radial is
  byte-identical to before the move).
- The layout is cached by key in `layout/index.ts`. Add any new design input to the key.
  `clearLayoutCache()` in tests that compare fresh layouts. Speed tests need fresh seeds: a cache
  hit times nothing.

## Testing approach that paid off

- Scratch measurement tests (`tests/zz-*.test.ts`, deleted afterwards) that write numbers to the
  scratchpad. Vitest swallows `console.log` here, so write a file. Accumulate debug counters in
  `globalThis` objects, never `concat` arrays in hot loops (that turned a 10-second run into 10 minutes).
- Real towns, several seeds, sizes 750 / 1,500 / 3,000 / 6,000 / 12,000 / 30,000. Most bugs only showed
  at one end of that range.
- Property tests over whole towns: nothing in the water, nothing on a street, no overlaps, nothing
  across the wall, the far share in range, signature buildings present, the river reaching the sea,
  the wall hugging the built town. Write the new layout's equivalents on day one.
- Speed: river must stay within 2× radial at 30,000. Use interleaved pairs and the median ratio
  (`tests/perf.test.ts`, `PERF=1`). Spatial grids (`SegGrid`, the plot grid) were essential.
- Snapshot updates: `vitest -u` per file (one run over two files only updated one).

## Downstream modules a new layout touches

`TownLayout` gains fields additively (`plan`, `farBank`, `high`, `farGreen`, `WardGeo.bank`). Then
check each of these:

- **uses/urban.ts:** `rollLayout` draws the plan last. The "site adds its signature buildings"
  pattern is `farBankUses` (reserve the last free copy, else add one).
- **religion:** parishes by side and area, chapels that act as parishes, and the Parish row in the
  seat panel.
- **civic:** ward names, gate names and postern labels, plus the town panel rows.
- **politics:** layout-specific issues, weighted.
- **lives:** rumours need `tpl` and `who` slots or the gossip links break.
- **map.ts:** draw anything new (green, deck, contours) and add a test that the SVG contains it.
- **newtown.ts, library.ts:** dialog fields. Hidden fields must be dropped in `designFrom`.
- **CLAUDE.md:** the module map.

## Added after the six forms (2026-10-23)

- **Guard first, then refactor.** A frozen-input snapshot of river output (`tests/layout-river-guard.test.ts`,
  fixture in `tests/fixtures/`) let one engine grow seven forms without moving river towns. Every
  form-specific change is gated on `form`, never applied to the river silently.
- **Height shapes the streets.** Contour-following side streets go wherever the level runs, so a form is
  mostly a height field: a cone round a castle gives Devizes' arcs; a crest gives a ridge; a ramp from the
  shore gives a harbour (add coombes, or a ramp gives a grid). Main roads that "climb least" go round
  a cone in rings: give them a pull away from the anchor.
- **The town disc.** The engine bounds side streets by a disc round the market. A long or one-sided town
  needs its own bound (`offSite`: a band along a ridge, the half-plane away from a castle or precinct).
- **Size the ground to the form.** `townRadius` assumes a full circle of land. A harbour loses half to the
  sea, a ridge both flanks: scale R, or the town only fits on the last retry.
- **Overflow hides shortfall.** Housing that spills onto roadside plots "fits" a town that doesn't. Allow it
  only on the last, roomiest try, so a short town is laid out again bigger; then the Suburbs choice
  really changes the suburbs.
- **Weigh every front.** "Take the first kind of street with room" crams trades into a front with few
  plots (rows of tailors). Score all fronts with a penalty instead; what spills to the suburbs still takes
  them first.
- **Convex tests on concave shapes.** `convexOverlap` treats a polygon as convex: a bent market refuses
  plots on its inner side. Test such shapes by their edge.
- **Measure to outlines, not corners.** A precinct has four corners; "distance to built" by vertex says
  the wall is 180 away when it is 25.
- **Look before you tune a test.** Twice a failing threshold was a test fault (corners; a big-village
  naming rule), and twice it was the layout (rings round a castle; walls bulging between arms). The
  picture tells which.

## Towns of blocks (layout 3.0.0)

- **Blocks are faces of the street graph.** Lots go round each block's edge, back to back with the
  next street's; corners split between the two streets or one L-shaped house; a big middle is built
  over with backland cottages round a court. Anything the graph can't see (a market loop touching the
  streets at one point, a dead end poking into a block) makes a face that wraps round it: tie the market
  into the streets all round, and test a church's fit against the streets near it, not the block outline.
- **Cells, not grown side streets.** Every form but the river grows its side streets as the edges of
  Voronoi cells round its own spine (small near the market, larger out). Seed a street town's cells along
  its market, half a block out and a block and a half apart, so the blocks front it; start the rings at
  the market's nearest side, not its farthest.
- **One measure per bearing can't fit every town.** The wall fitted bearing by bearing went round houses
  at one bearing and through them at the next. What held: fit, then repair in passes (take in what was
  within the first line, stop short of what was outside), and as a last resort put stretches back on the
  first line, which nothing was built across.
- **Gates follow the wall.** A gate fixed before anything is built pins the wall out in the fields. Let
  only a gate the town is built up to hold the wall; move every gate along its road to where the wall
  crosses it, gatehouse and all, sliding a little to clear houses and water.
- **Lots cross by tips.** A proportional shrink lets a corner poking 0.3 m into the next lot through; use
  separating axes with a fixed allowance for convex lots. A building on several lots must line up and
  clear its block's other lots, or its quadrilateral reaches over them round a bend.
- **Density and speed pull against each other.** Each retry lays the whole town out again. Size each
  form so a big town fits first time (castle and abbey lose the ground behind their anchors, a street town
  is long and narrow), and start small towns tighter, where a retry is cheap.
- **Measure what the test means.** A street town of blocks has depth behind its street by design: "a
  fifth of the town fronts the market" became "an eighth, and the market's sides lined with houses".

## Ideas carried forward

- A real "narrows" needs rivers that vary in width (the river has one width now). The ridge and
  harbour towns may want that anyway.
- A wall that dips between a town's arms is honest but not handsome; a smoothed hull of the blocks built
  in might read better than a radius per bearing.
