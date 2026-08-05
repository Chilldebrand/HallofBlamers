"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { requireCommissioner } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import { appSettings, franchises, managers } from "@/server/db/schema";
import { getEspnCredentials, getLeagueId } from "@/server/sync/credentials";
import { determineCurrentSeasonYear } from "@/server/sync/current-season";
import { requestManualSync } from "@/server/sync/manual-sync";
import { ADMIN_REVEAL_COOKIE } from "./constants";
import { testEspnConnection } from "./espn-connection";
import { validateDraftDate, validateEspnCookiesForm, validateManagerForm } from "./validation";

/**
 * /admin is the FIRST real commissioner mutation surface. Every action here
 * calls requireCommissioner() itself, first thing — the (league) layout's
 * requireManager() check does NOT re-run on client-side soft navigation
 * between sibling routes (only on a fresh full render), so it can't be
 * relied on as the authoritative gate for a mutation. See
 * src/app/(league)/layout.tsx's docstring for the same rule stated from the
 * read side.
 */

function redirectWithError(error: string): never {
  redirect(`/admin?error=${encodeURIComponent(error)}`);
}

export async function setDraftDate(formData: FormData): Promise<void> {
  await requireCommissioner();

  const raw = String(formData.get("draftDate") ?? "");
  const result = validateDraftDate(raw);
  if (!result.ok) redirectWithError(result.error);

  const db = getDb();
  const now = new Date();
  db.insert(appSettings)
    .values({ key: "draft_date", valueJson: result.value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson: result.value, updatedAt: now } })
    .run();

  redirect("/admin?success=draft_date");
}

/**
 * Stashes a freshly (re)generated invite token in a short-lived, httpOnly
 * cookie — the ONLY place it travels. Deliberately never in a URL/query
 * string (routinely captured by access logs, Location headers, browser
 * history) and never passed to console.log/console.error — the binding
 * "add-manager/regenerate actions must never print another manager's invite
 * link into logs" rule. The admin page reads and displays it once; the
 * 60-second maxAge bounds how long it lingers if never read.
 */
async function revealInviteAndRedirect(managerId: number, name: string, token: string): Promise<never> {
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_REVEAL_COOKIE, encodeURIComponent(JSON.stringify({ managerId, name, token })), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 60,
    path: "/admin",
  });
  redirect("/admin");
}

export async function regenerateInviteLink(formData: FormData): Promise<void> {
  await requireCommissioner();

  const managerId = Number(formData.get("managerId"));
  if (!Number.isInteger(managerId)) redirectWithError("Invalid manager.");

  const db = getDb();
  const manager = db.select().from(managers).where(eq(managers.id, managerId)).get();
  if (!manager) redirectWithError("Manager not found.");

  const newToken = randomUUID();
  db.update(managers).set({ inviteToken: newToken }).where(eq(managers.id, managerId)).run();

  await revealInviteAndRedirect(manager.id, manager.name, newToken);
}

export async function addManager(formData: FormData): Promise<void> {
  await requireCommissioner();

  const parsed = validateManagerForm({
    name: String(formData.get("name") ?? ""),
    role: String(formData.get("role") ?? ""),
    franchiseId: String(formData.get("franchiseId") ?? ""),
  });
  if (!parsed.ok) redirectWithError(parsed.error);

  const db = getDb();
  if (parsed.value.franchiseId !== null) {
    const franchise = db.select({ id: franchises.id }).from(franchises).where(eq(franchises.id, parsed.value.franchiseId)).get();
    if (!franchise) redirectWithError("Selected franchise does not exist.");
  }

  const newToken = randomUUID();
  const inserted = db
    .insert(managers)
    .values({ name: parsed.value.name, role: parsed.value.role, franchiseId: parsed.value.franchiseId, inviteToken: newToken })
    .returning()
    .get();

  await revealInviteAndRedirect(inserted.id, inserted.name, newToken);
}

