# Town Generator — Design Document

*Working title. Low-fantasy, human-only, mundane medieval town generator for D&D, built incrementally with Claude Code.*

This is a living document. It is meant to sit in the repo as `docs/DESIGN.md`. The "Notes for Claude Code" section at the bottom can be lifted into `CLAUDE.md`.

---

## 1. Pillars

1. **Look closer, get more.** A settlement starts as a map. Clicking a building identifies it. Clicking an occupant gives a person, their household, their relationships, and eventually what is on their kitchen table. Nothing is generated until it is looked at.
2. **Same seed, same town, forever.** Everything is deterministic from the town seed and the entity's address. Saves store the seed, the module versions, and the DM's edits, never the whole town.
3. **Modules never disturb each other.** Adding heraldry, a new name generator, or a gossip system must not change a single name, building or relationship in an existing saved town.
4. **Plausible, not fantastical.** The default tone is the dull, grinding plausibility of a real medieval town: debts, boundary stones, inheritance, tithes, bad bread, the miller's thumb on the scale. Plot hooks come out of that mundanity.
5. **Facts are procedural, prose is optional.** Generators produce structured facts. An optional LLM pass can turn facts into read-aloud prose, but it never invents facts the rest of the system can't see.

---

## 2. Setting profile

### 2.1 Defaults

- **Humans only.** No demographics tables for other peoples.
- **No working magic.** Superstition is real; magic is not. Cunning folk, charm-sellers, fortune-tellers and relic-pedlars exist and are believed in. Whether they're frauds, sincere, or something the DM decides is ambiguous is left to the DM.
- **Era: high medieval** by default, with an era profile so content can be filtered.

### 2.2 What we take from *Gary Gygax's Living Fantasy* (Troll Lord Games, 2003)

The book is a sourcebook on how a pre-modern fantasy society runs: class tiers, what each tier owns and eats, how hamlets differ by economy, who governs, courts, town services, temples, daily routines. It is used here as a **parameter source**. We take its proportions, structures and rules of thumb, rewrite them as data tables in our own words, and cite page numbers (`LF p.72`) so the source can be checked. No book text goes into content files.

**Important caveat:** Gygax deliberately assumes an *advanced, late-renaissance-ish* fantasy world. It has tobacco, tea and coffee, gin, potatoes, organised fire brigades, aqueduct water, weekly newssheets, museums, Baroque architecture and banks with letters of credit. Our default is earlier and plainer, so every content item carries an `era` tag and the active era profile filters it (see 2.4).

### 2.3 Translation table for a mundane setting

| Living Fantasy has | We use |
|---|---|
| Mages, enchanters, geourges | Removed. Possibly a scholar or astrologer of the upper middle tier. |
| Diviners, hedge magicians, apotropaists | Cunning folk, astrologers, charm-sellers, wise women (social role, no powers) |
| Alchemists | Apothecaries; "alchemist" as a learned crank or swindler |
| Magical healthcare by class | Physician (upper) → barber-surgeon (middle) → healer, herbwife, bonesetter (lower) → nothing (underclass). Priority by class still applies. |
| Gypsies as a criminal-underclass category | "Travelling folk" bands (tinkers, horse-traders, players), as a neutral itinerant group |
| Non-human underground construction | Removed. Cellars, crypts and old mine workings stay. |
| Exotic and magical punishments | Removed. Stocks, pillory, fines, branding, workhouse, exile, hanging. |
| "Temple, fane, chantry" vocabulary | Kept as a configurable religion module so it can be renamed to a real-world-flavoured church or an invented faith |

### 2.4 Era profiles

```ts
type Era = "early_medieval" | "high_medieval" | "late_medieval" | "early_modern";
```

Every content row (occupation, building, food, drink, service) has `era: Era[]` listing the eras it can appear in. The town's `era` setting filters tables at generation time.

| Era | Examples of what changes |
|---|---|
| `high_medieval` (default) | No tobacco, tea, coffee, potatoes, gin, printed news or fire brigades. Ale, cider, mead and wine. Fire hooks and buckets. Night curfew. |
| `late_medieval` | Brandy, early printing (woodblock broadsides), more stone and brick in towns, more money economy |
| `early_modern` | Gygax's full assumptions: tobacco, coffee houses, gin, sewers, fire stations, newssheets |

---

## 3. Architecture

### 3.1 Addresses and seeds

Every entity has a stable **address**, which is a path from the settlement root:

```
town:7f3a
town:7f3a/building:b017
town:7f3a/building:b017/household:0
town:7f3a/building:b017/household:0/person:2
town:7f3a/person:p00412          # canonical person id (people move house)
```

Randomness is derived, never shared:

```ts
// One RNG per (address, module, purpose). Order of generation never matters.
function rngFor(address: string, moduleId: string, purpose = ""): Rng {
  return sfc32FromString(`${townSeed}|${address}|${moduleId}@${major(moduleVersion)}|${purpose}`);
}
```

Rules:

- **No module ever reads from another module's RNG stream.** This is what makes pillar 3 hold. A new heraldry module draws from `…|heraldry@1|…` and cannot shift the names drawn from `…|names-core@1|…`.
- **The module's major version is part of the seed.** A breaking change to a generator bumps its major version. Old saves pin the old version and keep working, or the DM can choose to regenerate. (Procedural layout tools commonly warn that determinism only holds within one version; this is the same problem.)
- **IDs are generated deterministically too**, so `person:p00412` is the same person on every load.

### 3.2 Lazy generation and observation

Entities have a **generation depth**. Asking for a deeper field triggers that level's generators, which run once and are then cached in memory.

```ts
town.building("b017").resolve(Depth.Household)  // runs L3 generators for b017 only
```

Generating something at depth N may *reserve* things at a shallower depth elsewhere. For example, generating a household's debts creates a creditor in another building. Those references are created as **stubs**: addresses with only the minimum facts required ("a moneylender, upper middle class, lives in the merchant ward"). The stub resolves fully when someone clicks it.

### 3.3 The overlay

DM edits are stored as a patch layer keyed by address and field:

