import type { Module } from "./types";

export function major(version: string): string {
  return version.split(".")[0];
}

/** Topological sort on `requires`. Ties keep the given order, so load order is stable. */
export function loadOrder(modules: Module[]): Module[] {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const out: Module[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (m: Module, path: string[]) => {
    const s = state.get(m.id);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`module cycle: ${[...path, m.id].join(" -> ")}`);
    state.set(m.id, "visiting");
    for (const r of m.requires ?? []) {
      const dep = byId.get(r);
      if (!dep) throw new Error(`module ${m.id} requires missing module ${r}`);
      visit(dep, [...path, m.id]);
    }
    state.set(m.id, "done");
    out.push(m);
  };
  for (const m of modules) visit(m, []);
  return out;
}
