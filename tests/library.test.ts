import { describe, expect, test } from "vitest";
import { generate } from "../src/town-gen";
import { defaultModules } from "../src/town-gen";
import { withEdit } from "../src/core/save";
import { fetchKept, forget, keep, listKept, townKey } from "../src/ui/library";

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}

describe("your towns", () => {
  test("untouched towns are not kept; edited ones are, and survive a new seed", () => {
    const store = new MemoryStorage();
    const a = generate("lib-a");
    keep(store, a.toSave(), "A", 1);
    expect(listKept(store)).toEqual([]);

    const edited = withEdit(a, defaultModules, a.root, "enclosure", "ditch");
    keep(store, edited.toSave(), "A", 2);
    keep(store, generate("lib-b").toSave(), "B", 3);
    const kept = listKept(store);
    expect(kept.map((k) => k.name)).toEqual(["A"]);

    const back = fetchKept(store, kept[0].key)!;
    expect(back.overlay).toEqual(edited.toSave().overlay);
    expect(townKey(back)).toBe(townKey(a.toSave()));

    forget(store, kept[0].key);
    expect(listKept(store)).toEqual([]);
  });

  test("clearing the last edit drops the town from the library", () => {
    const store = new MemoryStorage();
    const a = generate("lib-c");
    const edited = withEdit(a, defaultModules, a.root, "enclosure", "ditch");
    keep(store, edited.toSave(), "C");
    keep(store, withEdit(edited, defaultModules, a.root, "enclosure", undefined).toSave(), "C");
    expect(listKept(store)).toEqual([]);
  });

  test("most recently touched first, damaged entries skipped", () => {
    const store = new MemoryStorage();
    for (const [seed, t] of [["lib-d", 5], ["lib-e", 9]] as const) {
      const x = generate(seed);
      keep(store, withEdit(x, defaultModules, x.root, "enclosure", "ditch").toSave(), seed, t);
    }
    store.setItem("town-gen:town:junk", "{not json");
    expect(listKept(store).map((k) => k.name)).toEqual(["lib-e", "lib-d"]);
  });
});
