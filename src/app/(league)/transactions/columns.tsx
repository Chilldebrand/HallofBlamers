import { cn } from "@/components/ui/cn";

export interface TransactionColumn {
  label: string;
  description: string;
}

export const WAIVER_COLUMNS: TransactionColumn[] = [
  { label: "Player", description: "The player claimed from waivers or free agency." },
  { label: "Franchise", description: "The canonical Hall of Blamers franchise that made the move." },
  { label: "Season", description: "The season and scoring week in the local ESPN archive." },
  { label: "FAAB", description: "Winning bid recorded by ESPN; free-agent adds show Free." },
  { label: "Starts", description: "Starts made for the acquiring franchise before the player left." },
  { label: "Starter pts", description: "Points scored in those starts during this possession window." },
  { label: "Pts / FAAB", description: "Starter points per FAAB dollar; unavailable for free or zero-dollar adds." },
];

export function TransactionHeaderRow({ columns, grid }: { columns: TransactionColumn[]; grid: string }) {
  return (
    <div role="row" className={cn("grid border-b-2 border-ink pb-2", grid)}>
      {columns.map((column, index) => (
        <span
          key={column.label}
          role="columnheader"
          tabIndex={0}
          data-tip={column.description}
          className={cn("display tip text-[11px] tracking-[0.13em] text-muted", index >= 2 ? "tip-end text-right" : "")}
        >
          {column.label}
        </span>
      ))}
    </div>
  );
}
