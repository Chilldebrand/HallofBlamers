import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { managers, type Manager } from "../db/schema";
import { SESSION_COOKIE_NAME, verifySessionToken } from "./session";

/**
 * Server-side "am I logged in" check for Server Components/Actions: reads
 * the session cookie, verifies the JWT, and loads the manager row from the
 * DB (the authoritative check — proxy.ts only does an optimistic,
 * cookie-only version of this). Redirects to /login on any failure.
 */
export async function requireManager(): Promise<Manager> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (!session) {
    redirect("/login");
  }

  const db = getDb();
  const manager = db.select().from(managers).where(eq(managers.id, session.managerId)).get();

  if (!manager) {
    redirect("/login");
  }

  return manager;
}

/**
 * DB-backed session check for Route Handlers (API routes) — returns `null` on any failure
 * instead of `redirect()`ing. `redirect()` (used by `requireManager` above) is right for a
 * Server Component/Action render, wrong for a `GET`/`fetch`/`EventSource` caller: proxy.ts's
 * matcher explicitly excludes the whole `/api/*` prefix (see proxy.ts's `config.matcher`), so
 * NOTHING gates an API route before it runs — the route itself must check auth, and a plain 401
 * Response is the correct "you're not logged in" signal for a non-navigational caller, not a
 * redirect. Used by `src/app/api/live/route.ts` and `.../live/snapshot/route.ts` (Task 25) — see
 * those routes' docstrings for the EventSource-specific verification (cookies flow automatically
 * on a same-origin request; EventSource cannot set custom headers, so a cookie-based session is
 * the only auth mechanism that actually works with it).
 */
export async function getSessionManager(): Promise<Manager | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySessionToken(token) : null;
  if (!session) return null;

  const db = getDb();
  const manager = db.select().from(managers).where(eq(managers.id, session.managerId)).get();
  return manager ?? null;
}

/** Pure guard, unit-testable without mocking next/headers or next/navigation. */
export function assertCommissioner(manager: Manager): void {
  if (manager.role !== "commissioner") {
    throw new Error(`Commissioner-only action: manager ${manager.id} has role "${manager.role}".`);
  }
}

export async function requireCommissioner(): Promise<Manager> {
  const manager = await requireManager();
  try {
    assertCommissioner(manager);
  } catch {
    redirect("/");
  }
  return manager;
}
