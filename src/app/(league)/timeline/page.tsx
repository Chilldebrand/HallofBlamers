import Link from "next/link";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { cn } from "@/components/ui/cn";
import {
  TIMELINE_EVENT_TYPES,
  TIMELINE_TYPE_LABELS,
  filterTimelineEntries,
  getAvailableFranchises,
  getAvailableSeasons,
  getTimelineEntries,
  type TimelineEventType,
} from "@/features/timeline/queries";

interface TimelineSearchParams {
  season?: string;
  franchise?: string;
  type?: string;
}

function buildHref(params: TimelineSearchParams): string {
  const query = new URLSearchParams();
  if (params.season) query.set("season", params.season);
  if (params.franchise) query.set("franchise", params.franchise);
  if (params.type) query.set("type", params.type);
  const qs = query.toString();
  return qs ? `/timeline?${qs}` : "/timeline";
}

export default async function TimelinePage({ searchParams }: { searchParams: Promise<TimelineSearchParams> }) {
  const params = await searchParams;
  const allEntries = getTimelineEntries();

  const season = params.season ? Number(params.season) : undefined;
  const franchiseId = params.franchise ? Number(params.franchise) : undefined;
  const type = TIMELINE_EVENT_TYPES.includes(params.type as TimelineEventType) ? (params.type as TimelineEventType) : undefined;

  const entries = filterTimelineEntries(allEntries, {
    season: Number.isInteger(season) ? season : undefined,
    franchiseId: Number.isInteger(franchiseId) ? franchiseId : undefined,
    type,
  });

  const seasons = getAvailableSeasons(allEntries);
  const availableFranchises = getAvailableFranchises(allEntries);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow="History" title="Timeline" />

      <div className="flex flex-col gap-3">
        <FilterRow label="Season">
          <FilterPill href={buildHref({ franchise: params.franchise, type: params.type })} active={season === undefined}>
            All
          </FilterPill>
          {seasons.map((s) => (
            <FilterPill key={s} href={buildHref({ season: String(s), franchise: params.franchise, type: params.type })} active={season === s}>
              {s}
            </FilterPill>
          ))}
        </FilterRow>

        <FilterRow label="Franchise">
          <FilterPill href={buildHref({ season: params.season, type: params.type })} active={franchiseId === undefined}>
            All
          </FilterPill>
          {availableFranchises.map((f) => (
            <FilterPill key={f.id} href={buildHref({ season: params.season, franchise: String(f.id), type: params.type })} active={franchiseId === f.id}>
              {f.name}
            </FilterPill>
          ))}
        </FilterRow>

        <FilterRow label="Type">
          <FilterPill href={buildHref({ season: params.season, franchise: params.franchise })} active={type === undefined}>
            All
          </FilterPill>
          {TIMELINE_EVENT_TYPES.map((t) => (
            <FilterPill key={t} href={buildHref({ season: params.season, franchise: params.franchise, type: t })} active={type === t}>
              {TIMELINE_TYPE_LABELS[t]}
            </FilterPill>
          ))}
        </FilterRow>
      </div>

      <div className="flex flex-col">
        {entries.map((entry, i) => (
          <Link
            key={`${entry.type}-${entry.season}-${entry.week}-${entry.franchiseId}-${i}`}
            href={entry.href}
            className={cn(
              "border-b border-line-sheet-soft px-1 py-3 transition-colors hover:bg-sheet-raised last:border-b-0",
              entry.gold ? "border-l-[3px] border-l-gold-fill bg-sheet-raised pl-3" : "",
            )}
          >
            <p className={cn("display text-[11px] tracking-[0.18em]", entry.gold ? "text-gold-ink" : "text-muted")}>
              {entry.season}
              {entry.week ? ` Wk ${entry.week}` : ""} · {entry.eyebrow}
            </p>
            <p className="text-[15px] text-ink">{entry.statement}</p>
          </Link>
        ))}
        {entries.length === 0 ? <p className="text-sm text-muted">No events match these filters.</p> : null}
      </div>
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="display w-20 shrink-0 text-[10px] tracking-[0.16em] text-muted">{label}</span>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function FilterPill({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        "display rounded-full border px-2.5 py-1 text-[10px] tracking-[0.1em]",
        active ? "border-kelly-deep bg-kelly-deep font-bold text-sheet" : "border-line-sheet-strong text-muted hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}
