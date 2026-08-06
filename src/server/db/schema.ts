// Drizzle schema for Hall of Blamers's three data layers:
//   1. snapshots     — raw archive (immutable, verbatim ESPN responses)
//   2. normalized     — rebuilt idempotently from snapshots (+ corrections)
//   3. app/operational — events, sync_runs, app_settings, recaps, etc.
//
// See AGENTS.md for the architecture rules this schema encodes.

import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Layer 1 — raw archive (immutable)
// ---------------------------------------------------------------------------

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    season: integer("season").notNull(),
    scoringPeriod: integer("scoring_period"),
    view: text("view").notNull(),
    url: text("url").notNull(),
    fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
    httpStatus: integer("http_status").notNull(),
    // Raw ESPN response body, stored verbatim — never parsed/re-serialized.
    payload: text("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    superseded: integer("superseded", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    index("snapshots_season_view_period_fetched_idx").on(
      t.season,
      t.view,
      t.scoringPeriod,
      sql`${t.fetchedAt} desc`,
    ),
    index("snapshots_payload_hash_idx").on(t.payloadHash),
  ],
);

export type Snapshot = typeof snapshots.$inferSelect;
export type NewSnapshot = typeof snapshots.$inferInsert;

// ---------------------------------------------------------------------------
// Layer 2 — normalized (rebuilt idempotently from snapshots)
// ---------------------------------------------------------------------------

export const leagues = sqliteTable("leagues", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  espnLeagueId: integer("espn_league_id").notNull().unique(),
  name: text("name").notNull(),
  firstSeason: integer("first_season").notNull(),
});

export type League = typeof leagues.$inferSelect;
export type NewLeague = typeof leagues.$inferInsert;

export const seasons = sqliteTable("seasons", {
  season: integer("season").primaryKey(),
  leagueId: integer("league_id")
    .notNull()
    .references(() => leagues.id),
  settingsJson: text("settings_json", { mode: "json" }).notNull(),
  scoringJson: text("scoring_json", { mode: "json" }).notNull(),
  playoffFormatJson: text("playoff_format_json", { mode: "json" }).notNull(),
  teamCount: integer("team_count").notNull(),
  regSeasonWeeks: integer("reg_season_weeks").notNull(),
  status: text("status", { enum: ["upcoming", "active", "complete"] as const }).notNull(),
});

export type Season = typeof seasons.$inferSelect;
export type NewSeason = typeof seasons.$inferInsert;

export const franchises = sqliteTable("franchises", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  canonicalName: text("canonical_name").notNull(),
  managerName: text("manager_name").notNull(),
  joinedSeason: integer("joined_season").notNull(),
  departedSeason: integer("departed_season"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  accentColor: text("accent_color"),
  notes: text("notes"),
});

export type Franchise = typeof franchises.$inferSelect;
export type NewFranchise = typeof franchises.$inferInsert;

// Display only — stats never split by manager; franchise is the atomic unit.
export const franchiseManagers = sqliteTable("franchise_managers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  franchiseId: integer("franchise_id")
    .notNull()
    .references(() => franchises.id),
  managerName: text("manager_name").notNull(),
  espnOwnerSwid: text("espn_owner_swid"),
  fromSeason: integer("from_season").notNull(),
  toSeason: integer("to_season"),
});

export type FranchiseManager = typeof franchiseManagers.$inferSelect;
export type NewFranchiseManager = typeof franchiseManagers.$inferInsert;

export const teamSeasons = sqliteTable(
  "team_seasons",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    season: integer("season")
      .notNull()
      .references(() => seasons.season),
    franchiseId: integer("franchise_id")
      .notNull()
      .references(() => franchises.id),
    espnTeamId: integer("espn_team_id").notNull(),
    teamName: text("team_name").notNull(),
    abbrev: text("abbrev"),
    logoUrl: text("logo_url"),
    divisionId: integer("division_id"),
    wins: integer("wins").notNull(),
    losses: integer("losses").notNull(),
    ties: integer("ties").notNull(),
    pointsFor: real("points_for").notNull(),
    pointsAgainst: real("points_against").notNull(),
    finalStanding: integer("final_standing"),
    madePlayoffs: integer("made_playoffs", { mode: "boolean" }).notNull(),
  },
  (t) => [unique("team_seasons_season_espn_team_id_unique").on(t.season, t.espnTeamId)],
);

export type TeamSeason = typeof teamSeasons.$inferSelect;
export type NewTeamSeason = typeof teamSeasons.$inferInsert;

export const weeks = sqliteTable(
  "weeks",
  {
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    scoringPeriodId: integer("scoring_period_id").notNull(),
    weekType: text("week_type", {
      enum: ["regular", "playoff", "consolation", "championship"] as const,
    }).notNull(),
    isComplete: integer("is_complete", { mode: "boolean" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.season, t.week] })],
);

export type Week = typeof weeks.$inferSelect;
export type NewWeek = typeof weeks.$inferInsert;

export const matchups = sqliteTable(
  "matchups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    espnMatchupId: integer("espn_matchup_id").notNull(),
    homeTeamSeasonId: integer("home_team_season_id")
      .notNull()
      .references(() => teamSeasons.id),
    // Nullable: byes have no away team.
    awayTeamSeasonId: integer("away_team_season_id").references(() => teamSeasons.id),
    homeScore: real("home_score").notNull(),
    awayScore: real("away_score").notNull(),
    homeProjected: real("home_projected"),
    awayProjected: real("away_projected"),
    playoffTier: text("playoff_tier"),
    multiWeekGroup: text("multi_week_group"),
    isFinal: integer("is_final", { mode: "boolean" }).notNull(),
    winner: text("winner", { enum: ["home", "away", "tie"] as const }),
  },
  (t) => [
    unique("matchups_season_week_espn_matchup_id_unique").on(t.season, t.week, t.espnMatchupId),
  ],
);

export type Matchup = typeof matchups.$inferSelect;
export type NewMatchup = typeof matchups.$inferInsert;

export const players = sqliteTable("players", {
  // Not autoincrement — ESPN's own player id is the primary key.
  espnPlayerId: integer("espn_player_id").primaryKey(),
  fullName: text("full_name").notNull(),
  defaultPosition: text("default_position").notNull(),
  proTeam: text("pro_team"),
  headshotUrl: text("headshot_url"),
});

export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;

export const rosterSlots = sqliteTable(
  "roster_slots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    teamSeasonId: integer("team_season_id")
      .notNull()
      .references(() => teamSeasons.id),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.espnPlayerId),
    lineupSlot: text("lineup_slot").notNull(),
    isStarter: integer("is_starter", { mode: "boolean" }).notNull(),
    points: real("points"),
    projectedPoints: real("projected_points"),
    // Array of slot names captured at that week.
    eligibleSlotsJson: text("eligible_slots_json", { mode: "json" }).notNull(),
  },
  (t) => [
    unique("roster_slots_season_week_team_season_id_player_id_unique").on(
      t.season,
      t.week,
      t.teamSeasonId,
      t.playerId,
    ),
  ],
);

export type RosterSlot = typeof rosterSlots.$inferSelect;
export type NewRosterSlot = typeof rosterSlots.$inferInsert;

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    season: integer("season").notNull(),
    espnTxId: text("espn_tx_id").notNull(),
    type: text("type", {
      enum: ["waiver", "freeagent", "trade", "drop", "lineup"] as const,
    }).notNull(),
    status: text("status").notNull(),
    bidAmount: real("bid_amount"),
    proposedAt: integer("proposed_at", { mode: "timestamp_ms" }),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
    rawJson: text("raw_json", { mode: "json" }).notNull(),
  },
  (t) => [unique("transactions_season_espn_tx_id_unique").on(t.season, t.espnTxId)],
);

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;

export const transactionItems = sqliteTable("transaction_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  transactionId: integer("transaction_id")
    .notNull()
    .references(() => transactions.id),
  teamSeasonId: integer("team_season_id")
    .notNull()
    .references(() => teamSeasons.id),
  playerId: integer("player_id")
    .notNull()
    .references(() => players.espnPlayerId),
  action: text("action", {
    enum: ["add", "drop", "trade_away", "trade_for"] as const,
  }).notNull(),
  // Task 62, migration 0021: provenance. "espn" (the default — every row before this task, and
  // every row normalize.ts builds directly from an ESPN-provided `items[]` entry) is a verbatim
  // ESPN-stated fact. "inferred" marks a trade_away/trade_for pair `normalize.ts`'s
  // `inferOrphanTradeItems` reconstructed from a roster_slots diff because ESPN never returned the
  // real trade's item data to our cookie's view at all (a genuine per-team visibility gap, not a
  // parsing bug — see that function's docstring and src/engines/tradeRosterDiff.ts). Inferred
  // content must NEVER be presented as ESPN-stated fact — every downstream consumer that surfaces
  // trade contents (the /transactions trade log, trade achievements, tendencies' trade-appetite
  // average) must be able to tell the difference.
  source: text("source", { enum: ["espn", "inferred"] as const })
    .notNull()
    .default("espn"),
});

