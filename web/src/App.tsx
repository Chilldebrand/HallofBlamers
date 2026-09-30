import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useViewer } from "./auth/session";
import { fetchStandings, type StandingsResponse } from "./api/league";
import { buildStandings } from "./api/standings";
import { TopNav } from "./components/TopNav";
import { BottomTabBar } from "./components/BottomTabBar";
import Link from "./components/Link";
import { Login } from "./pages/Login";
import StandingsPage from "./pages/Standings";
import { supabase } from "./lib/supabase";

export function App() {
  const { loading, viewer } = useViewer();
  if (loading) return <p role="status" className="p-8 text-muted">Checking league access…</p>;
  if (!viewer) return <Login />;
  return <LeagueApp key={viewer.authUserId} />;
}

function LeagueApp() {
  const { viewer, refresh } = useViewer();
  const location = useLocation();
  const [data, setData] = useState<StandingsResponse | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const load = async () => {
      try {
        const next = await fetchStandings(controller.signal);
        if (active) { setData(next); setError(false); }
      } catch {
        if (active) { setData(null); setError(true); void refresh(); }
      }
    };
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [attempt, refresh]);
  if (error) return <div className="p-8"><p role="alert">Unable to load league data.</p><button className="mt-4 text-kelly underline" onClick={() => { setError(false); setAttempt(n => n + 1); }}>Try again</button></div>;
  if (!data) return <p role="status" className="p-8 text-muted">Loading the league…</p>;
  const shell = data.shell;
  const params = Object.fromEntries(new URLSearchParams(location.search));
  return <div className="flex min-h-screen flex-col bg-frame">
    <TopNav isCommissioner={viewer?.role === "commissioner"} managerName={shell.managerName} franchiseName={shell.franchiseName} />
    <div className="flex flex-wrap justify-between gap-3 border-b border-line bg-chrome px-5 py-2 text-xs text-muted-on-chrome">
      <span>{shell.sync.state === "failed" ? "Latest sync failed · " : shell.sync.state === "running" ? "Updating · " : ""}{shell.sync.lastSuccessAt ? `Last updated ${new Date(shell.sync.lastSuccessAt).toLocaleString()}` : "No completed cloud sync yet"}</span>
      <button onClick={() => void supabase?.auth.signOut()} className="underline">Sign out</button>
    </div>
    <main className="mx-auto w-full max-w-5xl flex-1 bg-sheet px-5 pb-8 pt-5 sm:px-6 md:px-11 md:pb-13 md:pt-[34px]">
      {location.pathname === "/standings" ? <StandingsPage model={buildStandings(data, params)} identityFlags={shell.flags} /> : <div>
        <h1 className="display text-page-title text-kelly-deep">Hall of Blamers</h1>
        <p className="mt-4 text-muted">This preview is being connected to the league. More pages will be available when the migration is complete.</p>
        <Link href="/standings" className="mt-6 inline-block text-kelly underline">View standings</Link>
      </div>}
    </main>
    <BottomTabBar />
  </div>;
}
