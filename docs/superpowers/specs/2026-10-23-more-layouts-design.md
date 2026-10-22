# Six more town layouts: design

Status: written 2026-10-23 by Claude. The user asked for all six layouts filed in
`docs/ideas/next-layouts.md` and said "start without me, feel free to research town layouts as you
go". Every decision here is **Claude's call** unless marked as the user's. Read
`docs/ideas/layout-lessons.md` alongside this.

## Intent (the user's)

- The spiderweb plan looks unnatural. Real English towns are organic and shaped by their site
  (Devizes was the user's first example). Never grids.
- More variety: every layout is selectable in the New town dialog, and the dice pick one when the DM
  leaves it on "any".
- Breaking old saves is acceptable.

## What research said (2026-10-23)

- **Devizes:** the streets follow the line of the castle's defence ditches (arcs round the castle).
  The burgage plots of the Market Place and New Park Street were planned. The market lay in the outer
  bailey and before St Mary's ([Wiltshire community history](https://apps.wiltshire.gov.uk/communityhistory/Community/Index/77),
  [Wikipedia: Market Place, Devizes](https://en.wikipedia.org/wiki/Market_Place,_Devizes)).
- **Totnes:** the town sits on a ridge running down to the Dart crossing. The high street follows an
  old trackway up the ridge, with burgage plots perpendicular to it. The castle stands at the summit,
  the East Gate part-way up, and a small Bridgetown lies over the bridge
  ([South Hams appraisal](https://southhams.gov.uk/sites/default/files/2023-07/Totnes%20Conservation%20Area%20Appraisal%20-%20High%20Street.pdf),
  [English Heritage](https://www.english-heritage.org.uk/visit/places/totnes-castle/history/)).
- **Dartmouth:** the town is a waterfront with a quay. Narrow streets, steep hills and flights of
  steps climb from it, and early suburbs lie on the slopes above
  ([Wikipedia: Dartmouth](https://en.wikipedia.org/wiki/Dartmouth,_Devon)).
- **Abbey towns:** a broad market place lies outside the abbey gatehouse (Peterborough, Abingdon),
  with streets radiating from it, inns for pilgrims, and narrow, deep plots
  ([Oxoniensia: Abingdon](https://www.oxoniensia.org/volumes/2010/Thomas.pdf),
  [St Albans appraisal](https://www.stalbans.gov.uk/sites/default/files/documents/publications/planning-building-control/conservation/16.03.03%20Area%204a%20-%20Commercial%20Centre%20FINAL%20JD_tcm15-53958.pdf)).

## Architecture

One engine, many forms. `river.ts` already has the whole pipeline: site, then grown streets, plots,
wards, reserved sites, placement, the wall pull-in, fields and output. It becomes the **grown-town
engine** (renamed `grown.ts`), taking a `form`. Each form changes the site and the spine; the shared
pipeline stays one copy. `layoutRiver` stays as the river form's entry point, so river towns are
**byte-identical** after the refactor. A guard snapshot (like the radial one) is added before the
refactor and must not move.

Per form, the engine varies:

| Step | Varies by form |
|---|---|
| Site | the river's offset (crossing the town's edge, or a stream passing at a distance), the height field's shape, the sea, and the anchor (castle or precinct) |
| Spine | the high street and the market (shape and position) |
| Main roads | the bearings allowed and how many |
| Side streets | the share that run along the slope versus down it, and the frontage target |
| Far bank | only river and ridge forms have one |
| Reserved sites | castle-gate's castle and abbey-gate's precinct are fixed before plots |

### The forms

1. **River** (exists): unchanged.
2. **Ridge** (Totnes, Lewes, Bridgnorth).
   - **Site:** a long ridge rising from the river crossing. Height = a ridge profile across its axis
     times a rise along it, plus a little noise.
   - **Streets:** the high street climbs the crest from the bridge (the existing climb-the-easiest-rise
     walk follows a crest naturally). It is longer, about 1.2R. The market is a widened stretch part-way
     up, never a triangle. The castle (if any) takes the summit at the top end. Main roads leave from
     the top and from the market down the flanks. Side streets mostly run *down* the slope (level
     share 0.35). Back lanes run along the flanks.
   - **Far bank:** yes (Bridgetown), rolled as for river towns.
3. **Castle-gate** (Devizes, Ludlow, Richmond).
   - **Castle:** always has one; if the DM chose "no castle", the form is not offered and falls back.
     Its anchor is a mound on the high point. Height = a cone falling away from the castle, so
     contour-following side streets become arcs round it (Devizes' ditch lines).
   - **Market:** a broad space against the castle's gate side (the old outer bailey). Main roads fan
     out away from the castle (never through it).
   - **Water:** a stream passes at a distance (mills need one), with no far bank.
4. **Street town** (Marlborough, Chipping Campden, Thame).
   - **Spine:** one long, gently curving, very wide high street *is* the market. Its length grows to
     carry most of the town's frontage.
   - **Other streets:** a road on at each end, at most one side road, back lanes and a few cross lanes.
     Side streets only if the high street can't carry enough (frontage target, then a capped number of
     side streets).
   - **Water:** a stream passes at a distance.
5. **Crossroads** (Banbury, Abingdon, Cirencester).
   - **Roads:** two through-roads cross near the middle as four arms of unequal length that bend
     (never straight, never even: it must not read as radial).
   - **Market:** a triangle in one angle of the crossing, or the widened crossing itself. Side streets
     fill between the arms.
   - **Water:** a stream passes at a distance.
6. **Abbey-gate** (St Albans, Tewkesbury, Peterborough).
   - **Abbey:** always has one. It is a large walled precinct on one side, with a new `abbey` use (an
     abbot and 20–40 monks) drawn as a church, cloister and precinct.
   - **Market:** a broad space before the precinct gatehouse. The town grows away from the precinct;
     main roads fan from the market.
   - **Water:** a stream passes at a distance.
   - **Downstream:** the town-versus-abbey quarrels already written for the abbey far bank apply.
7. **Harbour** (Dartmouth, Fowey, Whitby).
   - **Sea:** close in front of the town; the land rises steeply from the shore.
   - **Spine:** the quay street along the shore. The market is a widened quayside space. Side streets
     follow the contour (parallel to the shore, stacked up the hill), with steep lanes climbing between
     them (the "down" streets).
   - **Main roads:** along the shore both ways and one climbing inland.
   - **Water:** a river reaches the sea beside the town, with no far bank.
   - **Rolling:** only rolled on the coast.

### Rolling (uses/urban.ts)

`rollLayout` still draws last and always, so a DM choice moves nothing else. The rolled form is
weighted by terrain:

| Terrain | river | ridge | castle | street | crossroads | abbey | harbour | radial |
|---|---|---|---|---|---|---|---|---|
| farmland | .25 | .05 | .15 | .2 | .2 | .1 | 0 | .05 |
| hills/moor | .2 | .25 | .25 | .05 | .1 | .1 | 0 | .05 |
| forest | .25 | .1 | .15 | .2 | .15 | .1 | 0 | .05 |
| coast | .2 | .05 | .05 | .05 | .05 | .05 | .5 | .05 |

- **Size floors:** castle-gate and abbey-gate need 1,001+ people (castles and abbeys need a town).
  Below that, the draw falls back to river.
- **Far bank:** the far-bank draw happens always and applies to river and ridge.
- **Signature buildings:**
  - castle-gate adds a castle when the plan lacks one, unless the DM chose "no castle" (then the
    rolled castle-gate becomes crossroads);
  - abbey-gate adds an `abbey`;
  - harbour reserves nothing new (a quay is street, fishers come from the base).

### Downstream

- **Types:** `LayoutPlan` gains `ridge | castle | street | crossroads | abbey | harbour`. `TownLayout.plan`
  likewise.
- **civic ward names:**
  - castle-gate: "Castle Ward", "Bailey";
  - abbey-gate: "Abbey Gate", "Sanctuary";
  - harbour: "Quay Ward", "the Strand";
  - ridge: "Over Town" / "Under Town" by height;
  - street town: "Upper / Lower End";
  - crossroads: wards named by arm ("North Street ward").
- **politics:**
  - castle-gate: the garrison, castle-guard dues;
  - abbey-gate: the abbey quarrels;
  - harbour: harbour dues and wrecks;
  - each pool weighted like the abbey's.
- **map:** the bridge deck for every form that has `bridges` (not radial). The abbey precinct drawn as
  a precinct. Contours for every grown form.
- **UI:** the Layout select lists all eight (river, ridge, castle-gate, street town, crossroads,
  abbey-gate, harbour, radial web). "Over the bridge" shows for river and ridge only. Shape shows for
  radial only.

## Testing (from the lessons)

For **every** form, on day one, property tests over whole towns at several sizes and seeds:
- nothing in the water;
- nothing on a street;
- no overlaps;
- nothing across the wall;
- signature present (castle, abbey, quay);
- the river reaches the sea on the coast;
- the wall hugs the town;
- trades not in rows;
- plot runs exist;
- the Suburbs choice matters;
- determinism;
- speed within 2× radial at 30,000;
- the form's own shape test:
  - ridge: the high street climbs (height rises along it);
  - castle-gate: side streets mostly keep a constant distance from the castle;
  - street town: the high street carries most of the frontage;
  - crossroads: four arms of unequal length;
  - abbey-gate: the market touches the precinct;
  - harbour: the quay street runs along the shore.

Plus the river guard snapshot and the radial guard snapshot, unmoved. Every form gets a visual
check in the app before it is called done.

## Non-goals

- New UI beyond the Layout select.
- Changing radial or river towns' output.
- Grids, bastides.
- Variable-width rivers (deferred).

## Order

1. River guard snapshot.
2. Engine refactor (form parameter, river unchanged).
3. Then one form at a time: ridge, castle-gate, street town, crossroads, abbey-gate, harbour.
4. Rolling and UI.
5. Downstream names and issues.
6. Final review by a fresh reviewer.