/**
 * Writes app_settings keys "espn_s2"/"swid" VERBATIM — see validateEspnCookiesForm's docstring
 * for why neither field is ever trimmed/decoded/transformed. Never logs or redirects with the
 * submitted values in the URL (the error path only ever echoes the generic validation message,
 * never the cookie text itself). Does NOT restart the worker — see the RUNBOOK entry and the
 * success screen's explicit reminder in admin/page.tsx; the worker only re-resolves credentials
 * at process startup (src/server/sync/run-tier.ts's authErrorMessage docstring), so saving here
 * alone does not fix a currently-stuck worker.
 */
export async function saveEspnCookiesAction(formData: FormData): Promise<void> {
  await requireCommissioner();

  const parsed = validateEspnCookiesForm({
    espnS2: String(formData.get("espnS2") ?? ""),
    swid: String(formData.get("swid") ?? ""),
  });
  if (!parsed.ok) redirectWithError(parsed.error);

  const db = getDb();
  const now = new Date();
  db.transaction((tx) => {
    tx.insert(appSettings)
      .values({ key: "espn_s2", valueJson: parsed.value.espnS2, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { valueJson: parsed.value.espnS2, updatedAt: now } })
      .run();
    tx.insert(appSettings)
      .values({ key: "swid", valueJson: parsed.value.swid, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { valueJson: parsed.value.swid, updatedAt: now } })
      .run();
  });

  redirect("/admin?success=espn_cookies");
}

function redirectWithTestResult(status: "success" | "error", message: string): never {
  redirect(`/admin?test=${status}&testMsg=${encodeURIComponent(message)}#espn-connection`);
}

/**
 * ONE polite live fetch against ESPN using the JUST-SUBMITTED field values if both are non-empty,
 * else falling back to the currently-stored cookies (src/server/sync/credentials.ts's
 * getEspnCredentials — DB-wins-over-env). Deliberately does NOT run validateEspnCookiesForm's
 * strict shape check first: testing is how a commissioner discovers a bad paste (e.g. missing
 * SWID braces) in the first place, via ESPN's own rejection, rather than being blocked from even
 * trying. Never writes to app_settings — this is read-only against ESPN, and never touches the
 * database at all beyond the two reads inside getEspnCredentials/getLeagueId.
 */
export async function testEspnConnectionAction(formData: FormData): Promise<void> {
  await requireCommissioner();

  const db = getDb();
  const submittedS2 = String(formData.get("espnS2") ?? "");
  const submittedSwid = String(formData.get("swid") ?? "");

  const testCookies = submittedS2.length > 0 && submittedSwid.length > 0 ? { espn_s2: submittedS2, swid: submittedSwid } : getEspnCredentials(db);
  if (!testCookies) {
    redirectWithTestResult("error", "No ESPN cookies to test — paste values above, or save them first.");
  }

  let leagueId: number;
  try {
    leagueId = getLeagueId(db);
  } catch {
    redirectWithTestResult("error", "No ESPN league id is configured yet — set that up before testing cookies.");
  }

  const result = await testEspnConnection({ leagueId, season: determineCurrentSeasonYear(), cookies: testCookies });
  if (result.ok) {
    redirectWithTestResult("success", result.leagueName ? `Connected — ESPN returned league "${result.leagueName}".` : "Connected — ESPN accepted the cookies.");
  } else {
    redirectWithTestResult("error", result.message);
  }
}

/**
 * "Sync now" (Task 33 audit catch) — does NOT call the ESPN pipeline itself; per AGENTS.md, the
 * worker is the sole writer of ESPN-derived data, and this Server Action runs in the WEB process.
 * It only writes a request flag (`src/server/sync/manual-sync.ts`), which the worker polls for
 * every minute and then runs through the exact same pipeline an hourly tick uses, tagged tier
 * 'manual'. Politeness (no stacking a second run) is enforced by `requestManualSync` itself,
 * checking `sync_runs` state — this action just surfaces whatever it decides.
 */
export async function syncNowAction(): Promise<void> {
  await requireCommissioner();

  const db = getDb();
  const result = requestManualSync(db);
  if (!result.ok) {
    redirect(`/admin?syncError=${encodeURIComponent(result.message)}#sync-status`);
  }

  redirect("/admin?success=sync_requested#sync-status");
}