```json
{ "town:7f3a/building:b017": { "use": "cooper" },
  "town:7f3a/person:p00412": { "name": "Agnes Thatcher", "traits+": ["pious"] } }
```

Generators check the overlay first. Downstream generators see the overlaid value, so changing a chandler to a cooper changes the stock, the tools and the guild, but not the person's name, which comes from a different stream. Regenerating an entity keeps its overlay unless the DM clears it.

### 3.4 Pinned entities

An entity can be **pinned**. That snapshots its generated state into the save so that it survives a generator upgrade untouched. This is for the handful of NPCs the players actually know.

### 3.5 Stack

- TypeScript, Vite, no framework required at first (vanilla or Preact if the UI grows)
- **Our own layout generator** for L1 (`src/modules/layout`), written from scratch so the project can be MIT. It does not use, port or consult Settlemaker or watabou's Medieval Fantasy City Generator, both of which are GPL-3. Only general ideas are shared (roads, plots, walls), and ideas aren't copyrightable. The hamlet engine is an English street village: main road, side lane, green, ford, tofts and crofts, hedge, and three open fields in furlongs. Town and city layout (wards, walls, gates) is still to come at milestone 7, and it will be our own code too.
- **Deterministic maths.** Layout geometry uses `src/core/dmath.ts` (polynomial sin/cos, sqrt-based hypot), because `Math.sin` and friends may round differently across JS engines, and the layout makes accept/reject decisions on geometry.
- **No runtime dependencies.** YAML content is converted to JSON at build time, so the bundle is entirely our own MIT code.
- SVG map with a pan and zoom library
- Saves as plain JSON files. Local-first, no server, backed up via git.
- Tests: Vitest, with determinism snapshot tests (section 12)

---

## 4. Data model

### 4.1 Core entity types

The core knows only these. Everything else is a component added by a module.

| Entity | Notes |
|---|---|
| `Settlement` | Root. Size class, economic base, lord, era, region context |
| `Ward` | District or quarter, with a value class (see 6.9) |
| `Building` | Polygon from the layout, use, construction, condition |
| `Household` | People sharing a roof and a budget. Has a class tier. |
| `Person` | One canonical record; households reference people |
| `Business` | A trade operated from a building; may span households (master + journeymen) |
| `Institution` | Manor, parish or temple, guild, court, watch, college: anything with members and offices |

### 4.2 Components

A component is a typed record attached to an entity and owned by exactly one module:

```ts
interface Component<T> { module: string; schemaVersion: number; data: T }
```

Examples: `Construction` (core), `Materials` (households module), `Arms` (heraldry), `Schedule` (routines), `Knowledge` (gossip).

### 4.3 Relationships

Relationships are directed, typed, weighted edges in a single graph:

```ts
interface Edge {
  id: string;
  from: Address; to: Address;
  kind: EdgeKind;              // registry-extensible
  weight: number;              // -1..1 (hostile..devoted) or magnitude for debts
  since?: GameDate;
  facts?: Record<string, unknown>;  // e.g. { amount: 40, currency: "s" }
  knownBy: Address[] | "public";    // a secret is an edge with a short knownBy
}
```

The core edge kinds are `kin` (with a subtype), `spouse`, `betrothed`, `lover`, `employer`, `apprentice_of`, `tenant_of`, `debtor_of`, `rival`, `friend`, `godparent`, `member_of` (institution), `office_in` (institution), `vassal_of` and `owes_service`. Modules can register more.

### 4.4 Class tier

Every household gets a **tier** (section 6.3). Tier is the single most important input to downstream generators: it drives dwelling, diet, dress, servants, arms, literacy, influence, which court tries them, and what their house smells like.

---

## 5. Module system

### 5.1 The interface

```ts
export interface Module {
  id: string;                       // "heraldry"
  version: string;                  // semver; major goes into RNG seeds
  requires?: string[];              // ["core", "households"]
  era?: Era[];                      // optional era restriction

  components?: Record<string, Schema>;
  registries?: RegistryContributions;   // occupations, building uses, edge kinds, name providers, sifters…
  hooks?: Partial<Hooks>;
  panels?: PanelSpec[];             // UI sections shown for an entity type
}

interface Hooks {
  onSettlementGenerated(ctx: Ctx, s: Settlement): void;   // L0/L1
  onWardGenerated(ctx: Ctx, w: Ward): void;
  onBuildingResolved(ctx: Ctx, b: Building): void;        // L2
  onHouseholdResolved(ctx: Ctx, h: Household): void;      // L3
  onPersonResolved(ctx: Ctx, p: Person): void;            // L4
  onDetailResolved(ctx: Ctx, e: Entity): void;            // L5
  onDayAdvanced(ctx: Ctx, date: GameDate): void;          // time passing
}
```

`ctx` gives the module its own RNG (`ctx.rng(purpose)`), read access to the graph and overlay, and the ability to create stubs and edges.

### 5.2 Registries

Most extension happens by adding rows to registries, not by writing new hooks:

| Registry | Example row |
|---|---|
| `occupations` | `{ id: "cooper", tier: "middle_middle", era: [...], workplace: "cooperage", guild: "coopers" }` |
| `buildingUses` | `{ id: "cooperage", category: "smaller_urban", staff: [...], sizeClass: [...] }` |
| `nameProviders` | `{ id: "anglo-norman", cultures: ["default"], generate(rng, ctx) }` |
| `edgeKinds` | `{ id: "sworn_brother", symmetric: true }` |
| `sifters` | pattern queries that turn graph state into hooks (section 9) |
| `eraProfiles`, `religions`, `calendars` | swappable settings |

### 5.3 Name generators as drop-ins

```ts
export const angloNorman: NameProvider = {
  id: "anglo-norman",
  cultures: ["default"],
  given(rng, { sex, tier }) { ... },
  family(rng, { occupation, origin, tier }) { ... },  // bynames: occupational, locative, patronymic
};
```

The settlement config picks providers per culture or region. Adding a new namegen script means adding one file and one config line. Bynames should prefer the medieval logic of occupation, place, father or nickname, so a family surname can be "out of date" with their current trade ("the Smiths are coopers now"). That kind of mismatch is free texture.

