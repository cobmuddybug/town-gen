# River towns: a second street-plan layout

Status: approved for planning on 2026-10-23.

## Why

Every settlement above 700 people is currently laid out by one generator, `src/modules/layout/town.ts`. It builds the town in polar coordinates: a market at the centre, main roads radiating to the gates, rings of back streets, and blocks cut into burgage plots. The DM's "Shape" choice (round, oval, long) only stretches that web. The result reads as a spiderweb. The user finds it repetitive and not natural for a medieval English town.

The user's model is the real English market town, with Devizes as the example. Its plan is organic, and the site shapes it: a castle, a slope, the roads that meet at the market. It is never a grid and never a web. The first new shape the user wants is a town built around a river. It is based on their own town, Wynyard in Tasmania, which began as two settlements on either side of a river. The river was later bridged. Most of the town lies on one bank, and the other bank is a different sort of place in who lives there.

## What the user decided

- **A river town is the first new layout.** Other sites (a castle on a hill, a town along one road, a crossroads) come later and are not part of this work.
- **The radial "spiderweb" plan stays** as a selectable layout.
- **The river town is lopsided.** One bank is dominant and holds most of the town. The other bank is smaller and was once its own place, joined by the bridge (sketch "B" in the brainstorm).
- **The far bank's character varies** from one river town to the next.
- **The DM can choose these in the New town dialog**, with "any" leaving it to the dice, as the existing plan choices do.
- **Breaking old saves is acceptable.**
- The user delegated everything else to the builder, including the list of far-bank kinds and all the details below. Those choices are marked *(our call)*.

## Goals

1. A new street-plan layout, **river town**, for settlements of 701–30,000 people. It must read as organic and English: streets that bend and follow the ground, a market where roads meet (a widened street or a triangle, not a central disc), burgage plots on the street fronts, back lanes, and lanes down to the water.
2. **Asymmetry.** The dominant bank holds about 75–85% of the buildings *(our call)*. The far bank holds the rest. One bridge joins the banks. At city scale a second bridge is allowed *(our call)*.
3. **A far bank with a character**, one of four kinds *(our call)*:
   - **Old village** (`village`): a green, its own parish church, smallholders and villeins under another lord, cottages and farmhouses.
   - **Bridge-end** (`bridgend`): a ribbon along the road beyond the bridge, with tanners, dyers and other smelly trades, inns and stables for late travellers, carters, and the poorest housing. It lies outside the borough's rules.
   - **Abbey's side** (`abbey`): a religious house's precinct (priory or friary) with its mill and its tenants, who answer to the abbot, not the town.
   - **Wharf side** (`wharf`): quays, warehouses and boatmen on the deeper water. It is busy and rough, and money passes through it.
4. **The rest of the town follows from the layout.** Ward names, ward values, parishes, crime turf, gossip and politics should reflect the two banks without extra DM work. The far bank should feel different in the Directory, the lenses and the panels.
5. **The radial layout keeps working** and stays selectable. Its output changes only because the module version bumps (see Constraints).
6. **The New town dialog** gets the two new choices.

## Non-goals

- Castle-hill, road and crossroads layouts. This work only makes room for them: see "Shape of the code".
- Changing hamlet layouts (700 people or fewer), apart from the unavoidable reseed from the version bump.
- A realistic terrain simulation. Simple high ground is enough.
- Changing what the rest of the generator needs from a layout, beyond the additive fields listed below.
- A renderer rewrite. The map keeps its parchment look.

## Anti-goals (it fails if…)

- The river town looks like the web with a river through it: radial spokes, concentric rings, or a disc-shaped market.
- It looks like a grid. The user lives where everything is a grid, and that is exactly what this must not be.
- The two banks are equal in size or in character.
- Buildings, plots or roads sit in the river, overlap each other, or are left without a plot. Every footprint in the plan must be placed, as the radial layout guarantees through its retry loop.
- A town of 30,000 takes noticeably longer to lay out than the radial plan does today. The budget is at most 2× the radial time for the same plan, measured with `PERF=1`.

## Constraints

