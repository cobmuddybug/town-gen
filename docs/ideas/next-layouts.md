# Next layout types (to brainstorm after river towns)

Filed 2026-10-23 at the user's request: "file this for brainstorming after this update, when we get around to it, I'll want you to work on them all". Every one of these is to be done; brainstorm each before building. Ordered by how much of the river-town code each can reuse.

Before starting any of these, read [layout-lessons.md](layout-lessons.md): what building the river town taught.

**Status (2026-10-23): all six built** on the grown-town engine (`src/modules/layout/grown.ts`); design in
`docs/superpowers/specs/2026-10-23-more-layouts-design.md`.

1. **Ridge town, down to a river** (Totnes, Lewes, Shaftesbury, Bridgnorth). One main street climbs a ridge from a river crossing to a castle or church at the top; burgage plots fall away steeply both sides; lanes and steps drop off the ridge. Reuses the height field, the high street up from the bridge, burgage cutting, back and water lanes. Main change: the high street follows the ridge line instead of curving to a market.
2. **Castle-gate town** (Devizes, the user's original reference; Ludlow, Richmond (Yorks), Launceston, Pembroke). The town grows outside the castle gate; streets curve round the old outer bailey; the market fills the space before the gate. Reuses the height field (castle on the high point), contour side streets (concentric arcs round a hill), plot cutting, the wall-fits-the-town logic, ward clustering. New: streets that follow the bailey line rather than the slope.
3. **Street town** (Marlborough, Chipping Campden, Thame, Henley-in-Arden, Northleach). One very wide high street that is also the market, long burgage plots both sides, back lanes, little else; often no wall. Reuses the widened-street market, plot cutting, back and cross lanes, suburb ribbons; a river at one end can reuse the bridge. Mostly simplification: no side-street growth.
4. **Crossroads market town** (Banbury, Chichester, Abingdon, Cirencester). Two main roads cross; the market at or beside the crossing, often a triangle in one corner; streets fill between the arms. Reuses uneven road bearings, the triangle market, contour infill, wall and gates. Caution: must not read as radial; arms bend and are unequal.
5. **Abbey-gate town** (St Albans, Tewkesbury, Abingdon, Evesham, Sherborne). A large abbey precinct dominates; the town grows outside its gate with the market before the gatehouse. Reuses the far-bank precinct code, the "site adds signature buildings" pattern, the town-versus-abbey quarrel, plot cutting. Caution: Bury St Edmunds is a grid; avoid it as a template.
6. **Harbour town** (Dartmouth, Whitby, Fowey, Rye). Streets pinned between steep ground and the water, quays along the front, lanes climbing the hill. Reuses the strand/quay street, water lanes, coast and sea handling, height field. Furthest from what exists: the land is the binding constraint, not the street pattern.

Suggested starts: the castle-gate (biggest visual change; the user's reference) or the ridge town (cheapest win).

Avoid as templates: New Winchelsea, Salisbury and Ludlow's later planned core: bastide grids, against the "not a grid" anti-goal.
