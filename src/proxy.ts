import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ADMIN_REVEAL_COOKIE } from "@/features/admin/constants";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/server/auth/session";

/**
 * Optimistic, cookie-only session check (per the Next.js auth guide: Proxy
 * runs on every request, including prefetches, so it must stay fast and
 * avoid DB access). requireManager()/requireCommissioner() do the
 * authoritative, DB-backed check inside Server Components/Actions.
 *
 * The `matcher` below excludes /join/*, /login, and manifest/icon/static
 * assets, so this only ever runs for routes inside the (league) shell.
 */
/** Forwarded to the page render in place of the cookie itself — see the block below for why. */
export const ADMIN_REVEAL_HEADER = "x-admin-reveal-payload";

export async function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (!session) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Fix round 1, I3: /admin's one-time invite-link reveal banner reads this cookie during its OWN
  // render (a plain Server Component can't mutate cookies — see (league)/layout.tsx's docstring
  // for the read-side version of that same rule), so the page itself cannot delete it. Proxy runs
  // before that render and CAN mutate cookies... but NOT the way the first attempt at this fix
  // assumed: Next.js propagates a middleware cookie DELETE to the SAME request's downstream
  // render via its internal `x-middleware-set-cookie` header (confirmed empirically — the first
  // version of this fix made the banner never show at all, not just stop re-showing on refresh).
  // Deleting the cookie here would erase it before the page ever gets to read it.
  //
  // Fix: read the cookie's raw value here and forward it to the page via an ordinary REQUEST
  // header instead (headers set via `NextResponse.next({ request: { headers } })` reach the
  // downstream render the same way any other request header does — no cookie-specific
  // propagation quirk). The cookie itself still gets deleted on the OUTGOING response, so the
  // browser won't send it on the NEXT request — that's what actually makes a refresh not
  // re-show the banner. Scoped to literally "/admin" (not every route this proxy matches) so
  // visiting anywhere else between an action's redirect and the commissioner actually loading
  // /admin doesn't burn the reveal early.
  if (request.nextUrl.pathname === "/admin") {
    const rawReveal = request.cookies.get(ADMIN_REVEAL_COOKIE)?.value;
    if (rawReveal !== undefined) {
      const forwardedHeaders = new Headers(request.headers);
      forwardedHeaders.set(ADMIN_REVEAL_HEADER, rawReveal);
      const response = NextResponse.next({ request: { headers: forwardedHeaders } });
      response.cookies.delete(ADMIN_REVEAL_COOKIE);
      return response;
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|manifest.json|icon|apple-icon|join|login).*)",
  ],
};
