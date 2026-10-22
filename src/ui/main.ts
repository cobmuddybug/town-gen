import { ancestors, typeOf, type Address } from "../core/address";
import { load, serialize, withEdit, withEvent, withoutEvent, withPin, withReroll } from "../core/save";
import type { Town } from "../core/town";
import type { PanelLink, PanelRow, PanelSpec, SaveFile } from "../core/types";
import type { MapData } from "../modules/layout";
import { findHooks } from "../modules/sifters";
import { defaultModules, generate } from "../town-gen";
import { renderMap, renderPeople } from "./map";
import { describeDate, parseDate, type Block, whenOf } from "../core/calendar";
import { occupancy } from "../modules/routines";
import { describeHour } from "../modules/gossip";
import { almanac, dayOf, LENSES, lensView, LISTS, placeName, search, whoKnows, type Fact, type Lens } from "./discover";
import { fetchKept, forget, keep, listKept, townKey } from "./library";
import { MANOR_MAX, PLAN_MIN, newTownHtml, settingsFromForm, sizePreview } from "./newtown";
import { clockLabel, stepClock, townMenuHtml } from "./topbar";
import { History, isTypingTarget } from "./history";
import { paletteGroups, paletteHtml, paletteItems, type PaletteGroup, type PaletteItem } from "./palette";
import type { Occupation } from "../modules/uses";
import { encounter, jobBoard, nearestBuildingTo, partyName, reachOf, report, type Text } from "./party";
import { lsd } from "../modules/households";
import { crimeContent, world } from "../modules/crime";
import { ordinaryDay } from "../modules/civic";

const modules = defaultModules;
const STORE = "town-gen:last";

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const mapEl = $<HTMLElement>("#map");
const insp = $<HTMLElement>("#inspector");
const form = $<HTMLFormElement>("#new-town");

let town: Town;
let selected: Address | undefined;
let view: [number, number, number, number] | undefined;
let showPeople = false;
try { showPeople = localStorage.getItem("town-gen:people") === "1"; } catch { /* ignore */ }

// What the inspector shows: an entity, the finder, the almanac, or who knows a fact.
type Page = "inspect" | "find" | "almanac" | "knows" | "nearby" | "jobs" | "underworld";
let page: Page = "inspect";
let fact: Fact | undefined;
let query = "";
let listId: string | undefined;
let follow: Address | undefined;
let lens: Lens = "none";
// The nearby page's encounter roll (0 = none yet), and whether the next map click places the party.
let rolls = 0;
let placing = false;
try { lens = (localStorage.getItem("town-gen:lens") as Lens) || "none"; } catch { /* ignore */ }

const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function randomSeed(): string {
  const words = ["ash", "oak", "rye", "elm", "fen", "hob", "wat", "moss", "flint", "barrow", "thorn", "brook", "lark", "kiln", "hay"];
  const n = new Uint32Array(3);
  crypto.getRandomValues(n);
  return `${words[n[0] % words.length]}-${words[n[1] % words.length]}-${n[2] % 1000}`;
}

// ---- state ---------------------------------------------------------------

function setTown(t: Town, keepView = false) {
  town = t;
  town.society();
  if (selected && !town.find(selected)) selected = undefined;
  if (!keepView) { view = undefined; hist = new History(); hist.push(town.root); }
  else hist.prune((a) => !!town.find(a));
  store();
  history.replaceState(null, "", `#${townKey(town.toSave())}`);
  syncForm();
  drawTowns();
  drawMap();
  drawInspector();
}

/** Remember the current town, and keep it in the library if it has been worked on. */
function store() {
  try {
    localStorage.setItem(STORE, serialize(town));
    keep(localStorage, town.toSave(), town.label(town.root));
  } catch { /* storage may be blocked or full */ }
}

// ---- the town menu --------------------------------------------------------

const menuBtn = $<HTMLButtonElement>("#town-menu");
const menuEl = $<HTMLElement>("#town-menu-list");

function drawTowns() {
  let kept: ReturnType<typeof listKept> = [];
  try { kept = listKept(localStorage); } catch { /* ignore */ }
  $("#town-name").textContent = town.label(town.root);
  document.title = `${town.label(town.root)} · Town Generator`;
  menuEl.innerHTML = townMenuHtml(kept, townKey(town.toSave()), town.label(town.root), showSources);
}

/** Open one popover (the menu, the clock) and close the others. */
function openPop(el: HTMLElement | undefined) {
  for (const p of document.querySelectorAll<HTMLElement>(".bar .pop")) {
    if (p.id === "palette") continue;
    const on = p === el && p.hidden;
    p.hidden = !on;
    const owner = p.id === "town-menu-list" ? menuBtn : p.id === "clock-pop" ? $<HTMLElement>("#clock-label") : undefined;
    owner?.setAttribute("aria-expanded", String(on));
  }
  el?.querySelector<HTMLElement>("button:not([disabled]), input, select")?.focus();
}
document.addEventListener("pointerdown", (e) => {
  const t = e.target as Element;
  if (!t.closest(".menu-wrap, .clock")) openPop(undefined);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.querySelector(".bar .pop:not([hidden]):not(#palette)")) openPop(undefined);
});

menuBtn.addEventListener("click", () => openPop(menuEl));
menuEl.addEventListener("click", (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!t) return;
  const key = t.dataset.openTown;
  const act = t.dataset.menu;
  if (act !== "sources") openPop(undefined);
  if (key) {
    const save = fetchKept(localStorage, key);
    if (!save) { drawTowns(); return; }
    selected = undefined;
    follow = undefined;
    setTown(load(save, modules));
  } else if (act === "download") {
    const blob = new Blob([serialize(town)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${town.label(town.root).replace(/\W+/g, "-").toLowerCase()}.town.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } else if (act === "open") {
    $<HTMLInputElement>("#load").click();
  } else if (act === "sources") {
    showSources = !showSources;
    try { localStorage.setItem("town-gen.sources", showSources ? "1" : "0"); } catch { /* ignore */ }
    drawTowns();
    menuEl.querySelector<HTMLElement>('[data-menu="sources"]')?.focus();
    drawInspector();
  } else if (act === "forget") {
    if (!confirm(`Forget your edits and pins in ${town.label(town.root)}? The seed still gives the town as generated.`)) return;
    try { forget(localStorage, townKey(town.toSave())); } catch { /* ignore */ }
    const save = town.toSave();
    selected = undefined;
    setTown(load({ ...save, overlay: {}, pinned: {}, events: [] }, modules));
  }
});
$<HTMLInputElement>("#load").addEventListener("change", async (ev) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    selected = undefined;
    setTown(load(JSON.parse(await file.text()) as SaveFile, modules));
  } catch (err) {
    alert(`Couldn't load that file: ${(err as Error).message}`);
  }
});

// ---- clock ---------------------------------------------------------------

const clockDate = $<HTMLInputElement>("#clock-date");
const clockBlock = $<HTMLSelectElement>("#clock-block");
const clockLabelEl = $<HTMLButtonElement>("#clock-label");

function syncClock() {
  clockLabelEl.textContent = clockLabel(town.clock.date, town.clock.block);
  clockLabelEl.title = `${describeDate(town.clock.date)}, ${town.clock.block.replace("_", " ")}. Click to pick a date; [ and ] step.`;
  clockDate.value = town.clock.date;
  clockBlock.value = town.clock.block;
  mapEl.querySelector('[data-zoom="people"]')?.classList.toggle("on", showPeople);
}

function setClock(date: string, block: string) {
  town.clock = { date, block };
  store();
  syncClock();
  drawPeople();
  drawFollow();
  drawInspector();
}

