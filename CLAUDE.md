# Town Generator

Low-fantasy, human-only, mundane medieval settlement generator for D&D. The design is in `docs/DESIGN.md`. Read §1 (pillars), §3 (architecture) and §11a (implementation notes) before changing generators.

## Commands

- `npm run dev`: dev server (use `-- --port 31741` to match the usual port)
- `npm test`: all tests (Vitest)
- `npm run check`: typecheck + tests. Run it before saying anything is done.
- `npm run build`: static build to `dist/`
- `BASE=fishing tools/preview.sh OUTDIR [seeds] [pop]`: render map PNGs for a few seeds (needs `rsvg-convert`)
- `node tools/look.mjs URL OUT.png 'js step' ...`: drive headless Chromium against the dev server and take a screenshot

## Licence: MIT, and keep it that way

- Never copy, port or consult GPL code, in particular Settlemaker or watabou's Medieval Fantasy City Generator (both GPL-3). The layout is clean-room.
- No runtime dependencies. YAML is converted to JSON at build time (see `vite.config.ts`). Before adding a runtime dependency, check its licence is permissive and ask first.
- Gygax's *Living Fantasy* is copyrighted. Use its numbers and structures, write every row in our own words, and cite the page in `source`.

## Rules for generators

- **Never call `Math.random()`.** Use `ctx.rng(entity, purpose)` or `ctx.gen(entity, key, rng => …)`. A test enforces this.
- **Never use `Math.sin/cos/atan2/hypot/pow/exp/log` in `src/core` or `src/modules`.** Use `src/core/dmath.ts`, because engines may round those differently. A test enforces this.
- **Write only your own fields.** `ctx.set` throws if another module owns the key. Read anything.
- **Prefer `ctx.gen(e, key, …)` for anything a DM might reroll.** It draws from a per-field stream and honours reroll counts.
- **Things that must survive DM edits (names!) must not read overlaid values.** Use the plan or `entity.generated(key)`. See DESIGN §11a.
- **Only `onSocietyResolved` may query edges or link households.** Everything else must be computable from the entity's own address, its ancestors and the plan.
- **Town modules must do nothing in hamlets** unless you mean to change hamlet output (and then update the golden and say so). Check `isStreetPlan(town)` or the size class.
- **Big settlements: avoid all-pairs loops.** Use grids or indexes; keep the small-settlement path identical.
- **Generation must not read `town.clock`.** Store dated things relative to now; work out the year when displaying.
- **Content goes in `content/*.yaml` or the module's `content/`**, with `id`, optional `era`, and `source`.
- **Version bumps:** if a change alters output for an existing seed, bump that module's major `version` (it goes into the RNG key) and add a line to `CHANGELOG.md`. The golden test in `tests/core.test.ts` catches this. Nothing is released yet, so until 1.0 of the app you may update the golden snapshot (`npx vitest run -u`) instead, but say so.

## Layout

```
src/core/       addresses, rng, dmath, calendar, registry, town (entities, overlay, ctx, society phase), save, loader
src/modules/    one folder per module: index.ts + content/*.yaml
  core          tiers, bases, sizes, materials, edge kinds, L0 settlement facts
  uses          building uses and occupations; the building plan (urban.ts above 1,000 people); L2 construction
  layout        L1 map: hamlet.ts (up to 700 people), town.ts (street plans), geom.ts the geometry kit; wards; nearestBuilding()
  households    L3 households, members, kin and service edges, income and land
  materials     how a household lives, by tier
  names         Anglo-Norman provider: place names, bynames, given names
  people        L4 traits and looks; relationships panel
  council       hamlet council, elder, docket, grievances
  society       the settlement-wide phase: links between households
  manor         manorial villages: lord, officer chain, reeve, statuses, week-work, socman, runaways
  religion      street plans: dedications, parishes, tithes up the chain, benefit of clergy
  civic         street plans: ward and gate names, government, watch, police, criers, courts, services
  guilds        towns: merchant and craft guilds, wardens, journeymen, demarcation quarrels
  lodging       inns, taverns, rooming houses, hostels: grades, prices, guests tonight
  visitors      the visitors calendar: visitsIn(year), visitorsOn(date); pure functions
  routines      six-block daily routines, whereabouts(), occupancy(); clock panels
  sifters       plot-hook sifters over the graph (capped at 2 each)
src/ui/         map.ts (pure SVG renderer), main.ts (app), style.css
tests/          core (determinism, isolation, stubs, overlay, saves, golden), people (calendar, society, routines),
                bases (all five economies, terrain, visitors), manor, town (street plans and town institutions)
                SAMPLE=1 / PERF=1 enable sample.test.ts / perf.test.ts
```

Module order comes from `requires`. Load order is the hook order.
