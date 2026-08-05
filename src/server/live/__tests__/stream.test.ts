import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { events, type NewEvent } from "../../db/schema";
import {
  createLiveEventStream,
  formatHeartbeatComment,
  formatSseFrame,
  SSE_POLL_BATCH_LIMIT,
  type IntervalHandle,
  type ScheduleInterval,
} from "../stream";

interface FakeHandle {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function fakeScheduler(): { scheduleInterval: ScheduleInterval; registered: FakeHandle[] } {
  const registered: FakeHandle[] = [];
  const scheduleInterval: ScheduleInterval = (fn, ms) => {
    const handle: FakeHandle = { fn, ms, cleared: false };
    registered.push(handle);
    const result: IntervalHandle = { clear: () => { handle.cleared = true; } };
    return result;
  };
  return { scheduleInterval, registered };
}

function baseEvent(overrides: Partial<NewEvent> & { dedupeKey: string }): NewEvent {
  return {
    eventType: "MatchupFinished",
    season: 2026,
    week: 1,
    occurredAt: new Date("2026-09-10T23:00:00Z"),
    detectedAt: new Date("2026-09-10T23:00:00Z"),
    franchiseId: null,
    matchupId: null,
    playerId: null,
    payloadJson: { foo: "bar" },
    ...overrides,
  };
}

/**
 * A CONTINUOUS background reader loop, started once per stream and kept running for the whole
 * test — never more than one `reader.read()` call outstanding at a time. This matters: racing an
 * individual `reader.read()` against a timeout (and abandoning it when the timeout wins) leaves a
 * DANGLING pending read that silently "steals" the next chunk a later, fresh `read()` call was
 * waiting for (reads are fulfilled in FIFO request order) — that bug is exactly what broke an
 * earlier version of this test file's "fresh connection" case. A single perpetual loop sidesteps
 * it entirely: there is only ever one outstanding read, so nothing can steal from it.
 */
function pumpReader(reader: ReadableStreamDefaultReader<Uint8Array>): { chunks: string[] } {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) chunks.push(decoder.decode(value));
      }
    } catch {
      // Reader errored/cancelled out from under the loop — stop pumping silently.
    }
  })();
  return { chunks };
}

/** Yields to the event loop long enough for the pump's currently-pending `read()` to resolve
 * against anything already enqueued (enqueue() itself is synchronous) and drains what arrived
 * since the last drain. A real macrotask wait (not just a microtask flush) so it reliably runs
 * after the reader's internal promise machinery settles. */
async function drain(pump: { chunks: string[] }, waitMs = 15): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return pump.chunks.splice(0, pump.chunks.length);
}

describe("formatSseFrame / formatHeartbeatComment", () => {
  it("formats id/event/data lines terminated by a blank line", () => {
    const frame = formatSseFrame({
      id: 42,
      eventType: "MatchupFinished",
      season: 2026,
      week: 3,
      occurredAt: new Date("2026-09-10T23:00:00.000Z"),
      detectedAt: new Date("2026-09-10T23:00:05.000Z"),
      franchiseId: 7,
      matchupId: 99,
      playerId: null,
      payloadJson: { winner: "home" },
      dedupeKey: "matchup_finished:99",
    });
    expect(frame).toBe(
      `id: 42\nevent: MatchupFinished\ndata: ${JSON.stringify({
        id: 42,
        eventType: "MatchupFinished",
        season: 2026,
        week: 3,
        occurredAt: new Date("2026-09-10T23:00:00.000Z").getTime(),
        franchiseId: 7,
        matchupId: 99,
        playerId: null,
        payload: { winner: "home" },
      })}\n\n`,
    );
  });

  it("formats the heartbeat as an SSE comment line, not a data event", () => {
    expect(formatHeartbeatComment()).toBe(`: heartbeat\n\n`);
  });
});

