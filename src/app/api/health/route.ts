import { getHealthStatus, type HealthStatus } from "@/server/queries/health";

/**
 * Unauthenticated health check (Task 15) — deliberately outside `(league)`,
 * so proxy.ts's matcher (which already excludes the whole `/api/*` prefix)
 * never gates it behind a session. Hit by the `web` service's Docker
 * healthcheck and `ops/status.sh`.
 *
 * Checks the DB opens (a failed `getHealthStatus()` call below means it
 * doesn't) and reports last-sync age against a warn threshold. No secrets in
 * the response — just sync/build bookkeeping, nothing from `app_settings`
 * or `.env`. Always evaluated fresh (GET route handlers default to dynamic
 * as of Next 15+, but this is spelled out explicitly since a cached health
 * check would be worse than useless).
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const status = getHealthStatus();
    return Response.json(status, { status: 200 });
  } catch (err) {
    // Full error (which can include filesystem paths) goes to the container's own logs
    // (`ops/logs.sh`) only — the response itself stays generic since this endpoint is reachable
    // over the public tunnel, unauthenticated.
    console.error("[/api/health] database check failed:", err);
    const failure: HealthStatus = { ok: false, lastSync: null, buildId: null };
    return Response.json(failure, { status: 503 });
  }
}
