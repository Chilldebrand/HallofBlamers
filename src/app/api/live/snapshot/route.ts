import { getSessionManager } from "@/server/auth/guard";
import { getLiveSnapshot } from "@/server/queries/live";

/**
 * Snapshot fallback (Task 25). `GET /api/live/snapshot` — JSON of the current week's matchup
 * scores plus the latest recorded `events.id`, for a client's initial paint before subscribing to
 * `/api/live` (pass the returned `lastEventId` straight through as `Last-Event-ID`) or as a plain
 * polling fallback when holding an EventSource open isn't viable. See `../route.ts`'s docstring
 * for why this route needs its own auth check (`/api/*` is excluded from proxy.ts's gating).
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const manager = await getSessionManager();
  if (!manager) {
    return new Response("Unauthorized", { status: 401 });
  }

  const snapshot = getLiveSnapshot();
  return Response.json(snapshot);
}
