import { entriesFromComments, recordMarker, renderMarker } from "#conventions.js";
import type { Marker, TrackerComment } from "#namespace.js";

const BOT = "landrace-bot";
const posted = (body: string, login = BOT): TrackerComment =>
  ({ id: 1, body, created_at: "2026-01-01T00:00:00.000Z", user: { login } });
const readBack = (m: Marker, login = BOT) => entriesFromComments([posted(`x${renderMarker(m)}`, login)], BOT)[0];

/*
 * One marker for every tracker. The GitHub hook and the in-memory tracker
 * each built their own, and had already drifted — the in-memory one dropped
 * the session — so a field the engine now routes on would have reached the
 * engine from one tracker and not the other.
 */
describe("the marker a record effect stamps", () => {
  it("carries a judge's goto on its own output record, and reads it back beside the value", () => {
    const m = recordMarker({
      type: "tracker.comment", kind: "output", stage: "triage", round: 2, marker: "intent:2",
      output: { intent: "goto-build" }, goto: "build",
    });
    expect(readBack(m)).toMatchObject({ kind: "output", stage: "triage", round: 2, goto: "build", data: { intent: "goto-build" } });
  });

  it("carries the stage an entry record says the item left", () => {
    const m = recordMarker({ type: "tracker.comment", kind: "enter", stage: "triage", round: 1, marker: "enter:triage:1", from: "blocked" });
    expect(readBack(m)).toMatchObject({ kind: "enter", from: "blocked" });
  });

  it("carries the session, as the GitHub hook always has", () => {
    expect(recordMarker({ type: "tracker.comment", kind: "output", stage: "s", round: 1, session: "sid" })).toMatchObject({ session: "sid" });
  });

  it.each(["", "__proto__", 7])("reads back no goto and no from that is not a usable stage id (%j)", (bad) => {
    const e = readBack({ stage: "s", kind: "goto", round: 0, goto: bad, from: bad } as unknown as Marker);
    expect(e).not.toHaveProperty("goto");
    expect(e).not.toHaveProperty("from");
  });
});