export type TransactionItem = typeof transactionItems.$inferSelect;
export type NewTransactionItem = typeof transactionItems.$inferInsert;

export const draftPicks = sqliteTable(
  "draft_picks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    season: integer("season").notNull(),
    round: integer("round").notNull(),
    roundPick: integer("round_pick").notNull(),
    overallPick: integer("overall_pick").notNull(),
    teamSeasonId: integer("team_season_id")
      .notNull()
      .references(() => teamSeasons.id),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.espnPlayerId),
    keeper: integer("keeper", { mode: "boolean" }).notNull().default(false),
    auctionAmount: real("auction_amount"),
  },
  (t) => [unique("draft_picks_season_overall_pick_unique").on(t.season, t.overallPick)],
);

export type DraftPick = typeof draftPicks.$inferSelect;
export type NewDraftPick = typeof draftPicks.$inferInsert;

// ---------------------------------------------------------------------------
// Layer 3 — app/operational
// ---------------------------------------------------------------------------

// NOTE: franchiseId / matchupId / playerId are intentionally plain integers,
// not foreign keys. Layer 2 tables are dropped/rebuilt idempotently; a hard
// FK here would either block those rebuilds or cascade-delete event history.
// matchupId in particular is a DURABLE reference (dedupe_key for MatchupFinished/
// MatchupLeadChanged/Belt* events embeds it, e.g. `matchup_finished:${matchupId}` — see
// emit-events.ts) — this is only safe because src/server/sync/normalize.ts (Task 45) guarantees
// matchups.id is stable across re-normalization (upsert by (season, week, espn_matchup_id), not
// delete+reinsert). Before that fix, every sync tick re-minted every current-season matchup's id,
// so this dedupe key silently stopped deduping the instant Week 1 started.
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventType: text("event_type").notNull(),
    season: integer("season"),
    week: integer("week"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    detectedAt: integer("detected_at", { mode: "timestamp_ms" }).notNull(),
    franchiseId: integer("franchise_id"),
    matchupId: integer("matchup_id"),
    playerId: integer("player_id"),
    payloadJson: text("payload_json", { mode: "json" }).notNull(),
    dedupeKey: text("dedupe_key").notNull().unique(),
  },
  (t) => [
    index("events_event_type_idx").on(t.eventType),
    index("events_season_week_idx").on(t.season, t.week),
  ],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

export const corrections = sqliteTable("corrections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  targetTable: text("target_table").notNull(),
  targetKeyJson: text("target_key_json", { mode: "json" }).notNull(),
  field: text("field").notNull(),
  valueJson: text("value_json", { mode: "json" }).notNull(),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export type Correction = typeof corrections.$inferSelect;
export type NewCorrection = typeof corrections.$inferInsert;

export const syncRuns = sqliteTable("sync_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  tier: text("tier", {
    enum: ["live", "hourly", "daily", "manual", "backfill"] as const,
  }).notNull(),
  status: text("status", {
    enum: ["ok", "partial", "failed", "auth_failed", "running"] as const,
  }).notNull(),
  viewsFetched: integer("views_fetched").notNull().default(0),
  snapshotsNew: integer("snapshots_new").notNull().default(0),
  eventsEmitted: integer("events_emitted").notNull().default(0),
  errorText: text("error_text"),
});

export type SyncRun = typeof syncRuns.$inferSelect;
export type NewSyncRun = typeof syncRuns.$inferInsert;

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type AppSetting = typeof appSettings.$inferSelect;
export type NewAppSetting = typeof appSettings.$inferInsert;

// Auth: invite links -> session cookies.
export const managers = sqliteTable("managers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  franchiseId: integer("franchise_id").references(() => franchises.id),
  role: text("role", { enum: ["commissioner", "manager"] as const }).notNull(),
  inviteToken: text("invite_token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  // PIN login (Task 57) — null pinHash means "no PIN set", the /login state that points a
  // manager back at their invite link. "salt:hash" scrypt string, see src/server/auth/pin.ts.
  // The invite link stays the recovery credential: it bypasses lockout by design (stronger
  // credential than a short numeric PIN) and setting/changing a PIN clears all four of these
  // back to their defaults (src/server/auth/pin-login.ts's setManagerPin).
  pinHash: text("pin_hash"),
  pinFailedAttempts: integer("pin_failed_attempts").notNull().default(0),
  pinLockoutLevel: integer("pin_lockout_level").notNull().default(0),
  // Epoch SECONDS (not the codebase's usual timestamp_ms) — matches the brief's column spec
  // verbatim and keeps lockout arithmetic in whole seconds throughout pin.ts.
  pinLockedUntil: integer("pin_locked_until"),
});

export type Manager = typeof managers.$inferSelect;
export type NewManager = typeof managers.$inferInsert;

