import { ELO_START } from "@/engines";
import type { EloSeries } from "@/server/queries/franchises";

export interface EloChartProps {
  series: EloSeries;
  className?: string;
}

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 320;
const TOP_PAD = 16;
const BOTTOM_PAD = 36;
const PLOT_HEIGHT = VIEW_HEIGHT - TOP_PAD - BOTTOM_PAD;
// Three evenly-spaced horizontal gridlines (README, Franchise "Elo history": "2px kelly stroke
// on three horizontal gridlines") — plain reference lines, not a single labeled 1500-baseline.
const GRIDLINE_FRACTIONS = [0.25, 0.5, 0.75];

/**
 * Server-rendered inline SVG — no chart library, per the brief. x = a sequential index across
 * this franchise's own elo_history rows (a "season/week continuum" that skips bye weeks
 * cleanly), y = Elo. Season boundaries get a thin vertical tick + year label below.
 *
 * Task 24 restyle (README, Franchise "Elo history" — "restyle, don't replace"): kept the
 * existing continuous per-GAME line (real elo_history rows) rather than switching to the
 * mockup's simplified one-point-per-SEASON rendering — the brief's "restyle, don't replace"
 * instruction, plus the general rule against ever thinning real per-game data down to fabricated
 * round numbers, both point the same way. Kelly stroke, gold dots on championship-SEASON points,
 * tarnish dots on sacko-season points (`EloPoint.isChampionSeason`/`isSackoSeason`, set by
 * `markSeasonEndDots` — the LAST elo_history point of that season), a small legend below when
 * either ever applies. Dropped the old dashed 1500-baseline + "current" ink dot — neither is in
 * the mockup, which shows only plain gridlines and championship/sacko dots.
 */
export function EloChart({ series, className }: EloChartProps) {
  const { points, seasonTicks } = series;

  if (points.length === 0) {
    return <p className="text-sm text-muted">No Elo history yet.</p>;
  }

  const values = points.map((p) => p.elo);
  const minElo = Math.min(...values, ELO_START);
  const maxElo = Math.max(...values, ELO_START);
  const pad = Math.max((maxElo - minElo) * 0.08, 10);
  const yMin = minElo - pad;
  const yMax = maxElo + pad;
  const range = yMax - yMin || 1;

  const lastIndex = points.length - 1;
  const xFor = (x: number) => (lastIndex === 0 ? VIEW_WIDTH / 2 : (x / lastIndex) * VIEW_WIDTH);
  const yFor = (elo: number) => TOP_PAD + PLOT_HEIGHT - ((elo - yMin) / range) * PLOT_HEIGHT;

  const linePoints = points.map((p) => `${xFor(p.x).toFixed(1)},${yFor(p.elo).toFixed(1)}`).join(" ");
  const current = points[lastIndex]!;
  const championDots = points.filter((p) => p.isChampionSeason);
  const sackoDots = points.filter((p) => p.isSackoSeason);
  const hasChampionDot = championDots.length > 0;
  const hasSackoDot = sackoDots.length > 0;

  return (
    <div className={className}>
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        className="aspect-[1000/320] h-auto w-full"
        role="img"
        aria-label={`Elo rating history, currently ${Math.round(current.elo)}`}
      >
        {GRIDLINE_FRACTIONS.map((f) => {
          const y = TOP_PAD + PLOT_HEIGHT * f;
          return <line key={f} x1={0} x2={VIEW_WIDTH} y1={y} y2={y} className="stroke-line-sheet" strokeWidth={1} />;
        })}

        {seasonTicks.map((t) => (
          <g key={t.season}>
            <line x1={xFor(t.x)} x2={xFor(t.x)} y1={TOP_PAD} y2={TOP_PAD + PLOT_HEIGHT} className="stroke-line-sheet-soft" strokeWidth={1} />
            <text x={Math.min(xFor(t.x) + 3, VIEW_WIDTH - 28)} y={VIEW_HEIGHT - 10} className="fill-muted text-[11px] tabular-nums">
              {t.season}
            </text>
          </g>
        ))}

        {/* Deferred-minors fix (Task 33 audit catch): stroke-width 3 and dot radius 6 are the
            mockup's own literal SVG values (docs/design/redesign-2026-08/Franchise.dc.html, both
            the 9a/9b desktop frames and the phone variant all agree — `stroke-width="3"` on the
            polyline, `r="6"` on every champ/sacko dot) — the README's prose ("2px kelly stroke...
            6px gold dots") undercounts the stroke; the mockup file itself is the literal source of
            truth for styling values (AGENTS.md), so this now matches it exactly. */}
        <polyline points={linePoints} fill="none" className="stroke-kelly" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />

        {championDots.map((p) => (
          <circle key={`champ-${p.x}`} cx={xFor(p.x)} cy={yFor(p.elo)} r={6} className="fill-gold-fill" />
        ))}
        {sackoDots.map((p) => (
          <circle key={`sacko-${p.x}`} cx={xFor(p.x)} cy={yFor(p.elo)} r={6} className="fill-tarnish-fill" />
        ))}
      </svg>

      {hasChampionDot || hasSackoDot ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-5 text-[13px] text-muted">
          {hasChampionDot ? (
            <span className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-gold-fill" aria-hidden="true" />
              Championship season
            </span>
          ) : null}
          {hasSackoDot ? (
            <span className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-tarnish-fill" aria-hidden="true" />
              Sacko season
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
