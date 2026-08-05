import Link from "next/link";

/**
 * ROOT-level not-found (Fix round 1, finding 9). `(league)/not-found.tsx` only renders when
 * `notFound()` is thrown from WITHIN a matched route under that layout (e.g. an unknown
 * franchise/season/matchup id) — Next.js walks up from the segment that threw it. A genuinely
 * mistyped top-level URL (the common case — it never enters the (league) tree at all) instead
 * falls through to Next's own unstyled default 404 unless a root `not-found.tsx` exists here.
 *
 * Renders OUTSIDE (league)/layout.tsx — no TopNav/SeasonTicker/chrome, no `requireManager()`
 * context — same self-contained, body's-own-`bg-bg`-alias constraint as (league)/error.tsx and
 * /login (see globals.css's file-header comment on why those two routes get no sheet wrapper).
 *
 * Copy is deliberately NOT identical to (league)/not-found.tsx's: that page's "the id in the URL
 * doesn't match anything in the archive" describes a resolved-but-invalid resource id, which isn't
 * an accurate description of a plain mistyped address (no "id" was ever looked up here).
 */
export default function RootNotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="flex w-full flex-col items-center border-b-2 border-ink pb-[18px]">
        <p className="display text-[12px] tracking-[0.26em] text-kelly">404</p>
        <h1 className="display mt-1.5 text-page-title tracking-normal text-kelly-deep">Not Found</h1>
      </div>
      <p className="max-w-md text-sm text-muted">That page doesn&apos;t exist — check the address, or head back home.</p>
      <Link href="/" className="display border border-line-sheet-strong px-4 py-2 text-xs tracking-[0.12em] text-ink hover:border-ink">
        Back to Home
      </Link>
    </div>
  );
}