export const recaps = sqliteTable(
  "recaps",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    style: text("style").notNull(),
    status: text("status", { enum: ["draft", "edited", "published"] as const }).notNull(),
    factsJson: text("facts_json", { mode: "json" }).notNull(),
    promptVersion: text("prompt_version"),
    model: text("model"),
    markdownDraft: text("markdown_draft"),
    markdownFinal: text("markdown_final"),
    // Task 16 (recap voice-learning): frozen copy of `markdownDraft` AS FIRST WRITTEN — by Claude
    // (generateRecap) or by the deterministic fallback template (switchToFallbackAction). Set once
    // at insert, NEVER touched by saveRecapEditAction. This is the "before" half of a revision
    // pair; `markdownDraft` itself keeps mutating as the commissioner edits, so by the time a row
    // is published `markdownDraft` already equals what's about to become `markdownFinal` — only
    // this frozen column still lets publishRecapAction diff "what the machine wrote" against "what
    // the commissioner actually published". Null for rows created before this column existed
    // (migration 0008 backfills it from each row's then-current `markdown_draft` for any row not
    // yet edited at migration time — see that migration's trailing UPDATE); a null here means
    // "no captured original", so capture-on-publish deliberately captures nothing for that row
    // rather than fabricating a diff against edited text.
    markdownGenerated: text("markdown_generated"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costUsd: real("cost_usd"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("recaps_season_week_idx").on(t.season, t.week)],
);

export type Recap = typeof recaps.$inferSelect;
export type NewRecap = typeof recaps.$inferInsert;

// ---------------------------------------------------------------------------
// Recap voice-learning (Task 16) — revision exemplars captured on publish, plus the
// commissioner-triggered learned style guide extracted from them. Manual voice notes are a single
// free-text app_settings value (key "recap_voice_notes"), not a table — see src/server/ai/voice.ts.
// ---------------------------------------------------------------------------

/**
 * One row per recap that was actually revised before publishing (draft_md != published_md).
 * `recapId` is UNIQUE so re-publishing the same recap upserts its exemplar in place — idempotent,
 * never duplicates — and an unchanged publish (see recaps.markdownGenerated's docstring) never
 * creates a row at all. `draftMd`/`publishedMd` are denormalized copies (not FKs into `recaps`'
 * mutable columns) so a later edit to that recap's `markdownDraft` can never retroactively change
 * an already-captured exemplar's "before" text.
 */
export const recapExemplars = sqliteTable(
  "recap_exemplars",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recapId: integer("recap_id")
      .notNull()
      .unique()
      .references(() => recaps.id),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    style: text("style").notNull(),
    draftMd: text("draft_md").notNull(),
    publishedMd: text("published_md").notNull(),
    capturedAt: integer("captured_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("recap_exemplars_captured_at_idx").on(t.capturedAt)],
);

export type RecapExemplar = typeof recapExemplars.$inferSelect;
export type NewRecapExemplar = typeof recapExemplars.$inferInsert;

/**
 * Versioned learned style guide: every save (an extraction run OR a commissioner's manual
 * tweak/clear) INSERTS a new row and flips the previous active row's `isActive` off in the same
 * transaction — never mutates a historical row in place, so the full history of guide text stays
 * inspectable. Exactly one row has `isActive = true` at any time; `model` is null for a manually
 * written/edited/cleared version (same nullable-means-no-API-call convention as `recaps.model`)
 * and the extraction model id (matches recap.ts's RECAP_MODEL) for an extracted version.
 * `sourceRecapIds` is the exemplar recap ids that fed THIS version — inherited unchanged from the
 * prior active row on a manual edit, so "based on N revised recaps" stays accurate even after the
 * commissioner hand-tweaks the extracted text.
 */
export const recapStyleGuides = sqliteTable(
  "recap_style_guides",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    guideText: text("guide_text").notNull(),
    exemplarCount: integer("exemplar_count").notNull(),
    sourceRecapIds: text("source_recap_ids", { mode: "json" }).notNull(),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costUsd: real("cost_usd"),
    isActive: integer("is_active", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("recap_style_guides_is_active_idx").on(t.isActive)],
);

export type RecapStyleGuide = typeof recapStyleGuides.$inferSelect;
export type NewRecapStyleGuide = typeof recapStyleGuides.$inferInsert;

// ---------------------------------------------------------------------------
// AI Podcast (Task 43) — scripts-only v1 (USER RULING 2026-08-05: no TTS/audio pipeline).
// Mirrors `recaps`' generation lifecycle (draft/edited/published, facts frozen at generation,
// deterministic fallback always available) but stores STRUCTURED SEGMENTS instead of one
// markdown blob — see src/server/ai/podcast.ts's docstring for why: that structure (an ordered
// array of {id, heading, body}) is the one clean seam a future audio/TTS provider slots into,
// one segment at a time, without this table or the generation pipeline changing shape. Reuses
// `recaps.factsJson`'s exact WeekFacts shape (buildWeekFacts is not forked) and the SAME
// voice-learning inputs recaps already read (recap_style_guides/recap_exemplars/manual notes —
// see voice.ts) — this table has no exemplar-capture table of its own; podcast publishes don't
// feed new exemplars back into that pool (out of scope for v1, and would require a schema change
// to recap_exemplars' recapId FK to accept either source, which the brief didn't ask for).
// ---------------------------------------------------------------------------

export const podcastEpisodes = sqliteTable(
  "podcast_episodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    status: text("status", { enum: ["draft", "edited", "published"] as const }).notNull(),
    factsJson: text("facts_json", { mode: "json" }).notNull(),
    promptVersion: text("prompt_version"),
    model: text("model"),
    // Ordered array of `{ id, heading, body }` objects — never one text blob. `body` is plain
    // prose (real franchise names spelled out, no `{{franchise}}` placeholder syntax stored here)
    // so the commissioner can hand-edit it in a plain textarea exactly like recaps' markdownDraft;
    // identity marks are derived at RENDER time from `body` + the episode's own `factsJson`
    // (src/server/ai/podcast.ts's `tokenizeFranchiseReferences`), never persisted, so an edit can
    // never leave a stale placeholder pointing at text that's since moved or been removed.
    segmentsDraft: text("segments_draft", { mode: "json" }).notNull(),
    segmentsFinal: text("segments_final", { mode: "json" }),
    // Frozen "as generated" copy, set once at insert — same convention as recaps.markdownGenerated
    // (Task 16), kept for symmetry even though nothing reads it back yet in v1.
    segmentsGenerated: text("segments_generated", { mode: "json" }).notNull(),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costUsd: real("cost_usd"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("podcast_episodes_season_week_idx").on(t.season, t.week)],
);

export type PodcastEpisode = typeof podcastEpisodes.$inferSelect;
export type NewPodcastEpisode = typeof podcastEpisodes.$inferInsert;

// ---------------------------------------------------------------------------
// AI Matchup Previews (Task 53) — the Wednesday companion to recaps: an UPCOMING (scheduled, not
// yet played) week's storylines instead of a played week's results. A DEDICATED table, not an
// extension of `podcast_episodes` above (disclosed judgment call, task-53-report.md): the two
// content types' facts payloads are fundamentally different shapes (`PreviewWeekFacts` —
// standings ENTERING the week, full H2H history, belt-at-stake, streaks — vs `WeekFacts`'s
// played-week results/superlatives/records/transactions), and this task's own boundary rule
// ("don't touch recap/podcast surfaces beyond genuinely shared plumbing") rules out folding a new
// content type into podcast_episodes' status/season/week space. Structurally still mirrors
// `podcast_episodes` field-for-field (segments, not one markdown blob — see
// src/server/ai/previews.ts's docstring for why that shape fits "a week-overview lead + one
// blurb per matchup" exactly) since it's the same generation-lifecycle precedent: draft/edited/
// published, facts frozen at generation, deterministic fallback always available.
// ---------------------------------------------------------------------------

export const previewEpisodes = sqliteTable(
  "preview_episodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    status: text("status", { enum: ["draft", "edited", "published"] as const }).notNull(),
    factsJson: text("facts_json", { mode: "json" }).notNull(),
    promptVersion: text("prompt_version"),
    model: text("model"),
    // Ordered array of `{ id, heading, body }` objects — a "week_overview" lead segment followed
    // by one "matchup_<matchupId>" segment per scheduled matchup, same shape/editing contract as
    // podcast_episodes.segmentsDraft (plain prose, no `{{franchise}}` syntax stored — identity
    // marks are derived at render time, see src/server/ai/previews.ts's tokenizeFranchiseReferences
    // use).
    segmentsDraft: text("segments_draft", { mode: "json" }).notNull(),
    segmentsFinal: text("segments_final", { mode: "json" }),
    // Frozen "as generated" copy, set once at insert — same convention as podcast_episodes /
    // recaps.markdownGenerated.
    segmentsGenerated: text("segments_generated", { mode: "json" }).notNull(),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costUsd: real("cost_usd"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("preview_episodes_season_week_idx").on(t.season, t.week)],
);

export type PreviewEpisode = typeof previewEpisodes.$inferSelect;
export type NewPreviewEpisode = typeof previewEpisodes.$inferInsert;

// ---------------------------------------------------------------------------
// Polls & surveys (Task 18) — commissioner-authored, manager-voted. Votes reference
// managers.id (not franchises) so a manager without a franchise can still vote.
// ---------------------------------------------------------------------------

export const polls = sqliteTable("polls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  question: text("question").notNull(),
  description: text("description"),
  kind: text("kind", { enum: ["single", "multi"] as const }).notNull(),
  status: text("status", { enum: ["draft", "open", "closed"] as const }).notNull(),
  // true -> individual votes hidden from everyone incl. the commissioner in the UI (stored, never
  // displayed per-voter) — see src/server/queries/polls.ts's getPollResults for the enforcement
  // point (the query itself omits per-voter data, not just the page).
  anonymous: integer("anonymous", { mode: "boolean" }).notNull().default(false),
  allowWriteIn: integer("allow_write_in", { mode: "boolean" }).notNull().default(false),
  createdBy: integer("created_by")
    .notNull()
    .references(() => managers.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  opensAt: integer("opens_at", { mode: "timestamp_ms" }),
  // Informational deadline shown in the UI only — closing a poll is always a manual commissioner
  // action ("close" button), never enforced automatically by this timestamp.
  closesAt: integer("closes_at", { mode: "timestamp_ms" }),
});

export type Poll = typeof polls.$inferSelect;
export type NewPoll = typeof polls.$inferInsert;

export const pollOptions = sqliteTable(
  "poll_options",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pollId: integer("poll_id")
      .notNull()
      .references(() => polls.id),
    label: text("label").notNull(),
    sort: integer("sort").notNull(),
    isWriteIn: integer("is_write_in", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("poll_options_poll_id_idx").on(t.pollId)],
);

export type PollOption = typeof pollOptions.$inferSelect;
export type NewPollOption = typeof pollOptions.$inferInsert;

export const pollVotes = sqliteTable(
  "poll_votes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pollId: integer("poll_id")
      .notNull()
      .references(() => polls.id),
    optionId: integer("option_id")
      .notNull()
      .references(() => pollOptions.id),
    managerId: integer("manager_id")
      .notNull()
      .references(() => managers.id),
    votedAt: integer("voted_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    unique("poll_votes_poll_id_option_id_manager_id_unique").on(t.pollId, t.optionId, t.managerId),
    index("poll_votes_poll_id_manager_id_idx").on(t.pollId, t.managerId),
  ],
);

export type PollVote = typeof pollVotes.$inferSelect;
export type NewPollVote = typeof pollVotes.$inferInsert;

// ---------------------------------------------------------------------------
// Preseason Predictions Time Capsule (Task 30) — one row per (manager, season,
// category); a manager's full "set" is up to 5 rows, one per PREDICTION_CATEGORIES
// value below. Sealed to the submitting manager only until the season is underway
// (src/server/sync/run-tier.ts's isSeasonUnderway — first real game played, NOT
// the draft date), then revealed to everyone at once — see
// src/server/queries/predictions.ts for the lock gate (enforced at the query
// layer, not just the page: the reveal query itself returns null pre-lock) and
// src/features/predictions/actions.ts for the write-side enforcement (a manager
// can only ever write their OWN rows — managerId comes from the session, never
// from form input).
//
// `subject` is one text column carrying different shapes depending on
// `category`: a franchise id (as a string) for champion/sacko/top_scorer, an
// integer win total (as a string) for win_total, or free text for bold_take —
// see src/features/predictions/validation.ts for the per-category validation.
// Deliberately kept as clean discrete (category, subject) rows rather than one
// JSON blob per manager: v1.1 (auto-scoring against real results, explicitly
// OUT of scope for this task) will be able to read a franchise-subject row
// directly with no reparsing, without this table needing to change shape.
// ---------------------------------------------------------------------------

export const PREDICTION_CATEGORIES = ["champion", "sacko", "top_scorer", "win_total", "bold_take"] as const;
export type PredictionCategory = (typeof PREDICTION_CATEGORIES)[number];

export const predictions = sqliteTable(
  "predictions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    managerId: integer("manager_id")
      .notNull()
      .references(() => managers.id),
    season: integer("season").notNull(),
    category: text("category", { enum: PREDICTION_CATEGORIES }).notNull(),
    subject: text("subject").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    unique("predictions_manager_season_category_unique").on(t.managerId, t.season, t.category),
    index("predictions_season_idx").on(t.season),
  ],
);

export type Prediction = typeof predictions.$inferSelect;
export type NewPrediction = typeof predictions.$inferInsert;

export const statBuilds = sqliteTable("stat_builds", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  inputHash: text("input_hash").notNull(),
  status: text("status", { enum: ["running", "ok", "failed"] as const }).notNull(),
  durationMs: integer("duration_ms"),
  errorText: text("error_text"),
});

