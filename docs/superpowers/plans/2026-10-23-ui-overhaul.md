# UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the town-gen frontend so that making a town is separate from using one, and so that any fact is one search or one click away. The parchment look stays.

**Architecture:** The layout and wiring stay as plain TypeScript and DOM in `src/ui/main.ts` and `index.html`. All new logic goes into small, pure modules in `src/ui/` (`newtown`, `history`, `palette`, `directory`, `glance`, `player`), which are tested with Vitest against generated towns. The main thread only renders and wires them up. Each phase's DOM behaviour is checked by `tools/ui-smoke.sh`, which drives headless Chromium through the existing `tools/look.mjs`.

**Tech Stack:** TypeScript, Vite, Vitest, and no runtime dependencies.

**Spec:** "Town Generator UI Overhaul" proposal (approved 2026-10-23), https://claude.ai/artifact/UDmKYtjyFy8JVyXYscRSJZ. Its Decisions section overrides the rest of it.

## Global Constraints

- No runtime dependencies and no UI framework (CLAUDE.md: "No runtime dependencies").
- The generator stays untouched: no changes under `src/core/` or `src/modules/`, except the `discover.ts` index (which is UI). Golden snapshots must not change.
- Saved towns, `#seed=` URLs and the `localStorage` library keep working with no migration. `SaveFile` keeps `format: 1` and gains no fields.
- The parchment look stays: the `--paper/--ink/--accent` tokens and the IM Fell English and Source Serif 4 fonts are kept. No Omarchy theming.
- Targets are a laptop (1280–1500 px wide) and a big monitor (2560 px). Below 760 px it must still work, using the existing stacked layout.
- Type scale is 13 / 15 / 18 / 26 px, spacing is on a 4 px grid, cards have 8 px corners, controls are at least 32 px tall, and focus rings are visible.
- No existing reachable fact or action may be lost. Every current control keeps a home, as listed in the spec's "Controls reorganised" table.
- Anti-goals: no fact harder to reach than today, no generic dashboard look, and looking someone up must not need the mouse.
- `npm run check` stays green after every task. Run `./install.sh` at the end of every phase.
- Never call `Math.random()` in `src/core` or `src/modules`. UI code may use `crypto` (as `randomSeed` does now).

## Review Focus

1. **Typing in an input must not trigger shortcuts.** `/`, `[`, `]`, `Alt+←/→` and `Shift+P` must be ignored while focus is in an `input`, `select` or `textarea`, so typing "/" in the deed box types a slash. Test: `isTypingTarget` in Task 1.
2. **Player view must not leak through side doors.** With player view on, search results, the Directory, the almanac, Nearby, encounters and history must all hide crime aliases, secrets, debts, crews and "who knows?". Test: `player.test` cases in Task 7 cover search, lists, almanac and panels.
3. **Stars must not change the town.** A star is stored as an event of kind `"star"`, so it must not alter gossip, deeds or any panel's rows. Test: Task 5, "a star leaves every panel's rows unchanged".
4. **History must survive regeneration.** After an edit, reroll or pin rebuilds the town, history entries whose address no longer exists are skipped, not crashed on. Test: `History.prune` in Task 1.
5. **A hamlet has no plan.** The New town dialog hides the Street plan section at 700 people or fewer, and the settings it produces carry no `design`. Test: `settingsFromForm` in Task 1.

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `src/ui/newtown.ts` | new | `sizePreview(pop)`, `settingsFromForm(get)`: pure, used by the New town dialog and `start()` |
| `src/ui/history.ts` | new | `History` back/forward stack of addresses; `isTypingTarget(el)` |
| `src/ui/palette.ts` | new | `paletteGroups(town, query, opts)`: grouped search results |
| `src/ui/directory.ts` | new | `DIRECTORY_TABS`, `directory(town, tab, opts)`: sortable table data |
| `src/ui/glance.ts` | new | `glance(town, address, date, block)`: rows for the at-a-glance card; `starsOf(town, address)` |
| `src/ui/player.ts` | new | the player-view filters |
| `src/ui/discover.ts` | modify | the search index gains `kind`; `search()` gains `opts.player` |
| `src/ui/main.ts` | modify | wiring: top bar, dialog, palette, rail, inspector, keyboard |
| `index.html` | modify | new top bar, `#rail`, dialog markup |
| `src/ui/style.css` | modify | tokens, type scale, new components, responsive widths |
| `tools/ui-smoke.sh` | new | starts Vite on :31742, runs look.mjs steps, fails on `[exception]` or a thrown check |
| `tests/ui.test.ts` | new | tests for all the pure UI modules |

