# Hall of Blamers operations

GitHub Pages builds only web/dist through .github/workflows/pages.yml. The repository public-config.json contains only the Supabase URL and publishable key. Private league access is enforced by Supabase membership RPCs. No database secret is available to the Pages job.

Pushes to main run tests, typechecks, identity checks, the static build and artifact audit before deployment. To roll back the website, revert the offending commit and let the Pages workflow republish. The original Next/SQLite app and consistent SQLite backup remain available. Do not re-import that old database over current hosted data.

## Private backup

Run node --env-file=.env.supabase.local --import tsx migration/backup-postgres.ts data/private-backups/UNIQUE-NAME with NODE_EXTRA_CA_CERTS set to the official certificate. The command saves all hob_private tables and sequences from a repeatable-read snapshot plus migrations; then restores into an isolated in-memory PostgreSQL engine and compares all rows. Existing destinations are refused. Backups remain gitignored and must never be uploaded as Actions artifacts. This is an application backup, not a backup of Supabase-managed Auth accounts; retain the Supabase project for existing logins or recreate accounts and relink membership during disaster recovery.

Launch backup: data/private-backups/launch-2026-09-30; 55 tables and 30,097 rows verified. The restore verifier can be rerun with --verify-only after the backup directory argument. Production restore is deliberately not automated: provision a separate project, apply archived migrations, restore parent tables before immediate-FK membership/invite/cache tables, preserve sequence states, reconcile every row, then change public configuration only after auth policy checks.

## Refresh and free tier

Scheduled ESPN refresh is enabled. Commissioners who own the repository can use Admin’s GitHub link to run the refresh workflow; a website-only queued refresh is deferred. Never grant league managers GitHub access just to refresh scores. Failed refreshes retain the last good generation. Check Actions logs, correct credentials privately if necessary, then retry once; never expose raw ESPN cookies in the frontend.

After an off-season pause, resume the Supabase project in its dashboard, check membership login, then run a daily refresh before relying on current standings. See cloud-sync.md for measured transfer and schedule assumptions. Keep database size below the 350 MB operational guard; review storage before changing retention. No automatic snapshot deletion is configured.

Rotate the database password through Supabase and update the ignored local environment and existing HOB_DATABASE_PASSWORD GitHub secret. Rotate ESPN session credentials only in protected app_settings. Never print either credential.
