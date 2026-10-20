import { major } from "./loader";
import { REROLL_KEY, Town, stableStringify } from "./town";
import type { Address } from "./address";
import type { Module, SaveFile } from "./types";

export function serialize(town: Town): string {
  return stableStringify(town.toSave()) + "\n";
}

export function load(save: SaveFile, modules: Module[]): Town {
  if (save.format !== 1) throw new Error(`unknown save format ${save.format}`);
  const town = new Town({
    seed: save.town.seed,
    settings: { ...save.town.config, era: save.town.era },
    modules,
    overlay: save.overlay,
    pinned: save.pinned,
    events: save.events,
    clock: save.clock,
  });
  for (const [id, v] of Object.entries(save.modules)) {
    const m = modules.find((x) => x.id === id);
    if (!m) town.warnings.push(`save used module ${id}@${v}, which isn't loaded`);
    else if (major(m.version) !== major(v)) {
      town.warnings.push(`${id} is ${m.version} but the save was made with ${v}; unpinned entities may differ`);
    }
  }
  return town;
}

/** Rebuild a town with one overlay change. Towns are cheap; edits regenerate. */
export function withEdit(town: Town, modules: Module[], address: Address, key: string, value: unknown): Town {
  const save = town.toSave();
  const o = (save.overlay[address] ??= {});
  if (value === undefined) delete o[key];
  else o[key] = value;
  if (Object.keys(o).length === 0) delete save.overlay[address];
  return load(save, modules);
}

/** Clear any edit on a field and draw it again from a fresh stream. */
export function withReroll(town: Town, modules: Module[], address: Address, key: string): Town {
  const save = town.toSave();
  const o = (save.overlay[address] ??= {});
  delete o[key];
  const r = ((o[REROLL_KEY] as Record<string, number>) ??= {});
  r[key] = (r[key] ?? 0) + 1;
  return load(save, modules);
}

export function withPin(town: Town, modules: Module[], address: Address, pinned: boolean): Town {
  const save = town.toSave();
  if (pinned) save.pinned[address] = town.pinSnapshot(address);
  else delete save.pinned[address];
  return load(save, modules);
}
