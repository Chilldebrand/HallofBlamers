/**
 * SSE stream construction for `GET /api/live` (Task 25). Deliberately separated from the route
 * handler itself (`src/app/api/live/route.ts`) so the polling/heartbeat/resume/cleanup logic is
 * unit-testable without a real Next.js server or real timers — same dependency-injection pattern
 * `run-tier.ts`/`worker/index.ts` use (`db`, `sleep` injected; production wires the real thing).
 *
 * Contract (per the brief):
 *   - Polls the `events` table in-process every `SSE_POLL_INTERVAL_MS` (3s) for rows newer than
 *     the current cursor, emitting one SSE frame per row with `id:`/`event:`/`data:`.
 *   - Sends a `: heartbeat` COMMENT line (not a data event — ignored by `EventSource.onmessage`)
 *     every `SSE_HEARTBEAT_INTERVAL_MS` (25s), well under Cloudflare's ~100s idle-connection kill.
 *   - Resumes from `Last-Event-ID` when the caller provides one (the route reads the real HTTP
 *     header; a fresh connection with none starts from "now" — only FUTURE events — since
 *     `/api/live/snapshot` is the documented fallback for a client's initial paint).
 *   - Cleans up both intervals (and closes the controller) exactly once, whether triggered by the
 *     request's abort signal (client disconnect) or the stream's own `cancel()` callback (a
 *     consumer-initiated stop) — whichever fires first; idempotent either way.
 */
import { asc, desc, gt } from "drizzle-orm";
import type { Db } from "../db/client";
import { events, type Event } from "../db/schema";

export const SSE_POLL_INTERVAL_MS = 3000;
export const SSE_HEARTBEAT_INTERVAL_MS = 25000;

/** Cap per poll so one huge backlog (a very stale Last-Event-ID, or a burst tick) can't build an
 * unbounded SSE write in one go — any remainder just goes out on the next poll instead. */
export const SSE_POLL_BATCH_LIMIT = 200;

export interface IntervalHandle {
  clear: () => void;
}

/** Injected timer so tests can fire ticks synchronously instead of waiting on real timers.
 * Production wires `realScheduleInterval` (a thin `setInterval`/`clearInterval` wrapper). */
export type ScheduleInterval = (fn: () => void, ms: number) => IntervalHandle;

export function realScheduleInterval(fn: () => void, ms: number): IntervalHandle {
  const id = setInterval(fn, ms);
  return { clear: () => clearInterval(id) };
}

export interface LiveStreamDeps {
  db: Db;
  scheduleInterval: ScheduleInterval;
  /** Defaults to `SSE_POLL_INTERVAL_MS`/`SSE_HEARTBEAT_INTERVAL_MS` — overridable for tests. */
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

export interface LiveStreamOptions {
  /** Parsed from the `Last-Event-ID` request header, or null for a fresh connection. */
  lastEventId: number | null;
  signal: AbortSignal;
}

function queryEventsSince(db: Db, cursor: number, limit: number): Event[] {
  return db.select().from(events).where(gt(events.id, cursor)).orderBy(asc(events.id)).limit(limit).all();
}

function latestEventId(db: Db): number {
  const row = db.select({ id: events.id }).from(events).orderBy(desc(events.id)).limit(1).get();
  return row?.id ?? 0;
}

/** `id`/`event:` per the SSE wire format; `data:` is a single-line JSON envelope carrying every
 * field a ticker line needs (facts + names + numbers) WITHOUT the client issuing another query. */
export function formatSseFrame(event: Event): string {
  const data = {
    id: event.id,
    eventType: event.eventType,
    season: event.season,
    week: event.week,
    occurredAt: event.occurredAt.getTime(),
    franchiseId: event.franchiseId,
    matchupId: event.matchupId,
    playerId: event.playerId,
    payload: event.payloadJson,
  };
  return `id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatHeartbeatComment(): string {
  return `: heartbeat\n\n`;
}

/**
 * Builds the SSE response body for `/api/live`. Every poll/heartbeat tick and the eventual
 * cleanup are driven entirely through `deps`/`opts` — nothing here reaches for a real timer or a
 * real request, so a test can fire ticks and simulate disconnects deterministically.
 */
export function createLiveEventStream(deps: LiveStreamDeps, opts: LiveStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pollIntervalMs = deps.pollIntervalMs ?? SSE_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS;

  let cursor = opts.lastEventId ?? latestEventId(deps.db);
  let closed = false;
  let pollHandle: IntervalHandle | null = null;
  let heartbeatHandle: IntervalHandle | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  function safeEnqueue(chunk: string): void {
    if (closed || !controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(chunk));
    } catch {
      // Controller already closed/errored out from under us (a race with cleanup) — stop trying.
      closed = true;
    }
  }

  function cleanup(): void {
    if (closed) {
      // Even if a prior cleanup already ran, a handle registered AFTER that (shouldn't happen,
      // but keeps this function safe to call from multiple triggers in any order) still gets
      // cleared — no leaked intervals either way.
      pollHandle?.clear();
      heartbeatHandle?.clear();
      return;
    }
    closed = true;
    pollHandle?.clear();
    heartbeatHandle?.clear();
    try {
      controllerRef?.close();
    } catch {
      // Already closed by the runtime — fine.
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;

      if (opts.signal.aborted) {
        cleanup();
        return;
      }

      pollHandle = deps.scheduleInterval(() => {
        const rows = queryEventsSince(deps.db, cursor, SSE_POLL_BATCH_LIMIT);
        for (const row of rows) {
          safeEnqueue(formatSseFrame(row));
          cursor = row.id;
        }
      }, pollIntervalMs);

      heartbeatHandle = deps.scheduleInterval(() => {
        safeEnqueue(formatHeartbeatComment());
      }, heartbeatIntervalMs);

      opts.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      // Invoked when the consumer stops reading (e.g. the runtime tearing down the response) —
      // belt-and-suspenders alongside the abort-signal listener; `cleanup` is idempotent either
      // way, so whichever trigger fires first fully releases both intervals.
      cleanup();
    },
  });
}
