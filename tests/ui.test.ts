import { describe, expect, test } from "vitest";
import { sizePreview, settingsFromForm } from "../src/ui/newtown";
import { History, isTypingTarget } from "../src/ui/history";

const form = (o: Record<string, string>) => (k: string) => o[k] ?? null;

describe("new town", () => {
  test("size preview follows LF p.72 bounds", () => {
    expect(sizePreview(200).label).toBe("hamlet");
    expect(sizePreview(700).label).toBe("village");
    expect(sizePreview(3000).label).toBe("market town");
    expect(sizePreview(30000).label).toBe("city");
    expect(sizePreview(3000).line).toMatch(/^A market town/);
  });

  test("a hamlet's settings carry no plan", () => {
    expect(settingsFromForm(form({ pop: "500", walls: "wall" })).settings.design).toBeUndefined();
    expect(settingsFromForm(form({ pop: "3000", walls: "wall" })).settings.design).toEqual({ walls: "wall" });
  });

  test("a big town is never manorial, and population is clamped", () => {
    expect(settingsFromForm(form({ pop: "9000", manorial: "on" })).settings.lordship).toBe("free");
    expect(settingsFromForm(form({ pop: "400", manorial: "on" })).settings.lordship).toBe("manorial");
    expect(settingsFromForm(form({ pop: "99999" })).settings.pop).toBe(30000);
    expect(settingsFromForm(form({ pop: "" })).settings.pop).toBe(200);
    expect(settingsFromForm(form({ seed: " oak-1 " })).seed).toBe("oak-1");
    expect(settingsFromForm(form({})).seed).toBeUndefined();
  });
});

describe("history", () => {
  test("goes back and forward and forgets the future on a new push", () => {
    const h = new History();
    h.push("a"); h.push("b"); h.push("c");
    expect(h.back()).toBe("b");
    expect(h.canForward).toBe(true);
    expect(h.forward()).toBe("c");
    expect(h.back()).toBe("b");
    h.push("d");
    expect(h.canForward).toBe(false);
    expect(h.back()).toBe("b");
  });

  test("pushing the current address again does nothing", () => {
    const h = new History();
    h.push("a"); h.push("a");
    expect(h.canBack).toBe(false);
  });

  test("prunes addresses that no longer exist", () => {
    const h = new History();
    h.push("a"); h.push("gone"); h.push("c");
    h.prune((x) => x !== "gone");
    expect(h.back()).toBe("a");
    expect(h.back()).toBeUndefined();
  });

  test("keeps at most max entries", () => {
    const h = new History(3);
    for (const x of ["a", "b", "c", "d"]) h.push(x);
    expect(h.back()).toBe("c");
    expect(h.back()).toBe("b");
    expect(h.back()).toBeUndefined();
  });

  test("typing targets", () => {
    const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as unknown as Element;
    expect(isTypingTarget(el("INPUT"))).toBe(true);
    expect(isTypingTarget(el("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(el("SELECT"))).toBe(true);
    expect(isTypingTarget(el("DIV", true))).toBe(true);
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

import { clockLabel, stepClock, townMenuHtml } from "../src/ui/topbar";
import { newTownHtml } from "../src/ui/newtown";

describe("top bar", () => {
  test("clock label is short weekday, day, month and the time of day", () => {
    expect(clockLabel("1203-10-01", "forenoon")).toBe("Wed 1 Oct · forenoon");
    expect(clockLabel("1203-10-01", "late_night")).toBe("Wed 1 Oct · late night");
  });

  test("stepping the clock wraps across days", () => {
    expect(stepClock("1203-10-01", "late_night", 1)).toEqual({ date: "1203-10-02", block: "morning" });
    expect(stepClock("1203-10-01", "morning", -1)).toEqual({ date: "1203-09-30", block: "late_night" });
    expect(stepClock("1203-10-01", "morning", 1)).toEqual({ date: "1203-10-01", block: "forenoon" });
  });

  test("the town menu offers file actions, and forgetting only for a kept town", () => {
    const kept = [{ key: "k1", name: "Ashby", pop: 200, base: "agricultural", updated: 0 }];
    const open = townMenuHtml(kept, "k1", "Ashby", false);
    expect(open).toContain("Download file");
    expect(open).toContain("Open file…");
    expect(open).toContain("Show book sources");
    expect(open).toContain("Forget my edits to Ashby…");
    expect(townMenuHtml(kept, "k2", "Brill", false)).not.toContain("Forget my edits");
  });

  test("the new town dialog has the plan, the preview and a build button", () => {
    const h = newTownHtml();
    for (const s of ['id="plan"', 'id="size-preview"', 'id="reroll-seed"', "Build town", "How many people?", 'name="walls"', 'name="crime"']) expect(h).toContain(s);
  });
});