function stepBy(step: number) {
  const c = stepClock(town.clock.date, town.clock.block, step);
  setClock(c.date, c.block);
}

function drawPeople() {
  const svg = mapEl.querySelector("svg");
  svg?.querySelector(".m-people")?.remove();
  if (!svg || !showPeople) return;
  svg.insertAdjacentHTML("beforeend", renderPeople(town, occupancy(town, town.clock.date, town.clock.block as Block)));
}

function togglePeople() {
  showPeople = !showPeople;
  try { localStorage.setItem("town-gen:people", showPeople ? "1" : "0"); } catch { /* ignore */ }
  syncClock();
  drawPeople();
}

$("#clock").addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest("#clock-label")) { openPop($<HTMLElement>("#clock-pop")); return; }
  const b = t.closest<HTMLElement>("[data-step]");
  if (b) stepBy(Number(b.dataset.step));
});
clockBlock.addEventListener("change", () => setClock(town.clock.date, clockBlock.value));
clockDate.addEventListener("change", () => {
  try { parseDate(clockDate.value.trim()); setClock(clockDate.value.trim(), town.clock.block); }
  catch { clockDate.value = town.clock.date; }
});

// ---- the New town dialog ----------------------------------------------------

const dialog = $<HTMLDialogElement>("#new-town-dialog");
form.innerHTML = newTownHtml();
const field = <T extends Element>(name: string) => form.elements.namedItem(name) as unknown as T;

function syncForm() {
  const s = town.toSave().town;
  field<HTMLInputElement>("seed").value = s.seed;
  field<HTMLInputElement>("pop").value = String(s.config.pop);
  field<HTMLSelectElement>("era").value = s.era;
  field<HTMLSelectElement>("base").value = s.config.base;
  field<HTMLInputElement>("manorial").checked = s.config.lordship === "manorial";
  const d = s.config.design ?? {};
  for (const k of ["walls", "gates", "shape", "castle", "market", "suburbs", "crime"] as const) {
    const v = d[k];
    field<HTMLSelectElement>(k).value = v === undefined ? "" : typeof v === "boolean" ? (v ? "1" : "0") : String(v);
  }
  syncManor();
}

/** What this many people will make, and which choices apply to it. */
function syncManor() {
  const pop = Number(field<HTMLInputElement>("pop").value) || 0;
  const p = sizePreview(Math.min(30000, Math.max(50, pop || 200)));
  $("#size-preview").textContent = p.line;
  const manor = $<HTMLElement>("#manor-field");
  manor.hidden = pop > MANOR_MAX;
  if (manor.hidden) field<HTMLInputElement>("manorial").checked = false;
  $<HTMLElement>("#plan").hidden = pop <= PLAN_MIN;
}

$("#new-town-btn").addEventListener("click", () => {
  syncForm();
  dialog.showModal();
  field<HTMLInputElement>("pop").focus();
});
form.addEventListener("input", syncManor);
$("#reroll-seed").addEventListener("click", () => { field<HTMLInputElement>("seed").value = randomSeed(); });
$("#new-town-cancel").addEventListener("click", () => dialog.close());

function select(a: Address | undefined) {
  selected = a;
  if (!walking) hist.push(a ?? town.root);
  page = "inspect";
  markMap();
  if (lens === "thread") drawLens();
  drawInspector();
  insp.scrollTop = 0;
}

// Back and forward through what the inspector has shown.
let hist = new History();
let walking = false;
function walk(step: number) {
  const a = step < 0 ? hist.back() : hist.forward();
  if (a === undefined) return;
  walking = true;
  try { select(a === town.root ? undefined : a); } finally { walking = false; }
  if (a !== town.root) focusOn(a);
}

function edit(address: Address, key: string, value: unknown) {
  setTown(withEdit(town, modules, address, key, value), true);
}

// ---- map -----------------------------------------------------------------

function buildingOf(a: Address): Address | undefined {
  const all = [...ancestors(a), a];
  return all.find((x) => typeOf(x) === "building");
}

function drawParty() {
  const svg = mapEl.querySelector("svg");
  if (!svg) return;
  svg.querySelector(".m-party")?.remove();
  const at = town.party?.at;
  if (!at) return;
  const r = reachOf(town);
  svg.insertAdjacentHTML("beforeend", `<g class="m-party"><title>${esc(partyName(town))}: right-click elsewhere to move</title><circle class="m-party-reach" cx="${f1(at[0])}" cy="${f1(at[1])}" r="${r}"/><path class="m-party-flag" d="M${f1(at[0])},${f1(at[1])}v-14l10,3.5l-10,3.5"/><circle class="m-party-dot" cx="${f1(at[0])}" cy="${f1(at[1])}" r="2.6"/></g>`);
}

/** Put the party on the map and open the report on what's round about them. */
function setParty(at: [number, number]) {
  town.party = { ...(town.party ?? {}), at: [Math.round(at[0] * 10) / 10, Math.round(at[1] * 10) / 10] };
  rolls = 0;
  store();
  drawParty();
  page = "nearby";
  drawInspector();
  insp.scrollTop = 0;
}

function drawMap() {
  mapEl.innerHTML = renderMap(town) +
    `<div class="lens"><select id="lens-select" title="Colour the map by...">${LENSES.filter((l) => !l.streetOnly || town.settlement().get<MapData>("map").kind === "town").map((l) => `<option value="${l.id}"${l.id === lens ? " selected" : ""}>${esc(l.label)}</option>`).join("")}</select><div class="legend"></div></div>` +
    `<div class="zoom"><button data-zoom="in" title="Zoom in">+</button><button data-zoom="out" title="Zoom out">−</button><button data-zoom="fit" title="Fit to the settlement">◎</button><button data-zoom="party" title="Place the party: click the map (or right-click anywhere)">⚑</button><button data-zoom="people" title="Show townsfolk">☺</button></div>`;
  const svg = mapEl.querySelector("svg")!;
  if (!view) view = fitVillage();
  applyView(svg);
  markMap();
  syncClock();
  drawPeople();
  drawLens();
  drawFollow();
  drawParty();
  mapEl.querySelector<HTMLSelectElement>("#lens-select")!.addEventListener("change", (ev) => {
    lens = (ev.target as HTMLSelectElement).value as Lens;
    try { localStorage.setItem("town-gen:lens", lens); } catch { /* ignore */ }
    drawLens();
  });
}

// ---- lenses and following -------------------------------------------------

const f1 = (n: number) => n.toFixed(1);

function drawLens() {
  const svg = mapEl.querySelector("svg");
  if (!svg) return;
  svg.querySelector(".m-lens")?.remove();
  const lv = lensView(town, lens, selected);
  svg.querySelectorAll<SVGGElement>("g[data-address]").forEach((g) => {
    const fill = lv.fills.get(g.dataset.address!);
    g.querySelectorAll<SVGElement>(".m-bld").forEach((p) => { p.style.fill = lens === "none" ? "" : fill ?? "var(--map-dim,#e6e0cc)"; });
  });
  if (lv.lines.length) {
    const g = lv.lines.map((l) => `<line x1="${f1(l.from[0])}" y1="${f1(l.from[1])}" x2="${f1(l.to[0])}" y2="${f1(l.to[1])}" stroke="${l.colour}" class="m-thread"><title>${esc(l.title)}</title></line>`).join("");
    const people = svg.querySelector(".m-people");
    const html = `<g class="m-lens">${g}</g>`;
    if (people) people.insertAdjacentHTML("beforebegin", html); else svg.insertAdjacentHTML("beforeend", html);
  }
  const legend = mapEl.querySelector(".legend")!;
  legend.innerHTML = lens === "none" ? "" : (lv.note ? `<p>${esc(lv.note)}</p>` : "") + lv.legend.slice(0, 18).map((x) => `<div><span style="background:${x.colour}"></span>${esc(x.label.replace(/_/g, " "))}</div>`).join("") + (lv.legend.length > 18 ? `<div>and ${lv.legend.length - 18} more</div>` : "");
}

