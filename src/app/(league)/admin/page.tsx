import { headers } from "next/headers";
import Link from "next/link";
import { Button, Notice } from "@/components/broadcast/FormControls";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { SectionLabel } from "@/components/broadcast/SectionLabel";
import { requireCommissioner } from "@/server/auth/guard";
import { addManager, regenerateInviteLink, saveEspnCookiesAction, setDraftDate, syncNowAction, testEspnConnectionAction } from "@/features/admin/actions";
import {
  getCurrentDraftDate,
  getEspnConnectionStatus,
  getFranchiseOptions,
  getManagersWithFranchise,
  getManualSyncStatus,
  getRecentStatBuilds,
  getRecentSyncRuns,
  getWhosNotSet,
} from "@/features/admin/queries";
import { ADMIN_REVEAL_HEADER } from "@/proxy";

interface RevealPayload {
  managerId: number;
  name: string;
  token: string;
}

/**
 * Reads the forwarded REQUEST header proxy.ts sets, not the cookie directly — see proxy.ts's
 * docstring (fix round 1, I3): a middleware cookie DELETE propagates to this same request's
 * render too, so by the time this page runs, the cookie itself is already gone from what
 * `cookies()` would return here even on the very first load. The raw value survives via this
 * header instead, forwarded before the delete took effect.
 */
