// Public entry point: make a town from a seed and settings.
import { Town } from "./core/town";
import type { Module, Settings } from "./core/types";
import { defaultModules } from "./modules";

export function generate(seed: string, settings: Partial<Settings> = {}, modules: Module[] = defaultModules): Town {
  return new Town({
    seed,
    settings: { base: "agricultural", pop: 200, era: "high_medieval", ...settings },
    modules,
  });
}

export { Town } from "./core/town";
export { defaultModules } from "./modules";