function drawFollow() {
  const svg = mapEl.querySelector("svg");
  if (!svg) return;
  svg.querySelector(".m-follow")?.remove();
  if (!follow || !town.find(follow)) return;
  const stops = dayOf(town, follow, town.clock.date);
  const pts = stops.filter((x) => x.at);
  const path = pts.map((x) => `${f1(x.at![0])},${f1(x.at![1])}`).join(" ");
  const marks = stops.map((x, i) => x.at ? `<g class="m-stop${x.block === town.clock.block ? " now" : ""}"><title>${esc(`${x.block.replace("_", " ")}: ${x.w.label} — ${x.w.doing}`)}</title><circle cx="${f1(x.at[0] + i * 1.2)}" cy="${f1(x.at[1])}" r="4.2"/><text x="${f1(x.at[0] + i * 1.2)}" y="${f1(x.at[1] + 1.6)}">${i + 1}</text></g>` : "").join("");
  svg.insertAdjacentHTML("beforeend", `<g class="m-follow"><polyline points="${path}"/>${marks}</g>`);
}

function fitVillage(): [number, number, number, number] {
  const m = town.settlement().get<MapData>("map");
  const xs = m.hedge.map((p) => p[0]), ys = m.hedge.map((p) => p[1]);
  const pad = 30;
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad - 30;
  const w = Math.max(...xs) + pad - x0, h = Math.max(...ys) + pad - y0;
  const r = mapEl.clientWidth / Math.max(1, mapEl.clientHeight);
  if (w / h > r) {
    const nh = w / r;
    return [x0, y0 - (nh - h) / 2, w, nh];
  }
  const nw = h * r;
  return [x0 - (nw - w) / 2, y0, nw, h];
}

// The map is a big SVG: re-rendering it at a new viewBox costs a full repaint.
// While a gesture is under way (wheel, drag, pinch) we move it with a CSS
// transform, which the GPU does for free, and set the real viewBox only once
// the gesture rests. `shown` is the viewBox the SVG is actually drawn at.
let shown: [number, number, number, number] | undefined;
let settle: ReturnType<typeof setTimeout> | undefined;
let frame = 0;

function applyView(svg = mapEl.querySelector("svg")!) {
  if (settle) { clearTimeout(settle); settle = undefined; }
  if (frame) { cancelAnimationFrame(frame); frame = 0; }
  svg.style.transform = "";
  svg.setAttribute("viewBox", view!.map((n) => n.toFixed(2)).join(" "));
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  shown = [...view!] as [number, number, number, number];
}

/** How a viewBox sits in the map's box: scale and offset, as preserveAspectRatio "meet" does it. */
function fitOf(v: [number, number, number, number]) {
  const W = mapEl.clientWidth, H = mapEl.clientHeight;
  const s = Math.min(W / v[2], H / v[3]);
  return { s, ox: (W - v[2] * s) / 2, oy: (H - v[3] * s) / 2 };
}

