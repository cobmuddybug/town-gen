import { describe, expect, test } from "vitest";
import { generate, defaultModules } from "../src/town-gen";
import { load, serialize, withEvent, withoutEvent } from "../src/core/save";
import { centroid, type Poly } from "../src/modules/layout/geom";
import { reach, rumoursIn, hourOf } from "../src/modules/gossip";
import { encounter, jobBoard, nearestBuildingTo, report } from "../src/ui/party";
import { whoKnows } from "../src/ui/discover";
import { worked } from "../src/ui/library";

const pubOf = (t: ReturnType<typeof generate>) => t.children(t.root, "building").find((b) => /alehouse|tavern|inn/.test(b.get<string>("use")))!;

describe("the party", () => {
  test("the marker rides in the save without changing the town", () => {
    const t = generate("party-a", { pop: 600 });
    const plain = serialize(t);
    t.party = { at: [10, 20], name: "the Ravens" };
    const save = JSON.parse(serialize(t));
    expect(save.party).toEqual({ at: [10, 20], name: "the Ravens" });
    const back = load(save, defaultModules);
    expect(back.party).toEqual(t.party);
    // Everything but the marker is as it was.
    delete save.party;
    expect(JSON.stringify(save) + "\n").toBe(JSON.stringify(JSON.parse(plain)) + "\n");
  });

  test("the report finds the building they stand by, and who's in it", () => {
    const t = generate("party-b", { pop: 3000 });
    const pub = pubOf(t);
    const at = centroid(pub.get<Poly>("poly"));
    const r = report(t, at, "1203-10-07", "evening");
    expect(r.buildings[0].a).toBe(pub.address);
    expect(r.buildings[0].total).toBeGreaterThan(0);
    expect(r.where.some((x) => typeof x === "object")).toBe(true);
    // Pure: the same question gives the same answer.
    expect(report(generate("party-b", { pop: 3000 }), at, "1203-10-07", "evening").buildings).toEqual(r.buildings);
  });

  test("encounters are someone near, different on each roll, and repeatable", () => {
    const t = generate("party-c", { pop: 3000 });
    const at = centroid(pubOf(t).get<Poly>("poly"));
    const rolls = [1, 2, 3, 4, 5, 6].map((n) => encounter(t, at, "1203-10-07", "afternoon", n)!);
    expect(rolls.every(Boolean)).toBe(true);
    expect(new Set(rolls.map((e) => e.p)).size).toBeGreaterThan(1);
    expect(encounter(t, at, "1203-10-07", "afternoon", 3)).toEqual(rolls[2]);
    for (const e of rolls) expect(e.opener.length).toBeGreaterThan(3);
  });

  test("a deed spreads from where it was done, and can be taken back", () => {
    let t = generate("party-d", { pop: 2000 });
    t.party = { at: centroid(pubOf(t).get<Poly>("poly")), name: "the Ravens" };
    const at = nearestBuildingTo(t, t.party.at)!;
    t = withEvent(t, defaultModules, { kind: "deed", date: "1203-10-07", block: "forenoon", at, text: "started a fight at the alehouse." });
    expect(worked(t.toSave())).toBe(true);
    const deed = rumoursIn(t, 1203).find((r) => r.topic === "deed")!;
    expect(deed.texts[0]).toBe("the Ravens started a fight at the alehouse");
    expect(deed.origin).toBe(at);
    const early = reach(t, deed, hourOf("1203-10-07", "forenoon")).heard;
    const later = reach(t, deed, hourOf("1203-10-08", "evening")).heard;
    expect(later).toBeGreaterThan(early);
    expect(whoKnows(t, `rumour:${deed.id}`, "1203-10-08", "evening")?.knowers.length).toBeGreaterThan(0);
    // The third telling blames a local instead.
    expect(deed.texts[2]).toMatch(/not the Ravens/);
    const gone = withoutEvent(t, defaultModules, 0);
    expect(rumoursIn(gone, 1203).some((r) => r.topic === "deed")).toBe(false);
  });

  test("the job board offers work that patrons can pay for", () => {
    const t = generate("party-e", { pop: 4000 });
    const jobs = jobBoard(t, "1203-10-07");
    expect(jobs.length).toBeGreaterThan(5);
    for (const j of jobs) {
      expect(t.find(j.patron)).toBeTruthy();
      expect(j.pay).toBeGreaterThan(0);
      expect(t.get(j.at).type).toBe("building");
      if (j.target) expect(j.target).not.toBe(j.patron);
    }
    // Reads like a notice board: no kind of job crowds out the rest.
    const kinds = new Map<string, number>();
    for (const j of jobs) kinds.set(j.id.split("/")[0], (kinds.get(j.id.split("/")[0]) ?? 0) + 1);
    expect(Math.max(...kinds.values())).toBeLessThanOrEqual(6);
  });
});
