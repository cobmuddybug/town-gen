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
