import Link from "next/link";
import { FranchiseName } from "@/components/league/FranchiseName";
import { cn } from "@/components/ui/cn";
import { requireManager } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { getIdentityFlags, resolveFranchiseFlags } from "@/server/queries/identity";
import { getTransactionCenter, type TransactionCenterScope, type TransactionCenterTrade } from "@/server/queries/transactions";
import { TransactionHeaderRow, WAIVER_COLUMNS } from "./columns";

const WAIVER_GRID = "grid-cols-[1.1fr_1fr_78px_66px_66px_88px_88px]";

function resolveScope(value: string | undefined, seasons: number[]): TransactionCenterScope {
  if (value === "career" || value === undefined) return "career";
  const season = Number(value);
  return seasons.includes(season) ? season : "career";
}

function seasonHref(scope: TransactionCenterScope): string {
  return `/transactions?season=${scope}`;
}

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<{ season?: string }> }) {
  const manager = await requireManager();
  const params = await searchParams;
  const db = getDb();
  const career = getTransactionCenter("career", db);
  const scope = resolveScope(params.season, career.seasons);
  const model = scope === "career" ? career : getTransactionCenter(scope, db);
  const flags = getIdentityFlags(db, manager.id);

  return (
    <div className="flex flex-col gap-7">
      <header className="border-b-2 border-ink pb-[18px]">
        <div className="display text-[12px] tracking-[0.26em] text-kelly">League archive</div>
        <h1 className="display mt-1.5 text-page-title tracking-normal text-kelly-deep">Transaction Center</h1>
        <p className="mt-3 max-w-3xl text-[15px] leading-6 text-muted">
          Waiver value and trade outcomes are calculated only from this league&apos;s saved ESPN transactions and weekly rosters. Missing history stays missing.
        </p>
      </header>

      <nav aria-label="Transaction season" className="flex flex-wrap gap-2">
        <Link href={seasonHref("career")} className={pillClass(scope === "career")}>Career</Link>
        {model.seasons.map((season) => (
          <Link key={season} href={seasonHref(season)} className={pillClass(scope === season)}>{season}</Link>
        ))}
      </nav>

      {model.notices.map((notice) => (
        <p key={notice} className="rounded-md border border-line-sheet-strong bg-sheet-raised px-4 py-3 text-sm text-muted">{notice}</p>
      ))}

      <section className="flex flex-col gap-3">
        <h2 className="display text-[22px] text-ink">Waiver and free-agent value</h2>
        {model.waivers.length === 0 ? (
          <p className="text-sm text-muted">No recoverable waiver or free-agent acquisitions are stored for this scope.</p>
        ) : (
          <div role="table" className="overflow-x-auto">
            <div className="min-w-[790px]">
              <TransactionHeaderRow columns={WAIVER_COLUMNS} grid={WAIVER_GRID} />
              {model.waivers.map((row) => (
                <div key={`${row.transactionId}:${row.teamSeasonId}:${row.playerId}`} role="row" className={cn("grid items-center border-b border-line-sheet py-3", WAIVER_GRID)}>
                  <span role="cell" className="truncate pr-3 text-sm font-semibold text-ink">{row.playerName}</span>
                  <span role="cell" className="min-w-0 pr-3">
                    <Link href={`/franchises/${row.franchiseId}`} className="hover:underline">
                      <FranchiseName franchise={{ id: row.franchiseId, name: row.franchiseName, ...resolveFranchiseFlags(flags, row.franchiseId) }} size="row" />
                    </Link>
                  </span>
                  <span role="cell" className="text-right text-sm tabular-nums text-muted">{row.season} W{row.acquiredWeek}</span>
                  <span role="cell" className="text-right text-sm tabular-nums text-muted">{row.type === "freeagent" && !row.bidAmount ? "Free" : `$${row.bidAmount ?? 0}`}</span>
                  <span role="cell" className="text-right text-sm tabular-nums text-ink">{row.startsMade}</span>
                  <span role="cell" className="text-right text-sm font-semibold tabular-nums text-ink">{row.starterPoints.toFixed(1)}</span>
                  <span role="cell" className="text-right text-sm tabular-nums text-muted">{row.pointsPerFaab === null ? "—" : row.pointsPerFaab.toFixed(1)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="display text-[22px] text-ink">Trades</h2>
        {model.trades.length === 0 ? (
          <p className="text-sm text-muted">No trades with recoverable player detail are stored for this scope.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {model.trades.map((trade) => <TradeCard key={trade.transactionId} trade={trade} flags={flags} />)}
          </div>
        )}
      </section>
    </div>
  );
}

function pillClass(active: boolean): string {
  return cn(
    "display rounded-full border px-3.5 py-1.5 text-[13px] tracking-[0.1em]",
    active ? "border-kelly-deep bg-kelly-deep font-bold text-sheet" : "border-line-sheet-strong text-muted hover:text-ink",
  );
}

export function TradeCard({ trade, flags }: { trade: TransactionCenterTrade; flags: ReturnType<typeof getIdentityFlags> }) {
  const isRecovered = trade.dataQuality === "recovered_incomplete";
  return (
    <article data-quality={isRecovered ? "recovered-incomplete" : "espn-confirmed"} className="rounded-md border border-line-sheet-strong p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
        <span>{trade.season} · Week {trade.tradeWeek}{trade.sides.length > 2 ? ` · ${trade.sides.length}-team trade` : ""}</span>
        {isRecovered ? (
          <span className="rounded-full border border-line-sheet-strong px-2 py-1 text-[10px] tracking-[0.12em] uppercase">Recovered · incomplete detail possible</span>
        ) : trade.marginPoints === null ? null : trade.marginPoints === 0 ? (
          <span>Even by subsequent starter points</span>
        ) : (
          <span>{trade.marginPoints.toFixed(1)} starter-point margin</span>
        )}
      </div>
      {isRecovered ? <p className="mb-3 text-xs leading-5 text-muted">Reconstructed from local before-and-after rosters. Participant names and missing pieces are never inferred.</p> : null}
      <div className={cn("grid gap-3", trade.sides.length > 2 ? "md:grid-cols-3" : "md:grid-cols-2")}>
        {trade.sides.map((side) => (
          <section key={side.franchiseId} className="rounded-md bg-sheet-raised p-3">
            <Link href={`/franchises/${side.franchiseId}`} className="hover:underline">
              <FranchiseName franchise={{ id: side.franchiseId, name: side.franchiseName, ...resolveFranchiseFlags(flags, side.franchiseId) }} size="inline" />
            </Link>
            <p className="mt-1 text-sm font-semibold tabular-nums text-ink">{side.totalStarterPoints.toFixed(1)} starter pts</p>
            <ul className="mt-2 flex flex-col gap-1 text-sm text-muted">
              {side.received.map((player) => <li key={player.playerId}>{player.playerName} · {player.starterPoints.toFixed(1)} pts</li>)}
            </ul>
          </section>
        ))}
      </div>
      {trade.sides.length !== 2 ? <p className="mt-3 text-xs text-muted">No winner is assigned to a multi-team or incomplete transaction.</p> : null}
    </article>
  );
}