export type StatBuild = typeof statBuilds.$inferSelect;
export type NewStatBuild = typeof statBuilds.$inferInsert;

// ---------------------------------------------------------------------------
// Layer 3 — derived stats (full rebuild every time; see src/server/stats/build.ts)
// ---------------------------------------------------------------------------
//
// Every row here is tagged with the `stat_builds.id` that produced it. A
// rebuild deletes ALL rows in both tables and re-inserts a fresh set inside
// one transaction — readers never see a half-built state (see AGENTS.md's
// "never write incremental stat logic" rule).
//
// franchiseId / teamSeasonId / matchupId (and the belt/h2h "which franchise"
// columns below) are INTENTIONALLY plain integers, not foreign keys into
// layer-2 tables — same reasoning AGENTS.md documents for `events`'
// franchiseId/matchupId/playerId: layer-2 tables (franchises, team_seasons,
// matchups) are dropped/rebuilt idempotently by `normalizeSeason`, and a hard
// FK here would block that rebuild the instant a derived-stats build has ever
// run (confirmed in production: normalizeSeason's per-season DELETE FROM
// team_seasons failed with "FOREIGN KEY constraint failed" once team_week
// etc. held rows referencing them). `buildId -> stat_builds.id` keeps its FK
// — `stat_builds` is stats-build-only bookkeeping, never touched by
// normalize, so it can never cause this conflict, and the FK still gives a
// real integrity guarantee within the derived-stats subsystem itself (every
// insert here happens inside build.ts's own transaction, always tagged with
// a build_id from a row that transaction just inserted).

export const teamWeek = sqliteTable(
  "team_week",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    weekType: text("week_type", {
      enum: ["regular", "playoff", "consolation", "championship"] as const,
    }).notNull(),
    teamSeasonId: integer("team_season_id").notNull(),
    franchiseId: integer("franchise_id").notNull(),
    // Null on a bye — no opponent to compare against that week.
    opponentFranchiseId: integer("opponent_franchise_id"),
    matchupId: integer("matchup_id"),
    score: real("score").notNull(),
    projected: real("projected"),
    // Null for a bye or a not-yet-final matchup.
    result: text("result", { enum: ["W", "L", "T"] as const }),
    margin: real("margin"),
    // optimal_score/bench_points_left/efficiency are all null together when the matchup isn't
    // final yet, OR when this team-week has no roster_slots data to compute an optimal lineup
    // from (2015-2017 have matchups but zero roster_slots archived) — never faked.
    optimalScore: real("optimal_score"),
    benchPointsLeft: real("bench_points_left"),
    efficiency: real("efficiency"),
    eligibilityFallback: integer("eligibility_fallback", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    unique("team_week_season_week_franchise_id_unique").on(t.season, t.week, t.franchiseId),
    index("team_week_franchise_id_season_idx").on(t.franchiseId, t.season),
  ],
);

export type TeamWeek = typeof teamWeek.$inferSelect;
export type NewTeamWeek = typeof teamWeek.$inferInsert;

export const allplayWeek = sqliteTable(
  "allplay_week",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    franchiseId: integer("franchise_id").notNull(),
    wins: integer("wins").notNull(),
    losses: integer("losses").notNull(),
    ties: integer("ties").notNull(),
    // Null when there's no real head-to-head result to compare against pAllPlay with (e.g. a bye).
    luckScore: real("luck_score"),
  },
  (t) => [unique("allplay_week_season_week_franchise_id_unique").on(t.season, t.week, t.franchiseId)],
);

export type AllplayWeek = typeof allplayWeek.$inferSelect;
export type NewAllplayWeek = typeof allplayWeek.$inferInsert;

// ---------------------------------------------------------------------------
// Layer 3 — derived stats, stages 3-4: chronological replay (Elo, belt,
// streaks) + rollups (season/career, record book, H2H). See
// src/server/stats/build.ts. Same full-rebuild-every-time, one-transaction
// atomic swap, build_id tagging as stages 0-2 above.
// ---------------------------------------------------------------------------

export const eloHistory = sqliteTable(
  "elo_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    franchiseId: integer("franchise_id").notNull(),
    eloPre: real("elo_pre").notNull(),
    eloPost: real("elo_post").notNull(),
  },
  (t) => [unique("elo_history_season_week_franchise_id_unique").on(t.season, t.week, t.franchiseId)],
);

export type EloHistory = typeof eloHistory.$inferSelect;
export type NewEloHistory = typeof eloHistory.$inferInsert;

export const franchiseElo = sqliteTable(
  "franchise_elo",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    franchiseId: integer("franchise_id").notNull(),
    current: real("current").notNull(),
    peak: real("peak").notNull(),
    peakSeason: integer("peak_season").notNull(),
    peakWeek: integer("peak_week").notNull(),
    trough: real("trough").notNull(),
    weeksAtNo1: integer("weeks_at_no1").notNull(),
  },
  (t) => [unique("franchise_elo_franchise_id_unique").on(t.franchiseId)],
);

export type FranchiseElo = typeof franchiseElo.$inferSelect;
export type NewFranchiseElo = typeof franchiseElo.$inferInsert;

export const beltReigns = sqliteTable(
  "belt_reigns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    reignNo: integer("reign_no").notNull(),
    franchiseId: integer("franchise_id").notNull(),
    // Null for the very first reign and for a vacancy award (won into a vacant title, not by
    // beating a holder).
    wonFromFranchiseId: integer("won_from_franchise_id"),
    startSeason: integer("start_season").notNull(),
    startWeek: integer("start_week").notNull(),
    endSeason: integer("end_season"),
    endWeek: integer("end_week"),
    defenses: integer("defenses").notNull(),
    weeksHeld: integer("weeks_held").notNull(),
    endReason: text("end_reason", { enum: ["lost", "vacated", "override"] as const }),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull(),
  },
  (t) => [unique("belt_reigns_reign_no_unique").on(t.reignNo)],
);

export type BeltReign = typeof beltReigns.$inferSelect;
export type NewBeltReign = typeof beltReigns.$inferInsert;

export const beltMatches = sqliteTable(
  "belt_matches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    matchupId: integer("matchup_id").notNull(),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    holderFranchiseId: integer("holder_franchise_id").notNull(),
    challengerFranchiseId: integer("challenger_franchise_id").notNull(),
    result: text("result", { enum: ["defense", "transfer"] as const }).notNull(),
    holderScore: real("holder_score").notNull(),
    challengerScore: real("challenger_score").notNull(),
  },
  (t) => [unique("belt_matches_matchup_id_unique").on(t.matchupId)],
);

export type BeltMatch = typeof beltMatches.$inferSelect;
export type NewBeltMatch = typeof beltMatches.$inferInsert;

export const seasonStats = sqliteTable(
  "season_stats",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    season: integer("season").notNull(),
    franchiseId: integer("franchise_id").notNull(),
    wins: integer("wins").notNull(),
    losses: integer("losses").notNull(),
    ties: integer("ties").notNull(),
    pointsFor: real("points_for").notNull(),
    pointsAgainst: real("points_against").notNull(),
    allplayW: integer("allplay_w").notNull(),
    allplayL: integer("allplay_l").notNull(),
    allplayT: integer("allplay_t").notNull(),
    luckTotal: real("luck_total"),
    // allplay xW = Sum(allplay_wins / (N-1)) across the season's weeks.
    expectedWins: real("expected_wins"),
    efficiencyAvg: real("efficiency_avg"),
    finalStanding: integer("final_standing"),
    madePlayoffs: integer("made_playoffs", { mode: "boolean" }).notNull(),
    champion: integer("champion", { mode: "boolean" }).notNull().default(false),
    // "Sacko" — last place (highest final_standing) that season.
    sacko: integer("sacko", { mode: "boolean" }).notNull().default(false),
    // Task 17 — count of "Beatdown of the Week" weekly awards taken this season (see
    // src/engines/records.ts's computeWeeklyBeatdowns).
    beatdowns: integer("beatdowns").notNull().default(0),
  },
  (t) => [unique("season_stats_season_franchise_id_unique").on(t.season, t.franchiseId)],
);

export type SeasonStat = typeof seasonStats.$inferSelect;
export type NewSeasonStat = typeof seasonStats.$inferInsert;

