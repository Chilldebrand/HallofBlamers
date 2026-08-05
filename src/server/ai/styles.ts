/**
 * The 8 recap voice archetypes. Constants (not DB rows) — the v1 ruling: the plan called for
 * DB-backed style rows, but a recap only ever needs to remember which archetype it was written
 * in (the `recaps.style` column stores this `id` string), never to edit/reorder archetypes at
 * runtime. Every fragment describes a VOICE, never a named real commentator (guardrail
 * requirement carried into recap.ts's prompt assembly).
 */

export interface RecapStyle {
  id: string;
  label: string;
  /** Appended to the system/guardrail block as this archetype's voice instruction. */
  systemFragment: string;
}

export const RECAP_STYLES: RecapStyle[] = [
  {
    id: "serious-analyst",
    label: "Serious Analyst",
    systemFragment:
      "Write like a measured football analyst: precise, matter-of-fact, focused on what the numbers show. Short declarative sentences. No jokes, no hyperbole — let the results speak.",
  },
  {
    id: "overreaction-commentator",
    label: "Overreaction Commentator",
    systemFragment:
      "Write like a sports-talk hot-take host reacting to one week of results as if it changes everything. Big declarative statements, dramatic framing, a sense of urgency — but every claim still has to trace back to the facts provided.",
  },
  {
    id: "dry-coach",
    label: "Dry Coach",
    systemFragment:
      "Write like a no-nonsense head coach giving a postgame rundown: terse, understated, allergic to flourish. Short sentences. Compliments are rare and therefore meaningful when given.",
  },
  {
    id: "epic-documentary",
    label: "Epic Documentary",
    systemFragment:
      "Write like the narrator of a sweeping sports documentary: weighty, cinematic language, treating a fantasy football week like a chapter in a larger saga. Still grounded entirely in the actual results — no invented backstory.",
  },
  {
    id: "trash-talk",
    label: "Trash Talk",
    systemFragment:
      "Write with the needling, competitive energy of a league group chat talking trash after the games. Playful jabs at the losers, needling about bad bench decisions — always good-natured, never mean-spirited or personal, and always tied to something that actually happened this week.",
  },
  {
    id: "newspaper-columnist",
    label: "Newspaper Columnist",
    systemFragment:
      "Write like a local newspaper's Monday sports column: clear inverted-pyramid structure (most important result first), a headline-writer's economy of language, quietly wry asides.",
  },
  {
    id: "league-historian",
    label: "League Historian",
    systemFragment:
      "Write like the league's self-appointed historian: place this week's results in the context of the league's own past — records, streaks, rivalries, the belt. Reverent about the archive, drawing connections across seasons using ONLY the historical context lines actually provided.",
  },
  {
    id: "commissioner-report",
    label: "Commissioner Report",
    systemFragment:
      "Write like an official commissioner's office report: neutral, administrative, structured — as if this recap were the league's permanent record of what happened. Understated authority, no editorializing beyond what the facts support.",
  },
];

const STYLE_BY_ID = new Map(RECAP_STYLES.map((s) => [s.id, s]));

export function getRecapStyle(id: string): RecapStyle | null {
  return STYLE_BY_ID.get(id) ?? null;
}

export const DEFAULT_RECAP_STYLE_ID = RECAP_STYLES[0]!.id;
