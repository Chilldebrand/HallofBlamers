# Migration checkpoint — September 30, 2026

The dedicated Supabase backend is connected and populated. The website is still an incomplete local preview and has not been deployed to GitHub Pages.

## Hosted verification

- Project: HallofBlamers (`aridozcvdxlfnibcnejf`), DaleDanTony Free organization, Canada Central.
- Four migrations applied, including full-precision numeric output for the standings API.
- All 51 application tables imported from the consistent backup; zero rejected rows. Import took approximately 9.4 minutes.
- Complete row-count and value-hash reconciliation passed with no mismatches. Hosted database size measured 90,221,715 bytes, below the planned 350 MB launch target.
- Initial comparison exposed Supabase's `extra_float_digits=0` text rounding. Stored values were intact. The checker now requests exact float output and restores the previous session setting; the API uses exact float output too. Regression tests detect genuine changes even as small as 0.30000000000000004 versus 0.3.
- All 54 private tables have RLS enabled; neither anonymous nor authenticated roles can access the raw schema. Anonymous REST calls return null for viewer and deny standings/shell (401 / 42501).
- Authenticated standings returned six seasons, 12 franchises for the default 2025 season, and 15 career franchises. The temporary test membership was rolled back.
- The user created and confirmed their website account. It is linked to the sole legacy commissioner record. Successful browser login, commissioner navigation, loaded league data, and career hash-route reload were verified in the local preview.
- TLS certificate/hostname verification remains enabled. The certificate was downloaded from the official link in the project's SSL settings. No security checks were bypassed.

## Local verification and rollback

- Consistent SQLite backup: ignored `data/migration-2026-09-29/league-2026-09-30.db`; quick_check returned ok. Original database preserved.
- Prior full suite: 117 files / 1,367 tests passed. This continuation adds two regression tests: migration suite 7/7 and read-policy suite 3/3 pass. Root TypeScript and targeted ESLint pass after the fixes.
- Both TypeScript configurations and Pages build passed at the previous checkpoint. Original Next production build passed at the earlier foundation checkpoint.
- Preserve the existing uncommitted AGENTS.md edit. No DWS resources changed, no paid plan selected, and no unsolicited emails sent.

## Remaining work

Standings is the only fully connected league page in the static client. Other read pages, invitation UI, mutations, cloud sync worker, backup/restore validation, final whole-branch review, and GitHub Pages deployment remain unfinished. Do not publish this preview as the finished website. Imported sync timestamps describe the old local data; scheduled cloud ingestion is not enabled.

The user has completed the database-password and account-creation handoffs. Do not request those again. Their credentials are not in Git. Future hosted commands use the ignored `.env.supabase.local` and `NODE_EXTRA_CA_CERTS` pointing to the official certificate under `.superpowers/sdd/2026-09-29-github-pages-supabase/prod-ca-2021.crt`.

Continue the existing approved plan in the existing worktree. Consult its ledger; do not redo the completed import or create another Supabase project.
