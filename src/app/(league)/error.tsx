"use client";

import Link from "next/link";

/**
 * Error boundaries must be Client Components (Next.js requirement) and wrap
 * OUTSIDE the segment's layout — so if (league)/layout.tsx itself is what
 * threw, TopNav/SeasonTicker won't be there to lean on. Kept deliberately
 * self-contained: plain Tailwind classes against the same design tokens
 * (globals.css is loaded app-wide regardless of which component rendered),
 * no dependency on the layout or any query function. Renders on bg-bg (the
 * legacy cream alias, not bg-frame) since there's no chrome shell around it
 * here to justify the darker frame tone.
 */
export default function LeagueError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg px-4 text-center">
      <p className="display text-[12px] tracking-[0.24em] text-muted">Something Went Wrong</p>
      <h1 className="display text-page-title tracking-normal text-kelly-deep">Hall of Blamers hit a snag</h1>
      <p className="max-w-md text-sm text-muted">
        This page failed to load. It&apos;s not you — try again, and if it keeps happening, let the commissioner know.
      </p>
      {error.digest ? <p className="text-xs tabular-nums text-muted">Ref: {error.digest}</p> : null}
      <div className="mt-2 flex gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="display border border-line-sheet-strong px-4 py-2 text-xs tracking-[0.12em] text-ink hover:border-ink"
        >
          Try Again
        </button>
        <Link href="/" className="display border border-line-sheet-strong px-4 py-2 text-xs tracking-[0.12em] text-ink hover:border-ink">
          Back to Home
        </Link>
      </div>
    </div>
  );
}
