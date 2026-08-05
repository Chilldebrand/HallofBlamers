/**
 * Which season year the worker's hourly/daily sync tiers should fetch
 * (Task 15). Deliberately a PURE function of wall-clock time, not DB state —
 * it has to give a sensible answer even against a brand-new, empty database
 * (first-ever worker startup on a freshly provisioned box has zero `seasons`
 * rows to consult).
 *
 * ESPN's fantasy league year runs roughly February (next season's league
 * settings/draft prep become available) through the following January (the
 * Super Bowl / championship week). So: January and February still belong to
 * the season that's wrapping up (drafted the PREVIOUS calendar year);
 * March onward belongs to the season that started this calendar year.
 *
 * This is a heuristic, not an ESPN-confirmed cutover date — it only needs to
 * be right for "what season is realistically active or about to be," which
 * is all the hourly/daily tiers need. It does not need to be exact to the
 * day; a season is `active`/`upcoming` for months on either side of any
 * plausible cutover.
 */
export function determineCurrentSeasonYear(now: Date = new Date()): number {
  const month = now.getUTCMonth(); // 0 = January
  const year = now.getUTCFullYear();
  return month <= 1 ? year - 1 : year;
}