- **Project rules in `CLAUDE.md` apply.**
  - Use no `Math.random`.
  - In `src/modules`, use only `dmath`, never `Math.sin`, `Math.cos` and the like.
  - Avoid all-pairs loops on big settlements.
  - DM choices override a roll and never replace the draw: always draw the layout kind and the far-bank kind, then apply the choice.
  - Town modules do nothing in hamlets.
  - No runtime dependencies.
  - The layout must stay clean-room: never consult GPL town generators (Settlemaker, watabou's MFCG).
- **Determinism.** The same seed and settings must give byte-identical output. The layout stays a pure function of its RNG stream and plan, so the existing cache in `layout/index.ts` keeps working. The cache key must include the new choices.
- **The layout contract is unchanged for consumers.** A river layout returns a `TownLayout` (`kind: "town"`) with everything other modules read today:
  - `wards`, as `WardGeo` with `value`, `near`, `compass`, `kind`, `ring`, `quarter`, `adj`;
  - `wall` (with gates on main roads);
  - `market`, `bridges`, optional `quay` and `castle`;
  - roads, buildings with `ward`/`block`/`front`/`road`, `fields`, `features`.
  
  For a river town, `ring` means distance bands from the market (0 is the core), so civic's ward naming keeps working. `sector` is an angular index around the market.
- **Additive fields** *(our call)*:
  - On `TownLayout`: `plan: "radial" | "river"` and `farBank?: FarBank`, where `FarBank = "village" | "bridgend" | "abbey" | "wharf"`.
  - On `WardGeo`: `bank?: "near" | "far"`.
  - Far-bank wards get `kind: "suburb"`, since they lie outside the borough, and `near` includes `"bridge"` plus the kind name.
- **Saves break.** Bump the layout module's major version (`1.0.0` → `2.0.0`), update the golden snapshot (`npx vitest run -u`), and add a `CHANGELOG.md` line. Any module whose output changes for existing seeds because of this also bumps. Hamlets will reseed: that is accepted.

## How it should work

### Choosing the layout

- **`Design` gains two fields:**
  - `layout?: "radial" | "river"`;
  - `farBank?: FarBank`.
- **Where the roll happens** *(our call, settled after the builder check)*. Both are rolled in the `uses` module at settlement level, before the building plan is made. The castle choice is already rolled there in the same way. This lets the far-bank kind **add its signature buildings to the plan**: the plan by itself often lacks them below a few thousand people (tanneries, inns, warehouses and religious houses all have population floors). The layout then reads the rolled kinds from the settlement and places them. `uses` bumps its major version along with `layout`.
- **Rolling.** Both are rolled for every street plan, even when the DM chooses (draw first, then apply the choice). Default odds *(our call)*:
  - river 2/3, radial 1/3;
  - far bank: village 35%, bridge-end 30%, abbey 15%, wharf 20%;
  - wharf only from 1,001 people;
  - the abbey's side at any size, because its religious house is added (below).

  No far-bank kind is ever impossible, so there is no fallback.
- **On the coast.** When "any" is chosen, coast towns roll only radial, because the radial plan already handles the sea. If the DM picks river on the coast, the river runs down to the sea along the downstream edge, and the quay goes on the dominant bank's downstream river front.
- **Shape.** The existing `shape` choice (round, oval, long) applies to the radial plan only. It is ignored for river towns.

### The site

- The river crosses the map with gentle meanders *(our call)*. It is wide enough to read clearly at town zoom and wider for cities.
- **The dominant bank is the higher bank.** Add a simple height field (a smooth sum of a few broad bumps from the layout's own stream) used only by the river layout. The river runs along the low ground. The town's high point, near the river on the dominant bank, takes the castle if there is one, otherwise the chief church.
- **The bridge** is placed where the high street meets the river, at a narrows. It carries a toll and often a chapel, which goes in `features` and can be rendered.

### Streets: grown, not stamped

The method is the builder's, but it must produce these properties:

- **The high street** runs from the bridge up to the **market**. The market is a widened stretch of street or a triangle where two or three roads meet, sized as the radial plan sizes it (it grows with the town).
- **Main roads** leave the market for the gates. They take the easy line across the height field and the existing roads out (`mainRoads`). They curve and they don't radiate evenly.
- **Back lanes** run behind the plots, about one plot-depth back from each main street, so plots back onto them. **Cross lanes** link streets at irregular intervals.
- **Water lanes** run down to the river from the streets nearest it.
- **Plots** are long, narrow burgage plots cut perpendicular to the street front, as the radial plan cuts them. The corner plot goes to the better street (same `FrontKind` priority).
- **Blocks** are the areas the streets enclose. Churches and precincts take whole blocks or slices, as the radial plan does.
- **The wall**, when there is one, wraps the dominant bank only. Its line follows the high ground and meets the river at both ends. Gates go where main roads cross it, and the bridge gate is at the bridge foot. The far bank is never walled *(our call)*.
- **Suburbs** string out along the roads beyond the gates on the dominant bank, as in the radial plan. The `suburbs` choice still applies.
- **Mills** go on the river. Tanneries and other smelly trades go downstream, on the far bank when it is a bridge-end.

### The far bank, by kind

**Signature buildings join the plan** *(our call)*. Each kind adds a few uses to the plan if they aren't already there, scaled down for small towns so a market town of 900 isn't swamped. These buildings are reserved for the far bank:

| Kind | Added to the plan if missing |
|---|---|
| Old village | a chapel (a fane from 3,000 people); 3–8 cottages or farmhouses moved from the plan's housing; an alehouse |
| Bridge-end | 1 tannery; 1 inn (an alehouse or hostel below the inn's 1,500-person floor); 1 stable or carter's yard |
| Abbey's side | a religious house sized to the town (a small priory cell below 4,500 people, otherwise the plan's friary or priory, moved over); its mill; a chapel serving as parish church for the tenants |
| Wharf side | 1–3 quays' worth of wharf frontage; 1 warehouse (a storehouse below 2,500 people); 1 boatwright |

Other placement biases go through the existing use-to-plot assignment (`value`, `cluster` and keeping-apart rules). Each kind:

| Kind | Street pattern | Gets first call on | Ward value |
|---|---|---|---|
| Old village | a green with houses round it and a lane or two off the bridge road | cottages, farmhouses, a parish church (fane or chapel), an alehouse, a smithy | low to moderate residential |
| Bridge-end | a ribbon along the road from the bridge | tanneries, dyers, inns, stables, carters, the poorest housing | slum to low commercial |
| Abbey's side | a walled precinct block, with the road and a few tenant lanes beside it | the priory or friary, its mill, tenant cottages | low to moderate residential, precinct excluded |
| Wharf side | a strand along the river with quays and short lanes behind | quays, warehouses, boatwrights, rooming houses, an alehouse | low to moderate commercial |

- **The far bank as a place.** It is one or two wards, `kind: "suburb"` and `bank: "far"`, plus more at city scale.
- **Names** come from civic, which gains candidates *(our call)*:
  - "Over the Bridge", "Bridge End" and "Bridgefoot" for any far bank;
  - "Abbey Fee" for the abbey's side;
  - "the Strand" for the wharf side;
  - the old village's own name (a place name from the names provider, for example "Old Ashby") for the village.

### The rest of the generator

These are additive changes in other modules. Each is gated on `map.plan === "river"` so the radial and hamlet outputs stay put, apart from the version reseed.

- **Religion.** An old-village or abbey far bank is its own parish, even when it is small *(our call)*. In a river town, households are assigned to the nearest parish church **on their own bank**, so far-bank households never count towards a church across the river.
- **Politics.** The quarrel of the year can draw from bridge, toll and market-rights grievances between the banks. The content already has bridge tolls. The town-versus-abbey feud is added for the abbey's side.
- **Manor and lordship.** An old village answers to another lord. At minimum, its ward carries a note naming the lord. A full second manor entity is optional and the builder's call.
- **Crime.** A bridge-end or wharf far bank should draw crews and dens a little more. Use the existing `ward value` and `near` inputs, not new rules, where that is enough.
- **Gossip.** No change is required. The bridge as a chokepoint can come later.

### The New town dialog

- **Layout** (any / river town / radial web) sits in the Street plan section.
- **Far bank** (any / old village / bridge-end / abbey's side / wharf side) shows only when the Layout is "river town" or "any".
- **Shape** is hidden when the Layout is "river town".
- `settingsFromForm` and `designFrom` carry the two fields, and `townKey` includes them.

### The map renderer

- The renderer draws `bridges` (with the chapel when present).
- It draws high ground with a light hachure or tint, and the far-bank ward label like any other.
- Nothing else needs to change. The river already renders.

## Shape of the code

- **Split the layout by plan** *(our call)*:
  - The current `town.ts` becomes the radial plan (`radial.ts`).
  - The river town goes in its own file (`river.ts`).
  - Shared steps go in a `streets.ts` (or similar): plot cutting along a street front, use-to-plot assignment, ward values, reserved blocks, fields beyond the town, and the market's furniture.
  - Move shared steps only when the river plan needs them. Don't refactor the radial plan beyond extracting what both use.
- **Dispatch.** `layout/index.ts` dispatches on the rolled `layout` kind. The retry-with-more-room loop applies to both plans.
- **Later sites** (castle hill, road town, crossroads) are new files implementing the same contract, plus a new `layout` value.

## Testing

Tests follow the style of `tests/town.test.ts` and `tests/design.test.ts`:

- **Determinism:** the same seed and settings give the same layout.
- **Every footprint is placed,** with no building or plot overlapping another, the river, or a road. Check at 800, 3,000, 8,000 and 30,000 people.
- **Asymmetry:** the far bank holds 15–25% of buildings, across 20 seeds per size.
- **Each far-bank kind**, at every size from 701 people, gets its signature uses on the far bank (a green and a parish church for the village, a tannery or an inn for the bridge-end, a religious house for the abbey, a quay for the wharf). Its wards have `bank: "far"` and `kind: "suburb"`.
- **The bridge** links the banks, and the road graph is connected.
- **The market** is not a disc at the map's centre. Test that its centroid isn't at the plan origin, or that its shape's aspect ratio isn't round. It must touch at least two main roads.
- **No radial structure:** main-road bearings from the market are not evenly spaced across several seeds. This is a cheap check against the "spiderweb with a river" failure.
- **DM choices** override the roll without moving other draws.
- **Performance:** `PERF=1` reports layout time for both plans at 30,000 people. The river plan must be at most 2× radial.
- **Visual check:** with `tools/preview.sh` and `tools/look.mjs`, render about 6 river towns per far-bank kind at 1,500, 5,000 and 20,000 people. The images get read and judged against the anti-goals before the work counts as done.

## Left to the builder

- The street-growing algorithm, the height field's form, how meanders are drawn, and exact widths and spacings.
- Exact probabilities, within the spirit above.
- Whether the old village gets a full second manor entity.
- How bridges and high ground are rendered, within the parchment look.
