import { redirect } from "next/navigation";
import { getLatestMatchupWeek } from "@/server/queries/matchups";

/** Redirects to the most recent week with any completed or scheduled matchup. */
export default function MatchupsIndexPage() {
  const target = getLatestMatchupWeek();
  if (!target) {
    redirect("/");
  }
  redirect(`/matchups/${target.season}/${target.week}`);
}
