import Link from "next/link";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { SectionLabel } from "@/components/broadcast/SectionLabel";
import { FranchiseName, type FranchiseNameFlags } from "@/components/league/FranchiseName";
import { cn } from "@/components/ui/cn";
import { formatWLT } from "@/components/history/format";
import { getDb } from "@/server/db/client";
import { requireManager } from "@/server/auth/guard";
import { getIdentityFlags, resolveFranchiseFlags } from "@/server/queries/identity";
import { getActiveH2HMatrix, getHistoricalH2H, type H2HAdvantage } from "@/server/queries/h2h";

const ADVANTAGE_CLASSES: Record<H2HAdvantage, string> = {
  leading: "bg-sheet-raised text-ink font-semibold",
  trailing: "text-muted",
  even: "text-muted italic",
};

/** Column headers are ~90px and truncated (up to a dozen franchises across) — full FranchiseName
 * (belt mark + SACKO badge + YOU tag) would overflow almost every one of them, so this axis only
 * carries the identity NAME COLOR (README's "Dense per-game tables" exemption: gold/tarnish
 * dilutes when applied to every cell of a long table; the row axis below still gets the full
 * treatment, matching Standings' FranchiseCell). Fix round 1, finding 4. */
function identityTextColor(flags: FranchiseNameFlags): string | undefined {
  return flags.isChampion ? "text-gold-ink" : flags.isSacko ? "text-tarnish-ink" : undefined;
}

export default async function H2HPage() {
  const manager = await requireManager();
  const identityFlags = getIdentityFlags(getDb(), manager.id);
  const matrix = getActiveH2HMatrix();
  const historical = getHistoricalH2H();

  return (
    <div className="flex flex-col gap-10">
      <PageHeader eyebrow="History" title="Head-to-Head" />

      <section className="flex flex-col gap-4">
        <p className="text-[15px] text-muted">Each row is that franchise&apos;s record against the column. Tap a cell for the full breakdown.</p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b-2 border-ink text-left text-muted">
                <th className="display sticky left-0 z-20 bg-sheet px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Franchise</th>
                {matrix.franchises.map((f) => (
                  <th
                    key={f.id}
                    title={f.name}
                    className={cn(
                      "display max-w-[90px] truncate px-2 py-2 text-center text-[10px] font-normal tracking-[0.14em]",
                      identityTextColor(resolveFranchiseFlags(identityFlags, f.id)),
                    )}
                  >
                    {f.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((row) => {
                const franchise = matrix.franchises.find((f) => f.id === row.franchiseId)!;
                const rowFlags = resolveFranchiseFlags(identityFlags, franchise.id);
                return (
                  <tr key={row.franchiseId} className="border-b border-line-sheet last:border-0">
                    <td title={franchise.name} className="sticky left-0 z-10 max-w-[160px] truncate bg-sheet px-3 py-2 text-ink">
                      <Link href={`/franchises/${franchise.id}`} className="hover:underline">
                        <FranchiseName franchise={{ id: franchise.id, name: franchise.name, ...rowFlags }} size="row" surfaceBehind="var(--color-sheet)" />
                      </Link>
                    </td>
                    {matrix.franchises.map((col) => {
                      if (col.id === row.franchiseId) {
                        return (
                          <td key={col.id} className="px-2 py-2 text-center tabular-nums text-line-sheet-strong">
                            —
                          </td>
                        );
                      }
                      const cell = row.cells[col.id];
                      if (!cell) {
                        return (
                          <td key={col.id} className="px-2 py-2 text-center tabular-nums text-muted">
                            —
                          </td>
                        );
                      }
                      const lo = Math.min(row.franchiseId, col.id);
                      const hi = Math.max(row.franchiseId, col.id);
                      return (
                        <td key={col.id} className="p-0 text-center">
                          <Link href={`/h2h/${lo}/${hi}`} className={`block px-2 py-2 tabular-nums transition-colors hover:bg-sheet-raised ${ADVANTAGE_CLASSES[cell.advantage]}`}>
                            {formatWLT(cell.wins, cell.losses, cell.ties)}
                          </Link>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {historical.length > 0 ? (
        <section className="flex flex-col gap-4">
          <SectionLabel>Historical — Departed Franchises</SectionLabel>
          <div className="flex flex-col gap-2">
            {historical.map((group) => (
              <details key={group.franchiseId} className="group border border-line-sheet bg-sheet">
                <summary className="display cursor-pointer list-none px-4 py-3 text-[14px] tracking-wide text-ink marker:content-none">
                  <span className="mr-2 inline-block transition-transform group-open:rotate-90">›</span>
                  <FranchiseName
                    franchise={{ id: group.franchiseId, name: group.franchiseName, ...resolveFranchiseFlags(identityFlags, group.franchiseId) }}
                    size="row"
                    surfaceBehind="var(--color-sheet)"
                    className="inline-flex"
                  />
                  <span className="ml-2 text-xs text-muted">({group.opponents.length} opponents)</span>
                </summary>
                <ul className="flex flex-col border-t border-line-sheet">
                  {group.opponents.map((o) => {
                    const lo = Math.min(group.franchiseId, o.opponentId);
                    const hi = Math.max(group.franchiseId, o.opponentId);
                    return (
                      <li key={o.opponentId} className="border-b border-line-sheet-soft px-4 py-2 last:border-0">
                        <Link href={`/h2h/${lo}/${hi}`} className="flex items-center justify-between gap-4 hover:underline">
                          <FranchiseName
                            franchise={{ id: o.opponentId, name: o.opponentName, ...resolveFranchiseFlags(identityFlags, o.opponentId) }}
                            size="row"
                            surfaceBehind="var(--color-sheet)"
                          />
                          <span className="tabular-nums text-muted">{formatWLT(o.wins, o.losses, o.ties)}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </details>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
