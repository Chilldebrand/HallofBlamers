import Link from "next/link";
import { Notice } from "@/components/broadcast/FormControls";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { SectionLabel } from "@/components/broadcast/SectionLabel";
import { requireCommissioner } from "@/server/auth/guard";
import { generateRecapAction } from "@/features/recaps/actions";
import { getCompletedWeekOptions, getRecapAdminList, hasAnthropicApiKey } from "@/features/recaps/queries";
import { RECAP_STYLES } from "@/server/ai/styles";

const STATUS_FILTERS = ["draft", "edited", "published"] as const;

export default async function AdminRecapsPage({ searchParams }: { searchParams: Promise<{ error?: string; status?: string }> }) {
  // Commissioner-only mutation surface — gate the page itself, not just the (league) layout (see
  // src/features/recaps/actions.ts's docstring for why the layout check alone isn't sufficient).
  await requireCommissioner();

  const params = await searchParams;
  const weekOptions = getCompletedWeekOptions();
  // Fix round 1 minor: getRecapAdminList's filter param was wired all the way to the query layer
  // but never actually invoked from a page — wired it here (a plain query-param status filter,
  // no client JS) rather than stripping the parameter, since the filtering logic was already
  // correct and tested, just unreachable.
  const activeStatus = STATUS_FILTERS.find((s) => s === params.status);
  const recapRows = getRecapAdminList(activeStatus ? { status: activeStatus } : {});
  const apiKeyAvailable = hasAnthropicApiKey();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Commissioner"
        title="Weekly Recaps"
        right={
          <Link href="/admin/recaps/voice" className="display border border-line-sheet-strong px-4 py-2 text-xs tracking-[0.12em] text-ink hover:border-ink">
            Writing Style
          </Link>
        }
      />

      {params.error ? <Notice tone="live">{params.error}</Notice> : null}

      {!apiKeyAvailable ? (
        <Notice tone="ink">No ANTHROPIC_API_KEY is configured. Generating still works — every new draft uses the deterministic fallback template instead of Claude.</Notice>
      ) : null}

      <section className="flex flex-col gap-4">
        <SectionLabel>Generate a Recap</SectionLabel>
        {weekOptions.length === 0 ? (
          <p className="border border-line-sheet bg-sheet p-5 text-sm text-muted">No completed weeks yet — a recap needs at least one finished week.</p>
        ) : (
          <form action={generateRecapAction} className="flex flex-wrap items-end gap-3 border border-line-sheet bg-sheet p-5">
            <label className="flex flex-col gap-1">
              <span className="display text-[10px] tracking-[0.16em] text-muted">Week</span>
              <select name="seasonWeek" defaultValue={`${weekOptions[0]!.season}-${weekOptions[0]!.week}`} className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink">
                {weekOptions.map((w) => (
                  <option key={`${w.season}-${w.week}`} value={`${w.season}-${w.week}`}>
                    {w.season} — Week {w.week}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="display text-[10px] tracking-[0.16em] text-muted">Style</span>
              <select name="styleId" defaultValue={RECAP_STYLES[0]!.id} className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink">
                {RECAP_STYLES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="display border border-line-sheet-strong px-4 py-2 text-xs tracking-[0.12em] text-ink hover:border-ink">
              Generate
            </button>
            {!apiKeyAvailable ? <span className="text-xs text-muted">No API key — this will use the fallback template.</span> : null}
          </form>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-sheet-strong pb-2.5">
          <h2 className="display text-[12px] tracking-[0.24em] text-muted">All Recaps</h2>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/admin/recaps"
              className={`display rounded-full border px-3 py-1 text-[10px] tracking-[0.1em] ${!activeStatus ? "border-kelly-deep bg-kelly-deep font-bold text-sheet" : "border-line-sheet-strong text-muted hover:text-ink"}`}
            >
              All
            </Link>
            {STATUS_FILTERS.map((s) => (
              <Link
                key={s}
                href={`/admin/recaps?status=${s}`}
                className={`display rounded-full border px-3 py-1 text-[10px] tracking-[0.1em] ${activeStatus === s ? "border-kelly-deep bg-kelly-deep font-bold text-sheet" : "border-line-sheet-strong text-muted hover:text-ink"}`}
              >
                {s}
              </Link>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b-2 border-ink text-left text-muted">
                <th className="display sticky left-0 z-10 bg-sheet px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Season</th>
                <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Week</th>
                <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Style</th>
                <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Status</th>
                <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Model</th>
                <th className="display px-3 py-2 text-right text-[11px] font-normal tracking-[0.14em]">Cost</th>
                <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Created</th>
              </tr>
            </thead>
            <tbody>
              {recapRows.map((r) => (
                <tr key={r.id} className="border-b border-line-sheet last:border-0">
                  <td className="sticky left-0 z-10 bg-sheet px-3 py-2 tabular-nums text-ink">
                    <Link href={`/admin/recaps/${r.id}`} className="hover:underline">
                      {r.season}
                    </Link>
                  </td>
                  <td className="px-3 py-2 tabular-nums text-ink">{r.week}</td>
                  <td className="px-3 py-2 text-muted">{r.style}</td>
                  <td className="px-3 py-2 text-muted">{r.status}</td>
                  <td className="px-3 py-2 text-muted">{r.model ?? "fallback"}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{r.costUsd !== null ? `$${r.costUsd.toFixed(4)}` : "—"}</td>
                  <td className="px-3 py-2 tabular-nums text-muted">{r.createdAt.toISOString().slice(0, 10)}</td>
                </tr>
              ))}
              {recapRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-muted">
                    No recaps generated yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