`main.ts` is already 953 lines. New rendering for each surface (palette, directory, dialog) goes into the matching module as an exported `*Html()` function that returns a string, the way `discover.ts` keeps logic out of `main.ts`. `main.ts` only adds event wiring.

---

### Task 1: Pure helpers and the smoke harness

**Files:**
- Create: `src/ui/newtown.ts`, `src/ui/history.ts`, `tests/ui.test.ts`, `tools/ui-smoke.sh`

**Interfaces:**
- Produces:
  - `sizePreview(pop: number): { id: string; label: string; line: string }` reads `src/modules/core/content/sizes.yaml`. For example, `line` = `"A market town: streets, wards, guilds and a market."`
  - `settingsFromForm(get: (k: string) => string | null): { seed: string | undefined; settings: { pop: number; era: Era; base: string; lordship: "manorial" | "free"; design?: Design } }`. `pop` is clamped to 50–30000 with a default of 200. `design` comes only above 700, via the existing `designFrom` in `library.ts`. `manorial` is allowed only at 6000 or fewer people (`MANOR_MAX` moves here and is exported).
  - `class History { constructor(max = 100); push(a: Address): void; back(): Address | undefined; forward(): Address | undefined; get canBack(): boolean; get canForward(): boolean; prune(exists: (a: Address) => boolean): void }`. Pushing the address that is already current does nothing, and pushing after going back drops the forward entries.
  - `isTypingTarget(el: Element | null): boolean` is true for `input`, `select`, `textarea` and `[contenteditable]`.
  - `tools/ui-smoke.sh [js-step ...]` starts `npx vite --port 31742 --strictPort`, waits for it, runs `node tools/look.mjs http://127.0.0.1:31742/ $OUT/smoke.png "$@"`, stops Vite, and exits 1 if the output contains `[exception]`. A step throws (`throw new Error(...)`) to fail.

- [ ] **Step 1: Write the failing tests** in `tests/ui.test.ts`:

```ts
test("size preview follows LF p.72 bounds", () => {
  expect(sizePreview(200).label).toBe("hamlet");
  expect(sizePreview(700).label).toBe("village");
  expect(sizePreview(3000).label).toBe("market town");
  expect(sizePreview(30000).label).toBe("city");
});
test("a hamlet's settings carry no plan and a big town is never manorial", () => {
  const f = (o: Record<string, string>) => (k: string) => o[k] ?? null;
  expect(settingsFromForm(f({ pop: "500", walls: "wall" })).settings.design).toBeUndefined();
  expect(settingsFromForm(f({ pop: "3000", walls: "wall" })).settings.design).toEqual({ walls: "wall" });
  expect(settingsFromForm(f({ pop: "9000", manorial: "on" })).settings.lordship).toBe("free");
  expect(settingsFromForm(f({ pop: "99999" })).settings.pop).toBe(30000);
  expect(settingsFromForm(f({ pop: "" })).settings.pop).toBe(200);
});
test("history goes back and forward and forgets the future on a new push", () => {
  const h = new History();
  h.push("a"); h.push("b"); h.push("c");
  expect(h.back()).toBe("b");
  h.push("d");
  expect(h.canForward).toBe(false);
  expect(h.back()).toBe("b");
});
test("history prunes addresses that no longer exist", () => {
  const h = new History();
  h.push("a"); h.push("gone"); h.push("c");
  h.prune((x) => x !== "gone");
  expect(h.back()).toBe("a");
});
test("typing targets", () => {
  const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as unknown as Element;
  expect(isTypingTarget(el("INPUT"))).toBe(true);
  expect(isTypingTarget(el("TEXTAREA"))).toBe(true);
  expect(isTypingTarget(el("DIV", true))).toBe(true);
  expect(isTypingTarget(el("BUTTON"))).toBe(false);
  expect(isTypingTarget(null)).toBe(false);
});
```