/** Show `view` now, by transform, and set it properly when the gesture rests. */
function previewView(restMs = 140) {
  const svg = mapEl.querySelector("svg");
  if (!svg || !view) return;
  if (!shown) return applyView(svg);
  if (!frame) frame = requestAnimationFrame(() => {
    frame = 0;
    if (!shown || !view) return;
    const a = fitOf(shown), b = fitOf(view);
    const k = b.s / a.s;
    const tx = b.ox + (shown[0] - view[0]) * b.s - a.ox * k;
    const ty = b.oy + (shown[1] - view[1]) * b.s - a.oy * k;
    svg.style.transformOrigin = "0 0";
    svg.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${k.toFixed(5)})`;
  });
  if (settle) clearTimeout(settle);
  settle = setTimeout(() => applyView(svg), restMs);
}

/** A point on screen, in map coordinates, as the map looks now (mid-gesture too). */
function screenToMap(clientX: number, clientY: number): [number, number] {
  const r = mapEl.getBoundingClientRect();
  const v = view!, f = fitOf(v);
  return [v[0] + (clientX - r.left - f.ox) / f.s, v[1] + (clientY - r.top - f.oy) / f.s];
}

function markMap(highlight: Address[] = []) {
  const sel = selected ? buildingOf(selected) : undefined;
  const hi = new Set(highlight.map(buildingOf).filter(Boolean));
  mapEl.querySelectorAll<SVGGElement>("g[data-address]").forEach((g) => {
    const a = g.dataset.address!;
    g.querySelectorAll(".m-bld").forEach((p) => {
      p.classList.toggle("sel", a === sel);
      p.classList.toggle("m-hi", hi.has(a));
    });
  });
}

/** Bring a thing into view: centre its building, close enough to read, gliding there. */
function focusOn(a: Address) {
  const svg = mapEl.querySelector("svg");
  const b = buildingOf(a);
  const g = b && svg?.querySelector<SVGGElement>(`g[data-address="${CSS.escape(b)}"]`);
  if (!svg || !g || !view) return;
  const r = g.getBBox();
  const w = Math.min(320, view[2]), h = (w * view[3]) / view[2];
  view = [r.x + r.width / 2 - w / 2, r.y + r.height / 2 - h / 2, w, h];
  svg.classList.add("glide");
  previewView(320);
  setTimeout(() => svg.classList.remove("glide"), 340);
}

function zoom(factor: number, cx?: number, cy?: number, smooth = false) {
  const [x, y, w, h] = view!;
  const px = cx ?? x + w / 2, py = cy ?? y + h / 2;
  const nw = Math.min(Math.max(w * factor, 40), 4000), k = nw / w;
  view = [px - (px - x) * k, py - (py - y) * k, w * k, h * k];
  if (smooth) previewView(); else applyView();
}

function toMapCoords(svg: SVGSVGElement, clientX: number, clientY: number): [number, number] {
  const pt = svg.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
  return [p.x, p.y];
}

let drag: { x: number; y: number; moved: boolean; view: [number, number, number, number] } | undefined;
// Fingers on the map, for pinch-zoom: pointer id -> where it is now.
const touches = new Map<number, { x: number; y: number }>();
let pinch: { d: number; mid: [number, number] } | undefined;
const pinchOf = () => {
  const [a, b] = [...touches.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y), mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] as [number, number] };
};

mapEl.addEventListener("pointerdown", (e) => {
  if ((e.target as Element).closest(".zoom, .lens")) return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  mapEl.setPointerCapture(e.pointerId);
  if (touches.size === 2) { pinch = pinchOf(); drag = undefined; return; }
  drag = { x: e.clientX, y: e.clientY, moved: false, view: [...view!] as [number, number, number, number] };
});
mapEl.addEventListener("pointermove", (e) => {
  if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && touches.size === 2) {
    // Zoom about the fingers' midpoint, and follow it as it moves.
    const now = pinchOf();
    const [mx, my] = screenToMap(pinch.mid[0], pinch.mid[1]);
    zoom(pinch.d / Math.max(1, now.d), mx, my, true);
    const f = fitOf(view!);
    view = [view![0] - (now.mid[0] - pinch.mid[0]) / f.s, view![1] - (now.mid[1] - pinch.mid[1]) / f.s, view![2], view![3]];
    previewView();
    pinch = now;
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
  drag.moved = true;
  mapEl.querySelector("svg")!.classList.add("dragging");
  const s = 1 / fitOf(drag.view).s;
  view = [drag.view[0] - dx * s, drag.view[1] - dy * s, drag.view[2], drag.view[3]];
  previewView(400);
});
const endPointer = (e: PointerEvent) => {
  touches.delete(e.pointerId);
  if (pinch) {
    if (touches.size < 2) { pinch = undefined; drag = undefined; applyView(); }
    return;
  }
  const d = drag;
  drag = undefined;
  mapEl.querySelector("svg")?.classList.remove("dragging");
  if (!d) return;
  if (d.moved) { applyView(); return; }
  if (e.type === "pointercancel") return;
  if (placing && e.button === 0) {
    placing = false;
    mapEl.classList.remove("placing");
    setParty(toMapCoords(mapEl.querySelector("svg")!, e.clientX, e.clientY));
    return;
  }
  if (e.button !== 0) return;
  const target = document.elementFromPoint(e.clientX, e.clientY);
  const g = target?.closest<SVGGElement>("g[data-address]");
  select(g?.dataset.address);
};
mapEl.addEventListener("pointerup", endPointer);
mapEl.addEventListener("pointercancel", endPointer);
mapEl.addEventListener("contextmenu", (e) => {
  if (!(e.target as Element).closest("svg")) return;
  e.preventDefault();
  setParty(toMapCoords(mapEl.querySelector("svg")!, e.clientX, e.clientY));
});
mapEl.addEventListener("wheel", (e) => {
  e.preventDefault();
  // Zoom by how far the wheel or trackpad actually moved: a mouse notch is
  // about 15%, a trackpad's stream of small deltas glides. A trackpad pinch
  // arrives as a wheel with ctrlKey and wants more per unit.
  const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  const k = Math.exp(Math.max(-0.6, Math.min(0.6, px * (e.ctrlKey ? 0.01 : 0.0014))));
  const [x, y] = screenToMap(e.clientX, e.clientY);
  zoom(k, x, y, true);
}, { passive: false });
mapEl.addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>("[data-zoom]");
  if (!b) return;
  if (b.dataset.zoom === "people") { togglePeople(); return; }
  if (b.dataset.zoom === "party") { placing = !placing; mapEl.classList.toggle("placing", placing); return; }
  if (b.dataset.zoom === "in") zoom(1 / 1.4);
  else if (b.dataset.zoom === "out") zoom(1.4);
  else { view = fitVillage(); applyView(); }
});

// ---- inspector -----------------------------------------------------------

function link(a: Address, text = town.label(a)) {
  return `<a href="#" data-go="${esc(a)}">${esc(text)}</a>`;
}

// Book citations ("LF p.86", "CC pp.58-59", "LFP") belong to the author, not the
// table: they come out of the text and wait in a hover, unless sources are on.
const SOURCE = /\s*\((?:[^()]*\b(?:LF|CC|LFP)\b(?: Table| p| pp)[^()]*|LFP[^()]*)\)/g;
const SOURCE_ALONE = /^(?:LF|CC|LFP)\b[^;]*$/;
let showSources = false;
try { showSources = localStorage.getItem("town-gen.sources") === "1"; } catch { /* ignore */ }
function sourcesOf(text: string): string[] {
  return [...text.matchAll(SOURCE)].map((m) => m[0].trim().replace(/^\(|\)$/g, ""));
}
function unsourced(text: string): string {
  return showSources ? text : text.replace(SOURCE, "");
}

function valueHtml(v: PanelRow["value"]): string {
  const one = (x: string | number | PanelLink) => (typeof x === "object" ? link(x.address, x.text) : esc(typeof x === "string" ? unsourced(x) : x));
  return Array.isArray(v) ? v.map(one).join(v.every((x) => typeof x === "object") ? ", " : "") : one(v);
}

function rowHtml(e: Address, r: PanelRow): string {
  const o = town.overlay[e]?.[r.key ?? ""];
  const edited = r.key !== undefined && o !== undefined;
  const editable = r.key !== undefined && typeof r.value !== "object" && !r.noEdit;
  const tools = r.key
    ? `<span class="tools">${editable ? `<button data-edit="${esc(r.key)}" title="Edit">✎</button>` : ""}${r.rerollable ? `<button data-reroll="${esc(r.key)}" title="Reroll">↻</button>` : ""}${edited ? `<button data-reset="${esc(r.key)}" title="Back to generated">×</button>` : ""}</span>`
    : "";
  const cited = [...(typeof r.value === "string" ? sourcesOf(r.value) : []), ...(r.hint ? sourcesOf(r.hint) : []), ...(r.hint && SOURCE_ALONE.test(r.hint) ? [r.hint] : [])];
  const hintText = r.hint && !(SOURCE_ALONE.test(r.hint) && !showSources) ? unsourced(r.hint) : "";
  const src = cited.length && !showSources ? ` <span class="src" title="${esc(cited.join("; "))}">§</span>` : "";
  const hint = (r.fact ? ` <button class="knows" data-fact="${esc(r.fact)}" title="Who knows this, and where to find them">who knows?</button>` : "") + (hintText ? `<span class="hint">${esc(hintText)}</span>` : "") + src;
  const opts = r.options ? ` data-options="${esc(r.options.join("|"))}"` : "";
  const hi = r.highlight?.length ? ` data-involves="${esc(r.highlight.join(" "))}"` : "";
  return `<dt>${esc(r.label)}</dt><dd class="${edited ? "edited" : ""}" data-key="${esc(r.key ?? "")}"${opts}${hi}><span class="val">${valueHtml(r.value)}${hint}</span>${tools}</dd>`;
}

function panelsFor(e: Address): PanelSpec[] {
  const type = town.get(e).type;
  return modules.flatMap((m) => m.panels ?? []).filter((p) => p.for === type).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function panelHtml(e: Address, p: PanelSpec): string {
  const rows = p.rows(town, town.get(e));
  if (!rows.length) return "";
  return `<details class="panel" open data-panel="${p.id}"><summary>${esc(p.title)}</summary><dl class="rows">${rows.map((r) => rowHtml(e, r)).join("")}</dl></details>`;
}

function crumbs(e: Address): string {
  const parts = [...ancestors(e), e].filter((a) => typeOf(a) !== "household" || a === e);
  return `<nav class="crumbs">${parts.map((a, i) => (i === parts.length - 1 ? esc(town.label(a)) : link(a))).join('<span class="sep">›</span>')}</nav>`;
}

function tabsHtml(): string {
  const t = (id: Page, label: string) => `<button data-page="${id}" class="${page === id || (id === "inspect" && page === "knows") ? "on" : ""}">${label}</button>`;
  const following = follow && town.find(follow) ? `<span class="following">following ${link(follow)} <button data-follow="" title="Stop following">×</button></span>` : "";
  return `<nav class="tabs">${t("inspect", "Inspect")}${t("nearby", "Nearby")}${t("jobs", "Jobs")}${world(town) ? t("underworld", "Underworld") : ""}${t("find", "Find")}${t("almanac", "Almanac")}${following}</nav>`;
}

function rowsHtml(rows: PanelRow[]): string {
  return `<dl class="rows">${rows.map((r) => rowHtml(town.root, { ...r, key: undefined })).join("")}</dl>`;
}

function findHtml(): string {
  const h: string[] = [`<h2>Find</h2>`, `<input id="find-q" class="find" placeholder="a name, a trade, a building, a ward…" value="${esc(query)}" autocomplete="off" />`, `<div id="find-results">${findResultsHtml()}</div>`];
  h.push(`<details class="panel" open><summary>Lists</summary><p class="lists">${LISTS.map((l) => `<button data-list="${l.id}" class="${listId === l.id ? "on" : ""}">${esc(l.title)}</button>`).join(" ")}</p>`);
  const l = LISTS.find((x) => x.id === listId);
  if (l) h.push(rowsHtml(l.rows(town, town.clock.date, town.clock.block as Block)));
  h.push("</details>");
  return h.join("");
}

function findResultsHtml(): string {
  if (!query.trim()) return `<p class="sub">Type to search everyone and everything. Try a surname, a trade, "alehouse" or a ward.</p>`;
  const { results, total } = search(town, query);
  if (!total) return `<p class="sub">Nothing matches.</p>`;
  return `<ul class="links">${results.map((x) => `<li>${link(x.address, x.label)} <span class="sub">— ${esc(x.detail)}</span></li>`).join("")}</ul>${total > results.length ? `<p class="sub">and ${total - results.length} more; add a word to narrow it</p>` : ""}`;
}

// What the almanac shows. Crimes and deaths to come are the DM's foreknowledge,
// and drown out the rest: off until asked for.
const ALMANAC_KINDS: [string, string][] = [["feast", "feasts"], ["market", "markets"], ["visit", "visitors"], ["secret", "secrets"], ["life", "lives"], ["crime", "crimes"]];
const almanacShow = new Set(["feast", "market", "visit", "secret", "life"]);

function almanacHtml(): string {
  const from = town.clock.date;
  const all = almanac(town, from, 60);
  const items = all.filter((x) => almanacShow.has(x.kind === "rent" ? "feast" : x.kind));
  const chips = ALMANAC_KINDS.map(([k, l]) => `<button data-almanac="${k}" class="${almanacShow.has(k) ? "on" : ""}">${l} (${all.filter((x) => (x.kind === "rent" ? "feast" : x.kind) === k).length})</button>`).join(" ");
  const h: string[] = [`<h2>Almanac</h2>`, `<p class="sub">The next sixty days from ${esc(describeDate(from))}. Click a date to go there.</p>`, `<p class="lists">${chips}</p>`];
  let day = "";
  for (const it of items) {
    if (it.date !== day) {
      if (day) h.push("</dl>");
      day = it.date;
      h.push(`<h3 class="day"><a href="#" data-date="${esc(it.date)}">${esc(describeDate(it.date, from))}</a></h3><dl class="rows">`);
    }
    h.push(rowHtml(town.root, { label: it.kind === "secret" ? "comes out" : it.kind, value: it.text, fact: it.fact }));
  }
  if (day) h.push("</dl>");
  return h.join("");
}

function knowsHtml(): string {
  const k = fact && whoKnows(town, fact, town.clock.date, town.clock.block as Block);
  if (!k) return `<p class="sub">That has gone.</p>`;
  const all = k.knowers.map((x) => x.person);
  const h: string[] = [`<h2>Who knows</h2>`, `<p class="fact" data-involves="${esc(all.join(" "))}">${valueHtml(k.title)}</p>`, `<p class="sub">${esc(k.note)}. ${k.total === Infinity ? "" : `${k.total} ${k.total === 1 ? "person knows" : "people know"}${k.total > k.knowers.length ? `; the first ${k.knowers.length} shown` : ""}.`} Hover here to see their houses on the map.</p>`];
  const TELL = ["", " (heard it grown in the telling)", " (heard it with the wrong name in it)"];
  for (const x of k.knowers) {
    const later = x.later.map((l) => `${l.date === town.clock.date ? l.block.replace("_", " ") : "tomorrow " + l.block}: ${l.w.where.startsWith("place:") ? esc(l.w.label) : link(l.w.where)}`).join("; ");
    const how = x.how === "heard" ? `heard ${esc(x.since !== undefined ? describeHourShort(x.since) : "")}${TELL[x.telling ?? 0]}` : x.how === "in it" ? "in it" : "kept it to themselves";
    h.push(`<div class="knower" data-involves="${esc(x.person)}"><h3>${link(x.person)} <span class="sub">— ${how}</span></h3><p>Now: ${x.now.where.startsWith("place:") ? esc(x.now.label) : link(x.now.where)}, ${esc(x.now.doing)}</p><p class="sub">Later: ${later}</p></div>`);
  }
  return h.join("");
}

const textHtml = (x: Text) => x.map((v) => (typeof v === "object" ? link(v.address, v.text) : esc(v))).join("");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function nearbyHtml(): string {
  const h: string[] = [`<h2>Nearby</h2>`];
  const at = town.party?.at;
  if (!at) {
    h.push(`<p class="sub">Put the party on the map: right-click where they are, or press ⚑ and click. This page then reports what's going on around them, who they bump into, what's being said, and who has work for them.</p>`);
    return h.join("");
  }
  const { date, block } = town.clock;
  const r = report(town, at, date, block as Block);
  h.push(`<p class="sub">${esc(cap(partyName(town)))}, ${textHtml(r.where)}. ${esc(describeDate(date))}, ${esc(block.replace("_", " "))}. <button class="knows" data-party-clear title="Take the party off the map">remove</button></p>`);
  h.push(`<label class="party-name">The town calls them <input id="party-name" placeholder="the strangers" value="${esc(town.party?.name ?? "")}" autocomplete="off" /></label>`);
  if (r.scene.length) h.push(`<details class="panel" open><summary>The scene</summary><p class="scene">${r.scene.map(esc).join(" ")}</p></details>`);

  // Who do we bump into?
  h.push(`<details class="panel" open><summary>Who do they bump into?</summary>`);
  if (rolls) {
    const e = encounter(town, at, date, block as Block, rolls);
    if (!e) h.push(`<p class="sub">Nobody about. The street is empty.</p>`);
    else {
      h.push(`<div class="encounter" data-involves="${esc(e.p)}"><h3>${link(e.p)} <span class="sub">— ${textHtml(e.where)}, ${esc(e.doing)}</span></h3>`);
      h.push(`<p class="opener">${esc(e.opener)}</p>`);
      if (e.lines?.length) h.push(`<ul class="lines">${e.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`);
      h.push(`<dl class="rows">`);
      if (e.crew) h.push(`<dt>Underneath</dt><dd class="dm"><span class="val">${textHtml(e.crew)}</span></dd>`);
      for (const [l, v] of [["Looks", e.looks], ["Talks", e.speech], ["Habit", e.habit], ["Wants", e.want], ["To strangers", e.strangers]] as const) if (v) h.push(`<dt>${l}</dt><dd><span class="val">${esc(v)}</span></dd>`);
      h.push(`</dl></div>`);
    }
  }
  h.push(`<p><button data-roll>${rolls ? "Someone else" : "Roll an encounter"}</button></p></details>`);

  // Here and now.
  h.push(`<details class="panel" open><summary>Here and now</summary><dl class="rows">`);
  for (const b of r.buildings.slice(0, 10)) {
    const who = b.inside.map((x) => `${link(x.p)}: ${esc(x.doing)}`).join("; ");
    const more = b.total > b.inside.length ? `; and ${b.total - b.inside.length} more` : "";
    h.push(`<dt>${Math.round(b.d)} m</dt><dd data-involves="${esc(b.a)}"><span class="val">${link(b.a)}${b.total ? ` — ${who}${more}` : ` <span class="sub">— empty</span>`}</span></dd>`);
  }
  if (!r.buildings.length) h.push(`<dt>—</dt><dd><span class="val">open ground; nobody within call</span></dd>`);
  h.push(`</dl></details>`);
  if (r.street.length) h.push(`<details class="panel" open><summary>Out and about</summary><dl class="rows">${r.street.map((x) => `<dt></dt><dd data-involves="${esc(x.p)}"><span class="val">${link(x.p)}: ${esc(x.doing)}</span></dd>`).join("")}</dl></details>`);

  if (r.crime) h.push(crimeNearHtml(r.crime));

  // What's being said.
  h.push(`<details class="panel" open><summary>Talk round here</summary><dl class="rows">`);
  h.push(r.talk.length ? r.talk.map((x) => `<dt></dt><dd><span class="val">${textHtml(x.text)} <button class="knows" data-fact="${esc(x.fact)}">who knows?</button><span class="hint">heard at ${esc(town.label(x.at).replace(/^The /, "the "))}</span></span></dd>`).join("") : `<dt></dt><dd><span class="val">the weather, the price of bread, and who drank too much</span></dd>`);
  h.push(`</dl></details>`);

  // The party's deeds.
  h.push(`<details class="panel" open><summary>What they say about ${esc(partyName(town))}</summary><dl class="rows">`);
  for (const x of r.deeds) h.push(`<dt></dt><dd><span class="val">${textHtml(x.text)} <button class="knows" data-fact="${esc(x.fact)}">who knows?</button><span class="hint">${x.total ? Math.round((100 * x.heard) / x.total) : 0}% of households have heard</span></span></dd>`);
  if (!r.deeds.length) h.push(`<dt></dt><dd><span class="val sub">Nothing yet. Log what they did below and the town will talk.</span></dd>`);
  h.push(`</dl><p class="deed-entry"><input id="deed-text" placeholder="what they did: started a fight at the alehouse…" autocomplete="off" /> <button data-deed>Spread it</button></p>`);
  const deeds = town.events.map((ev, i) => ({ ev, i })).filter((x) => x.ev.kind === "deed");
  if (deeds.length) h.push(`<ul class="links deeds">${deeds.map(({ ev, i }) => `<li>${esc(ev.date)}, ${esc((ev.block ?? "").replace("_", " "))}: ${esc(ev.text)}${ev.at ? `, at ${link(ev.at, town.label(ev.at).replace(/^The /, "the "))}` : ""} <button class="knows" data-undeed="${i}" title="Forget it was ever done">×</button></li>`).join("")}</ul>`);
  h.push(`</details>`);

  if (r.jobs.length) h.push(`<details class="panel" open><summary>Work going nearby</summary>${r.jobs.map(jobHtml).join("")}<p><a href="#" data-page="jobs">All the work going in ${esc(town.label(town.root))}</a></p></details>`);
  if (r.visitors.length) h.push(`<details class="panel" open><summary>In town today</summary><ul class="links">${r.visitors.map((v) => `<li>${esc(v)}</li>`).join("")}</ul></details>`);
  return h.join("");
}

/** The underworld round about the party: for the DM, not the players. */
function crimeNearHtml(c: NonNullable<ReturnType<typeof report>["crime"]>): string {
  const rows: string[] = [];
  const row = (label: string, html: string, involves: string[] = []) => rows.push(`<dt>${esc(label)}</dt><dd${involves.length ? ` data-involves="${esc(involves.join(" "))}"` : ""}><span class="val">${html}</span></dd>`);
  const crew = (g: string) => link(g, town.label(g).replace(/^The /, "the "));
  if (c.turf.length) row("Turf of", c.turf.map(crew).join(", "));
  else row("Turf of", `nobody's in particular`);
  if (c.dark) row("After dark", "a black, unlit ward: footpads' country");
  for (const d of c.dens) row("A den", `${link(d.a)}, where ${crew(d.gang)} meet`, [d.a]);
  for (const f of c.fences) row("A fence", `${link(f)} buys anything, at the back door`, [f]);
  for (const m of c.marks) row("Chalked", `${link(m.a)}: ${m.marks.map((k) => `${esc(crimeContent.marks[k].glyph)} ${esc(crimeContent.marks[k].text)}`).join("; ")}`, [m.a]);
  for (const a of c.active) row("About now", `${link(a.p)} of ${crew(a.gang)}: ${esc(a.doing)}`, [a.p]);
  for (const i of c.recent) row(whenOf(i.date, town.clock.date, i.block), `${esc(crimeContent.crimes[i.kind].label)}${i.victim ? `: ${link(i.victim)}` : ""}${i.items ? ` — ${esc(i.items)}` : ""}; by ${i.culprits.map((p) => link(p)).join(", ")}${i.caught && i.caught.date <= town.clock.date ? " (taken)" : ""}`, [i.at, ...i.culprits]);
  return `<details class="panel" open><summary>The underworld round here <span class="sub">— for the DM</span></summary><dl class="rows">${rows.join("")}</dl></details>`;
}

/** The underworld page: the whole thing at a glance, each crew in its own section. */
function underworldHtml(): string {
  const W = world(town);
  if (!W) return `<h2>Underworld</h2><p class="sub">Too small a place for crews.</p>`;
  const h: string[] = [`<h2>The underworld of ${esc(town.label(town.root))}</h2>`, `<p class="sub">For the DM. Crews, their dens and turf, who they pay and who sells them out, and the cant they speak. Click any name; hover a row to see it on the map.</p>`];
  for (const p of panelsFor(W.address)) h.push(panelHtml(W.address, p).replace('<details class="panel" open data-panel="crime-cant">', '<details class="panel" data-panel="crime-cant">'));
  for (const g of W.gangs) {
    const rows = panelsFor(g.address).filter((p) => p.id === "crime-gang").map((p) => p.rows(town, town.get(g.address))).flat();
    h.push(`<details class="panel"><summary>${esc(town.label(g.address))} <span class="sub">— ${esc(g.lay.label)}, ${g.members.length}</span></summary><dl class="rows">${rows.map((r) => rowHtml(g.address, r)).join("")}</dl><p>${link(g.address, "Open the crew")}</p></details>`);
  }
  return h.join("");
}

function jobHtml(j: ReturnType<typeof jobBoard>[number]): string {
  const involves = [j.patron, ...(j.target ? [j.target] : [])].join(" ");
  return `<div class="hook job" data-involves="${esc(involves)}"><h3>${esc(j.title)} <span class="pay">${esc(lsd(j.pay))}</span></h3><p>${textHtml(j.detail)}</p><p class="sub">Risk: ${textHtml(j.risk)}</p><p class="sub">Ask at ${link(j.at, town.label(j.at).replace(/^The /, "the "))}${j.fact ? ` <button class="knows" data-fact="${esc(j.fact)}">who knows?</button>` : ""}</p></div>`;
}

function jobsHtml(): string {
  const jobs = jobBoard(town, town.clock.date);
  return `<h2>Work going</h2><p class="sub">What people in ${esc(town.label(town.root))} would pay to have done: debts, grudges, quarrels, worries. Pay is what the patron can actually spare. Hover a job to see who's in it.</p>` +
    (jobs.length ? jobs.map(jobHtml).join("") : `<p class="sub">Nobody wants anything done that they'd pay a stranger for.</p>`);
}

function describeHourShort(h: number): string {
  return describeHour(h).slice(5);
}

function followHtml(p: Address): string {
  const stops = dayOf(town, p, town.clock.date);
  const rows = stops.map((x, i) => {
    const where = x.w.where.startsWith("place:") ? esc(placeName(town, x.w.where)) : link(x.w.where);
    const company = x.others.length ? ` <span class="sub">with ${x.others.map((a) => link(a)).join(", ")}${x.othersTotal > x.others.length ? ` and ${x.othersTotal - x.others.length} more` : ""}</span>` : "";
    return `<dt>${i + 1}. ${esc(x.block.replace("_", " "))}</dt><dd><span class="val">${where}: ${esc(x.w.doing)}${company}</span></dd>`;
  });
  return `<details class="panel" open><summary>Their day, on the map</summary><dl class="rows">${rows.join("")}</dl></details>`;
}

function drawInspector() {
  if (page !== "inspect") {
    insp.innerHTML = tabsHtml() + (page === "find" ? findHtml() : page === "almanac" ? almanacHtml() : page === "nearby" ? nearbyHtml() : page === "jobs" ? jobsHtml() : page === "underworld" ? underworldHtml() : knowsHtml());
    if (page === "nearby") {
      const name = insp.querySelector<HTMLInputElement>("#party-name");
      // The name is in every telling of their deeds, so the town is rebuilt with it.
      name?.addEventListener("change", () => {
        if (!town.party) return;
        const save = town.toSave();
        save.party = { ...save.party!, name: name.value.trim() || undefined };
        if (!save.party.name) delete save.party.name;
        setTown(load(save, modules), true);
      });
      const deed = insp.querySelector<HTMLInputElement>("#deed-text");
      deed?.addEventListener("keydown", (k) => { if (k.key === "Enter") logDeed(); });
    }
    if (page === "find") {
      const q = insp.querySelector<HTMLInputElement>("#find-q")!;
      q.addEventListener("input", () => { query = q.value; insp.querySelector("#find-results")!.innerHTML = findResultsHtml(); });
      if (!listId) q.focus();
    }
    return;
  }
  const e = selected ?? town.root;
  const ent = town.get(e);
  const h: string[] = [tabsHtml()];
  h.push(`<div class="ihead"><span class="hist"><button data-hist="-1" aria-label="Back" title="Back  (Alt+←)"${hist.canBack ? "" : " disabled"}>◀</button><button data-hist="1" aria-label="Forward" title="Forward  (Alt+→)"${hist.canForward ? "" : " disabled"}>▶</button></span>${e !== town.root ? crumbs(e) : ""}</div>`);
  h.push(`<button class="pin" data-print title="Print this page, with the map around it, as a handout or notes">Print</button>`);
  if (ent.type === "person" || ent.type === "household") {
    const on = !!town.pinned[e];
    h.push(`<button class="pin${on ? " on" : ""}" data-pin="${on ? "off" : "on"}" title="Pinned entities keep their details through generator upgrades">${on ? "Pinned" : "Pin"}</button>`);
  }
  if (ent.type === "person") {
    const on = follow === e;
    h.push(`<button class="pin${on ? " on" : ""}" data-follow="${on ? "" : esc(e)}" title="Draw their day on the map">${on ? "Following" : "Follow"}</button>`);
  }
  h.push(`<h2>${esc(town.label(e))}</h2>`);

  if (ent.type === "settlement") {
    const people = town.allEntities().filter((x) => x.type === "person").length;
    h.push(`<p class="sub">${people} souls in ${town.children(e, "building").length} buildings. Click a building on the map.</p>`);
    for (const w of town.warnings) h.push(`<p class="warn">${esc(w)}</p>`);
  } else if (ent.type === "building") {
    h.push(`<p class="sub">${esc(e.slice(e.lastIndexOf("/") + 1))}</p>`);
  } else if (ent.type === "person") {
    const hh = town.parentOf(e)!;
    h.push(`<p class="sub">of ${link(hh)}, at ${link(town.parentOf(hh)!)}</p>`);
  }

  if (ent.type === "person" && follow === e) h.push(followHtml(e));
  for (const p of panelsFor(e)) h.push(panelHtml(e, p));

  if (ent.type === "building") {
    const hs = town.children(e, "household");
    h.push(`<details class="panel" open><summary>Who lives here</summary>${hs.length ? `<ul class="links">${hs.map((x) => `<li>${link(x.address)} — ${town.children(x.address, "person").map((p) => link(p.address)).join(", ")}</li>`).join("")}</ul>` : "<p class=\"sub\">Nobody.</p>"}</details>`);
  }
  if (ent.type === "settlement") {
    const council = town.children(e, "institution");
    h.push(`<details class="panel" open><summary>Institutions</summary><ul class="links">${council.map((c) => `<li>${link(c.address)}</li>`).join("")}</ul></details>`);
    const hooks = findHooks(town);
    h.push(`<details class="panel" open><summary>Hooks</summary>${hooks.length ? hooks.map((k) => `<div class="hook" data-involves="${esc(k.involves.join(" "))}"><h3>${esc(k.title)}</h3><p>${esc(k.summary)}</p><p>${k.involves.map((a) => link(a)).join(", ")}</p></div>`).join("") : '<p class="sub">Nothing has come to light. Try another seed, or look closer.</p>'}</details>`);
    const byUse = new Map<string, Address[]>();
    for (const b of town.children(e, "building")) {
      const l = town.label(b.address);
      byUse.set(l, [...(byUse.get(l) ?? []), b.address]);
    }
    h.push(`<details class="panel"><summary>Buildings</summary><dl class="rows">${[...byUse].map(([l, as]) => `<dt>${esc(l)}</dt><dd><span class="val">${as.map((a, i) => link(a, String(i + 1))).join(" ")}</span></dd>`).join("")}</dl></details>`);
  }
  insp.innerHTML = h.join("");
}

insp.addEventListener("click", (ev) => {
  const t = ev.target as HTMLElement;
  const go = t.closest<HTMLElement>("[data-go]");
  if (go) { ev.preventDefault(); select(go.dataset.go === town.root ? undefined : go.dataset.go); return; }
  const hs = t.closest<HTMLElement>("[data-hist]");
  if (hs) { walk(Number(hs.dataset.hist)); return; }
  const pg = t.closest<HTMLElement>("[data-page]");
  if (pg) { ev.preventDefault(); page = pg.dataset.page as Page; drawInspector(); insp.scrollTop = 0; return; }
  const fk = t.closest<HTMLElement>("[data-fact]");
  if (fk) { fact = fk.dataset.fact as Fact; page = "knows"; drawInspector(); insp.scrollTop = 0; return; }
  const ls = t.closest<HTMLElement>("[data-list]");
  if (ls) { listId = listId === ls.dataset.list ? undefined : ls.dataset.list; drawInspector(); return; }
  const ak = t.closest<HTMLElement>("[data-almanac]");
  if (ak) { const k = ak.dataset.almanac!; if (almanacShow.has(k)) almanacShow.delete(k); else almanacShow.add(k); drawInspector(); return; }
  const dt = t.closest<HTMLElement>("[data-date]");
  if (dt) { ev.preventDefault(); setClock(dt.dataset.date!, "forenoon"); return; }
  const fo = t.closest<HTMLElement>("[data-follow]");
  if (fo) { follow = fo.dataset.follow || undefined; drawFollow(); drawInspector(); return; }
  if (t.closest("[data-print]")) { printPage(); return; }
  if (t.closest("[data-roll]")) { rolls++; drawInspector(); return; }
  if (t.closest("[data-deed]")) { logDeed(); return; }
  const ud = t.closest<HTMLElement>("[data-undeed]");
  if (ud) { setTown(withoutEvent(town, modules, Number(ud.dataset.undeed)), true); return; }
  if (t.closest("[data-party-clear]")) { town.party = undefined; store(); drawParty(); drawInspector(); return; }
  const e = selected ?? town.root;
  const pin = t.closest<HTMLElement>("[data-pin]");
  if (pin) { setTown(withPin(town, modules, e, pin.dataset.pin === "on"), true); return; }
  const rr = t.closest<HTMLElement>("[data-reroll]");
  if (rr) { setTown(withReroll(town, modules, e, rr.dataset.reroll!), true); return; }
  const rs = t.closest<HTMLElement>("[data-reset]");
  if (rs) { edit(e, rs.dataset.reset!, undefined); return; }
  const ed = t.closest<HTMLElement>("[data-edit]");
  if (ed) startEdit(e, ed.closest("dd")!, ed.dataset.edit!);
});

insp.addEventListener("mouseover", (ev) => {
  const hook = (ev.target as HTMLElement).closest<HTMLElement>("[data-involves]");
  markMap(hook ? hook.dataset.involves!.split(" ") : []);
});

/** Print the inspector with every section open and a map inset: the whole place, or around the building. */
function printPage() {
  const shut = [...insp.querySelectorAll<HTMLDetailsElement>("details:not([open])")];
  shut.forEach((d) => { d.open = true; });
  const svg = mapEl.querySelector("svg")!;
  const b = selected ? buildingOf(selected) : undefined;
  let box = fitVillage();
  const g = b && svg.querySelector<SVGGElement>(`g[data-address="${CSS.escape(b)}"]`);
  if (g) {
    const r = g.getBBox(), pad = 70;
    box = [r.x - pad, r.y - pad, r.width + 2 * pad, r.height + 2 * pad];
  }
  const fig = document.createElement("figure");
  fig.className = "print-map";
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("viewBox", box.map((n) => n.toFixed(1)).join(" "));
  fig.append(clone);
  (insp.querySelector("h2 + .sub") ?? insp.querySelector("h2"))!.after(fig);
  window.addEventListener("afterprint", () => {
    fig.remove();
    shut.forEach((d) => { d.open = false; });
  }, { once: true });
  window.print();
}

/** Log what the party just did where they stand; the town starts talking from this block. */
function logDeed() {
  const input = insp.querySelector<HTMLInputElement>("#deed-text");
  const text = input?.value.trim();
  if (!text || !town.party) return;
  const at = nearestBuildingTo(town, town.party.at);
  if (!at) return;
  setTown(withEvent(town, modules, { kind: "deed", date: town.clock.date, block: town.clock.block, at, text }), true);
}

function startEdit(e: Address, dd: HTMLElement, key: string) {
  const current = town.get(e).get(key);
  const val = dd.querySelector(".val")!;
  const opts = dd.dataset.options?.split("|");
  let input: HTMLInputElement | HTMLSelectElement;
  if (opts) {
    input = document.createElement("select");
    for (const o of opts) input.add(new Option(o.replace(/_/g, " "), o, false, o === current));
  } else {
    input = document.createElement("input");
    input.value = Array.isArray(current) ? current.join(", ") : String(current ?? "");
  }
  val.replaceChildren(input);
  input.focus();
  const commit = () => {
    let v: unknown = input.value.trim();
    if (Array.isArray(current)) v = (v as string).split(",").map((x) => x.trim()).filter(Boolean);
    else if (typeof current === "number") v = Number(v);
    if (v === "" || JSON.stringify(v) === JSON.stringify(current)) { drawInspector(); return; }
    edit(e, key, v);
  };
  input.addEventListener("keydown", (k) => {
    if ((k as KeyboardEvent).key === "Enter") commit();
    if ((k as KeyboardEvent).key === "Escape") drawInspector();
  });
  input.addEventListener(opts ? "change" : "blur", commit);
}

// ---- building a town ------------------------------------------------------

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  dialog.close();
  const fd = new FormData(form);
  selected = undefined;
  follow = undefined;
  const { seed, settings } = settingsFromForm((k) => fd.get(k) as string | null);
  setTown(fresh(seed ?? randomSeed(), settings));
});

