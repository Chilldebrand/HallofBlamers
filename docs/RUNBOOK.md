# Hall of Blamers Operations Runbook

This is the owner's manual for running the league site. You don't need to know how to code to
use it — every operation is one script with one obvious name, living in `ops/`. Run them from
inside the cloned repo folder on the box, e.g. `./ops/status.sh`.

If something here doesn't match what actually happens when you run it, that's a bug in this
document — let Claude know and it'll get fixed.

**Contents**
1. [First-time setup](#1-first-time-setup)
2. [Routine operations](#2-routine-operations)
3. [Incident playbook](#3-incident-playbook)
4. [Inviting league mates](#4-inviting-league-mates)
5. [Verifying backups monthly](#5-verifying-backups-monthly)
6. [Offsite backup copy (rclone)](#6-offsite-backup-copy-rclone)

---

## 1. First-time setup

You need: a small always-on Linux box (a cheap VPS, a Raspberry Pi, an old laptop — anything
that stays on) reachable over SSH, and a Cloudflare account (free tier is fine) if you're using a
custom domain.

### 1.1 Get the code onto the box

SSH into the box, then:

```bash
git clone <your-repo-url> hallofblamers
cd hallofblamers
./ops/setup.sh
```

`ops/setup.sh` does everything else in this section for you:
- Installs Docker if it isn't already there.
- Creates `.env` from `.env.example` and asks you for each value it needs (explained below —
  press Enter to skip anything you don't have yet and fill it in later).
- Builds the site and starts it up.
- Tells you what to do next.

The rest of this section explains what those prompts are asking for, in case you want the detail
or need to fill something in later.

Before the first historical import, follow the private local-data workflow in
[`HALLOFBLAMERS-BOOTSTRAP.md`](HALLOFBLAMERS-BOOTSTRAP.md). It keeps league mappings, corrections,
credentials, and operational data out of Git.

### 1.2 Box timezone

The worker's own schedule (hourly/daily sync, the 4:30am nightly backup) doesn't depend on the
box's system clock — its code tells the scheduler `timezone: "America/New_York"` explicitly (see
`worker/index.ts`), so it runs on league time no matter what timezone the box itself is set to.

The host's regular `cron` — used later in [§6](#6-offsite-backup-copy-rclone) for the offsite
backup copy — has no such luxury: a plain crontab line just runs at that hour in the box's
**system** timezone. Most VPS images default to UTC, not Eastern, so it's worth checking/setting
this now rather than discovering it later when a "5am" cron line turns out to mean 5am UTC
(12-1am Eastern, depending on daylight saving) instead:

```bash
timedatectl status                                # check what it's currently set to
sudo timedatectl set-timezone America/New_York    # set it, if it isn't already
```

This also just makes every timestamp you see in `ls -la data/backups/`, `./ops/logs.sh`, etc.
read in the timezone the league actually runs on — worth doing regardless of whether you set up
§6.

### 1.3 ESPN league id and cookies

- **ESPN league id**: the number in your league's ESPN URL, e.g.
  `fantasy.espn.com/football/league?leagueId=1690915927` → `1690915927`.
- **ESPN_S2 / SWID cookies** (private leagues only — skip for a public league): with a browser
  logged into ESPN Fantasy and your league page open, open DevTools (F12) → Application (Chrome)
  or Storage (Firefox) → Cookies → `fantasy.espn.com`. Copy the `espn_s2` value and the `SWID`
  value (keep SWID's `{curly braces}`) exactly as shown — don't trim or decode anything.

These only matter for the very first sync. After that, the database is the source of truth — see
[3. Incident playbook](#espn-credentials-expired) for how to rotate them later.

### 1.4 Anthropic API key (optional)

Only needed for the AI-written weekly recaps feature. Get one from
[console.anthropic.com](https://console.anthropic.com) → API Keys. Leave it blank and everything
else on the site works fine.

### 1.5 Creating the Cloudflare Tunnel

Choose a **configured public hostname** in Cloudflare. This is what makes the site reachable there without
opening any port on your router or exposing the box's IP address.

1. Go to the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/) → **Networks →
   Tunnels → Create a tunnel**.
2. Choose **Cloudflared** as the connector type, give the tunnel a name (e.g. `hallofblamers`).
3. On the "Install and run a connector" step, Cloudflare shows you a command containing a long
   token after `--token`. You only need that token — you're running the connector via Docker
   Compose, not the command it suggests, so don't run it directly on the box.
4. Copy just the token value into `.env` as `CLOUDFLARE_TUNNEL_TOKEN` (setup.sh already prompted
   you for this; if you skipped it, edit `.env` directly then run `./ops/deploy.sh`).
5. Back in the dashboard, add a **Public Hostname** using the configured public hostname, service type
   `HTTP`, address `web:3000` (the Docker Compose service name and internal port — NOT
   `localhost`, which would mean "inside the cloudflared container itself"). Since the zone is
   already on this Cloudflare account, DNS is set up automatically as part of adding the
   hostname.
6. Optionally add a second Public Hostname such as `www.<configured-public-hostname>` pointed at the same
   `web:3000` address, if you want both to work.
7. Save. Within a minute or two, the configured public hostname should load the site over HTTPS automatically
   — Cloudflare handles the certificate, nothing to configure on the box for that part.

**Note:** the site's login uses secure (HTTPS-only) cookies, so it will not work at all over
plain `http://`. The tunnel isn't optional if anyone needs to log in from outside the box itself.

#### Fallback: Tailscale Funnel

If the Cloudflare Tunnel is ever down, misconfigured, or you need the site reachable while you're
untangling a Cloudflare-side problem, [Tailscale](https://tailscale.com) Funnel is a free,
independent path to a working HTTPS URL (a `*.ts.net` address, not the configured public hostname) that
doesn't touch the Cloudflare tunnel/DNS at all — useful specifically because it fails
independently of anything above.

1. Install Tailscale on the box: `curl -fsSL https://tailscale.com/install.sh | sh`, then
   `sudo tailscale up` and follow the login link it prints.
2. In the [Tailscale admin console](https://login.tailscale.com/admin/dns), enable **HTTPS
   Certificates** for your tailnet (under DNS settings) if you haven't already — Funnel needs
   this.
3. Run `sudo tailscale funnel 3000 on`. This forwards public HTTPS traffic to
   `http://127.0.0.1:3000` — which is exactly what `web`'s Docker Compose port mapping already
   exposes (see `docker-compose.yml`), so no extra configuration is needed on the app side.
4. Tailscale prints the public URL (something like `https://your-box-name.your-tailnet.ts.net`).
   Share that instead of the configured public hostname for as long as you're using it.
5. This runs alongside the Cloudflare Tunnel with no conflict — `cloudflared` can keep running
   (or retrying) in the background; you don't need to stop it just to use Funnel temporarily.
   Turn Funnel back off when you're done: `sudo tailscale funnel 3000 off`.

### 1.6 Set up the first commissioner

The database ships with no managers at all — you (the commissioner) are the first. From the box:

```bash
docker compose exec web npm run seed:managers
```

Follow its prompts to create your own manager row (name, franchise, commissioner role). Then log
in at your site's URL — the login page explains how, or see
[4. Inviting league mates](#4-inviting-league-mates) for the general flow, which is the same one
you'll use for yourself.

---

## 2. Routine operations

Every script below is run from inside the repo folder on the box (`cd hallofblamers` first if you're
not already there).

| Script | What it does |
|---|---|
| `./ops/status.sh` | One-shot snapshot: are the containers up, is the site healthy, when did it last sync, how much disk is left. Your first move whenever something seems off. |
| `./ops/deploy.sh` | Pulls the latest code and redeploys. Run this whenever there's a new change to go live. |
| `./ops/logs.sh` | Live-tails the logs from all three services. `./ops/logs.sh worker` to watch just one. Ctrl+C to stop. |
| `./ops/backup-now.sh` | Takes an on-demand database backup right now, outside the nightly schedule. |
| `./ops/restore.sh <file>` | Replaces the live database with a backup file. Destructive — has a big confirmation prompt. |

### Deploying a change

```bash
./ops/deploy.sh
```

This pulls the latest git commits, rebuilds the Docker image, restarts both `web` and `worker`
with zero-downtime-ish rolling restart (Compose recreates one container at a time), removes old
unused images, and then polls `/api/health` until the site reports healthy — printing a clear
`DEPLOY OK` or `DEPLOY FAILED` at the end. On `DEPLOY FAILED`, run `./ops/logs.sh` to see why.

**Database migrations run automatically as part of this** — you never need to do anything extra
for a normal deploy, even one that changes the database. Before `web` or `worker` start, a
one-shot `migrate` step applies any new database changes and exits; only once that's finished
successfully do `web` and `worker` start up. This is what stops a very real failure mode: the site
serving pages against a database that's missing a table or column a new update needs.

- **What it looks like when it works:** nothing extra to notice — `deploy.sh` just prints
  `DEPLOY OK` as usual. If you're curious, `./ops/logs.sh migrate` shows a line like
  `Migrations applied from ...` (or nothing changed, if there was nothing new to apply — that's
  normal too, not an error).
- **What it looks like when it fails:** `deploy.sh` stops immediately and prints
  `DEPLOY STOPPED`, pointing you at `./ops/logs.sh migrate` for the actual error. Neither `web`
  nor `worker` is (re)started in this case — Compose's design is to leave whatever was already
  running from before untouched rather than tear the site down for a failed update, so there's no
  rush, but the update didn't go live until this is fixed (`./ops/status.sh` confirms what's
  actually running either way — get in touch, this isn't something to debug from `/admin`).
- **You may also see `migrate` listed as `Exited (0)` in `./ops/status.sh`'s container list** —
  that's expected, not a problem. It's a one-shot step that finishes and stops on purpose; `web`,
  `worker`, and `cloudflared` are the ones that should show `Up`/healthy.
- **Manual fallback**, if you ever need to (re)apply migrations by hand without a full deploy —
  for example while debugging on the box directly:
  ```bash
  docker compose run --rm migrate
  ```
  This applies any pending database migrations and exits; safe to run any time, even if there's
  nothing new to apply.

### Watching logs

```bash
./ops/logs.sh          # everything
./ops/logs.sh worker   # just the sync/backup process
./ops/logs.sh web      # just the web server
```

### Live scoring (in-season)

During the season, the worker also runs a **live** sync tier — separate from the hourly/daily
ones above — every 2 minutes during three named game windows (all times America/New_York,
matching typical NFL kickoffs): **Thursday 8:00–11:58pm**, **Sunday 12:55pm–11:58pm**, and
**Monday 8:00–11:58pm**. This is what powers the live-updating scoreboard on the home page, the
current week's matchup cards, and the "Just In" ticker strip (lead changes, finals, records,
beatdowns) — none of that needs anything from you; it just works once the season's underway.

- **What it looks like when it's working:** during a game window, `/admin`'s Sync Status table
  shows new rows with `tier: live` appearing every couple of minutes. `./ops/logs.sh worker` shows
  a `live sync tick finished` line at the same cadence.
- **What "nothing happening" looks like, and when that's normal:** outside a game window (any
  other time — including Tue/Wed/Thu-before-8pm), the worker deliberately does nothing for the
  live tier and records no `sync_runs` row at all. Also normal in the run-up to a season: ESPN
  generates the full schedule months before Week 1 actually kicks off, so ticks stay silent even
  during a "window" until the season has genuinely started. Neither is a bug — see
  `src/server/sync/run-tier.ts`'s `isSeasonUnderway` for the exact signal this gates on.
- **If live scores genuinely aren't updating during a real game window:** treat it the same as any
  other stuck sync — check `./ops/logs.sh worker` for errors first, then work through
  [ESPN credentials expired](#espn-credentials-expired) below if it's an auth problem.

### Triggering a sync manually ("Sync Now")

Don't want to wait for the next scheduled hourly tick (e.g. right after fixing expired cookies, or
just to double-check something synced)? `/admin`'s **Sync Status** section has a **Sync Now**
button. Clicking it doesn't sync instantly — it queues a request the worker picks up within a
minute (same pipeline an hourly tick uses, just recorded as `tier: manual` in the table so you can
tell it apart from an automatic one).

**Only one sync ever runs at a time, of ANY kind.** The button disables itself while a request is
queued or a sync (manual, hourly, daily, or live) is already running — and that "only one at a
time" rule is symmetric: an hourly/daily/live tick due to fire automatically will likewise wait
its turn rather than start on top of a manual sync you just kicked off (this matters most during a
game window, when the live tier fires every 2 minutes). Nothing stacks; a busy tier just tries
again on its own next scheduled tick.

**If the worker crashes mid-sync** (killed, out of memory, host reboot), the sync it was running
can be left showing `running` forever in the table, which would otherwise block every future sync
— manual and automatic alike — since "one at a time" has no way to know that run is actually dead.
Two things prevent that from becoming a real problem: (1) any `running` row **older than 15
minutes** is automatically treated as not-actually-running by every tier's own check, so the
system unblocks itself within 15 minutes even if nothing else happens; (2) every time the worker
process itself (re)starts, it also explicitly marks any such stale `running` row `failed` — so
after a restart (`./ops/deploy.sh`, or the container just coming back up) the table shows an honest
`failed` instead of a misleading `running` that never finishes. You don't need to do anything for
either of these; they're automatic.

### Backups

The `worker` service takes a backup automatically every night at 4:30am Eastern
(`VACUUM INTO data/backups/league-<date>.db`, keeping the newest 14 — see
`src/server/db/backup.ts`). To take one right now instead of waiting:

```bash
./ops/backup-now.sh
```

Backups live in `data/backups/` on the box, named `league-YYYY-MM-DD.db`.

### Restore drill

Worth actually doing once, so you're not learning the process for the first time during a real
incident:

1. Take a fresh backup first: `./ops/backup-now.sh`.
2. Pick a backup file: `ls data/backups/`.
3. Run `./ops/restore.sh data/backups/league-<date>.db`.
4. Read the warning. Type `restore` exactly (not `y`, not `yes`) to confirm — anything else
   cancels safely, nothing is touched.
5. The script stops the stack, saves a safety copy of whatever database was live (in case you
   picked the wrong file), copies the backup into place, restarts, and waits for `/api/health`
   to come back healthy.
6. Confirm with `./ops/status.sh` that `lastSync` and `buildId` look sane for the restored data.

---

## 3. Incident playbook

### Site is down / unreachable

1. `./ops/status.sh` — this tells you container status, site health, and disk space in one shot.
2. If a container isn't running: `docker compose up -d` restarts everything without rebuilding.
3. If it's still unhealthy after that: `./ops/logs.sh` and look for the error near the bottom.
4. If nothing obvious jumps out, `./ops/deploy.sh` does a full rebuild + restart, which fixes
   most "got into a weird state" problems.

### <a name="espn-credentials-expired"></a>ESPN credentials expired

You'll see this in `./ops/logs.sh worker` or on the `/admin` Sync Status table as
`auth_failed` sync runs, with an error mentioning ESPN authentication. `/admin` itself also shows
a red "ESPN cookies expired" banner in its **ESPN Connection** section whenever the most recent
sync run failed this way.

ESPN's cookies are read from the database first, only falling back to `.env`'s `ESPN_S2` /
`ESPN_SWID` on an install that has never stored anything yet — so once the site has synced
successfully even once, **just editing `.env` again does nothing**; the stale database copy keeps
winning. Rotate the stored copy instead, either from the phone-friendly admin form (preferred) or
by hand (fallback, e.g. if the site itself is unreachable).

**Preferred: rotate from `/admin` (no SSH needed)**

1. Get fresh cookie values the same way as first-time setup (§1.3).
2. On `/admin`, scroll to **ESPN Connection**. Paste the new `espn_s2` and `SWID` values exactly
   as copied (keep SWID's `{curly braces}` — the form rejects a SWID pasted without them rather
   than silently fixing it) and click **Save Cookies**. Use **Test Connection** — before or after
   saving — to confirm ESPN actually accepts them; it shows the league name on success or a plain
   failure reason if not, without ever displaying the cookie values back on the page.
3. **Required next step — restart the worker.** Saving alone is not enough: the ESPN client is
   built once at worker process startup and reused for every tick (see
   `src/server/sync/run-tier.ts`'s `authErrorMessage`), so the worker keeps failing with the OLD
   cookies until the process restarts, even though the new ones are already saved. The success
   screen on `/admin` repeats this same reminder. SSH in and run `./ops/deploy.sh` (or
   `docker compose restart worker`), then `./ops/status.sh` a few minutes later (after the next
   hourly sync) to confirm `lastSync.status` is `ok` again.

**Fallback: manual DB edit (if `/admin` itself is unreachable)**

1. Get fresh cookie values the same way as first-time setup (§1.3).
2. Edit `.env` with the new `ESPN_S2` / `ESPN_SWID` values.
3. Clear the stale, stored copies so the fresh `.env` values get picked back up:
   ```bash
   docker compose exec web node -e "
   const db = require('better-sqlite3')('/data/league.db');
   db.prepare(\"DELETE FROM app_settings WHERE key IN ('espn_s2','swid')\").run();
   console.log('Cleared — next sync will read the new cookies from .env.');
   "
   ```
4. `./ops/deploy.sh` to restart everything with the new `.env` values, then `./ops/status.sh` a
   few minutes later (after the next hourly sync) to confirm `lastSync.status` is `ok` again.

### Disk full

1. `./ops/status.sh` shows disk usage for `data/` and the whole box.
2. The database itself only grows slowly. The most likely culprit is `data/backups/` if
   retention pruning somehow isn't running — it should never hold more than 14 nightly backups
   plus whatever you've made manually. `ls -la data/backups/` and remove anything you don't
   need: `rm data/backups/league-<date>.db`.
3. Old, unused Docker images/layers can also add up over many deploys —
   `docker system df` shows what's using space, `docker image prune -f` (also run automatically
   by `./ops/deploy.sh`) clears unused images.
4. If it's still tight, check `docker compose logs` output size — the compose file caps each
   container's logs at 10MB × 3 files, so this shouldn't be a large contributor, but
   `docker system df -v` will show you if it somehow is.

---

## 4. Inviting league mates

There's no self-service signup — every manager account is created by the commissioner from
`/admin`, and joining is a one-time link.

1. Log into the site as commissioner, go to **/admin**.
2. Under "Managers & Invite Links", fill in the new manager's **name**, pick their **franchise**,
   leave role as **Manager** (only pick Commissioner for a co-commissioner), click **Add Manager**.
3. A banner appears once, at the top of the page: `For <name>: /join/<token>` — that path, appended
   to your configured public hostname, is their invite link (e.g. `<configured-public-hostname>/join/abc123...`).
   **Copy it now** — this banner only shows once and the link is never displayed again anywhere
   in the UI.
4. Send that full URL to them however you'd normally reach them (text, group chat, email). When
   they open it, they're logged in immediately — no password, no account creation step on their
   end.
5. If a link gets lost, leaked, or you just want to issue a new one: find that manager in the
   table and click **Regenerate Invite Link** — this immediately invalidates the old link and
   shows a fresh one-time banner with the new one.

---

## 5. Verifying backups monthly

A backup you've never tested is a hope, not a backup. Once a month:

1. `./ops/status.sh` — confirm `lastSync` looks recent and healthy, and note today's date.
2. `ls -la data/backups/` — confirm there's a file dated within the last day or two, and roughly
   14 files total (older ones should already be pruned).
3. Do the actual [restore drill](#restore-drill) from §2 against the most recent backup. This is
   the only way to know restores actually work, not just that files exist.
4. If you've set up the offsite copy (§6), also spot-check that the same recent file shows up in
   Google Drive.

---

## 6. Offsite backup copy (rclone)

Local backups protect you from bad data or a bad deploy. They don't protect you if the box itself
dies or the disk fails. [rclone](https://rclone.org) syncing `data/backups/` to a Google Drive
folder covers that — this is documented here as manual steps, not scripted, since it walks you
through an interactive Google login that can't be automated safely.

### One-time setup

1. Install rclone on the box: `curl https://rclone.org/install.sh | sudo bash`.
2. Run `rclone config` and follow the prompts:
   - `n` for a new remote.
   - Name it `gdrive` (the crontab line below assumes this name).
   - Storage type: `drive` (Google Drive).
   - Leave `client_id` / `client_secret` blank (press Enter) — rclone's own defaults are fine for
     personal use.
   - Scope: `drive.file` (rclone can only see/manage files and folders IT creates — the more
     conservative, recommended option; not your whole Drive).
   - Leave `root_folder_id` and `service_account_file` blank.
   - When asked "Use auto config?", answer **No** — this is a headless server with no browser.
     rclone prints a URL; open it on your own laptop/phone, sign into the Google account you want
     backups in, approve access, and paste the resulting verification code back into the
     terminal.
   - Confirm the remote, and `q` to quit config.
3. Test it: `rclone lsd gdrive:` should print (probably empty) folder listing, not an error.

### The actual sync

**Before adding this, make sure the box's system timezone is actually America/New_York** — see
[§1.2](#12-box-timezone). This matters more here than almost anywhere else in this document: the
worker's own nightly backup schedule is immune to the box's system timezone (its code sets
`timezone: "America/New_York"` explicitly), but a plain crontab line has no such protection — it
just fires at that clock hour in whatever timezone the box's clock is set to. On a box still
running the common VPS default (UTC), the "5am" line below would actually fire at 5am UTC
(roughly midnight-1am Eastern, depending on daylight saving) — BEFORE the 4:30am ET backup has
even run, syncing yesterday's files or, worse, racing a backup still mid-write. `timedatectl
status` (from §1.2) confirms which situation you're in before you rely on this.

Add this to the box's crontab (`crontab -e`), running daily after the nightly database backup
(4:30am ET) has had time to finish:

```
0 5 * * * rclone sync /home/<you>/hallofblamers/data/backups gdrive:hallofblamers-backups --min-age 1h >> /var/log/hallofblamers-rclone.log 2>&1
```

Replace `/home/<you>/hallofblamers` with wherever you actually cloned the repo (`pwd` from inside it
tells you). `rclone sync` mirrors exactly — a file deleted locally by the 14-day retention prune
also disappears from Drive, so Drive never accumulates more than local retention keeps.
`--min-age 1h` skips any file still less than an hour old, avoiding a race with a backup that's
still being written.

Verify it's working: `ls -la /var/log/hallofblamers-rclone.log` after the next scheduled run, and
check the `hallofblamers-backups` folder actually appears in Google Drive.
