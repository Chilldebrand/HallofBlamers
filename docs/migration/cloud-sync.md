# Cloud refresh operations

The cloud worker reads protected ESPN credentials from Supabase, fetches current league data, computes a complete statistics generation in temporary memory, then publishes normalized rows and statistics in one Postgres transaction. The original local database remains a rollback copy. Failed publication leaves the prior generation available.

## GitHub setup

In repository Settings → Secrets and variables → Actions, add repository secret `HOB_DATABASE_PASSWORD` containing the dedicated Hall of Blamers Supabase database password. Never add the website login password, ESPN cookies, or a password to a workflow file.

Run **Refresh ESPN data** manually with `hourly` and **Validate without publishing** checked. After success, run once with that box unchecked and verify the last-update timestamp. Then set repository variable `HOB_SYNC_ENABLED` to `true`. Set it to `false` to pause scheduled ingestion. Manual runs remain available.

Only trusted repository administrators should edit or dispatch this workflow: its database credential permits privileged database operations. The workflow runs only on schedules or explicit dispatch, never on pull requests, and has read-only GitHub permissions. Do not expose private snapshots in Actions logs or artifacts.

## Initial cadence and budget

- Hourly during Thursday/Monday 8pm–midnight and Sunday 12:55pm–midnight, evaluated in America/New_York with DST handling.
- Every six hours outside those windows, plus one daily refetch of elapsed weeks for corrections. GitHub schedules are best effort, not real-time guarantees.
- September 30 measurements: full Week 4 publication took 27.6 seconds with nine ESPN requests; a cached hourly trial took 6.8 seconds with three requests and 8.21 MB of database input. Database size after publication was 99.04 MB.
- This cadence represents roughly 230 computations per month, or 1.9 GB of serialized database input at the measured size, before protocol overhead and site usage. It replaces the provisional 15-minute/all-day-hourly plan until further transfer reduction is measured. This is an estimate, not a quota guarantee; review Supabase usage after enabling.
- The worker refuses computation above 32 MB input or publication, and pauses ingestion when database size reaches 350 MB. Raw snapshots are immutable and accumulate; archive/retention work remains necessary before approaching that limit. No paid upgrade or destructive cleanup is automatic.

## Recovery

GitHub concurrency and a Postgres session advisory lock prevent overlapping writers. A terminated job releases the database lock when its connection closes; the next run marks abandoned running records failed before starting. An ESPN authentication failure retains the last successful data and requires credential renewal in the protected backend. The UI reports failure without advancing its successful-update timestamp.

For local operator runs, use the ignored database environment file and the verified public CA certificate:

```powershell
$env:NODE_EXTRA_CA_CERTS=(Resolve-Path '.superpowers/sdd/2026-09-29-github-pages-supabase/prod-ca-2021.crt').Path
node --env-file=.env.supabase.local --import tsx worker/cloud/cli.ts hourly --dry-run
```

Remove `--dry-run` only to publish. `daily` revisits all elapsed weeks; `live` fetches the current box score and is gated by game windows and active season state. No historical backfill or paid AI/audio service is enabled by this workflow.
