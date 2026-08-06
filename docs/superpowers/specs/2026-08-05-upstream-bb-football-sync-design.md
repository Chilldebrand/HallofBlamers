# Hall of Blamers upstream BB_Football synchronization design

## Goal

Transplant the generic application changes between the originally imported BB_Football snapshot
(`d72bbb0`) and its current `main` (`12c8876`) into Hall of Blamers without replacing its
repository history or importing the source league's identity, credentials, data, or operations.

## Scope and preservation boundaries

The synchronization includes generic UI, analytics, statistics, migrations, operational tooling,
and optional integrations from upstream. It preserves Hall of Blamers-specific behavior:

- Hall of Blamers names, assets, icons, navigation labels, and visual identity.
- Private ESPN league `1690915927`, local database, locally stored ESPN cookies, seeds,
  corrections, snapshots, and manager invitations.
- The existing invite-link authentication flow. Upstream authentication additions may be added only
  when they do not remove or bypass invite authorization.
- The user's uncommitted `AGENTS.md` edit.

Source-league credentials, seed data, generated databases, raw archives, personal copy, and source
repository metadata remain excluded.

## Approach

Apply changes incrementally in dependency order rather than attempting a Git fast-forward or a
wholesale overwrite. The local history has no shared ancestor with BB_Football, so a direct merge
would neither be safe nor meaningful.

1. Compare the source snapshot to upstream `main`, classify each changed path, and reject
   source-league data/identity files before importing anything.
2. Apply schema/migration and shared server changes first. Reconcile migration numbering and verify
   they are safe for the existing local Hall of Blamers database.
3. Apply generic feature waves in dependency order (analytics and data tools before pages and
   navigation), preserving Hall of Blamers overlays whenever a source change conflicts.
4. Add optional integrations in a configuration-disabled state. No Discord, web-push, AI, or other
   third-party secret is added or transmitted without the commissioner's explicit setup.
5. Retain invite authorization. Any upstream PIN/login functionality is integrated only as a
   commissioner-controlled complement, never as an unauthenticated replacement.
6. Re-run normalizer/stat builds as needed after schema/data-pipeline changes, then test, typecheck,
   lint, build, identity audit, and browser smoke tests.

## Error handling and rollback

Each coherent upstream wave is committed independently. Conflicts default to the Hall of Blamers
version for branding, private configuration, and auth boundaries, and to upstream for generic
features/fixes. A failing migration or verification halts the current wave before later changes
are applied. Local private data remains ignored by Git and is never rolled back or overwritten by
source content.

## Completion criteria

- Hall of Blamers contains all applicable upstream generic changes through `12c8876`.
- No source-league identity, credentials, data, or Git history is imported.
- Existing local ESPN history and commissioner access continue to work.
- All project checks pass, and a signed-in local browser renders league history after the sync.
