import Link from "next/link";

/**
 * Renders whenever notFound() is thrown from a page under (league) — e.g. an
 * unknown franchise/season/matchup id. Still wrapped by (league)/layout.tsx
 * (TopNav/SeasonTicker/BottomTabBar), since the layout has already rendered by
 * the time a child page calls notFound().
 *
 * Fix round 1, finding 8: this used to render `<PageHeader eyebrow="404" title="Not Found" />`
 * inside a `text-center` wrapper, on the (wrong) assumption that `text-center` would center it.
 * PageHeader's own root is `flex ... justify-between` — with no `right` prop, that's a SINGLE
 * flex child, and `justify-between` with one item resolves to flex-start (left), not centered;
 * `text-center` on an ancestor doesn't fix that because the eyebrow/title block is positioned by
 * flexbox, not text-align. Rebuilt locally with `flex-col items-center text-center` instead of
 * reusing PageHeader, so the eyebrow+title actually center on this one two-line, no-right-slot page.
 */
export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <div className="flex w-full flex-col items-center border-b-2 border-ink pb-[18px]">
        <p className="display text-[12px] tracking-[0.26em] text-kelly">404</p>
        <h1 className="display mt-1.5 text-page-title tracking-normal text-kelly-deep">Not Found</h1>
      </div>
      <p className="max-w-md text-sm text-muted">That page doesn&apos;t exist — the id in the URL doesn&apos;t match anything in the archive.</p>
      <Link href="/" className="display border border-line-sheet-strong px-4 py-2 text-xs tracking-[0.12em] text-ink hover:border-ink">
        Back to Home
      </Link>
    </div>
  );
}
