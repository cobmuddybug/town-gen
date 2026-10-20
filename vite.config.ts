import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { defineConfig, type Plugin } from "vitest/config";

// Content tables are YAML in the repo and plain JSON in the bundle, so the
// YAML parser is a build tool only and ships to nobody.
function yamlContent(): Plugin {
  return {
    name: "yaml-content",
    load(id) {
      if (!id.endsWith(".yaml")) return null;
      return `export default ${JSON.stringify(parse(readFileSync(id, "utf8")))};`;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [yamlContent()],
  test: { include: ["tests/**/*.test.ts", "src/**/*.test.ts", "tools/**/*.test.ts"] },
});