// ---- search ----------------------------------------------------------------

const searchEl = $<HTMLInputElement>("#search");
const palEl = $<HTMLElement>("#palette");
let palGroups: PaletteGroup[] = [];
let palActive = 0;

function drawPalette() {
  palGroups = paletteGroups(town, searchEl.value);
  const n = paletteItems(palGroups).length;
  palActive = Math.max(0, Math.min(palActive, n - 1));
  palEl.innerHTML = paletteHtml(palGroups, palActive, searchEl.value);
  palEl.hidden = false;
  palEl.querySelector(".pal-item.on")?.scrollIntoView({ block: "nearest" });
  markMap(paletteItems(palGroups).flatMap((x) => (x.address ? [x.address] : [])));
}

function closePalette() {
  if (palEl.hidden) return;
  palEl.hidden = true;
  markMap();
}

function openItem(x: PaletteItem | undefined) {
  if (!x) return;
  closePalette();
  searchEl.blur();
  if (x.address) { select(x.address === town.root ? undefined : x.address); focusOn(x.address); }
  else if (x.list) openDirectory(x.list);
}

/** Open a list (or a trade's people) in the finder. */
function openDirectory(list: string) {
  selected = undefined;
  if (list.startsWith("trade:")) {
    listId = undefined;
    query = town.registry<Occupation>("occupations").find(list.slice(6))?.label ?? "";
  } else listId = list;
  page = "find";
  drawInspector();
  insp.scrollTop = 0;
}