async function readRevealPayload(): Promise<RevealPayload | null> {
  const headerStore = await headers();
  const raw = headerStore.get(ADMIN_REVEAL_HEADER);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as RevealPayload;
    if (typeof parsed.token === "string" && typeof parsed.name === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string; test?: string; testMsg?: string; syncError?: string }>;
}) {
  // /admin is the FIRST real commissioner mutation surface — gate the page itself, not just the
  // (league) layout (which does not re-run on soft navigation; see its docstring). Non-commissioner
  // managers land back on "/".
  await requireCommissioner();

  const params = await searchParams;
  const reveal = await readRevealPayload();
  const draftDate = getCurrentDraftDate();
  const managerRows = getManagersWithFranchise();
  const franchiseOptions = getFranchiseOptions();
  const syncRuns = getRecentSyncRuns(10);
  const statBuilds = getRecentStatBuilds(5);
  const espnStatus = getEspnConnectionStatus();
  const manualSync = getManualSyncStatus();
  const whosNotSet = getWhosNotSet();

  return (
    <div className="flex flex-col gap-10">
      <PageHeader eyebrow="Commissioner" title="Admin" />

      {params.error ? <Notice tone="live">{params.error}</Notice> : null}
      {params.syncError ? <Notice tone="live">{params.syncError}</Notice> : null}
      {params.success === "draft_date" ? <Notice tone="kelly">Draft date updated.</Notice> : null}
      {params.success === "sync_requested" ? <Notice tone="kelly">Sync requested — it&apos;ll appear in the table below within a minute.</Notice> : null}
      {reveal ? (
        <Notice tone="ink">
          For {reveal.name}: <span className="font-semibold tabular-nums text-ink">/join/{reveal.token}</span> — copy this now, it won&apos;t
          be shown again.
        </Notice>
      ) : null}

      <section className="flex flex-col gap-4">
        <SectionLabel>Commissioner Tools</SectionLabel>
        <div className="flex flex-col gap-2">
          <Link href="/admin/recaps" className="flex items-center justify-between gap-4 border border-line-sheet bg-sheet px-4 py-3 transition-colors hover:border-ink">
            <span className="text-ink">Weekly Recaps</span>
            <span className="text-xs text-muted">review &amp; publish AI drafts</span>
          </Link>
          <Link href="/admin/polls" className="flex items-center justify-between gap-4 border border-line-sheet bg-sheet px-4 py-3 transition-colors hover:border-ink">
            <span className="text-ink">Polls &amp; Surveys</span>
            <span className="text-xs text-muted">create league votes</span>
          </Link>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionLabel>Draft Date</SectionLabel>
        <form action={setDraftDate} className="flex flex-wrap items-end gap-3 border border-line-sheet bg-sheet p-5">
          <label className="flex flex-col gap-1">
            <span className="display text-[10px] tracking-[0.16em] text-muted">Draft Date</span>
            <input type="date" name="draftDate" defaultValue={draftDate} required className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink" />
          </label>
          <Button type="submit">Save</Button>
          <span className="text-xs text-muted">Drives the home page&apos;s draft countdown.</span>
        </form>
      </section>

      <section className="flex flex-col gap-4">
        <SectionLabel>Managers &amp; Invite Links</SectionLabel>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b-2 border-ink text-left text-muted">
                <th className="display sticky left-0 z-10 bg-sheet px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Name</th>
                <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Role</th>
                <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Franchise</th>
                <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Added</th>
                <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]"></th>
              </tr>
            </thead>
            <tbody>
              {managerRows.map((m) => (
                <tr key={m.id} className="border-b border-line-sheet last:border-0">
                  <td className="sticky left-0 z-10 bg-sheet px-3 py-2 text-ink">{m.name}</td>
                  <td className="px-3 py-2 text-muted">{m.role}</td>
                  <td className="px-3 py-2 text-muted">{m.franchiseName ?? "—"}</td>
                  {/* Invite tokens are NEVER rendered here — see ManagerRow's docstring. The only
                      place a live link ever appears is the one-time reveal banner above, right
                      after this action runs. */}
                  <td className="px-3 py-2 tabular-nums text-muted">{m.createdAt.toISOString().slice(0, 10)}</td>
                  <td className="px-3 py-2 text-right">
                    <form action={regenerateInviteLink}>
                      <input type="hidden" name="managerId" value={m.id} />
                      <button type="submit" className="display text-[10px] tracking-wide text-muted underline hover:text-ink">
                        Regenerate Invite Link
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form action={addManager} className="flex flex-wrap items-end gap-3 border border-line-sheet bg-sheet p-5">
          <label className="flex flex-col gap-1">
            <span className="display text-[10px] tracking-[0.16em] text-muted">Name</span>
            <input type="text" name="name" required className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="display text-[10px] tracking-[0.16em] text-muted">Franchise</span>
            <select name="franchiseId" defaultValue="" className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink">
              <option value="">None</option>
              {franchiseOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="display text-[10px] tracking-[0.16em] text-muted">Role</span>
            <select name="role" defaultValue="manager" className="border border-line-sheet bg-sheet px-3 py-2 text-sm text-ink">
              <option value="manager">Manager</option>
              <option value="commissioner">Commissioner</option>
            </select>
          </label>
          <Button type="submit">Add Manager</Button>
        </form>
      </section>

      <section id="sync-status" className="flex flex-col gap-4">
        <SectionLabel>Sync Status</SectionLabel>

        <div className="flex flex-wrap items-center gap-3 border border-line-sheet bg-sheet p-5">
          <form action={syncNowAction}>
            <Button disabled={manualSync.pending}>{manualSync.pending ? "Sync in progress…" : "Sync Now"}</Button>
          </form>
          <span className="text-xs text-muted">
            {manualSync.requestedAt !== null
              ? `Requested at ${manualSync.requestedAt.toISOString()} — waiting for the worker to pick it up (polls every minute).`
              : manualSync.anySyncRunning
                ? "A sync is currently running."
                : "Runs one hourly-style sync right now instead of waiting for the next scheduled tick."}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b-2 border-ink text-left text-muted">
                <th className="display sticky left-0 z-10 bg-sheet px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Started</th>
                <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Tier</th>
                <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Status</th>
                <th className="display px-3 py-2 text-right text-[11px] font-normal tracking-[0.14em]">Snapshots</th>
                <th className="display px-3 py-2 text-right text-[11px] font-normal tracking-[0.14em]">Events</th>
                <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Error</th>
              </tr>
            </thead>
            <tbody>
              {syncRuns.map((run) => (
                <tr key={run.id} className="border-b border-line-sheet last:border-0">
                  <td className="sticky left-0 z-10 bg-sheet px-3 py-2 tabular-nums text-muted">{run.startedAt.toISOString()}</td>
                  <td className="px-3 py-2 text-ink">{run.tier}</td>
                  <td className={`px-3 py-2 ${run.status === "ok" ? "text-ink" : run.status === "failed" || run.status === "auth_failed" ? "font-semibold text-live" : "text-muted"}`}>{run.status}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{run.snapshotsNew}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{run.eventsEmitted}</td>
                  <td className="px-3 py-2 text-muted">{run.errorText ?? "—"}</td>
                </tr>
              ))}
              {syncRuns.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-muted">
                    No sync runs recorded yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr className="border-b-2 border-ink text-left text-muted">
                <th className="display sticky left-0 z-10 bg-sheet px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Started</th>
                <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Status</th>
                <th className="display px-3 py-2 text-right text-[11px] font-normal tracking-[0.14em]">Duration (ms)</th>
                <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Error</th>
              </tr>
            </thead>
            <tbody>
              {statBuilds.map((build) => (
                <tr key={build.id} className="border-b border-line-sheet last:border-0">
                  <td className="sticky left-0 z-10 bg-sheet px-3 py-2 tabular-nums text-muted">{build.startedAt.toISOString()}</td>
                  <td className={`px-3 py-2 ${build.status === "ok" ? "text-ink" : build.status === "failed" ? "font-semibold text-live" : "text-muted"}`}>{build.status}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{build.durationMs ?? "—"}</td>
                  <td className="px-3 py-2 text-muted">{build.errorText ?? "—"}</td>
                </tr>
              ))}
              {statBuilds.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-muted">
                    No stat builds recorded yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionLabel>Who&apos;s Not Set</SectionLabel>
        {whosNotSet.unresolved.length === 0 ? (
          <p className="text-sm text-muted">Every starting lineup is filled for the current week.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b-2 border-ink text-left text-muted">
                  <th className="display sticky left-0 z-10 bg-sheet px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Franchise</th>
                  <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Slot</th>
                  <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Issue</th>
                  <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Player</th>
                  <th className="display px-3 py-2 text-[11px] font-normal tracking-[0.14em]">Status</th>
                </tr>
              </thead>
              <tbody>
                {whosNotSet.unresolved.map((hole, i) => (
                  <tr key={`${hole.franchiseId}-${hole.slot}-${hole.reason}-${i}`} className="border-b border-line-sheet last:border-0">
                    <td className="sticky left-0 z-10 bg-sheet px-3 py-2 text-ink">{hole.franchiseName}</td>
                    <td className="px-3 py-2 text-muted">{hole.slot}</td>
                    <td className={`px-3 py-2 ${hole.reason === "empty" ? "font-semibold text-live" : "text-ink"}`}>{hole.reason === "empty" ? "Empty slot" : "Disqualified"}</td>
                    <td className="px-3 py-2 text-muted">{hole.playerName ?? "—"}</td>
                    <td className="px-3 py-2 text-muted">{hole.injuryStatus ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {whosNotSet.resolved.length > 0 ? (
          <p className="text-xs text-muted">
            Resolved this week:{" "}
            {whosNotSet.resolved
              .map((r) => `${r.franchiseName} (${r.slot}${r.resolvedReason === "matchup_final" ? " — game went final, not necessarily fixed" : r.resolvedReason === "fixed" ? " — fixed" : ""})`)
              .join(", ")}
          </p>
        ) : null}
      </section>

      <section id="espn-connection" className="flex flex-col gap-4">
        <SectionLabel>ESPN Connection</SectionLabel>

        {espnStatus.latestRunIsAuthFailed ? <Notice tone="live">ESPN cookies expired — paste fresh ones below.</Notice> : null}

        <p className="text-xs text-muted">
          Last successful sync: <span className="tabular-nums text-ink">{espnStatus.lastSuccessfulSync ? espnStatus.lastSuccessfulSync.toISOString() : "never"}</span>
        </p>

        {params.test === "success" ? (
          <Notice tone="kelly">
            {params.testMsg ?? "Connected."}
            {/* Deferred-minors fix (Task 33 audit catch): this only proves the WEB app can reach
                ESPN with whatever cookies were just tested — if those are new ones, the worker
                (a separate long-running process) still needs its own restart to pick them up. A
                successful test alone doesn't fix a currently-stuck worker. */}
            <p className="mt-2 text-xs text-muted">
              This only tests the connection from the web app. If you just saved new cookies, the worker still needs a restart to actually
              use them — see the reminder below.
            </p>
          </Notice>
        ) : null}
        {params.test === "error" ? <Notice tone="live">{params.testMsg ?? "ESPN did not accept these cookies."}</Notice> : null}

        {params.success === "espn_cookies" ? (
          <Notice tone="ink">
            ESPN cookies saved.
            <p className="mt-2 text-sm text-ink">
              <strong>Required next step:</strong> restart the worker so it picks up the new cookies — the client is only built once at
              worker startup, so it will keep failing with the old cookies until you do. Run{" "}
              <code className="bg-sheet-raised px-1 py-0.5 text-xs">./ops/deploy.sh</code> (or{" "}
              <code className="bg-sheet-raised px-1 py-0.5 text-xs">docker compose restart worker</code>) from the server.
            </p>
          </Notice>
        ) : null}

        <div className="flex flex-col gap-3 border border-line-sheet bg-sheet p-5">
          <p className="text-sm text-muted">
            With a browser logged into ESPN Fantasy and your league page open: DevTools (F12) → Application (Chrome) or Storage (Firefox) →
            Cookies → <span className="text-ink">fantasy.espn.com</span>. Copy the <span className="text-ink">espn_s2</span> value and the{" "}
            <span className="text-ink">SWID</span> value — <strong>keep SWID&apos;s curly braces</strong> — exactly as shown. Don&apos;t trim
            or decode anything; paste them verbatim below.
          </p>
          <form className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="display text-[10px] tracking-[0.16em] text-muted">espn_s2</span>
              <input type="text" name="espnS2" autoComplete="off" spellCheck={false} className="border border-line-sheet bg-sheet px-3 py-2 font-mono text-xs text-ink" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="display text-[10px] tracking-[0.16em] text-muted">SWID</span>
              <input
                type="text"
                name="swid"
                placeholder="{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}"
                autoComplete="off"
                spellCheck={false}
                className="border border-line-sheet bg-sheet px-3 py-2 font-mono text-xs text-ink"
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <Button formAction={saveEspnCookiesAction}>Save Cookies</Button>
              <Button formAction={testEspnConnectionAction}>Test Connection</Button>
            </div>
            <span className="text-xs text-muted">Test Connection uses whatever&apos;s in the fields above; leave both blank to test the currently-saved cookies instead.</span>
          </form>
        </div>
      </section>
    </div>
  );
}
