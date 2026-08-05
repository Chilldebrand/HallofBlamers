import { Button, Notice } from "@/components/broadcast/FormControls";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { SectionLabel } from "@/components/broadcast/SectionLabel";
import { FranchiseName } from "@/components/league/FranchiseName";
import { requireManager } from "@/server/auth/guard";
import { savePredictionsAction } from "@/features/predictions/actions";
import { getDb } from "@/server/db/client";
import { PREDICTION_CATEGORIES, type PredictionCategory } from "@/server/db/schema";
import { getIdentityFlags, resolveFranchiseFlags, type IdentityFlags } from "@/server/queries/identity";
import {
  getActiveFranchises,
  getMyPredictions,
  getPredictionsSeason,
  getReveal,
  getSubmissionStatus,
  getWinTotalMax,
  isPredictionsLocked,
  type RevealCell,
} from "@/server/queries/predictions";

const CATEGORY_LABELS: Record<PredictionCategory, string> = {
  champion: "Champion",
  sacko: "Sacko",
  top_scorer: "League Top Scorer",
  win_total: "Win Total",
  bold_take: "Bold Take",
};

function RevealCellValue({ cell, flags }: { cell: RevealCell; flags: IdentityFlags }) {
  if (cell.kind === "franchise") {
    return <FranchiseName franchise={{ id: cell.franchiseId, name: cell.franchiseName, ...resolveFranchiseFlags(flags, cell.franchiseId) }} size="row" />;
  }
  if (cell.kind === "number") return <span className="tabular-nums">{cell.value}</span>;
  return <span>{cell.value}</span>;
}

export default async function PredictionsPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const manager = await requireManager();
  const db = getDb();
  const { error, success } = await searchParams;

  const season = getPredictionsSeason(db);

  if (season === null) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader eyebrow="Time Capsule" title="Predictions" />
        <div className="border border-line-sheet bg-sheet p-6 text-sm text-muted">No season on the board yet — check back once one shows up.</div>
      </div>
    );
  }

  const locked = isPredictionsLocked(db, season);

  if (locked) {
    const reveal = getReveal(db, season);
    const flags = getIdentityFlags(db, manager.id);

    return (
      <div className="flex flex-col gap-8">
        <PageHeader eyebrow={`${season} · Sealed no more`} title="The Reveal" />
        {error ? <Notice tone="live">{error}</Notice> : null}
        <p className="text-sm text-muted">
          Kickoff happened, so every capsule is open. Here&apos;s what the league was thinking before a single snap was played.
        </p>

        {!reveal || reveal.length === 0 ? (
          <div className="border border-line-sheet bg-sheet p-6 text-sm text-muted">Nobody made a prediction this season.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr className="border-b-2 border-ink text-left text-muted">
                  <th className="display sticky left-0 z-10 bg-sheet px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Manager</th>
                  {PREDICTION_CATEGORIES.map((c) => (
                    <th key={c} className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">
                      {CATEGORY_LABELS[c]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {reveal.map((row) => (
                  <tr key={row.managerId} className="border-b border-line-sheet last:border-0">
                    <td className="sticky left-0 z-10 bg-sheet px-3 py-2 text-ink">
                      {row.franchiseId !== null ? (
                        <FranchiseName
                          franchise={{ id: row.franchiseId, name: row.franchiseName ?? row.managerName, ...resolveFranchiseFlags(flags, row.franchiseId) }}
                          size="row"
                        />
                      ) : (
                        row.managerName
                      )}
                    </td>
                    {PREDICTION_CATEGORIES.map((c) => {
                      const cell = row.cells.find((cc) => cc.category === c);
                      return (
                        <td key={c} className="px-3 py-2 text-ink">
                          {cell ? <RevealCellValue cell={cell} flags={flags} /> : <span className="text-muted">—</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // Pre-lock: the manager's own form, plus the seal (names only — never contents).
  const mine = getMyPredictions(db, manager.id, season);
  const mineByCategory = new Map(mine.map((r) => [r.category, r.subject]));
  const franchiseOptions = getActiveFranchises(db);
  const winTotalMax = getWinTotalMax(db, season) ?? 14;
  const submissionStatus = getSubmissionStatus(db, season);
  const hasFranchise = manager.franchiseId !== null;
  const alreadySubmitted = mine.length > 0;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow={`${season} · Sealed until kickoff`} title="Predictions" />

      {error ? <Notice tone="live">{error}</Notice> : null}
      {success === "saved" ? <Notice tone="kelly">Locked in. Edit it as many times as you want before kickoff.</Notice> : null}

      <p className="text-sm text-muted">
        Say it now, own it later. Nobody — not even the commissioner — sees another manager&apos;s picks until the season actually kicks off.
      </p>

      <section className="flex flex-col gap-4">
        <SectionLabel>{alreadySubmitted ? "Your Predictions" : "Make Your Predictions"}</SectionLabel>
        <form action={savePredictionsAction} className="flex flex-col gap-4 border border-line-sheet bg-sheet p-5">
          <label className="flex flex-col gap-1">
            <span className="display text-[10px] tracking-[0.16em] text-muted">Champion</span>
            <select name="champion" required defaultValue={mineByCategory.get("champion") ?? ""} className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink">
              <option value="" disabled>
                Pick a franchise
              </option>
              {franchiseOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="display text-[10px] tracking-[0.16em] text-muted">Sacko</span>
            <select name="sacko" required defaultValue={mineByCategory.get("sacko") ?? ""} className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink">
              <option value="" disabled>
                Pick a franchise
              </option>
              {franchiseOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="display text-[10px] tracking-[0.16em] text-muted">League Top Scorer</span>
            <select name="topScorer" required defaultValue={mineByCategory.get("top_scorer") ?? ""} className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink">
              <option value="" disabled>
                Pick a franchise
              </option>
              {franchiseOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>

          {hasFranchise ? (
            <label className="flex flex-col gap-1">
              <span className="display text-[10px] tracking-[0.16em] text-muted">Your Win Total (0–{winTotalMax})</span>
              <input
                type="number"
                name="winTotal"
                min={0}
                max={winTotalMax}
                required
                defaultValue={mineByCategory.get("win_total") ?? ""}
                className="w-24 border border-line-sheet bg-sheet px-3 py-2 text-sm tabular-nums text-ink"
              />
            </label>
          ) : (
            <p className="text-xs text-muted">No franchise on file for you, so there&apos;s no win total to call.</p>
          )}

          <label className="flex flex-col gap-1">
            <span className="display text-[10px] tracking-[0.16em] text-muted">Bold Take</span>
            <textarea
              name="boldTake"
              required
              maxLength={500}
              rows={3}
              defaultValue={mineByCategory.get("bold_take") ?? ""}
              placeholder="Say something you'll have to defend in Week 17."
              className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink"
            />
          </label>

          <div>
            <Button type="submit">{alreadySubmitted ? "Update Predictions" : "Lock In Predictions"}</Button>
          </div>
        </form>
      </section>

      <section className="flex flex-col gap-4">
        <SectionLabel>The Seal</SectionLabel>
        <p className="text-xs text-muted">Who&apos;s in and who&apos;s stalling — no picks shown until kickoff, not even to the commissioner.</p>
        <div className="flex flex-wrap gap-2">
          {submissionStatus.map((m) => (
            <span
              key={m.managerId}
              className={`display px-2.5 py-1 text-[11px] tracking-[0.1em] ${m.submitted ? "border border-kelly text-kelly" : "border border-line-sheet-strong text-muted"}`}
            >
              {m.name} {m.submitted ? "· Sealed" : "· Not Yet"}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}