export const careerStats = sqliteTable(
  "career_stats",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    franchiseId: integer("franchise_id").notNull(),
    seasons: integer("seasons").notNull(),
    wins: integer("wins").notNull(),
    losses: integer("losses").notNull(),
    ties: integer("ties").notNull(),
    winPct: real("win_pct").notNull(),
    pointsFor: real("points_for").notNull(),
    pointsAgainst: real("points_against").notNull(),
    allplayW: integer("allplay_w").notNull(),
    allplayL: integer("allplay_l").notNull(),
    allplayT: integer("allplay_t").notNull(),
    championships: integer("championships").notNull(),
    sackos: integer("sackos").notNull(),
    playoffAppearances: integer("playoff_appearances").notNull(),
    bestFinish: integer("best_finish"),
    worstFinish: integer("worst_finish"),
    highestWeek: real("highest_week"),
    highestWeekSeason: integer("highest_week_season"),
    highestWeekWeek: integer("highest_week_week"),
    lowestWeek: real("lowest_week"),
    lowestWeekSeason: integer("lowest_week_season"),
    lowestWeekWeek: integer("lowest_week_week"),
    longestWinStreak: integer("longest_win_streak"),
    longestWinStreakStartSeason: integer("longest_win_streak_start_season"),
    longestWinStreakStartWeek: integer("longest_win_streak_start_week"),
    longestWinStreakEndSeason: integer("longest_win_streak_end_season"),
    longestWinStreakEndWeek: integer("longest_win_streak_end_week"),
    longestLossStreak: integer("longest_loss_streak"),
    longestLossStreakStartSeason: integer("longest_loss_streak_start_season"),
    longestLossStreakStartWeek: integer("longest_loss_streak_start_week"),
    longestLossStreakEndSeason: integer("longest_loss_streak_end_season"),
    longestLossStreakEndWeek: integer("longest_loss_streak_end_week"),
    currentElo: real("current_elo").notNull(),
    peakElo: real("peak_elo").notNull(),
    luckTotal: real("luck_total"),
    expectedWins: real("expected_wins"),
    efficiencyAvg: real("efficiency_avg"),
    // Task 17 — career "Beatdown of the Week" award count + this franchise's own single worst
    // beatdown ever (margin + when), same null-together shape as highestWeek/lowestWeek above.
    beatdowns: integer("beatdowns").notNull().default(0),
    worstBeatdownMargin: real("worst_beatdown_margin"),
    worstBeatdownSeason: integer("worst_beatdown_season"),
    worstBeatdownWeek: integer("worst_beatdown_week"),
  },
  (t) => [unique("career_stats_franchise_id_unique").on(t.franchiseId)],
);

export type CareerStat = typeof careerStats.$inferSelect;
export type NewCareerStat = typeof careerStats.$inferInsert;

export const recordEntries = sqliteTable(
  "record_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    recordKey: text("record_key").notNull(),
    rank: integer("rank").notNull(),
    franchiseId: integer("franchise_id").notNull(),
    season: integer("season").notNull(),
    week: integer("week"),
    value: real("value").notNull(),
    weekType: text("week_type", {
      enum: ["regular", "playoff", "consolation", "championship"] as const,
    }),
    // Opponent/matchup id/streak span/etc — shape varies by record_key, documented in
    // src/engines/records.ts.
    detailJson: text("detail_json", { mode: "json" }),
  },
  (t) => [
    unique("record_entries_record_key_rank_franchise_id_season_week_unique").on(
      t.recordKey,
      t.rank,
      t.franchiseId,
      t.season,
      t.week,
    ),
  ],
);

export type RecordEntryRow = typeof recordEntries.$inferSelect;
export type NewRecordEntry = typeof recordEntries.$inferInsert;

export const h2hPairs = sqliteTable(
  "h2h_pairs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    // franchiseA < franchiseB (normalized unordered pair).
    franchiseA: integer("franchise_a").notNull(),
    franchiseB: integer("franchise_b").notNull(),
    // W/L/T are from franchise_a's perspective.
    regW: integer("reg_w").notNull(),
    regL: integer("reg_l").notNull(),
    regT: integer("reg_t").notNull(),
    playoffW: integer("playoff_w").notNull(),
    playoffL: integer("playoff_l").notNull(),
    playoffT: integer("playoff_t").notNull(),
    pointsA: real("points_a").notNull(),
    pointsB: real("points_b").notNull(),
    avgMargin: real("avg_margin").notNull(),
    streakHolder: integer("streak_holder"),
    streakLen: integer("streak_len").notNull(),
    largestWinJson: text("largest_win_json", { mode: "json" }),
    closestGameJson: text("closest_game_json", { mode: "json" }),
    lastMeetingJson: text("last_meeting_json", { mode: "json" }),
  },
  (t) => [unique("h2h_pairs_franchise_a_franchise_b_unique").on(t.franchiseA, t.franchiseB)],
);

export type H2HPair = typeof h2hPairs.$inferSelect;
export type NewH2HPair = typeof h2hPairs.$inferInsert;

// ---------------------------------------------------------------------------
// Layer 3 — derived stats, stage 5: historical context notes. See
// src/server/stats/build.ts and src/engines/context.ts. Same full-rebuild-
// every-time, one-transaction atomic swap, build_id tagging as stages 0-4
// above — franchiseId/matchupId are plain integers for the same rebuildable-
// layer-2 reason documented at the top of this section.
// ---------------------------------------------------------------------------

export const contextNotes = sqliteTable(
  "context_notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    subjectType: text("subject_type", { enum: ["team_week", "matchup"] as const }).notNull(),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    // Null for a 'matchup'-subject note; set for a 'team_week'-subject note.
    franchiseId: integer("franchise_id"),
    // Null only when a team_week-subject note has no resolvable matchup (shouldn't happen for a
    // decided game, but kept nullable for honesty); always set for a 'matchup'-subject note.
    matchupId: integer("matchup_id"),
    ruleId: text("rule_id").notNull(),
    salience: integer("salience").notNull(),
    renderedText: text("rendered_text").notNull(),
    factsJson: text("facts_json", { mode: "json" }),
  },
  (t) => [
    index("context_notes_season_week_idx").on(t.season, t.week),
    index("context_notes_matchup_id_idx").on(t.matchupId),
    index("context_notes_franchise_id_season_week_idx").on(t.franchiseId, t.season, t.week),
  ],
);

export type ContextNoteRow = typeof contextNotes.$inferSelect;
export type NewContextNoteRow = typeof contextNotes.$inferInsert;

// ---------------------------------------------------------------------------
// Layer 3 — derived stats, stage 6: achievements. See src/server/stats/build.ts
// and src/engines/achievements.ts. Same full-rebuild-every-time, one-
// transaction atomic swap, build_id tagging as stages 0-5 above.
//
// `dedupeKey` is the AGENTS.md "upserted by deterministic key, never
// appended" anchor: src/engines/achievements.ts computes it purely from the
// achievement type + season/week/franchise (+ record key, where more than
// one can attach to the same team-week), so a full rebuild always
// reproduces byte-identical rows, in the same way record_entries'
// compound-unique key does for the record book.
// ---------------------------------------------------------------------------

export const achievements = sqliteTable(
  "achievements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    achievementKey: text("achievement_key").notNull(),
    franchiseId: integer("franchise_id").notNull(),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payloadJson: text("payload_json", { mode: "json" }),
  },
  (t) => [
    unique("achievements_dedupe_key_unique").on(t.dedupeKey),
    index("achievements_franchise_id_idx").on(t.franchiseId),
    index("achievements_season_week_idx").on(t.season, t.week),
    index("achievements_achievement_key_idx").on(t.achievementKey),
  ],
);

export type AchievementRow = typeof achievements.$inferSelect;
export type NewAchievementRow = typeof achievements.$inferInsert;

// ---------------------------------------------------------------------------
// Weekly Pick'em (Task 31, migration 0010) — manager picks against every non-bye matchup of the
// "current" scoring period, locked at that week's first live window (Thursday 20:00 ET — see
// src/server/sync/pickem-lock.ts), scored 1 point per correct pick from FINAL matchups only.
// ---------------------------------------------------------------------------

export const pickemPicks = sqliteTable(
  "pickem_picks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // FK to managers.id for a real human pick. NULL for "The Algorithm" pseudo-entrant's picks
    // (isAlgorithm = true) — deliberately NOT a row in `managers` itself: the algorithm is not a
    // real login-capable account, and keeping it out of `managers` means it never appears in
    // /admin's manager roster or interacts with the invite/session system at all (see
    // src/server/sync/pickem-lock.ts's module docstring). A real manager row is stable (never
    // dropped/rebuilt by normalizeSeason), so this is a genuine hard FK, same as poll_votes.manager_id.
    managerId: integer("manager_id").references(() => managers.id),
    isAlgorithm: integer("is_algorithm", { mode: "boolean" }).notNull().default(false),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    // Plain integer, not a hard FK — matchups is a layer-2 table normalizeSeason DROPS and
    // rebuilds per season (see AGENTS.md), so a hard FK here would block re-normalization the
    // instant a pick exists for that season. Same reasoning as events.matchupId / teamWeek.matchupId.
    // DURABLE reference: a pick stored here must still join `matchups` (by this id) after any
    // number of later re-normalizes, or grading/pre-fill silently breaks — safe only because
    // normalize.ts (Task 45) upserts matchups by (season, week, espn_matchup_id) rather than
    // deleting and reinserting, so a given matchup's id never changes once assigned.
    matchupId: integer("matchup_id").notNull(),
    // Plain integer for the identical reason — franchises itself isn't rebuilt, but this stays
    // consistent with every other derived/operational table's franchiseId (events, teamWeek,
    // achievements, ...).
    pickedFranchiseId: integer("picked_franchise_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Covers every HUMAN pick (managerId NOT NULL) — one pick per manager per matchup, upsert
    // target for "editable until lock." Does NOT dedupe algorithm rows: SQLite/ANSI SQL treat NULL
    // as distinct from NULL in a UNIQUE index, so managerId=NULL never collides here — see this
    // migration's hand-added partial unique index (`pickem_picks_algorithm_matchup_unique`) for
    // that other half.
    unique("pickem_picks_manager_id_matchup_id_unique").on(t.managerId, t.matchupId),
    index("pickem_picks_season_week_idx").on(t.season, t.week),
  ],
);

