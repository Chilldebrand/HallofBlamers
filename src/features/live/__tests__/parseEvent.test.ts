import { describe, expect, it } from "vitest";
import { parseLiveEventFrame } from "../parseEvent";

describe("parseLiveEventFrame", () => {
  it("parses a well-formed frame, mirroring formatSseFrame's envelope", () => {
    const raw = JSON.stringify({
      id: 42,
      eventType: "MatchupFinished",
      season: 2026,
      week: 3,
      occurredAt: 1700000000000,
      franchiseId: 5,
      matchupId: 9,
      playerId: null,
      payload: { homeScore: 100.1, awayScore: 90.2 },
    });
    expect(parseLiveEventFrame(raw)).toEqual({
      id: 42,
      eventType: "MatchupFinished",
      season: 2026,
      week: 3,
      occurredAt: 1700000000000,
      franchiseId: 5,
      matchupId: 9,
      playerId: null,
      payload: { homeScore: 100.1, awayScore: 90.2 },
    });
  });

  it("returns null for invalid JSON", () => {
    expect(parseLiveEventFrame("{not json")).toBeNull();
  });

  it("returns null for a JSON value that isn't an object", () => {
    expect(parseLiveEventFrame("42")).toBeNull();
    expect(parseLiveEventFrame("null")).toBeNull();
  });

  it("returns null when required fields are missing or the wrong type", () => {
    expect(parseLiveEventFrame(JSON.stringify({ eventType: "MatchupFinished", occurredAt: 1 }))).toBeNull(); // no id
    expect(parseLiveEventFrame(JSON.stringify({ id: 1, occurredAt: 1 }))).toBeNull(); // no eventType
    expect(parseLiveEventFrame(JSON.stringify({ id: "1", eventType: "x", occurredAt: 1 }))).toBeNull(); // id wrong type
  });

  it("defaults nullable fields to null rather than undefined/fabricated", () => {
    const raw = JSON.stringify({ id: 1, eventType: "BeatdownOfWeek", occurredAt: 1700000000000 });
    expect(parseLiveEventFrame(raw)).toEqual({
      id: 1,
      eventType: "BeatdownOfWeek",
      season: null,
      week: null,
      occurredAt: 1700000000000,
      franchiseId: null,
      matchupId: null,
      playerId: null,
      payload: null,
    });
  });
});
