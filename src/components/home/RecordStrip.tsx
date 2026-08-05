import Link from "next/link";
import { cn } from "@/components/ui/cn";
import type { RecordStripCell } from "@/server/queries/homepage";

/** Home's footer record strip (README "2. Home"): four chrome cells, 1px dividers — a 2×2 grid on
 * phone (per the README's general "six-cell scoreboard becomes a 2-column grid" responsive rule,
 * applied here to this strip's own 4 cells), a single row on desktop. */
export function RecordStrip({ cells }: { cells: RecordStripCell[] }) {
  return (
    <div className="grid grid-cols-2 bg-chrome md:grid-cols-4">
      {cells.map((cell, i) => {
        const rightColOnPhone = i % 2 === 1;
        const lastOnDesktop = i === cells.length - 1;
        return (
          <Link
            key={cell.key}
            href="/records"
            className={cn(
              "border-line px-5 py-5 transition-colors hover:bg-chrome-raised/40 md:px-7",
              rightColOnPhone ? "border-r-0" : "border-r",
              lastOnDesktop ? "md:border-r-0" : "md:border-r",
              i >= 2 ? "border-t md:border-t-0" : undefined,
            )}
          >
            <div className="display text-[11px] tracking-[0.2em] text-muted-on-chrome">{cell.label}</div>
            <div className="display mt-1 text-[26px] tabular-nums text-ink-on-chrome md:text-[34px]">{cell.value}</div>
            <div className="mt-0.5 text-[13px] text-muted-on-chrome">
              {cell.franchiseName ?? "—"}
              {cell.season ? ` · ${cell.season}` : ""}
              {cell.week ? ` Wk ${cell.week}` : ""}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