export type PickemPick = typeof pickemPicks.$inferSelect;
export type NewPickemPick = typeof pickemPicks.$inferInsert;

// ---------------------------------------------------------------------------
// Layer 3 — derived stats, stage 7: slot-level scoring calibration (Task 32).
// Feeds src/engines/winProbability.ts's normal-approximation remaining-
// starter model — see that module's docstring for exactly what this table
// can and cannot support. Same full-rebuild-every-time, one-transaction
// atomic swap, build_id tagging as every derived-stats table above.
//
// One row per lineup-slot label PLUS one reserved row (slot='ALL') pooling
// every starter across every slot — the fallback distribution
// src/engines/winProbability.ts falls back to for a slot with no calibrated
// row of its own. Sourced entirely from `roster_slots` (isStarter=true,
// points IS NOT NULL) — which only has rows for 2018+ (2015-2017 have
// matchups but zero archived rosters, same boundary team_week's
// optimal-lineup fields document). `unique` on `slot` alone, not
// `(build_id, slot)`, matching franchise_elo's "one current row per key,
// full rebuild replaces it" pattern rather than team_week's
// "many historical rows" pattern — there is no meaningful history to keep
// here, only "the latest calibration."
// ---------------------------------------------------------------------------

export const slotScoringStats = sqliteTable(
  "slot_scoring_stats",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    slot: text("slot").notNull(),
    mean: real("mean").notNull(),
    variance: real("variance").notNull(),
    sampleSize: integer("sample_size").notNull(),
    seasonMin: integer("season_min").notNull(),
    seasonMax: integer("season_max").notNull(),
  },
  (t) => [unique("slot_scoring_stats_slot_unique").on(t.slot)],
);

export type SlotScoringStat = typeof slotScoringStats.$inferSelect;
export type NewSlotScoringStat = typeof slotScoringStats.$inferInsert;

// ---------------------------------------------------------------------------
// Layer 3 — derived stats, stage 8: Waiver ROI + Trade Analytics (roadmap
// §18-19, Task 34, migration 0012). See src/server/stats/build.ts and
// src/engines/waiverROI.ts / src/engines/tradeAnalytics.ts / src/engines/
// rosterPossession.ts. Same full-rebuild-every-time, one-transaction atomic
// swap, build_id tagging as every derived-stats table above.
//
// Sourced entirely from `transactions`/`transaction_items` (2018+ only —
// pre-2018 is permanently purged by ESPN, not a gap in this pipeline) joined
// against `roster_slots` for post-acquisition starter points. `franchiseId`/
// `teamSeasonId`/`transactionId` are INTENTIONALLY plain integers, not FKs —
// `team_seasons`/`transactions`/`transaction_items` are all dropped/
// rebuilt per season by normalizeSeason, same reasoning documented at the
// top of the "Layer 3 — derived stats" section above. `playerId` IS a real
// FK (players is upserted, never dropped/rebuilt — same precedent as
// roster_slots.playerId/transaction_items.playerId).
// ---------------------------------------------------------------------------

export const waiverAcquisitions = sqliteTable(
  "waiver_acquisitions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    season: integer("season").notNull(),
    franchiseId: integer("franchise_id").notNull(),
    teamSeasonId: integer("team_season_id").notNull(),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.espnPlayerId),
    type: text("type", { enum: ["waiver", "freeagent"] as const }).notNull(),
    // FAAB dollars for `waiver` (real range: $0-$87); almost always 0 for `freeagent` (a handful
    // of real rows carry $1-$3) — kept verbatim either way, never zeroed out or fabricated.
    bidAmount: real("bid_amount"),
    transactionId: integer("transaction_id").notNull(),
    espnTxId: text("espn_tx_id").notNull(),
    acquiredWeek: integer("acquired_week").notNull(),
    // Null = still rostered by this franchise through the last week roster_slots covers for this
    // season — see stillRostered.
    droppedWeek: integer("dropped_week"),
    stillRostered: integer("still_rostered", { mode: "boolean" }).notNull(),
    weeksRostered: integer("weeks_rostered").notNull(),
    startsMade: integer("starts_made").notNull(),
    starterPoints: real("starter_points").notNull(),
    // Null when startsMade = 0 — never a fabricated 0/0 rate.
    pointsPerStart: real("points_per_start"),
  },
  (t) => [
    unique("waiver_acquisitions_transaction_id_team_season_id_player_id_unique").on(t.transactionId, t.teamSeasonId, t.playerId),
    index("waiver_acquisitions_season_franchise_id_idx").on(t.season, t.franchiseId),
    index("waiver_acquisitions_franchise_id_idx").on(t.franchiseId),
  ],
);

export type WaiverAcquisitionRow = typeof waiverAcquisitions.$inferSelect;
export type NewWaiverAcquisitionRow = typeof waiverAcquisitions.$inferInsert;

/**
 * One row per (trade transaction, received player) — the "trade log" groups these by
 * `transactionId` to show both sides; "biggest heists/blunders" ranks directly across rows.
 *
 * GROUND TRUTH (verified against real data/league.db before this table was designed — see
 * src/engines/tradeAnalytics.ts's docstring for the full account): of 59 "trade"-classified
 * transactions across 2018-2025, only 13 carried recoverable player data directly on an EXECUTED
 * record — the other 46 are ESPN's own content-free `TRADE_UPHOLD` settlement echoes (their
 * `items` field is `undefined` in the raw archived payload, not just unparsed).
 *
 * TASK 62 UPDATE: those 46 collapse to 19 DISTINCT trades once ESPN's per-trade duplication is
 * accounted for; ~10 of those were RECOVERED via roster-diff inference
 * (`src/engines/tradeRosterDiff.ts`, `transaction_items.source = "inferred"`) because ESPN never
 * returns their real proposal to our cookie's view at all. `sendingFranchiseId`/
 * `sendingTeamSeasonId` IS well-defined per PLAYER even for a 3+-sided trade (every traded player
 * still has exactly one real sender — see `stats/build.ts`'s `senderByTxPlayer`, built from the
 * `transaction_items.action = 'trade_away'` row that always accompanies a `trade_for` row for the
 * SAME player, real or inferred), so — TASK 62 FIX ROUND 1 (reviewer-caught, C2) — this table is
 * NOT limited to 2-sided trades: `stats/build.ts` writes a full row set for every side of a trade
 * regardless of how many total sides it has. Only `winnerFranchiseId`/`marginPoints` (computed by
 * `src/engines/tradeAnalytics.ts`) stay null for anything but exactly 2 sides — a real, deliberate
 * "no well-defined pairwise winner among 3+ parties" limitation, not a reason a 3+-sided trade's
 * rows are ever withheld from this table. (An earlier version of this fix DID silently drop any
 * non-2-sided trade from trade_ledger entirely — caught in review as a real bug, not just a
 * documentation gap, and fixed.) Confirmed against the full rebuilt dataset: exactly ONE 3+-sided
 * trade exists in this league's real history (a 3-team trade, Task 62's roster-diff recovery) —
 * an earlier draft of this comment also claimed a separate 4-team trade, which was wrong: that
 * was the same 3-team transaction, double-counted from an early candidate-team count taken before
 * the roster-diff engine had actually run, never cross-checked against the final result.
 */
export const tradeLedger = sqliteTable(
  "trade_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    season: integer("season").notNull(),
    transactionId: integer("transaction_id").notNull(),
    espnTxId: text("espn_tx_id").notNull(),
    tradeWeek: integer("trade_week").notNull(),
    receivingFranchiseId: integer("receiving_franchise_id").notNull(),
    receivingTeamSeasonId: integer("receiving_team_season_id").notNull(),
    sendingFranchiseId: integer("sending_franchise_id").notNull(),
    sendingTeamSeasonId: integer("sending_team_season_id").notNull(),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.espnPlayerId),
    weeksRostered: integer("weeks_rostered").notNull(),
    startsMade: integer("starts_made").notNull(),
    starterPoints: real("starter_points").notNull(),
    // Null when startsMade = 0 — never a fabricated 0/0 rate.
    pointsPerStart: real("points_per_start"),
    stillRostered: integer("still_rostered", { mode: "boolean" }).notNull(),
    droppedWeek: integer("dropped_week"),
    // Task 62, migration 0021: passthrough of transaction_items.source for this exact
    // (transactionId, receivingTeamSeasonId, playerId) row — see that column's docstring above.
    // Every consumer surfacing this row to a user (the /transactions trade log) must be able to
    // mark an "inferred" trade distinctly from an ESPN-stated one.
    source: text("source", { enum: ["espn", "inferred"] as const })
      .notNull()
      .default("espn"),
  },
  (t) => [
    unique("trade_ledger_transaction_id_receiving_team_season_id_player_id_unique").on(t.transactionId, t.receivingTeamSeasonId, t.playerId),
    index("trade_ledger_season_idx").on(t.season),
    index("trade_ledger_transaction_id_idx").on(t.transactionId),
    index("trade_ledger_receiving_franchise_id_idx").on(t.receivingFranchiseId),
  ],
);