- [ ] **Step 2:** Run `npx vitest run tests/ui.test.ts`. Expected: FAIL, because the modules don't exist yet.
- [ ] **Step 3:** Implement `newtown.ts` and `history.ts` as specified above. Then switch the `form` submit handler and `start()` in `main.ts` to `settingsFromForm`, with no visible change yet.
- [ ] **Step 4:** Write `tools/ui-smoke.sh` (and `chmod +x` it). Run `tools/ui-smoke.sh 'new Promise(r=>setTimeout(r,1500))' 'if(!document.querySelector("#map svg")) throw new Error("no map")'`. Expected: exit 0.
- [ ] **Step 5:** Run `npm run check`. Expected: PASS.
- [ ] **Step 6:** Commit: `git add -A && git commit -m "UI: pure helpers for new-town settings, history; smoke harness"`

### Task 2: Top bar, town menu, clock, New town dialog (phase 1)

**Files:**
- Modify: `index.html` (replace `header.bar`), `src/ui/main.ts` (the top bar, clock, towns and file sections), `src/ui/style.css`, `src/ui/newtown.ts` (add `newTownHtml`)

**Interfaces:**
- Consumes: `sizePreview`, `settingsFromForm`, `MANOR_MAX` (Task 1).
- Produces these DOM ids, which later tasks rely on: `#town-menu` (button showing the town's name with ▾), `#town-menu-list` (popover), `#search` (input; inert until Task 3), `#clock` (button with `◀`/`▶` steppers `[data-step]`, label `#clock-label`, popover `#clock-pop` holding the date input and the block select), `#new-town-btn`, a `<dialog id="new-town-dialog">` holding `form#new-town`, and `#player-toggle` (inert until Task 7).
- `newTownHtml(): string` builds the dialog body. It contains the fields: "Name the seed" (the input plus a reroll button `#reroll-seed`), "How many people?", "How do they live?", "When?", "Held as a manor" (a checkbox, hidden above `MANOR_MAX`), the "Street plan" `<fieldset id="plan">` (hidden at 700 people or fewer), the live preview `<p id="size-preview">`, and the buttons "Build town" (submit) and "Cancel".

Exact menu items in `#town-menu-list`, in order: one entry per kept town (as `drawTowns` builds now), a divider, "Download file" (the old Save), "Open file…" (the old Load), "Show book sources" (a checkbox, the old §), and "Forget my edits to <name>…" (only when the open town is kept).

- [ ] **Step 1:** Replace the markup. The bar is a 48 px row holding `#town-menu`, `#search` (flex 1, max 420 px, placeholder `Search people, places, trades  /`), `#clock`, `#player-toggle` and `#new-town-btn`. Remove `#towns`, `#sources`, `#save`, `#load` and `#show-people` from the bar (the People checkbox moves to the map toolbar in Task 6; until then, keep it as a temporary map button `[data-zoom="people"]`).
- [ ] **Step 2:** Wire the dialog. `#new-town-btn` calls `showModal()` with the form synced from the current town, and Esc or Cancel closes it. Editing never regenerates; only submit does. Typing in the population box updates `#size-preview` and the plan and manor visibility.
- [ ] **Step 3:** Wire the clock. `#clock-label` reads `describeDate(date)` shortened to a weekday, a day and a month (e.g. "Wed 1 Oct"), followed by "· forenoon". Clicking the label opens `#clock-pop`. A document-level keydown steps the clock with `[` and `]` when `!isTypingTarget(document.activeElement)`.
- [ ] **Step 4:** Smoke check: `tools/ui-smoke.sh` with steps that click `#new-town-btn`, set the population to 3000, assert `#plan` is visible and `#size-preview` contains "market town", submit, wait 2.5 s, then assert `#town-menu` text ≠ the old name. Then a second run asserting that pressing `]` changes `#clock-label`.
- [ ] **Step 5:** Screenshots at 1500×950 and 2560×1440 (temporarily `CHROME`/look.mjs `--window-size`; add an optional `SIZE=WxH` env to look.mjs). Read both images and check that the bar is one row with no wrapping.
- [ ] **Step 6:** Run `npm run check`, then `./install.sh`. Commit: `"UI phase 1: slim top bar, town menu, clock, New town dialog"`

### Task 3: Search everywhere (phase 2)

**Files:**
- Modify: `src/ui/discover.ts:268-299` (the index adds `kind`), `src/ui/main.ts`, `src/ui/style.css`
- Create: `src/ui/palette.ts`
- Test: `tests/ui.test.ts`

**Interfaces:**
- Consumes: `History`, `isTypingTarget` (Task 1); `#search` (Task 2).
- Produces:
  - In `discover.ts`, `Entry` gains `kind: "person" | "building" | "ward" | "institution"`, and is exported as `SearchEntry`. `search(town, query, limit?, opts?: { player?: boolean })`: with `player` on, the person detail omits `crime.alias`.
  - `paletteGroups(town: Town, query: string, opts?: { player?: boolean }): { title: "People" | "Places" | "Trades" | "Offices" | "Lists"; items: { address?: Address; list?: string; label: string; detail: string }[] }[]`. Places are buildings plus wards, and Offices are institutions. Trades are occupation labels that match, each item carrying `list: "trade:<occupation id>"`, which opens the Directory filtered (Task 4). Lists are the `LISTS` titles that match, `list: <id>`. There are at most 8 items per group, empty groups are dropped, and the groups are ordered as in the type.
  - `paletteHtml(groups, active: number): string` renders into `#palette` (a popover under `#search`).
  - In `main.ts`: `focusOn(a: Address)` pans and zooms the map so the building of `a` is centred at a view width of 320 map units (or the current width, if that is smaller), animated through `previewView()`. `const hist = new History()`. `select()` pushes to `hist`, and `setTown()` calls `hist.prune(a => !!town.find(a))`.
  - The inspector header gets `◀`/`▶` buttons `[data-hist="back"|"forward"]`, disabled when the history can't move that way.

- [ ] **Step 1: Write the failing tests:**

```ts
test("palette groups a surname into People and a trade into Trades", () => {
  const g = paletteGroups(town, "smith");
  expect(g.map((x) => x.title)).toContain("People");
  expect(g.find((x) => x.title === "Trades")!.items[0].list).toMatch(/^trade:/);
});
test("palette caps each group at 8 and drops empty groups", () => {
  for (const x of paletteGroups(town, "a")) expect(x.items.length).toBeGreaterThan(0), expect(x.items.length).toBeLessThanOrEqual(8);
});
test("player search hides crime aliases", () => {
  const alias = town.allEntities().find((e) => e.get("crime.alias"))!;
  const name = town.label(alias.address);
  expect(search(town, name, 60, { player: true }).results.find((r) => r.address === alias.address)!.detail).not.toContain('"');
});
```
(`town` = `generate("burgh-a", { pop: 8000 })` with `society()` in `beforeAll`, as in `tests/discover.test.ts`.)

- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the index `kind`, `paletteGroups` and `paletteHtml`.
- [ ] **Step 4:** Wire the palette. `/` or `Ctrl+K` (when not typing) focuses `#search`. Input re-renders the palette. Arrow keys move the active row. Enter opens the result: an address calls `select(a)` then `focusOn(a)`, and a list calls `openDirectory(list)` (a stub that opens Find with that list until Task 4). Esc clears the search and blurs it. The matching buildings get `.m-hi` (`markMap(addresses)`) while the palette is open. `Alt+←/→` and the inspector arrows walk `hist`.
- [ ] **Step 5:** Run the tests. Expected: PASS. Smoke check: press `/`, type the label of the 5th building in the index, press Enter, then assert that the inspector `h2` equals that label and the `viewBox` width is ≤ 320. Press `Alt+ArrowLeft` and assert the `h2` changed.
- [ ] **Step 6:** Run `npm run check`, then `./install.sh`. Commit: `"UI phase 2: search from anywhere, pan to result, inspector history"`

### Task 4: Left rail and the Directory (phase 3)

**Files:**
- Create: `src/ui/directory.ts`
- Modify: `index.html` (`<nav id="rail">` before `#map` inside `main`), `src/ui/main.ts` (`Page`, `tabsHtml` removed, `findHtml` replaced), `src/ui/style.css`
- Test: `tests/ui.test.ts`

**Interfaces:**
- Consumes: `paletteGroups` list ids (Task 3), including `trade:<id>`.
- Produces:
  - `type DirTab = "people" | "households" | "buildings" | "trades" | "offices" | "wards" | \`list:${string}\``
  - `DIRECTORY_TABS(town: Town, opts?: { player?: boolean }): { id: DirTab; title: string }[]`. These are the six fixed tabs, followed by one per `LISTS` entry. Wards are present only when `isStreetPlan(town)`.
  - `directory(town: Town, tab: DirTab, opts: { date: string; block: Block; filter?: string; sort?: { col: number; desc: boolean }; player?: boolean }): { columns: string[]; rows: { address?: Address; cells: (string | number)[]; fact?: Fact }[] }`. Columns per tab: people `["Name","Trade","Age","Household","Building"]`; households `["Household","Trade","Income","Members","Building"]` (income as `lsd`, sorted numerically); buildings `["Building","Use","Ward","Households"]`; trades `["Trade","People"]` (a row filters people by that trade); offices `["Office","Holder"]`; wards `["Ward","Buildings","People"]`; `list:*` `["", "Entry", "Note"]` from `ListSpec.rows`. The filter is case-insensitive and needs every word to match across the cells. Number cells sort numerically, and ties break on the address.
  - `directoryHtml(...)` renders a `<table class="dir">` with clickable headers `[data-sort]` and rows `[data-go]`.
  - Rail pages: `type Page = "town" | "directory" | "party" | "jobs" | "underworld" | "almanac" | "knows"`. `#rail` buttons `[data-page]` show "Town, Directory, Party, Jobs, Underworld, Almanac", in that order. Underworld appears only when `world(town)` exists. The inspector always shows the selection. The rail page renders into the inspector **only** when nothing is selected or when the user clicks a rail item. "Town" = `select(undefined)`.

- [ ] **Step 1: Write the failing tests:**

```ts
test("directory people tab has one row per person and sorts by age", () => {
  const d = directory(town, "people", { date: "1203-10-01", block: "forenoon", sort: { col: 2, desc: true } });
  expect(d.rows.length).toBe(town.allEntities().filter((e) => e.type === "person").length);
  expect(Number(d.rows[0].cells[2])).toBeGreaterThanOrEqual(Number(d.rows[1].cells[2]));
});
test("directory filter needs every word", () => {
  const d = directory(town, "buildings", { date: "1203-10-01", block: "forenoon", filter: "ale house" });
  for (const r of d.rows) expect(r.cells.join(" ").toLowerCase()).toMatch(/ale/);
});
test("every LISTS entry is a directory tab", () => {
  const ids = DIRECTORY_TABS(town).map((t) => t.id);
  for (const l of LISTS) expect(ids).toContain(`list:${l.id}`);
});
test("a hamlet has no wards tab", () => expect(DIRECTORY_TABS(hamlet).map((t) => t.id)).not.toContain("wards"));
```

- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `directory.ts`. Move the tabs to `#rail` (80 px wide at ≥ 1100 px; below 1100 px, a 56 px rail with a 2-letter abbreviation in a `title` tooltip). Delete `tabsHtml` and the Find page; `openDirectory(list)` now opens the Directory on that tab. The "following ×" indicator moves to the inspector header.
- [ ] **Step 4:** Run the tests. Expected: PASS. Smoke check: click the rail's Directory item, then the Age header twice, and assert the first row's Age is ≥ the second's. Click a row and assert the `h2` matches its name.
- [ ] **Step 5:** Run `npm run check`, then `./install.sh`. Commit: `"UI phase 3: left rail and sortable Directory"`

### Task 5: Inspector polish (phase 4)

**Files:**
- Create: `src/ui/glance.ts`
- Modify: `src/ui/main.ts` (the inspect branch of `drawInspector`, `panelHtml`, `rowHtml`), `src/ui/style.css`
- Test: `tests/ui.test.ts`

**Interfaces:**
- Produces:
  - `glance(town: Town, a: Address, date: string, block: Block): { label: string; value: Value }[]` (`Value` from `discover.ts`). For a person: Trade, Age, Household (a link), Now (`whereabouts().label` + `doing`). For a building: Use, Households (links), Inside now (the count from `occupancy`, plus up to 3 links). For a household: Head (a link), Trade, Income (`lsd`). Any other type gets `[]`.
  - `starsOf(town: Town, a: Address): { label: string; index: number }[]`. These are the `town.events` with `kind === "star" && target === a`, where `index` is the index into `town.events`. Starring calls `withEvent(town, modules, { kind: "star", target: a, text: row.label, date: town.clock.date })`, and unstarring calls `withoutEvent(town, modules, index)`. Starred rows are copied into the card by matching `PanelRow.label` against the panel rows.
  - Each `rowHtml` row gains a `☆`/`★` button `[data-star]` among its `.tools`.
  - Collapsed sections: `localStorage["town-gen:shut"]` holds a JSON array of `"<entityType>:<panelId>"`. The `toggle` event on `details.panel` updates it. `panelHtml` renders `open` unless the panel is in the set.
  - Jump chips: `<nav class="jump">` lists one chip `[data-jump="<panel id>"]` per non-empty panel, labelled with its title. A click opens that `details` and scrolls it to the top of `#inspector`.

- [ ] **Step 1: Write the failing tests:**

```ts
test("glance for a person has trade, age, household and now", () => {
  const p = town.allEntities().find((e) => e.type === "person")!;
  expect(glance(town, p.address, "1203-10-01", "forenoon").map((r) => r.label)).toEqual(["Trade", "Age", "Household", "Now"]);
});
test("a star leaves every panel's rows unchanged", () => {
  const p = town.allEntities().find((e) => e.type === "person")!.address;
  const before = JSON.stringify(modules.flatMap((m) => m.panels ?? []).filter((x) => x.for === "person").map((x) => x.rows(town, town.get(p))));
  const t2 = withEvent(town, modules, { kind: "star", target: p, text: "Age", date: "1203-10-01" }); t2.society();
  const after = JSON.stringify(modules.flatMap((m) => m.panels ?? []).filter((x) => x.for === "person").map((x) => x.rows(t2, t2.get(p))));
  expect(after).toBe(before);
  expect(starsOf(t2, p)).toEqual([{ label: "Age", index: t2.events.length - 1 }]);
});
```
(Use the hamlet for the star test, so it stays fast.)

- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the card (`.glance`, an 8 px radius, a `--surface` background, under the `h2`), the stars, the jump chips and the collapsed-section memory. The header order is: crumbs with `◀ ▶`, `h2`, the subtitle, the card, the buttons row (Pin, Follow, and a `⋯` menu holding Print), the chips, then the panels.
- [ ] **Step 4:** Run the tests. Expected: PASS. Smoke check: select a person, star a row, assert the `.glance` contains its label, reload, assert it is still there. Collapse a panel, reload, assert it is still collapsed.
- [ ] **Step 5:** Run `npm run check`, then `./install.sh`. Commit: `"UI phase 4: at-a-glance card, stars, jump chips, remembered sections"`

### Task 6: Map toolbar and visual pass (phase 5)

**Files:**
- Modify: `src/ui/main.ts` (`drawMap`, the map pointer handlers), `src/ui/style.css`, `tools/look.mjs` (`SIZE` env, if not already done in Task 2)

**Interfaces:**
- Produces:
  - Map toolbar `.maptools` (top left): chips `[data-lens]` for `none`, `wealth`, `class`, `crime` (crime only when the lens is available), a "More ▾" popover with the remaining `LENSES`, then a divider and a `[data-people]` toggle labelled "Show townsfolk". The legend stays under the toolbar.
  - Zoom stack: `+`, `−`, "Fit", "Party" (text labels with `aria-label` and `title`; 32 px targets).
  - Hover tooltip `#map-tip`: on `pointermove` over `g[data-address]` (not while dragging), it shows `town.label(a)`, a `·` separator and the first household's label, offset 12 px from the cursor, throttled with `requestAnimationFrame`.
  - Zoom-dependent labels: `mapEl.dataset.zoom = view[2] > 900 ? "far" : view[2] > 350 ? "mid" : "near"`, set in `applyView`. In CSS, `.m-small` is hidden when `far`.
  - CSS tokens added on `:root` and in the dark block: `--surface`, `--surface-2`, `--focus`, `--hit`, `--fs-s: 13px; --fs-m: 15px; --fs-l: 18px; --fs-xl: 26px`, `--r: 8px`. All `font-size` declarations use the scale, and all buttons, selects, chips and inputs share one style (`min-height: 32px`, `border-radius: 6px`) with `:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px }`. Inspector width is `clamp(380px, 28vw, 560px)`, and on screens ≥ 2000 px the body text is 16 px.

- [ ] **Step 1:** Implement the toolbar and the tooltip, and remove the temporary People button from Task 2.
- [ ] **Step 2:** Do the CSS pass. Grep check: `grep -nE "font-size: *[0-9.]+px" src/ui/style.css` lists only the scale values (13, 15, 18, 26) and the print and map-label exceptions.
- [ ] **Step 3:** Smoke check: hover the centre building and assert `#map-tip` is visible with text. Click the "wealth" chip and assert the `.legend` is not empty. Zoom out to `far` and assert `.m-small` is computed as `display:none`.
- [ ] **Step 4:** Take screenshots: hamlet and 3000-person town at 1500×950 and 2560×1440, in light and dark (`page.emulateMedia` via a CDP step `Emulation.setEmulatedMedia`, or `document.documentElement.dataset.theme`). Read all of them and check against the anti-goals: book-like, no wrapped bar, readable inspector.
- [ ] **Step 5:** Run `npm run check`, then `./install.sh`. Commit: `"UI phase 5: map toolbar, hover names, type and spacing system"`

### Task 7: Player view (phase 6)

**Files:**
- Create: `src/ui/player.ts`
- Modify: `src/ui/main.ts`, `src/ui/directory.ts`, `src/ui/palette.ts`, `src/ui/style.css`
- Test: `tests/player.test.ts`

**Interfaces:**
- Produces:
  - `HIDDEN_PANELS = (id: string) => id === "secrets" || id.startsWith("crime-")`
  - `HIDDEN_LISTS = new Set(["debts", "secrets", "feuds", "underworld", "crimes", "gaol"])`
  - `HIDDEN_ALMANAC = new Set(["secret", "crime", "life"])`
  - `playerPanels(panels: PanelSpec[]): PanelSpec[]`
  - `playerRow(r: PanelRow): PanelRow`, which returns `{ ...r, fact: undefined, key: undefined }` (no "who knows?", no edit, reroll or star tools).
  - `playerLists(lists: ListSpec[]): ListSpec[]`
  - `let player: boolean` in `main.ts`, persisted as `localStorage["town-gen:player"]`. It is toggled by `#player-toggle` (labelled "Player view", with `aria-pressed`) and by `Shift+P` when not typing. When on, `body.player` adds a 3 px accent band at the top of the bar and changes the toggle's label to "Player view on".
  - When on: the Underworld rail item is hidden. In Nearby, `crimeNearHtml`, the encounter's "Underneath" row, the deed log input and the "remove" button are hidden. The Hooks and Buildings panels on the Town page are hidden. Almanac chips for the hidden kinds are not rendered. `paletteGroups` and `directory` receive `{ player: true }`. `DIRECTORY_TABS` drops the hidden lists. If the selection or a history entry is the underworld or one of its crews (`world(town).address` or any `world(town).gangs[i].address`), selecting it falls back to the town.

- [ ] **Step 1: Write the failing tests** in `tests/player.test.ts` (`town` = `generate("burgh-a", { pop: 8000 })`):

```ts
test("player panels drop secrets and every crime panel", () => {
  const ids = playerPanels(modules.flatMap((m) => m.panels ?? [])).map((p) => p.id);
  expect(ids).not.toContain("secrets");
  expect(ids.some((i) => i.startsWith("crime-"))).toBe(false);
  expect(ids).toContain("relationships");
});
test("player rows have no fact and no edit key", () => {
  expect(playerRow({ label: "x", value: "y", key: "k", fact: "edge:1" })).toEqual({ label: "x", value: "y" , key: undefined, fact: undefined });
});
test("player directory has no debts, secrets or crime lists", () => {
  const ids = DIRECTORY_TABS(town, { player: true }).map((t) => t.id);
  for (const h of HIDDEN_LISTS) expect(ids).not.toContain(`list:${h}`);
});
test("player palette never offers a hidden list", () => {
  const lists = paletteGroups(town, "secrets", { player: true }).find((g) => g.title === "Lists");
  expect(lists?.items.some((i) => i.list === "secrets") ?? false).toBe(false);
});
test("player almanac kinds exclude secrets, crimes and deaths", () => {
  expect([...HIDDEN_ALMANAC].sort()).toEqual(["crime", "life", "secret"]);
});
```

- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `player.ts` and thread `player` through the rendering.
- [ ] **Step 4:** Run the tests. Expected: PASS. Smoke check on a 3000-person town: turn player view on, then assert there is no `[data-page="underworld"]`, no `button.knows`, no `.tools`, and no text "Underneath" in the inspector after selecting the first person with `crime.alias` (found via `search` in a step). Reload and assert it is still on.
- [ ] **Step 5:** Run `npm run check`. Update `README.md` (keyboard shortcuts: `/`, `Ctrl+K`, `[`, `]`, `Alt+←/→`, `Shift+P`; player view) and `CLAUDE.md` (the `src/ui/` layout line and the `tools/ui-smoke.sh` command). Run `./install.sh`. Commit: `"UI phase 6: player view"`

### Task 8: Whole-app check

- [ ] **Step 1:** Run `npm run check` and `npm run build`. Expected: both pass, with no new chunk-size warning beyond the existing one.
- [ ] **Step 2:** Walk the spec's "Controls reorganised" table row by row in the running app (`./install.sh`, then :31741) and confirm each control is in its new home.
- [ ] **Step 3:** Keyboard-only run: open the app, press `/`, type a surname, Enter, `Alt+←`, `]`, `Shift+P`, then `Shift+P` again, without touching the mouse. Every step must work.
- [ ] **Step 4:** Update the memory note `town-gen.md` (shortcuts, player view, smoke harness).
