// The towns you have worked on, kept in localStorage so a new seed never throws one away.
// A town is kept once it differs from what its seed gives (edits, pins, notes); untouched
// towns are left out because the seed alone brings them back.
import type { Design, SaveFile } from "../core/types";

const PREFIX = "town-gen:town:";

export interface Kept {
  key: string;
  name: string;
  pop: number;
  base: string;
  updated: number;
}

/** The URL hash for a town: its seed and settings, which is also its key in the library. */
export function townKey(s: Pick<SaveFile, "town">): string {
  const t = s.town;
  const d = t.config.design ?? {};
  const plan = (Object.keys(d) as (keyof Design)[]).sort().map((k) => `&${k}=${k === "castle" ? (d[k] ? 1 : 0) : d[k]}`).join("");
  return `seed=${encodeURIComponent(t.seed)}&pop=${t.config.pop}&base=${t.config.base}${t.config.lordship === "manorial" ? "&manor=1" : ""}&era=${t.era}${plan}`;
}

/** The design choices in a URL hash or form, as settings (empty values mean "any"). */
export function designFrom(get: (k: string) => string | null): Design | undefined {
  const d: Design = {};
  const walls = get("walls"), gates = get("gates"), shape = get("shape"), castle = get("castle"), market = get("market"), suburbs = get("suburbs"), crime = get("crime");
  if (walls === "none" || walls === "palisade" || walls === "wall") d.walls = walls;
  if (gates && Number(gates) >= 2 && Number(gates) <= 6) d.gates = Math.round(Number(gates));
  if (shape === "round" || shape === "oval" || shape === "long") d.shape = shape;
  if (castle === "1" || castle === "0") d.castle = castle === "1";
  if (market === "small" || market === "large") d.market = market;
  if (suburbs === "few" || suburbs === "many") d.suburbs = suburbs;
  if (crime === "quiet" || crime === "usual" || crime === "rife") d.crime = crime;
  const layout = get("layout"), farBank = get("farBank");
  if (layout === "radial" || layout === "river") d.layout = layout;
  if (farBank === "village" || farBank === "bridgend" || farBank === "abbey" || farBank === "wharf") d.farBank = farBank;
  return Object.keys(d).length ? d : undefined;
}

/** Whether a save holds anything its seed wouldn't give back. */
export function worked(s: SaveFile): boolean {
  return Object.keys(s.overlay).length > 0 || Object.keys(s.pinned).length > 0 || s.events.length > 0;
}

export function keep(store: Storage, save: SaveFile, name: string, now = Date.now()) {
  const key = townKey(save);
  if (!worked(save)) {
    store.removeItem(PREFIX + key);
    return;
  }
  const entry = { name, updated: now, save };
  store.setItem(PREFIX + key, JSON.stringify(entry));
}

export function fetchKept(store: Storage, key: string): SaveFile | undefined {
  try {
    const raw = store.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as { save: SaveFile }).save : undefined;
  } catch {
    return undefined;
  }
}

export function forget(store: Storage, key: string) {
  store.removeItem(PREFIX + key);
}

/** Kept towns, most recently touched first. */
export function listKept(store: Storage): Kept[] {
  const out: Kept[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (!k?.startsWith(PREFIX)) continue;
    try {
      const e = JSON.parse(store.getItem(k)!) as { name: string; updated: number; save: SaveFile };
      out.push({ key: k.slice(PREFIX.length), name: e.name, pop: e.save.town.config.pop, base: e.save.town.config.base, updated: e.updated });
    } catch { /* a damaged entry is skipped, not fatal */ }
  }
  return out.sort((a, b) => b.updated - a.updated);
}