export type TradeLedgerRow = typeof tradeLedger.$inferSelect;
export type NewTradeLedgerRow = typeof tradeLedger.$inferInsert;

// ---------------------------------------------------------------------------
// Layer 3 — derived stats, stage 9: "The One That Got Away" revenge tracking
// (roadmap §20, Task 50, migration 0017). See src/server/stats/build.ts and
// src/engines/revengeTracking.ts. Same full-rebuild-every-time, one-
// transaction atomic swap, build_id tagging as every derived-stats table
// above.
//
// One row per (former franchise, ex-player, game they started in while away
// from that franchise) — render-ready: a single row IS a displayable
// "revenge game" or "painful former player" line item, no further
// aggregation needed to show one. Two DISTINCT honest metrics read from the
// SAME rows, never conflated: revenge points = SUM(points) WHERE
// is_against_former_franchise (the ex-player beating them specifically);
// "most painful former player" = SUM(points) with NO such filter (the
// ex-player's total post-departure production anywhere). See
// src/engines/revengeTracking.ts's docstring for why "once rostered, later
// lost" is anchored on the departure event alone (not a matched acquisition
// the way waiver_acquisitions/trade_ledger require) and why every row here
// is gated on the corresponding matchup's is_final flag (never an unplayed
// roster-shell week).
//
// `franchiseId`/`currentFranchiseId`/`currentTeamSeasonId`/
// `departureTransactionId` are INTENTIONALLY plain integers, not FKs — same
// "team_seasons/transactions/transaction_items are dropped/rebuilt per
// season by normalizeSeason" reasoning as waiver_acquisitions/trade_ledger
// above. `matchupId` is also plain, but — unlike a merely "durable in
// practice" reference — safe to treat as a STABLE identifier specifically
// because Task 45 made matchups.id stable across re-normalization (upsert by
// natural key, never regenerated), the same precedent `events.matchupId`
// documents. `playerId` IS a real FK (players is upserted, never dropped/
// rebuilt — same precedent as roster_slots.playerId).
// ---------------------------------------------------------------------------

export const revengeEvents = sqliteTable(
  "revenge_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    // The franchise that once rostered this player and later lost them.
    franchiseId: integer("franchise_id").notNull(),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.espnPlayerId),
    departureType: text("departure_type", { enum: ["dropped", "traded_away"] as const }).notNull(),
    departureTransactionId: integer("departure_transaction_id").notNull(),
    departureEspnTxId: text("departure_espn_tx_id").notNull(),
    // Who the player actually played FOR in this specific game.
    currentFranchiseId: integer("current_franchise_id").notNull(),
    currentTeamSeasonId: integer("current_team_season_id").notNull(),
    matchupId: integer("matchup_id").notNull(),
    season: integer("season").notNull(),
    week: integer("week").notNull(),
    points: real("points").notNull(),
    // True iff this specific game's opponent WAS the former franchise — the revenge-points
    // filter. False rows still count toward "most painful former player" (post-departure points
    // anywhere).
    isAgainstFormerFranchise: integer("is_against_former_franchise", { mode: "boolean" }).notNull(),
  },
  (t) => [
    unique("revenge_events_franchise_id_player_id_season_week_unique").on(t.franchiseId, t.playerId, t.season, t.week),
    index("revenge_events_franchise_id_idx").on(t.franchiseId),
    index("revenge_events_franchise_id_player_id_idx").on(t.franchiseId, t.playerId),
    index("revenge_events_franchise_id_against_idx").on(t.franchiseId, t.isAgainstFormerFranchise),
  ],
);

export type RevengeEventRow = typeof revengeEvents.$inferSelect;
export type NewRevengeEventRow = typeof revengeEvents.$inferInsert;

// ---------------------------------------------------------------------------
// PWA + Web Push (Task 39, roadmap §30, migration 0013) — operational/app tables (layer 3),
// never touched by a stats rebuild, never dropped/rebuilt like layer-2. `managerId` IS a real
// hard FK on both (same precedent as poll_votes.manager_id / predictions.manager_id above) —
// `managers` is stable, never dropped/rebuilt by normalizeSeason.
//
// `push_subscriptions` is one row per browser/device endpoint a manager has granted Notification
// permission on and subscribed via the Push API — a manager with N devices has N independent
// rows, each with its OWN delivery watermark (see `lastDeliveredEventId` below), since two
// devices for the same manager advance independently (one could be offline/uninstalled while the
// other keeps receiving). `notification_prefs` is ONE row per manager (not per subscription) —
// preferences are a per-person setting shared across every device that manager subscribes from;
// a manager with zero rows here gets the defaults baked into every column below (see
// src/engines/pushNotifications.ts's DEFAULT_NOTIFICATION_PREFS, which must stay in sync with
// these column defaults by hand — Drizzle's `.default()` only applies at INSERT time, so a row
// really does get these exact values the first time it's created).
// ---------------------------------------------------------------------------

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    managerId: integer("manager_id")
      .notNull()
      .references(() => managers.id),
    // The browser's own PushSubscription.endpoint URL — globally unique per device/browser
    // profile (re-subscribing the SAME device replaces its keys via onConflictDoUpdate, never
    // creates a second row for the same endpoint).
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    // Worker-side delivery watermark (Task 39 brief item 3): the highest `events.id` this specific
    // subscription has already considered (sent, collapsed into a summary, OR filtered out by
    // that manager's prefs) — never a global/per-manager watermark. Starts at 0 (below every real
    // `events.id`, which is AUTOINCREMENT starting at 1), so a brand-new subscription's first send
    // pass considers every event that exists at subscribe time. Advances even for
    // preference-filtered events (not just delivered ones) — see sender.ts's docstring for why:
    // otherwise a manager flipping a preference ON later would get flooded with every historical
    // event that pref used to exclude.
    lastDeliveredEventId: integer("last_delivered_event_id").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("push_subscriptions_manager_id_idx").on(t.managerId)],
);

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscriptionRow = typeof pushSubscriptions.$inferInsert;

