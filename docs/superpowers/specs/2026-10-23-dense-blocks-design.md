# Dense blocks: reworking every town layout

Status: written 2026-10-23 by Claude from a conversation with the user. Marked **(user)** where the
user decided; everything else is Claude's call and says so. Read `docs/ideas/layout-lessons.md` first.

## Intent

The towns look sparse. The user compared them with the maps watabou's city generator draws and asked
for a rework of every layout: denser, convincing blocks, buildings that touch, parkland, graveyards.
Breaking old saves is fine **(user)**.

What the user said, in their words where it matters:

- "Blocks are just rows and single houses deep." Today a street gets one row of long plots with a
  small house at the front and a garden strip behind; the next street is a garden-length away.
- "Not all properties irl have large gardens." Commercial and mixed-use areas are denser **(user)**.
- Barcelona-style blocks: several buildings on a block sharing one common courtyard **(user)**.
- Parks are part of blocks. Communal spots, and private parks and gardens for the wealthier
  **(user)**. Graveyards close to churches **(user)**.
- Every layout has terrain height; two don't today (radial, and villages) **(user)**.
- Radial needs the biggest rewrite: "incredibly repetitive and a simple algorithm", though its
  compactness reads as more realistic than the grown towns **(user)**.
- Towns get **tighter on the map**, not the same size with more green **(user)**.
- Take "a lot of leeway" from the watabou layouts and reimagine ours **(user)**, but keep our edge.
- Mockups approved: six kinds of block (shop, ordinary, courtyard, well-off, church, green), corners
  split between the two streets or taken by one L-shaped house **(user: "they look good", corners
  revised after "the squares on the corners look rough")**.

### What we measured (2026-10-23)

| Town | Ground | People/ha | Building cover | Mean building |
|---|---|---|---|---|
| river 6,000 | 92 ha | 65 | 4% | 35 m² |
| castle 6,000 | 93 ha | 64 | 4% | 34 m² |
| radial 6,000 | 106 ha | 56 | 8% | 71 m² |
| radial 25,000 | 99 ha | 252 | 34% | 89 m² |