searchEl.addEventListener("focus", () => { openPop(undefined); drawPalette(); });
searchEl.addEventListener("input", () => { palActive = 0; drawPalette(); });
searchEl.addEventListener("keydown", (e) => {
  const n = paletteItems(palGroups).length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (n) { palActive = (palActive + (e.key === "ArrowDown" ? 1 : n - 1)) % n; drawPalette(); }
  } else if (e.key === "Enter") {
    e.preventDefault();
    openItem(paletteItems(palGroups)[palActive]);
  } else if (e.key === "Escape") {
    e.preventDefault();
    searchEl.value = "";
    closePalette();
    searchEl.blur();
  }
});
palEl.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus in the box
palEl.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-pal]");
  if (b) openItem(paletteItems(palGroups)[Number(b.dataset.pal)]);
});
palEl.addEventListener("mousemove", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-pal]");
  if (b && Number(b.dataset.pal) !== palActive) { palActive = Number(b.dataset.pal); palEl.querySelectorAll(".pal-item").forEach((x, i) => x.classList.toggle("on", i === palActive)); }
});
document.addEventListener("pointerdown", (e) => {
  if (!(e.target as Element).closest(".search-wrap")) closePalette();
});

// ---- keys ----------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if (dialog.open) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }
  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); walk(e.key === "ArrowLeft" ? -1 : 1); return; }
  if (isTypingTarget(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); searchEl.focus(); searchEl.select(); }
  else if (e.key === "[") { e.preventDefault(); stepBy(-1); }
  else if (e.key === "]") { e.preventDefault(); stepBy(1); }
});
window.addEventListener("resize", () => { view = undefined; drawMap(); });

// ---- start ---------------------------------------------------------------

function start() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("seed")) {
    let saved: SaveFile | undefined;
    try { saved = JSON.parse(localStorage.getItem(STORE) ?? "null") ?? undefined; } catch { /* ignore */ }
    const seed = hash.get("seed")!;
    const { settings } = settingsFromForm((k) => hash.get(k === "manorial" ? "manor" : k));
    const key = townKey({ town: { seed, era: settings.era, config: settings } });
    if (saved && townKey(saved) === key) return setTown(load(saved, modules));
    let kept: SaveFile | undefined;
    try { kept = fetchKept(localStorage, key); } catch { /* ignore */ }
    if (kept) return setTown(load(kept, modules));
    return setTown(fresh(seed, settings));
  }
  try {
    const saved = localStorage.getItem(STORE);
    if (saved) return setTown(load(JSON.parse(saved), modules));
  } catch { /* ignore */ }
  setTown(fresh(randomSeed()));
}

/** A new town opens on an ordinary market day, mid-morning. */
function fresh(seed: string, settings: Parameters<typeof generate>[1] = {}) {
  const t = generate(seed, settings);
  t.clock = { date: ordinaryDay(t), block: "forenoon" };
  return t;
}
start();
