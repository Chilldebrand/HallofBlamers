import Link from "next/link";
import { PageHeader } from "@/components/broadcast/PageHeader";

const HISTORY_LINKS = [
  { href: "/franchises", label: "Franchises", description: "Every franchise, active and departed." },
  { href: "/records", label: "Record Book", description: "League bests and worsts, all time." },
  { href: "/h2h", label: "Head-to-Head", description: "Franchise vs. franchise, all time." },
  { href: "/seasons", label: "Seasons", description: "Every season, year by year." },
  { href: "/belt", label: "The Belt", description: "The full lineage, reign by reign." },
  { href: "/timeline", label: "Timeline", description: "The league's story, in order." },
] as const;

export default function HistoryPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow="The Archive" title="History" />
      <div className="grid gap-4 sm:grid-cols-2">
        {HISTORY_LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="border border-line-sheet bg-sheet p-5 transition-colors hover:border-ink">
            <p className="display text-[20px] uppercase text-ink">{link.label}</p>
            <p className="mt-1 text-[14px] text-muted">{link.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
