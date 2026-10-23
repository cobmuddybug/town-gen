import { test } from "vitest";
import { writeFileSync } from "node:fs";
import { generate } from "../src/town-gen";
import { setBlockedForTest } from "../src/modules/layout/grown";
import { clearLayoutCache } from "../src/modules/layout";
import { renderMap, MAP_STYLE } from "../src/ui/map";
test("look", () => {
  const forms = (process.env.FORMS ?? "river").split(",");
  setBlockedForTest(forms as never); clearLayoutCache();
  const t = generate(process.env.SEED ?? "blk-river", { pop: Number(process.env.POP ?? 3000), base: "agricultural", design: { layout: (process.env.LAYOUT ?? "river") as never } });
  writeFileSync("/tmp/claude-1000/-home-theseus-Work/6327eed3-d682-459d-b5cc-15f8598effad/scratchpad/look.html", `<!DOCTYPE html><html><head><style>${MAP_STYLE} body{margin:0;background:#efe8d6} svg{width:100%;height:auto}</style></head><body>${renderMap(t)}</body></html>`);
  setBlockedForTest([]); clearLayoutCache();
}, 600000);
