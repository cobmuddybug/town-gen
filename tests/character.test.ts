import { describe, expect, test } from "vitest";
import { generate, defaultModules } from "../src/town-gen";
import { withEdit, withReroll } from "../src/core/save";
import { whereabouts } from "../src/modules/routines";
import { secretsOf } from "../src/modules/gossip";
import { addDays, type Block } from "../src/core/calendar";

const KEYS = ["want", "fear", "speech", "habit", "knack", "strangers", "faith", "health", "letters", "tongues"];

describe("character", () => {
  test("adults get the lot, and pronouns agree", () => {
    const t = generate("char-a", { pop: 3000 });
    t.resolveAll();
    const adults = t.allEntities().filter((e) => e.type === "person" && e.get<number>("age") >= 18);
    expect(adults.length).toBeGreaterThan(100);
    for (const p of adults.slice(0, 300)) {
      for (const k of KEYS) expect(p.get(`character.${k}`), `${p.address} ${k}`).toBeTruthy();
      const text = KEYS.map((k) => p.get<string>(`character.${k}`)).join(" ");
      expect(text).not.toMatch(/\{\w+\}/);
      if (p.get("sex") === "f") expect(text).not.toMatch(/\b(he|his|him|himself)\b/);
      else expect(text).not.toMatch(/\b(she|her|herself)\b/);
      expect(text).not.toMatch(/\b(he|she) (are|have|do|go|keep|know|say|think|check|sleep|talk|walk|come|die|grow)\b/);
    }
  });

  test("children get children's lines; clergy read Latin", () => {
    const t = generate("char-b", { pop: 9000 });
    t.resolveAll();
    const kids = t.allEntities().filter((e) => e.type === "person" && e.get<number>("age") < 10 && e.get<number>("age") >= 7);
    for (const k of kids.slice(0, 200)) expect(k.get<string>("character.faith") ?? "").not.toMatch(/tithe|drink|ale/);
    const clergy = t.allEntities().filter((e) => e.type === "person" && e.get("role") === "cleric");
    expect(clergy.length).toBeGreaterThan(0);
    for (const c of clergy) expect(c.get("character.letters")).toMatch(/Latin/);
  });

  test("character fields reroll and edit like any other", () => {
    const t = generate("char-c");
    t.resolveAll();
    const p = t.allEntities().find((e) => e.type === "person" && e.get<number>("age") > 20)!;
    const before = p.get("character.want");
    const edited = withEdit(t, defaultModules, p.address, "character.want", "to be left alone");
    expect(edited.get(p.address).get("character.want")).toBe("to be left alone");
    let moved = false;
    let cur = t;
    for (let i = 0; i < 6 && !moved; i++) { cur = withReroll(cur, defaultModules, p.address, "character.want"); moved = cur.get(p.address).get("character.want") !== before; }
    expect(moved).toBe(true);
    // Nothing owned by other modules moves.
    expect(cur.get(p.address).get("given")).toBe(p.get("given"));
  });

  test("everyone in a secret holds it; talk reaches others", () => {
    const t = generate("char-d", { pop: 2000 });
    t.society();
    const secret = t.edges().find((e) => e.knownBy !== "public" && e.from.includes("/building:") && e.to.includes("/building:"))!;
    expect(secret).toBeDefined();
    const holder = (secret.knownBy as string[])[0];
    expect(secretsOf(t, holder, "1203-01-02", "forenoon").some((s) => s.edge.id === secret.id && s.how === "kept")).toBe(true);
  });
});

describe("errands and visits", () => {
  test("people shop at real shops and visit people they know", () => {
    const t = generate("char-e", { pop: 5000 });
    t.resolveAll();
    t.society();
    const people = t.allEntities().filter((e) => e.type === "person" && e.address.includes("/building:"));
    let shops = 0, visits = 0;
    for (let d = 0; d < 6; d++) {
      const date = addDays("1203-10-06", d);
      for (const block of ["forenoon", "afternoon", "evening"] as Block[]) for (const p of people.slice(0, 1500)) {
        const w = whereabouts(t, p.address, date, block);
        if (/^(buying|sent to the shop|getting boots|taking (a|the)|turning over|choosing cloth|being shaved|waiting while|ordering wine)/.test(w.doing)) {
          shops++;
          expect(w.where.includes("/building:") || w.where === "place:market").toBe(true);
        }
        const m = w.doing.match(/^(?:round at|at|sitting up with|calling on|visiting|walking out with) ([A-Z][\w ]+?)(?:'s|,| putting|$)/);
        if (m && /round at|sitting up|calling on|visiting|walking out|sharing a jug/.test(w.doing)) {
          visits++;
          expect(w.where).not.toBe(t.parentOf(t.parentOf(p.address)!));
        }
      }
    }
    expect(shops).toBeGreaterThan(50);
    expect(visits).toBeGreaterThan(50);
  });

  test("whereabouts stay a pure function of person, date and block", () => {
    const a = generate("char-f", { pop: 800 }), b = generate("char-f", { pop: 800 });
    const ps = a.allEntities().filter((e) => e.type === "person" && e.address.includes("/building:")).slice(0, 200).map((e) => e.address);
    for (const p of ps) for (const block of ["forenoon", "evening"] as Block[]) expect(whereabouts(b, p, "1203-10-07", block)).toEqual(whereabouts(a, p, "1203-10-07", block));
  });
});