describe("createLiveEventStream", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-live-stream-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers the poll and heartbeat intervals at the configured (injectable) cadence", () => {
    const { scheduleInterval, registered } = fakeScheduler();
    const controller = new AbortController();

    createLiveEventStream(
      { db, scheduleInterval, pollIntervalMs: 111, heartbeatIntervalMs: 222 },
      { lastEventId: null, signal: controller.signal },
    );

    expect(registered).toHaveLength(2);
    expect(registered.map((r) => r.ms).sort((a, b) => a - b)).toEqual([111, 222]);
  });

  it("resumes from Last-Event-ID, emitting only events newer than it", async () => {
    const e1 = db.insert(events).values(baseEvent({ dedupeKey: "k1" })).returning().get();
    const e2 = db.insert(events).values(baseEvent({ dedupeKey: "k2" })).returning().get();
    const e3 = db.insert(events).values(baseEvent({ dedupeKey: "k3" })).returning().get();

    const { scheduleInterval, registered } = fakeScheduler();
    const controller = new AbortController();
    const stream = createLiveEventStream({ db, scheduleInterval }, { lastEventId: e1.id, signal: controller.signal });
    const pump = pumpReader(stream.getReader());
    const pollHandle = registered.find((r) => r.ms === 3000)!;

    pollHandle.fn(); // simulate one poll tick
    const chunks = await drain(pump);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain(`id: ${e2.id}`);
    expect(chunks[1]).toContain(`id: ${e3.id}`);
    expect(chunks.join("")).not.toContain(`id: ${e1.id}\n`);

    controller.abort();
  });

  it("a fresh connection (no Last-Event-ID) starts from 'now' — only events inserted AFTER the connection opened", async () => {
    db.insert(events).values(baseEvent({ dedupeKey: "old-1" })).run(); // pre-existing, must NOT be replayed

    const { scheduleInterval, registered } = fakeScheduler();
    const controller = new AbortController();
    const stream = createLiveEventStream({ db, scheduleInterval }, { lastEventId: null, signal: controller.signal });
    const pump = pumpReader(stream.getReader());
    const pollHandle = registered.find((r) => r.ms === 3000)!;

    pollHandle.fn(); // first poll: nothing new since connection opened
    expect(await drain(pump)).toEqual([]);

    const fresh = db.insert(events).values(baseEvent({ dedupeKey: "fresh-1" })).returning().get();
    pollHandle.fn(); // second poll: the newly-inserted row IS new
    const chunks = await drain(pump);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain(`id: ${fresh.id}`);

    controller.abort();
  });

  it("emits a heartbeat comment on its own injectable cadence, independent of the poll interval", async () => {
    const { scheduleInterval, registered } = fakeScheduler();
    const controller = new AbortController();
    const stream = createLiveEventStream({ db, scheduleInterval }, { lastEventId: null, signal: controller.signal });
    const pump = pumpReader(stream.getReader());

    const heartbeatHandle = registered.find((r) => r.ms === 25000)!;
    heartbeatHandle.fn();

    const chunks = await drain(pump);
    expect(chunks).toEqual([": heartbeat\n\n"]);

    controller.abort();
  });

  it("clears both intervals on client disconnect (abort signal) — no leaked intervals", () => {
    const { scheduleInterval, registered } = fakeScheduler();
    const controller = new AbortController();
    createLiveEventStream({ db, scheduleInterval }, { lastEventId: null, signal: controller.signal });

    expect(registered.every((r) => !r.cleared)).toBe(true);
    controller.abort();
    expect(registered.every((r) => r.cleared)).toBe(true);
  });

  it("clears both intervals when the stream itself is cancelled (consumer-initiated stop)", async () => {
    const { scheduleInterval, registered } = fakeScheduler();
    const controller = new AbortController();
    const stream = createLiveEventStream({ db, scheduleInterval }, { lastEventId: null, signal: controller.signal });

    expect(registered.every((r) => !r.cleared)).toBe(true);
    await stream.cancel();
    expect(registered.every((r) => r.cleared)).toBe(true);
  });

  it("is idempotent if both abort and cancel fire (no double-clear errors, no crash)", async () => {
    const { scheduleInterval } = fakeScheduler();
    const controller = new AbortController();
    const stream = createLiveEventStream({ db, scheduleInterval }, { lastEventId: null, signal: controller.signal });

    controller.abort();
    await expect(stream.cancel()).resolves.toBeUndefined();
  });

  it("caps a single poll at SSE_POLL_BATCH_LIMIT rows, delivering the remainder on the NEXT poll", async () => {
    const TOTAL = SSE_POLL_BATCH_LIMIT + 50;
    for (let i = 0; i < TOTAL; i++) {
      db.insert(events).values(baseEvent({ dedupeKey: `batch-${i}` })).run();
    }

    const { scheduleInterval, registered } = fakeScheduler();
    const controller = new AbortController();
    // lastEventId: 0 — resume from the very beginning, so ALL rows are "new".
    const stream = createLiveEventStream({ db, scheduleInterval }, { lastEventId: 0, signal: controller.signal });
    const pump = pumpReader(stream.getReader());
    const pollHandle = registered.find((r) => r.ms === 3000)!;

    pollHandle.fn();
    expect(await drain(pump, 50)).toHaveLength(SSE_POLL_BATCH_LIMIT);

    pollHandle.fn();
    expect(await drain(pump, 50)).toHaveLength(TOTAL - SSE_POLL_BATCH_LIMIT);

    controller.abort();
  });
});
