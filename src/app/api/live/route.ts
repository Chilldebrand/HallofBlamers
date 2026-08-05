import { getSessionManager } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { createLiveEventStream, realScheduleInterval } from "@/server/live/stream";

/**
 * SSE live event stream (Task 25). `GET /api/live` — streams `events` rows as Server-Sent
 * Events: `Last-Event-ID` resume, a 3s in-process poll, a 25s `: heartbeat` comment (well under
 * Cloudflare's ~100s idle-connection kill), and cleanup on client disconnect — the actual
 * poll/heartbeat/resume/cleanup logic lives in `src/server/live/stream.ts` (unit-tested there;
 * this route is intentionally thin wiring, same split `worker/index.ts` uses for its ticks).
 *
 * AUTH — VERIFIED, not assumed: `src/proxy.ts`'s `config.matcher` explicitly excludes the whole
 * `/api/*` prefix (see that file), so nothing gates this route before it runs — unlike every page
 * inside the `(league)` shell, which proxy.ts redirects to `/login` on a missing/invalid session
 * BEFORE the page ever renders. Left ungated, this route would stream freely to anyone who can
 * reach the tunnel. It therefore does its OWN DB-backed session check via `getSessionManager()`
 * (`src/server/auth/guard.ts`) and returns a plain 401 for no/invalid session. A `redirect()`
 * (what every page-level guard does, `requireManager`/`requireCommissioner`) would be WRONG here:
 * it's the right response for a browser navigation, not for a non-navigational
 * `EventSource`/`fetch` caller — `getSessionManager()` exists specifically to give routes like
 * this one a redirect-free auth check.
 *
 * EventSource + auth interaction — VERIFIED: `EventSource` cannot set custom request headers (a
 * genuine browser platform limitation — there is no `EventSourceInit.headers`), so any
 * header-based auth scheme (bearer tokens, etc.) would be unusable from a real browser here. It
 * DOES send cookies automatically on a same-origin request, exactly like a plain `<img>` tag or a
 * default-credentials `fetch` — which is exactly what makes the existing httpOnly `wbb_session`
 * cookie work with zero extra plumbing; no live-specific auth mechanism was needed or added.
 *
 * `Last-Event-ID` resume — VERIFIED: a browser's `EventSource` automatically sends the
 * `Last-Event-ID` header on its OWN reconnect attempts (after a dropped connection that had
 * previously received `id:` lines) — this route reads that header when present. Manual/curl
 * testing can set it explicitly (`-H "Last-Event-ID: 5"`) to exercise the exact same resume path.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const manager = await getSessionManager();
  if (!manager) {
    return new Response("Unauthorized", { status: 401 });
  }

  const lastEventIdHeader = request.headers.get("last-event-id");
  const lastEventId = lastEventIdHeader !== null && /^\d+$/.test(lastEventIdHeader) ? Number(lastEventIdHeader) : null;

  const stream = createLiveEventStream(
    { db: getDb(), scheduleInterval: realScheduleInterval },
    { lastEventId, signal: request.signal },
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disables response buffering on nginx-family proxies sitting in front of the app; harmless
      // (ignored) behind the Cloudflare Tunnel setup this repo actually deploys with.
      "X-Accel-Buffering": "no",
    },
  });
}