### 5.4 Load order and isolation

- Modules are topologically sorted by `requires`.
- A module may **read** any component but **write** only its own components, its own edges, and stubs.
- A module may declare `overrides` on a registry row owned by another module (e.g. an era module removing `tobacconist`). Overrides are logged in the save so their effect is reproducible.

---

## 6. Generation rules (from Living Fantasy, adapted)

Numbers are starting parameters. They live in data files under `content/`, not in code, so they can be tuned.

### 6.1 Zoom levels

| Level | Clicking reveals | Main generators |
|---|---|---|
| **L0 Region** | Liege, terrain, roads and rivers, economic base, era | `region`, `feudal` |
| **L1 Settlement** | Map, wards, walls or palisade, green, market, temple sites | `layout`, `wards`, `institutions` |
| **L2 Building** | Use (home, shop, inn, chapel…), construction, roof, condition, occupancy | `buildingUse`, `construction` |
| **L3 Household / Business** | Who lives and works here, tier, trade, servants, apprentices, debts, standing | `households`, `businesses`, `economy` |
| **L4 Person** | Name, age, traits, history, offices, relationships, secrets, daily routine | `people`, `names`, `relationships`, `routines` |
| **L5 Close detail** | What they're wearing, eating, worried about; the room's contents; today's rumour | `materials`, `inventory`, `gossip` |

### 6.2 Settlement size classes (LF p.72)

| Class | Population | Notes |
|---|---|---|
| Hamlet | 50–250 | Settlement of generally free folk |
| Thorp | ~300–1,000 | Large hamlet |
| Village | ~1,000–5,000+ | Non-manorial |
| Manorial village | hamlet to village size | Owned outright by a lord (royal, noble or ecclesiastical); inhabitants are villeins |
| Town | > ~6,000 | |
| City | > ~25,000 | |

All settlements are **closely built**, with buildings shoulder to shoulder so the whole can be enclosed (a fence or hedge for a hamlet, a curtain wall for a city). Farms cluster in or right beside the settlement, as walled compounds.

### 6.3 Class tiers

**Realm-wide distribution (LF pp.44–65).** This is used at L0 to decide what kind of people exist in the region and who the local lord is. It is *not* applied directly to a hamlet, since a hamlet has no dukes.

| Class | Tier | Share of population | Typical members (mundane-filtered) |
|---|---|---|---|
| Upper | upper upper | ~1 in 50,000 | sovereigns, great palatine nobles, heads of the realm's faith |
| | middle upper | ~1 in 10,000 | marquises, counts, viscounts, great barons, great officers, lords mayor of free cities, knights commander |
| | lower upper | rest of ~1% | petty nobles, lesser barons, knights of royal orders, judges, senior clergy |
| Middle (~21%) | upper middle | ~2.5% | wealthy esquires and gentlemen, wealthy merchants, major guild masters, abbots and abbesses, lawyers, magistrates, architects, ship owners, bankers, goldsmiths, landless knights, large landowners |
| | middle middle | ~6.5% | lesser guild masters, ordinary merchants, innkeepers, priests, notaries, scholars, millers, artisans, landless esquires, socmen, freemen, justices of the peace, ordinary officers |
| | lower middle | ~12% | petty merchants, shopkeepers, bailiffs, minor town officials, minor clergy, serjeants and men-at-arms, journeymen, large tenant farmers, small farmers, artists, poets, renowned performers |
| Lower (~78%) | upper lower | ~22% | village officials, tavern keepers, waggoners and carters, huntsmen, stall vendors, fishermen, constables, tenant farmers, healers, chief servants, monks and nuns, artisans' apprentices |
| | middle lower | ~26% | hamlet officials, deputy marshals, gardeners, ordinary servants, herdsmen, pack traders, boatmen, chimney sweeps, chapmen, other apprentices |
| | lower lower | ~30% | menial servants, ordinary soldiers and sailors, peasants, dock workers, woodcutters, labourers, link boys, street sweepers, nightsoil men, villeins, licensed beggars |
| Underclass | — | +10–15 per 100 | itinerant workers, bond servants, serfs, debtors |
| Criminal underclass | — | +5–10 per 100 | thieves, unlicensed beggars, outlaws, runaways, vagabonds, mountebanks, fences; assassins at the top |

**Urban composition (LF pp.83–84)** is used for towns and cities directly:

| Group | Share |
|---|---|
| Workers (servants, labourers, porters, sweepers, laundresses, day labourers) | ~50% |
| Tradesmen (small shops, taverns, cookshops, stalls, weavers, carpenters, smiths) | ~25% |
| Underclass, recorded | ~10% |
| Underclass, unrecorded (the town is ~10% bigger than its census says) | +~10% |
| Craftsmen (guild masters, artisans, journeymen, apprentices) | ~9% |
| Merchants (importers, factors, financiers) | ~4% |
| Aristocrats, clergy, officials | remainder (~2%) |

### 6.4 Household materials (LF Tables 2:2–2:16)

Gygax gives every tier the same schema of material conditions. We use it directly as the L3/L5 component `Materials`, with one content row per tier:

```
land · dwelling · illumination · heat · plumbing · cooking · officers ·
dependents · servants · transportation · arms & armour · personal property ·
dress · diet · drink · wealth · power · influence
```

Gradients worth encoding, paraphrased:

- **Dwelling:** palaces, castles and hunting lodges (upper) → one large house plus a country manor (upper middle) → own building, often shop below and living above, 6–10 rooms (middle middle) → small building or rented rooms (lower middle) → rented quarters (upper and middle lower) → a room or two (lower lower) → hovel, shed, doorway, gaol (underclass).
- **Cooking:** lower-class town households often have **no hearth fit for cooking** and take food to a common cookhouse or bakehouse. Country folk cook on their own hearth. This is a great L5 detail and a reason for people to be in a particular place at a particular hour.
- **Servants:** up to ~25 staff for the wealthiest upper middle household; one or two for middle middle (housemaid, journeyman, an apprentice or two); none below.
- **Arms:** swords are worn by the upper and middle tiers and **forbidden to the lower class** in most places. Below that tier people carry tool-weapons: axe, cleaver, flail, spear, knife.
- **Display:** the upper middle class competes through costume, residence and conveyance. A successful middle middle household may pour its spare money into **one showpiece room** to look higher than it is. That's a good L5 detail.
- **Dress styles:** `traditional` / `modish` / `near-astonishing`, with tier and occupation shifting the odds. Scholars, ship owners and fencing masters run modish; landed gentry run traditional.
- **Work garments** (LF Table 2:12). Men: cap, jacket, apron, smock, shirt, knee breeches, stockings, leggings, shoes. Women: kerchief, coat, apron, smock, blouse, skirt, petticoat, stockings, shoes. Layer by season.
- **Villein inventory** (LF p.78) is a ready-made L5 table. It covers kitchenware (tub, bucket, kettle, jug, pots, bowls, wooden spoons, spit, knives), farm gear (plough, harrow, sledge, barrow), bedding (handmade blankets and quilts, no sheets), roughly two sets of clothes each, sacks and rags, small personal items (razor, comb, thimble, ribbons), kitchen staples (grain, flour, lard, salt, vinegar, honey, herbs, lye soap) and tools (axes, wedge, pick, spade, flail, rake, hoe).

### 6.5 Income and value

Gygax uses a 1 : 10 : 500 bronze : silver : gold value standard and gives assumed average incomes per tier, which run roughly geometrically from the lower lower class to the upper upper (LF Table 2:21). We store wealth internally as an abstract `value` in pennies and keep the **ratios** between tiers, not the dollar figures. The ratios are what drive the comparisons that matter: who can lend to whom, who can buy their freedom, and who is overspending.

Two rules worth keeping:

- **Title outranks money.** A baron as rich as a duke is still a baron. Tier is set by birth, office or trade first, and by wealth second.
- **Wealth moves people between tiers, and both sides resent it.** The people left behind envy the climber; the tier they join sneers at them as "jumped up". This is a free source of relationship edges (`rival`, negative-weight `neighbour`).

### 6.6 Hamlets by economic base (LF pp.72–75)

Each hamlet, thorp or village has an **economic base**. It sets the core buildings, the extra trades that appear as it grows, the materials, the fuel, the council, the richest person, and the disputes the council hears.

| Base | Core buildings | Extra trades (≈ one per 100 people above 250) | Construction / roof | Fuel | Usually richest |
|---|---|---|---|---|---|
| Agricultural | farmhouses, shrine or chapel, mill, general trader, alehouse | baker, smith, carpenter, carter, thatcher, weaver | wattle and daub, sod, timber; thatch | wood, charcoal, dung | the **miller** |
| Fishing | fishers' houses, shrine, boatwright, trader, alehouse | smith, rope-maker, mason, carter, slater, net-maker | timber, fieldstone; wood or slate | driftwood | the **boatwright** |
| Herding | herders' houses and barns, shrine, wool factor, trader, alehouse | carder and spinner, carpenter or mason, carter, thatcher, weaver, tanner | wattle, sod, timber, fieldstone; thatch, sod or wood | peat, dung | the **carter or tanner** |
| Mining | miners' houses, shrine, sawyer, assayer, trader, alehouse | freighter, smith, carpenter or brickmaker, slater | stone masonry; slate or wood | coal, charcoal | the **assayer or freighter** |
| Woodcutting | loggers' houses, shrine, sawyer, trader, alehouse | freighter, smith, carpenter, charcoal burner | timber and board; plank or shingle | wood, charcoal | the **sawyer or freighter** |

**Governance.** An elder and a small council. The council is typically the biggest local holder (largest landholder, boat owner or herd owner, or the best miner or woodcutter), the trader, the tavern keeper, and the wisest old person. The richest person is usually the elder or the most influential councillor. The council has **stocks**.

**Low justice heard locally:** disorderly conduct, minor vandalism and petty theft, plus a base-specific dispute:

| Base | Typical dispute |
|---|---|
| Agricultural | fence lines and boundary marks |
| Fishing | tangled nets, fishing spots |
| Herding | grazing rights, strayed animals |
| Mining | digging rights, division of ore shares |
| Woodcutting | felling rights, division of timber shares |

Anything bigger waits for the officer who comes around to collect taxes and hear cases.

### 6.7 Manorial villages (LF pp.77–78)

- The lord owns the land, the buildings and, legally, the villeins.
- The chain of management runs **lord → steward → regarder → bailiff (visiting) → reeve (resident)**. Each link is a person with an `office_in` edge and an opportunity for skimming.
- Villeins keep only part of their harvest, owe **one day's labour in seven** to the lord, and may not leave without permission. Leaving makes them criminals, subject to the lord's own justice.
- A villein can **buy freedom** and usually becomes a cash-rent tenant of the same lord, often paying as much as before but now free to leave. Some lords prefer cash rents and quietly let able villeins commute their labour. This makes a good mixed-status household generator.
- A **socman** owns no land but rents large tracts and sub-lets to tenants. He's a middle-class middleman, and a natural target for resentment from above and below.

### 6.8 Towns and cities

**Institutions to generate (LF pp.85–104):**