A walled German town of 47 ha held about 112 people/ha
([note](https://hamiltonurbanblog.substack.com/2021/10/germany-waikato-1648-to-1806-my-notes)).
Conzen's burgage cycle: the backlands of plots fill progressively with buildings, following the old
plot lines ([Tait, PSAS](https://journals.socantscot.org/index.php/psas/article/download/9756/9723/9707)).

## Licence: clean-room, outputs only

`CLAUDE.md` forbids consulting watabou's code (GPL-3; ours is MIT). The user asked to "inspect the
code"; we do not. We studied only its rendered maps (four screenshots, 2026-10-23), plus real towns.
What the maps show, in our words: irregular polygonal blocks; buildings sharing walls round the edges
of each block, with small yards as holes in the middle; narrow streets; blocks packed inside the wall
and thinning into scattered suburbs beyond; open greens near the citadel; piers along the shore.
Nothing below comes from its code; every algorithm here is ours.

## Goals

1. **Blocks, not rows.** Streets enclose blocks. Every block is filled by a *kind*, wall to wall
   round its edge, square to the street, corners split or L-shaped.
2. **Density by kind** (targets, Claude's call; tests hold them loosely):

   | Kind | Where | Fill |
   |---|---|---|
   | shop | market, high street, main roads near the centre | narrow lots (4.5–7 m), buildings 12–20 m deep, slivers of yard, back ranges |
   | ordinary | most streets | lots 5–9 m, buildings 9–14 m deep, small yards, sometimes a shared green or orchard mid-block |
   | courtyard | dense wards, inns, almshouses, colleges | a few large buildings round one common court with a well |
   | well-off | high-value wards | few big houses with gaps, private gardens and walks behind a wall |
   | church | every parish church and chapel | the church in a graveyard, trees along the wall, houses on what the yard doesn't take |
   | green | some blocks, more in big towns | a communal green or common, paths and trees, houses along part of its edge |
   | precinct | castle, abbey, friary, priory | as today (bailey, precinct), drawn as one walled block |
   | croft | villages and suburbs | as today: a house set back on a long plot; suburbs thin out along the roads |

   Inside the walls of a town: building cover 40–65% in the shop and ordinary blocks, 30–45% over the
   whole walled area; 110–220 people/ha inside the walls (towns of 1,001+). Mean building 60–140 m².
3. **Parkland and graveyards.** Every parish church and chapel has a graveyard in its block. Greens
   are communal (anyone may be there) or private (a well-off household's garden). Both are things
   on the map with names where it suits, and routines can send people to a green.
4. **Height everywhere.** Radial (renamed, below) and villages get a height field and contours like
   the grown forms (`height.ts`).
5. **A new heart for the old radial plan.** See "The organic plan" below.
6. **Tighter towns.** Town area follows population at the densities above; walls, suburbs and
   fields shrink with it.

## Non-goals

- No grids, no Barcelona chamfered octagons as a street pattern: we borrow the shared courtyard, not
  the Eixample.
- No change to who lives in the town: the building plan (uses, households, people) stays as it is.
  Only where and how big buildings are changes.
- No new UI beyond drawing what's new (greens, graveyards, gardens, contours, party walls).

## Anti-goals (failure even if it works)

- Losing a form's character: the river and its banks, the ridge crest, the castle mound, the abbey
  precinct, the harbour quay, the street town's long market, the crossroads.
- Losing what makes a building a place: every building is still one entity with its households,
  people and use, clickable on the map.
- Rows again, under a new name: a block one house deep with empty middle fails.
- Determinism broken: the same seed and settings give the same town.
- A city that takes much longer: every layout within 2× today's time at 30,000.

## The organic plan (replaces radial)

The radial spiderweb (`radial.ts`) is replaced. The plan id `radial` stays in saves and links but
reads "organic" in the dialog (Claude's call: old links still open a town, of the new kind).

1. Site: a height field with a rise or two, a stream maybe, as the grown forms have.
2. The market where the roads meet, on easy ground near the high point.
3. Roads out at uneven bearings, bending to the ground (the grown engine's `growRoad`).
4. **Blocks from seeds.** Scatter block seeds round the market, closest together at the centre and
   spreading outward (block size grows with distance: 35–60 m across at the core, 70–110 m at the
   edge, Claude's call). Partition the town disc by the seeds (Voronoi cells, a textbook method,
   written fresh in `geom.ts`), merging cells that a road cuts so roads run along cell edges. Cell
   edges are the streets; streets bend where three cells meet; steep cell edges become lanes or
   steps. The result is irregular four-to-seven-sided blocks of different sizes.
5. Kinds by ward value and frontage (as goal 2), then fill.
6. Wall round the inner cells; suburbs as strings of small blocks along the roads beyond the gates.

## Filling a block (shared by every street plan)

A new module, `layout/blocks.ts`, used by the organic plan and the grown engine alike:

1. **Block outline:** the polygon between streets, inset by half the street width.
2. **Frontage lots:** walk each edge, cutting lots of the kind's widths, square to the edge. Corner
   lots: split between the two streets (60%) or one L-shaped building (40%), as in the approved mockup.
3. **Buildings:** each lot's building takes the front of the lot to the kind's depth; neighbours share
   side walls exactly (no gaps, no overlaps). Depth jitters a little lot by lot.
4. **The middle:** by kind: yards and back ranges (shop), small yards and a shared green (ordinary),
   one court with a well (courtyard), gardens (well-off), graveyard (church), green (green).
5. **Multi-lot uses** (inns, merchants, warehouses, farms) take adjacent lots, in left-to-right order
   (`leftToRight`, the fix of 2026-10-23), merged into one outline; big ones become an L or a range
   round a yard.
6. **Plan to lots:** the engine grows streets/blocks until there are enough lots of each kind for the
   plan, as `wantFront` does today. Spare lots become yards, gardens or a green, never empty plots.

## Roads that aren't blocks

Not every road encloses a block, and buildings still line the ones that don't **(user asked; Claude's
answer)**:

- **Ribbons.** Roads out past the gates are lined with houses as a ribbon: a row of lots each side,
  yards and plots behind ending at a back fence one plot deep, thinning with distance from the gate.
- **One-sided streets.** A street on the edge of the built town, with country on the other side, gets
  one row on its town side; the open side stays open. A face open to the country is only closed into
  a block where it is narrow enough to fill; otherwise its edge streets are ribbons.
- **Lanes and village roads.** Dead-end lanes and a village's roads keep frontage along their length.

The same lot cutter makes ribbons and block edges, so a ribbon's houses look like a block's: square to
the road, sharing walls in the denser stretches, gaps and crofts further out.

## The grown forms

Each keeps its spine: river and bridge, ridge crest, castle cone, long street, crossroads, abbey
precinct, harbour quay. What changes:

- Side streets and back lanes are generated as today, then the land between them is cut into blocks
  (the faces of the street network) and filled by `blocks.ts`, instead of one row of plots per
  street.
- Back lanes close blocks off at a block's depth, so blocks are two lots deep back to back, not one.
- Fewer, shorter side streets for the same population (tighter towns).

## Villages and hamlets

Keep the green and crofts (long plots are right for farmers). Add the height field and contours,
a churchyard with graves round the chapel, and a green that reads as the village green.

## Drawing (map.ts)

Party walls as thin lines inside a continuous block fill (as one terrace, not separate boxes),
yards in the yard colour, greens with trees and paths, graveyards with crosses inside a wall, private
gardens with a hedge line, contours in every plan. Buildings stay clickable one by one.

## Downstream

- `capacityOf`, materials, storeys: bigger footprints mean bigger houses; check storeys still fit.
- Wards from blocks (k-means of blocks, not plots).
- Routines: `place:green` can be a real green block in towns; the churchyard is where burials go
  (`lives` already buries in "the churchyard").
- Religion: parish by nearest church is unchanged.
- Gossip and crime use building positions and distances: tighter towns change spread distances;
  check the scope constants (`SPEED`, `scopeOf`) still read sensibly.
- Guards: the river guard and the radial guard are retired (both forms change on purpose) and
  replaced by new frozen-input snapshots once the new layouts settle.

## Tests (day one)

- Cover and density per kind and per town, inside the targets.
- No overlaps; no building over a street, in water or across the wall; every building fronts a
  street or a yard with a way in.
- Every block is filled: no block with an empty middle unless it is a green, garden or graveyard.
- Corners: no building with an interior angle under 50°.
- Every parish church has a graveyard touching it; at least one green in every town over 3,000.
- Contours in every plan, villages included.
- Same seed, same town; layout within 2× today at 30,000.
- Each form keeps its own shape (the existing shape tests).

## Order of work (Claude's call)

1. `blocks.ts` and drawing, tried on the organic plan first (the user's priority).
2. Height for the organic plan and villages.
3. The grown forms, one at a time, river first.
4. Greens, gardens and graveyards everywhere.
5. Tuning density and size; downstream fixes; new guards; docs (`layout-lessons.md`, DESIGN §6.8).

Look at the map after each step and show the user before moving on.

## Builder notes (Claude's calls, from reading this as the builder)

- **Roads through the organic plan.** Roads are routed first (as now). Seeds are then placed so that
  cell edges follow them: seeds in pairs either side of each road, a half block off it, every block
  length along it. The road's path becomes the chain of cell edges between those pairs, so roads
  bend where cells meet. Seeds elsewhere are scattered (jittered rings from the market outward).
- **Blocks from the grown forms' streets.** Street polylines are noded: split where they cross,
  ends within 3 m snapped together, dead ends kept as lanes into a block. Faces of that graph are the
  blocks. Faces open to the country at the town's edge are closed by the built edge (the wall line
  inside walls, else an offset of the outermost streets by one block depth).
- **Village** means the hamlet layout (`hamlet.ts`, up to 700 people); 701 and up are street plans.
- **Tests that assumed rows** (runs of plots, trades not in rows) are rewritten against lots in blocks.
- **The branch** starts from `fix-flat-buildings` (the left-to-right fix), not yet on main.

## Left to the builder

Exact widths and depths within the ranges above, the seed density curve, how cells merge round
roads, tree and path drawing, and how far each form's side streets shrink.