export const notificationPrefs = sqliteTable("notification_prefs", {
  managerId: integer("manager_id")
    .primaryKey()
    .references(() => managers.id),
  // Defaults per the Task 39 brief: ON for finals/belt events/weekly recap, OFF for lead changes.
  // `records` (RecordBroken + BeatdownOfWeek, grouped — the brief's pref list doesn't name
  // beatdowns separately, so they're folded into "records" as a judgment call, see
  // task-39-report.md) and `lineupHoles` (LineupHoleDetected only, gated to the viewer's OWN
  // franchiseId — never LineupHoleResolved, which isn't actionable) both default ON — also a
  // judgment call, not explicitly stated in the brief either way.
  leadChanges: integer("lead_changes", { mode: "boolean" }).notNull().default(false),
  finals: integer("finals", { mode: "boolean" }).notNull().default(true),
  records: integer("records", { mode: "boolean" }).notNull().default(true),
  beltEvents: integer("belt_events", { mode: "boolean" }).notNull().default(true),
  lineupHoles: integer("lineup_holes", { mode: "boolean" }).notNull().default(true),
  weeklyRecap: integer("weekly_recap", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type NotificationPrefsRow = typeof notificationPrefs.$inferSelect;
export type NewNotificationPrefsRow = typeof notificationPrefs.$inferInsert;

// ---------------------------------------------------------------------------
// League Chat (Task 40) — self-hosted, SSE-delivered. Two channel kinds v1: the
// league-wide "league" channel and per-matchup threads
// (`matchup:{season}:{week}:{matchupId}`), both plain text — v1 renders no markdown/HTML,
// every body is escaped on the way out (React's default text-child escaping; never
// `dangerouslySetInnerHTML`). No edit in v1; the only mutation after insert is a
// commissioner hard-delete (moderation).
//
// System ("The League") lines share this table with member messages rather than getting a
// parallel table, so a channel's history is a single ordered feed — but they are NEVER
// written into the `events` table (AGENTS.md: `events` is the live-ticker feed / cross-process
// dedupe ledger, not a chat log; conflating the two would let a chat rebuild-replay distort
// ticker history and vice versa). `kind` distinguishes the two; `managerId` is null for a
// system line (never a fabricated manager author) and the CHECK below makes that pairing a
// schema-level invariant, not just an application convention. System lines derive from
// MatchupFinished/BeltTransferred/RecordBroken `events` rows (src/server/sync/emit-events.ts) —
// `dedupeKey` carries a deterministic `system:<event kind>:<events.id>:<channel>` key so
// re-running the same event-to-chat pass (e.g. after a sync re-tick, or a worker restart) is a
// guaranteed no-op via `onConflictDoNothing`, same "insert-or-ignore, deterministic key" idiom
// `events.dedupeKey` itself uses. Ordinary member messages have no natural dedupe key and leave
// it null — SQLite's unique index treats every NULL as distinct, so any number of member
// messages can coexist with a null `dedupeKey`.
// ---------------------------------------------------------------------------
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // "league" | "matchup:{season}:{week}:{matchupId}" — validated at the query/action layer
    // (src/server/queries/chat.ts), not a DB enum, since the matchup form is parameterized.
    // The embedded matchupId is a DURABLE reference baked into every message's channel string at
    // post time — a message stored under `matchup:{season}:{week}:{matchupId}` must still resolve
    // to that same thread after any number of later re-normalizes, or the whole thread is orphaned
    // (Task 45). Safe only because normalize.ts upserts matchups by (season, week,
    // espn_matchup_id) rather than deleting and reinserting, so matchupId never changes once
    // assigned to a given ESPN schedule entry.
    channel: text("channel").notNull(),
    managerId: integer("manager_id").references(() => managers.id),
    kind: text("kind", { enum: ["user", "system"] as const }).notNull().default("user"),
    body: text("body").notNull(),
    dedupeKey: text("dedupe_key").unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Primary read path: "last N messages in this channel, in order" — src/server/queries/chat.ts
    // and the SSE stream's "since cursor N in this channel" poll both drive off this.
    index("chat_messages_channel_id_idx").on(t.channel, t.id),
    check(
      "chat_messages_kind_manager_id_check",
      sql`(kind = 'user' AND manager_id IS NOT NULL) OR (kind = 'system' AND manager_id IS NULL)`,
    ),
    // Generous but real — v1 is plain text chat, not a document editor; matches the
    // application-layer MAX_CHAT_BODY_LENGTH in src/features/chat/shared.ts (kept in sync by
    // hand, same as every other engine/DB constant pair in this schema).
    check("chat_messages_body_length_check", sql`length(body) <= 2000`),
  ],
);

export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;

// ---------------------------------------------------------------------------
// Draft Center (roadmap §17, Task 49, migration 0016) — derived stats, stage 9.
// See src/server/stats/build.ts and src/engines/draftValue.ts / draftGrades.ts. Same
// full-rebuild-every-time, one-transaction atomic swap, build_id tagging as every derived-stats
// table above.
//
// Sourced entirely from `draft_picks` joined against `roster_slots` for the drafted player's
// starter+bench points while on the DRAFTING team specifically (2018+ only — roster_slots has no
// rows before that; pre-2018 drafts get zero rows here, board-only rendering, never a fabricated
// grade — see draftValue.ts's docstring). `draftPickId`/`franchiseId`/`teamSeasonId` are
// INTENTIONALLY plain integers, not FKs — `draft_picks`/`team_seasons` are both dropped/rebuilt
// per season by normalizeSeason, same reasoning documented at the top of the "Layer 3 — derived
// stats" section above. `playerId` IS a real FK (players is upserted, never dropped/rebuilt —
// same precedent as roster_slots.playerId/waiver_acquisitions.playerId).
//
// Roster construction (the positional draft-capital profile — src/engines/draftRosterConstruction.ts)
// deliberately has NO table here: it needs only draft_picks + player position, no roster_slots
// dependency, so it's cheap enough to compute live at query time (src/server/queries/draft.ts) —
// the same "just query layer-2 directly" precedent src/server/queries/seasons.ts's own
// getSeasonDraftBoard already sets for the draft board itself. Persisting it would only add a
// stage with nothing expensive to save.
// ---------------------------------------------------------------------------

export const draftPickValues = sqliteTable(
  "draft_pick_values",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    season: integer("season").notNull(),
    draftPickId: integer("draft_pick_id").notNull(),
    franchiseId: integer("franchise_id").notNull(),
    teamSeasonId: integer("team_season_id").notNull(),
    playerId: integer("player_id")
      .notNull()
      .references(() => players.espnPlayerId),
    round: integer("round").notNull(),
    roundPick: integer("round_pick").notNull(),
    overallPick: integer("overall_pick").notNull(),
    // Sum of roster_slots.points (starter + bench) for this exact (season, team_season_id,
    // player_id) — never the player's whole-league season total. See draftValue.ts.
    value: real("value").notNull(),
    // 1 = most value produced that season, among every real (non-sentinel) 2018+ pick.
    valueRank: integer("value_rank").notNull(),
    totalRankedPicks: integer("total_ranked_picks").notNull(),
    // overallPick - valueRank: positive = steal (outperformed draft slot), negative = reach
    // (underperformed it), zero = performed exactly as drafted. See draftValue.ts's docstring for
    // the full definition and why this rank-based curve is the honest substitute for a real
    // "expected points" model (ESPN projections are null for every historical week).
    reachStealScore: integer("reach_steal_score").notNull(),
    reachStealPct: real("reach_steal_pct").notNull(),
  },
  (t) => [
    unique("draft_pick_values_draft_pick_id_unique").on(t.draftPickId),
    index("draft_pick_values_season_idx").on(t.season),
    index("draft_pick_values_franchise_id_season_idx").on(t.franchiseId, t.season),
  ],
);

export type DraftPickValueRow = typeof draftPickValues.$inferSelect;
export type NewDraftPickValueRow = typeof draftPickValues.$inferInsert;

/**
 * One row per (season, franchise) — the letter grade + the numbers behind it, curved against
 * that season's own league. See src/engines/draftGrades.ts for the exact z-score curve and
 * thresholds; disclosed identically in the UI wherever a grade renders.
 */
export const draftGrades = sqliteTable(
  "draft_grades",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    season: integer("season").notNull(),
    franchiseId: integer("franchise_id").notNull(),
    pickCount: integer("pick_count").notNull(),
    totalValue: real("total_value").notNull(),
    avgReachStealScore: real("avg_reach_steal_score").notNull(),
    avgReachStealPct: real("avg_reach_steal_pct").notNull(),
    zScore: real("z_score").notNull(),
    grade: text("grade", { enum: ["A", "B", "C", "D", "F"] as const }).notNull(),
  },
  (t) => [unique("draft_grades_season_franchise_id_unique").on(t.season, t.franchiseId)],
);

export type DraftGradeRow = typeof draftGrades.$inferSelect;
export type NewDraftGradeRow = typeof draftGrades.$inferInsert;

// ---------------------------------------------------------------------------
// Layer 3 — derived stats, stage 9: Playoff Odds (Task 52, roadmap §5, migration 0019). Monte
// Carlo regular-season simulation via src/engines/playoffOdds.ts, fed the CALIBRATED
// win-probability model (src/engines/eloCalibration.ts — raw Elo is proven miscalibrated, see
// that module's docstring) and this season's real playoff format
// (seasons.playoff_format_json/team_count). See src/server/stats/build.ts's stage 9 docstring and
// this task's report (task-52-report.md) for the honesty-core backtest that gated this feature —
// the model's Brier score beat a naive "current standings hold forever" baseline across all 11
// real complete seasons before this table was allowed to ship at all.
//
// CURRENT SEASON ONLY, recomputed every build — one row per franchise in whichever season is
// `seasons.status = 'active'` right now (0 or 1 such season at a time; see build.ts's stage 9).
// `unique` on franchiseId alone, not (season, franchiseId) — same "one current row per key, full
// rebuild replaces it" pattern franchise_elo/slot_scoring_stats already use, since there is no
// meaningful HISTORY to keep here, only "the latest odds." A complete season has real finals
// (never simulated odds); an upcoming season hasn't kicked off (nothing to simulate from) — both
// genuinely have zero rows here, not an error, per this table's own "current season only" scope.
// ---------------------------------------------------------------------------

export const playoffOdds = sqliteTable(
  "playoff_odds",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    buildId: integer("build_id")
      .notNull()
      .references(() => statBuilds.id),
    season: integer("season").notNull(),
    franchiseId: integer("franchise_id").notNull(),
    playoffProbability: real("playoff_probability").notNull(),
    topSeedProbability: real("top_seed_probability").notNull(),
    // Ordered array, index 0 = P(finish seed 1) ... index (team_count - 1) = P(finish last) — see
    // src/engines/playoffOdds.ts's PlayoffOddsFranchiseResult docstring.
    seedDistributionJson: text("seed_distribution_json", { mode: "json" }).notNull(),
    // The ACTUAL simulated-trajectory count this row's numbers are built from — can be 1 for a
    // season boundary with zero remaining regular-season games (fully decided, not a smaller/lazier
    // simulation — see the engine's own "no remaining games" short-circuit docstring), 10,000
    // otherwise (this build's fixed PLAYOFF_ODDS_RUNS constant).
    runs: integer("runs").notNull(),
  },
  (t) => [unique("playoff_odds_franchise_id_unique").on(t.franchiseId)],
);

export type PlayoffOddsRow = typeof playoffOdds.$inferSelect;
export type NewPlayoffOddsRow = typeof playoffOdds.$inferInsert;