| Institution | Generation notes |
|---|---|
| **Merchant associations and guilds** | Every merchant belongs to one. Each guild also runs religious observances, charity and a social life. Foreign merchants keep a compound house (warehouse, hall, lodgings). |
| **Craft guilds** | Masters, journeymen (own residence) and apprentices (lodge with master). |
| **Watch** | Volunteers per ward, ~6 paid officers per quarter leading them by night. The **hue and cry** obliges every able man to turn out armed. |
| **Day policing** | Bailiffs and beadles; a town marshal and a handful of deputies with town-wide authority; a constable per quarter with authority in that quarter only. |
| **Gate guard** | Paid; guards gates by day and walks the walls by night. |
| **Criers** | ~1 per 5,000 inhabitants. They read proclamations at set places and post bills. |
| **Refuse and nightsoil** | Weekly carting, done by the lowest-status workers, who are often criminally connected. |
| **Water** | Wells, fountains, cisterns; piped water only in `early_modern`. |
| **Fire** | `high_medieval`: hooks, buckets, ladders, curfew on hearths. `early_modern`: stations and paid crews. |
| **Schools** | Apprenticeship is the main route. Temple or parish schools give ~4 years of letters and reckoning to the middle and upper lower and the lower and middle middle tiers. Private schools serve wealthier children; tutors serve the richest. A college or university is a **separate community** with its own officers and grounds and real weight in town politics. |
| **Literacy** | ~25% in towns (Gygax's figure, for an advanced setting). Use 5–15% for `high_medieval`. |

**Religious hierarchy (LF p.85).** This lives in the `religion-core` module and is renameable.

| Seat | Clergy | Congregation that supports it | Tithes to |
|---|---|---|---|
| Grand temple (cathedral-equivalent) | high cleric + 6 | 1,000+ | — (receives from all temples in its see) |
| Temple | high cleric + ≥4 | 600+ | grand temple |
| Fane | ranked cleric + ≤2 | ~300 | temple |
| Chapel | ranked cleric + 1 | ~150 | temple |
| Chantry | ordained cleric, supported by monks or friars from a nearby house | ~100 | its abbey or priory |
| Shrine | one minor cleric | ~50 | temple, abbey or friary |

The generator uses population to **budget** religious buildings. For example, a town of 8,000 gets roughly one temple, a few fanes, and chapels, chantries and shrines filling the rest. Tithe edges run up the chain, which provides both a money flow and a grievance flow.

**Building categories (LF pp.10–11)** map onto layout footprint sizes and positions:

| Category | Examples |
|---|---|
| Major public | guildhall-scale civic buildings, courts, prison, armoury, baths, grand temple |
| Other large | breweries, granaries, guild halls, inns, gaol, mills, record hall, religious houses, rope walks, storehouses, temples, town houses, warehouses |
| Smaller urban (the bulk) | alehouses, armourers, boatwrights, butchers, cartwrights, chapels, cook shops, cooperages, eating houses, fencing schools, hostels, money changers, residences, rooming houses, shops, smithies, stables, taverns, watch houses, wine merchants |
| Large suburban (outside walls) | baiting arenas, brick works, foundries, lumber yards, mills, stockyards, tallow works, **tanneries** (smell, so downwind and downstream) |
| Small suburban / rural | alehouses, cottages, smithies, shrines, sheds, gatehouses, farmhouses, smokehouses, barns |

Smaller urban buildings are built **walls abutting, fronts on the street, upper storey overhanging, shop on the ground floor, living above, yard behind.** That's the default L2 floor plan.

**Construction cost order (LF p.79), cheapest first.** Walls: wattle and daub (or mud brick) → timber and board → timber and plaster → timber and brick → timber and stone → brick → stone. Roofs: thatch → plank → shakes → tile → slate → lead or copper (stone only on fortifications). Tier and ward value class pick from this ladder.

### 6.9 Ward value classes (LF Table 2:20)

Gygax prices building lots by district class. We keep only the ordering, which assigns each layout ward a value class:

```
slum < low residential < low commercial < moderate residential < moderate commercial
     < high residential < high commercial < prestige residential < prestige commercial
```

Value class biases tier, construction, building use and street lighting. Gygax notes that wealthy areas require residents to light the street, so they **stand out at night**.

### 6.10 Justice (LF pp.86–89, 105)

| Court | Hears | Notes |
|---|---|---|
| Sovereign / high court | state crimes, aristocrats, death and bondage sentences | sits ~quarterly until the docket is clear; judges are lower-upper class |
| Magistrate (middle justice) | felonies and civil suits for non-aristocrats | assault, burglary, debt, horse theft, **leaving villeinage**, purse-cutting, receiving or selling stolen goods, robbery, rustling, theft |
| Justice of the peace (low justice) | petty local matters | middle middle class, lives like a wealthy craftsman |
| Manorial court | the lord's villeins | the lord's justice only |
| Clerical court | **all clergy, for any offence** | penalties: defrocking (then handed to secular court), exile, demotion, pilgrimage, penance |
| Hamlet council | lowest justice | stocks |

Foreigners are under local law, with no extradition. Merchant enclaves govern their own people inside the compound, but members are fair game outside it. Clergy immunity is a classic hook: the priest who did it can't be tried by the people he wronged.

### 6.11 Officials (LF Table 2:32)

A realm module can generate the officer ladder when needed. Great officers: steward, constable, chancellor, seneschal. Second rank: justiciar, marshal, admiral, chaplain, treasurer. Third rank: secretary, auditor, **sheriff** (per district), guard commander, major-domo, chamberlain. Fourth rank and below includes the **herald** (keeps the arms register, needed by heraldry), cofferer, almoner, forester, castellan, porter, usher and spymaster. Down at the bottom are woodwards and haywards. A noble's household mirrors this ladder in miniature: castellan, porter, usher, captain of the guard, spymaster.

Local offices only reference upward ("the sheriff's man comes at Michaelmas") until someone clicks through.

### 6.12 Lodging (LF pp.93–94)

| Type | Serves | Notes |
|---|---|---|
| Inn | aristocrats and middle class | rooms and suites, private meeting rooms, dining, stabling, coach barn, storage for goods in transit |
| Tavern | everyone | drink, food, some rooms. Travellers' taverns have more rooms and stabling; locals' taverns sell more drink. |
| Alehouse | locals | even a hamlet alehouse lets a room or two |
| Rooming house | lower middle and upper lower, staying a week or more | shared rooms, meals at fixed narrow hours |
| Hostel | the poor | commercial, or religious (pay what you can, dormitory, light breakfast) |
| Sleeping house | the overflow | cheap, appears when the tavern can't meet demand |

Every establishment and meal has a quality grade: `poor` / `common` / `good` / `extravagant`.

### 6.13 Daily routine (LF pp.140–151)

Gygax describes days in six four-hour blocks. That makes a clean schedule format:

```ts
type Block = "morning" | "forenoon" | "afternoon" | "evening" | "night" | "late_night";
//            5–8        9–12        13–16       17–20     21–24    1–4
interface Schedule { [b in Block]: { where: Address | "home" | "abroad"; doing: string } }
```

Routines are templated by occupation and tier, so the bailiff, beggar, gaoler, squire, farmer, labourer, serving maid, shopkeeper and merchant come almost straight from the book. They're also how you answer "**where is this person right now?**", which is what lets a DM say who is in the tavern when the players walk in.

**Calendar:** one holy day in seven, with no work except what can't wait (milking, watching, innkeeping). Add four seasonal festivals of about three days each. Fair days and quarter-days (rent day) come from the calendar module.

The book's routines also hide good secrets. Its city gaoler rents cells to working thieves as an alibi, takes a cut of their takings, and sells out a gang to the marshal for the reward when it suits him. Any routine template can carry an optional `sideline` that becomes a secret edge.

### 6.14 How news travels (LF pp.76, 93)

- **Towns:** hot news spreads about **one block per hour**, jumping to adjacent blocks at the same rate. It reaches the edge of a large city in a few hours. This is directly implementable on the ward and block graph.
- **Hubs:** inns, taverns and alehouses, where travellers talk.
- **Official channels:** criers and posted bills (towns). In hamlets, the tax collector comes once or twice a year and a herald brings decrees now and then.
- **Ballad singers** carry the common folk's view of current events.

### 6.15 Visitors calendar (LF pp.76–77)

These are per-hamlet recurring events and a steady source of hooks:

| Visitor | Frequency |
|---|---|
| Tax collector | 1–2 times a year |
| Herald with a decree | occasional |
| Strolling players | about yearly, troupe sized to the settlement |
| Mountebank's train | about yearly: a "doctor" with 3–6 wagons, a fortune-teller, acts, shills, hangers-on |
| Travelling folk band | every year or two, but the **same band no more than about once in five years** |
| Tinkers | regularly. Gygax's tinkers keep their hands clean while in town and **come back later** to steal. |
| Wandering priest or friar | regularly, if there's no resident cleric |
| The fair | not held locally; people travel to the nearest village or town |

### 6.16 Influence (LF p.58)

Gygax gives rough odds that an influential upper middle person gets their way: about 60% with their own tier, 80% with the middle tiers below, 40% with the lower class, and 20% with the lowest upper tier. We generalise this to a `sway(from, to)` function by tier distance. It's handy for "can she get the magistrate to drop it?" rolls, and for weighting relationship edges.

---

## 7. Feudal context (L0)

Use this when generating the lord, the taxes and who owns what around the settlement (LF pp.44–45):

- **Land:** the crown holds ~10% directly, the temple ~15%, free cities and freeholders ~15%, and nobles ~60% in fiefs, from a few dukes down to a score of baronets and knights.
- **Obligations:** military service is capped (~60 days a year); labour service is a day a week or so for the unfree. Taxes are roughly 15% to the state and another ~20% to overlords and the temple.
- **Monopolies:** the crown and state reserve monopolies such as salt and post, giving smuggling, licences, informers.
- **Tensions:** nobles want a weak crown, the crown wants a strong one, and towns buy charters to escape their local lord. The settlement's charter status (`lord-held` / `chartered` / `free`) is an L0 field.

---

## 8. The heraldry module (planned, LF p.55)

This is the module the architecture needs to accommodate. It is laid out here so the core leaves room for it.

- **Who may bear arms:** titled nobles, knights, gentlemen of gentle birth, clergy, and **organisations** (cities, towns, guilds, orders of knighthood). Commoners never do. Wealthy merchants want to.
- **Grant:** only by the monarch, through the heralds' office, which keeps a **register**. The herald is an L0 officer stub.
- **Inheritance:** male primogeniture. **Junior branches must difference** the arms of the senior line, which needs a `branch` field on family lineage and a cadency-mark generator.
- **Shape:** the shield (escutcheon) is the norm, a **lozenge** for women and an **oval** for clergy. The helm shown full-face marks nobility.
- **Parts:** escutcheon with partitions and charges, tinctures (colours, metals, furs, plus optional fantasy extras), helm and crest, mantling in the main colours, supporters, motto, and **marshalling** to combine arms on marriage.
- **Loss:** arms can be **rescinded** along with title and lands for treason. A blank or defaced shield in the hall is a hook.

Implementation sketch: an `Arms` component on `Household` (gentle-born or higher) and `Institution`, a blazon string (`"Azure, a bend Or"`), an SVG renderer panel, and an `onHouseholdResolved` hook gated on tier. Heralds' office records become an `Institution`. This needs nothing from core beyond tier, lineage and institutions, all of which are planned.

---

## 9. Plot hooks by story sifting

Hooks are not rolled from a table. They are **found** by sifter queries over the relationship graph, following James Ryan's "story sifting" idea from Talk of the Town. Each sifter is a module-registered pattern:

```ts
export const debtAndCourtship: Sifter = {
  id: "debt-and-courtship",
  match: g => g.query`
    (a)-[:debtor_of]->(b),
    (b)-[:courting]->(c),
    (c)-[:kin {rel:"daughter"}]->(a)`,
  render: ({a, b, c}) => ({ title: "Paid in full", summary: `${b} holds ${a}'s debt and is courting ${c}.` }),
};
```

To get hooks, generators must create **stakes**, not trivia: debts, land, inheritance, office, guild standing, secrets with a short `knownBy`.

**Starter sifter catalogue**, drawn from the book's social structures:

| Sifter | Pattern |
|---|---|
| Thumb on the scale | Miller is richest and the elder; someone on the council has a grievance about short measures |
| Bought freedom | A villein household has commuted its labour; the reeve resents losing labour he skimmed |
| The socman squeeze | A socman's tenants are behind; he's behind with the lord |
| Alibi cells | Gaoler or turnkey with a `sideline`; a "prisoner" has been seen outside |
| Junior branch | A cadet line flaunts undifferenced arms or claims seniority (needs heraldry) |
| Clergy immunity | A cleric harmed someone; only a clerical court can try him |
| Gone with the tinkers | Thefts started after the tinkers left; the tinkers are due back |
| Same band, too soon | The travelling folk band is back within five years; someone remembers last time |
| Jumped up | A newly middle-class household with a showpiece room; envious neighbours, sneering betters |
| Leaving the land | A villein is missing. The lord wants him back; a town master took on a new apprentice who won't say where he's from. |
| Tithe chain | A shrine or chapel is behind on its tithe to the temple; the temple sends someone |
| The unrecorded tenth | Someone not in the census needs the town not to notice them |
| Monopoly | Salt or licence smuggling through the trader, informer in the alehouse |
| Spoken will | Two households claim the same holding; the will was oral |

---

## 10. Persistence and save format

```json
{
  "format": 1,
  "town": { "seed": "7f3a…", "era": "high_medieval", "config": { "base": "agricultural", "pop": 420 } },
  "modules": { "core": "1.4.0", "layout": "1.0.0", "names-anglo-norman": "1.0.2", "heraldry": "0.3.0" },
  "overlay": { "town:7f3a/building:b017": { "use": "cooper" } },
  "pinned":  { "town:7f3a/person:p00412": { "...full snapshot..." } },
  "events":  [ { "date": "1203-09-29", "kind": "dm-note", "target": "town:7f3a/person:p00412", "text": "Owes the party a favour" } ],
  "clock":   { "date": "1203-10-02", "block": "evening" }
}
```

Loading means regenerating from the seed with the pinned module versions, then applying the pinned snapshots, then the overlay, then the events. Saves stay small and readable, and they diff nicely in git.

---

## 11. UI notes

- Keep it restrained. Map on the left; on the right, a plain inspector for whatever's selected, with collapsible sections that modules register (`panels`). No dashboard cards or ornamental chrome.
- **Breadcrumb by address:** `Ashby › Mill Lane › The Mill › Household › Wat the Miller`.
- Every generated field has a small reroll control (it clears that field's overlay or bumps a per-field reroll counter in the overlay) and an edit control (writes to the overlay).
- A **clock control** (date and block) drives routines: "who's in the tavern now?" becomes a map highlight.
- A **hooks list** shows current sifter matches for the settlement, each linking to the entities involved.
- Read-aloud text, when the LLM module is on, is cached per entity and shown under the facts, never in place of them.

---

## 11a. Implementation notes (added while building M1-M3)

- **Addresses are hierarchical and canonical for now.** A person is `town:x/building:b017/household:0/person:2`. Resolving any address resolves its ancestors, which create it. The flat `person:p00412` form (so people can move house) becomes an alias table when moving house exists.
- **Reading a field is looking.** `entity.get(key)` resolves the entity first if needed, so laziness needs no ceremony.
- **Stability under edits.** Anything that must not change when the DM edits something (names above all) must derive from generated or plan values, not overlaid ones. Example: a family's trade byname comes from the settlement plan's use for its building, not from the building's current (possibly edited) use. Tests check this.
- **Reservations must not depend on look order.** §3.2's "generating a household's debts creates a creditor in another building" can't be done by writing into the other building when the first one resolves, because then results depend on which was clicked first. Cross-entity stakes (debts, kin in other houses, tenancies) should be planned at settlement level from a settlement-level stream, and each entity reads its share of the plan when it resolves. The council already works this way: it reads all heads and writes only its own edges.
- **The society phase (`onSocietyResolved`).** This is how the reservation problem above is solved. It runs once, after everything is resolved, the first time anyone asks for edges. Links between households (natal kin, brothers, employment, apprenticeships, debts, friendships, rivalries, courtships, affairs) are made there from settlement-level streams. Other hooks must not query edges. `edges()` always returns edges sorted by id, so insertion order (which depends on clicks) never leaks.
- **Kin by name.** Half of all wives have a local family's surname as their maiden name (names module). The society phase then links each one to that family as daughter or sister wherever the ages fit, so maiden names and kin edges always agree.
- **Routines are pure functions** of person, date and block (`whereabouts()`), with a per-day stream for the odd evening at the alehouse. Nothing is stored, so the clock moves freely and costs nothing to save. The calendar (`src/core/calendar.ts`) is integer-only: weekdays, Easter, Whitsun, the four festivals and the quarter-days.
- **Economic bases live in `bases.yaml`.** Each base has a `terrain` (farmland, coast, moor, hills or forest) that the layout dresses the country with; `core` buildings; a `fill` mix of ordinary houses; the `stake` that makes the "biggest local holder" (acres, boats, sheep, ore shares or felling rights); and a list of `richest` trades. One richest trade is chosen per settlement, from those actually practised there. Its `grievance` and `disputes` feed the council and the sifters.
- **Visitors are pure functions of settlement and year** (`visitsIn()`), like routines. The five-year rule for travelling bands works by walking the years forward from a fixed epoch (1100), so any year can be asked about in any order. The rule is broken on purpose about one time in twelve, and that feeds "Same band, too soon". Thefts follow tinker visits by two to six weeks (LF p.77).
- **Manorial villages** are a setting (`lordship: "manorial"`), not a base, so any economy can be held by a lord. The `manor` module adds an institution with the lord and the officers who live elsewhere (people attached to the institution, not a household), the reeve chosen from the villeins, a status on every household (villein, cottar, free, commuted, socman, the lord's miller and servant), week-work days, rents for freed families, the socman's subtenancies and arrears, and the occasional runaway. It adds bailiff visits and manor courts through the `visitSources` registry, so `visitors` knows nothing about manors. Free settlements are byte-for-byte unchanged: demesne strips are chosen by position, with no extra random draws.
- **Generation never reads the clock.** Anything dated is stored relative ("freed 11 years ago") and turned into a year only for display.
- **Some sifters read the clock** (tinkers, bands, the sheriff's man), so the hooks list changes as the DM moves time on.
- **Sifters are capped at two matches each**, so the hooks list reads like a set of leads, not a ledger.
- **Overrides of other modules' registry rows** go through `override()` and are logged in `town.overrides`.
- **Street plans (towns, cities, big villages).** Above 700 people the layout is `layout/town.ts`, our own: a market at the centre, main roads out through the gates, rings of back streets cut by lanes into blocks, and every block cut into burgage plots (building on the street front, yard behind). Corner plots go to the better street (market, main road, quay, street, lane, wall lane). The plan is drawn in (angle, radius) and bent by a wobble whose fine terms drift with the radius, so the rings are not copies of each other; `dmath.atan2` makes the inverse possible without engine-dependent maths. Churches take a slice of a block, grown until it covers every plot it touches, so nothing overlaps. Suburbs are ribbons of plots along the roads beyond the gates; a gap in a ribbon starts a new run, so wide uses never span it. Coast towns cut the plan with a half-plane sea and line it with a quay.
- **Ward values are set by demand.** Wards are ranked by how good an address they are (market, chief church and castle up; tanneries down), then value classes are handed out so each class has about as much room as the plan wants. Ordinary housing fills from the centre out, trading distance against value fit, and any surplus inside the walls is turned into gardens under the wall before assignment, so there are no gaps in the middle of town.
- **The urban plan** (`uses/urban.ts`, above 1,000 people): trades from `per` (one per so many people; villages get half), religious seats from a population budget, civic buildings from thresholds, and housing to the urban composition. People-per-building figures were measured, not guessed, so populations land within about 5% of the target.
- **Town modules.** `religion` (dedications, parishes, tithes up to the minster and the see, a cleric's misdeed only the bishop's court may try); `civic` (ward and gate names, government, marshal, constables, beadles, the watch and its rota, gate guards, criers, the courts and docket, services); `guilds` (masters, wardens, journeymen and their masters, meeting places, rules, demarcation quarrels); `lodging` (grades, rooms, prices, who is staying tonight as a pure function of the date). All of them do nothing in hamlets, so hamlet output is byte-for-byte unchanged.
- **Scale.** Society steps that were quadratic use grids, surname indexes and numbered person pairs once a settlement is big; the hamlet paths give identical results. `edges()` keeps an endpoint index. An 8,000-person town builds in about a second, 20,000 in about two.
- **Gossip is a pure function of the town and the clock** (`gossip` module), like routines: nothing is stored. Secret edges come out at most once, each at its own moment within five years of 1203 (the clock's default year), from the house of someone who knew. Visitors bring news, heralds' decrees are cried, and every four days something everybody already knows comes up again. Talk travels about 90 m (a block) an hour while people are awake (5 to 22), taverns relay it across town faster, and criers carry official news six times faster. Its telling depends on distance from the origin: the truth, the truth grown, and the truth with a neighbour's name in it. The people a story is about hear it three days late. `knownByAt(edge, date, block)` is the "knownBy update" of §4.3: the original knowers, plus everyone the talk has reached, and public once the story is old.

## 12. Milestones

Status: 1–8 are done (2026-10-20). Heraldry (9) and prose (10) are on hold.

1. **Skeleton and determinism.** Address scheme, `rngFor`, module loader, registries, save/load with overlay. Test: generate, save, load and compare byte-for-byte.
2. **Map.** Our own village layout to building polygons with addresses; click a building to show an empty inspector.
3. **Vertical slice.** An agricultural hamlet of ~200 people. Economic base, core buildings, building uses, households with tiers, names (one provider), kin edges, the council, the miller rule, one sifter ("thumb on the scale").
4. **People depth.** Traits, history, debts, employer and apprentice edges, routines (six blocks), the clock.
5. **Other bases.** Fishing, herding, mining and woodcutting tables; base-specific disputes; visitors calendar.
6. **Manorial village.** The lord's officer chain, villeinage, commuted labour, the socman.
7. **Towns.** Wards and value classes, urban composition, guilds, the watch, criers, religious hierarchy budget, the justice ladder, lodging.
8. **Gossip.** Block-per-hour spread over the ward graph, `knownBy` updates, rumours in taverns.
9. **Heraldry.**
10. **Optional prose module** (LLM read-aloud, cached).

---

## 13. Notes for Claude Code

- **Never call `Math.random()`.** All randomness goes through `ctx.rng(purpose)`. A lint rule should enforce this.
- **Write only your own components.** A module that needs to change another module's data registers an override or creates an overlay entry; it never mutates.
- **Content lives in `content/*.yaml`, not code.** That covers occupations, building uses, tier materials, hamlet bases, religious seats and routine templates. Each row has `id`, `era`, and a `source` string like `"LF p.72"` where it came from the book.
- **Required tests for every module:**
  - *Determinism:* the same seed gives an identical snapshot.
  - *Isolation:* generating with the module enabled must not change any field owned by other modules compared to a run without it. (This is the test that protects heraldry-next-month.)
  - *Stub resolution:* resolving a stub gives the same entity whether it's reached from the map or from an edge.
- **Version bumps:** if a change alters output for an existing seed, bump the module's **major** version and add a changelog line.
- **Repo layout (suggested):**

```
town-gen/
  src/core/          # addresses, rng, graph, overlay, loader, save
  src/modules/       # one folder per module: index.ts, content/, panels/, tests/
  src/ui/
  content/           # shared tables (eras, tiers)
  docs/DESIGN.md     # this file
  CLAUDE.md
```

---

## 14. Sources and licences

- **Gary Gygax's Living Fantasy** (Gary Gygax, Troll Lord Games, 2003): parameters and structure. Copyrighted; used as reference only. Content tables are our own wording, with page citations.
- **This project is MIT.** Every line of code is our own. The only runtime code in the bundle is ours (YAML is a build-time tool). Fonts come from Google Fonts (OFL) and are not bundled.
- **Settlemaker** (barrulus) and **watabou's Medieval Fantasy City Generator**: GPL-3. **Not used.** Don't copy, port, or read their source while working on `layout`, so the layout stays a clean-room implementation. If someone wants Settlemaker output later, it can only be an optional, separately distributed GPL plugin, never part of this repo.
- **Eigengrau's Essential Establishment Generator**: MIT. Reference for the click-to-expand interaction and for how prosperity cascades into establishments.
- **Talk of the Town / Neighborly** (Ryan; Johnson-Bey et al.): reference for knowledge propagation and story sifting.
- **S. John Ross, *Medieval Demographics Made Easy***: an optional cross-check for trade-per-population ratios in towns.
