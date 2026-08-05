import { describe, expect, it } from "vitest";
import { toPredictionRows, validatePredictionsForm, type PredictionsFormInput, type PredictionsValidationOpts } from "../validation";

const FRANCHISE_IDS = new Set([1, 2, 3]);

const BASE_OPTS: PredictionsValidationOpts = { activeFranchiseIds: FRANCHISE_IDS, hasFranchise: true, winTotalMax: 14 };

const BASE_INPUT: PredictionsFormInput = {
  champion: "1",
  sacko: "2",
  topScorer: "3",
  winTotal: "9",
  boldTake: "The sacko wins it all next year.",
};

describe("validatePredictionsForm", () => {
  it("accepts a well-formed submission", () => {
    const result = validatePredictionsForm(BASE_INPUT, BASE_OPTS);
    expect(result).toEqual({
      ok: true,
      value: { champion: 1, sacko: 2, topScorer: 3, winTotal: 9, boldTake: "The sacko wins it all next year." },
    });
  });

  it("rejects a blank champion pick", () => {
    const result = validatePredictionsForm({ ...BASE_INPUT, champion: "" }, BASE_OPTS);
    expect(result).toEqual({ ok: false, error: "Pick a champion." });
  });

  it("rejects a champion id that isn't a real active franchise", () => {
    const result = validatePredictionsForm({ ...BASE_INPUT, champion: "999" }, BASE_OPTS);
    expect(result).toEqual({ ok: false, error: "That's not a real franchise for champion." });
  });

  it("rejects a non-integer franchise id", () => {
    const result = validatePredictionsForm({ ...BASE_INPUT, sacko: "abc" }, BASE_OPTS);
    expect(result).toEqual({ ok: false, error: "That's not a real franchise for sacko." });
  });

  it("rejects a top-scorer id that isn't a real active franchise", () => {
    const result = validatePredictionsForm({ ...BASE_INPUT, topScorer: "42" }, BASE_OPTS);
    expect(result).toEqual({ ok: false, error: "That's not a real franchise for top scorer." });
  });

  describe("win total range", () => {
    it("accepts the boundary values 0 and winTotalMax", () => {
      expect(validatePredictionsForm({ ...BASE_INPUT, winTotal: "0" }, BASE_OPTS).ok).toBe(true);
      expect(validatePredictionsForm({ ...BASE_INPUT, winTotal: "14" }, BASE_OPTS).ok).toBe(true);
    });

    it("rejects a negative win total", () => {
      const result = validatePredictionsForm({ ...BASE_INPUT, winTotal: "-1" }, BASE_OPTS);
      expect(result).toEqual({ ok: false, error: "Win total has to be a whole number between 0 and 14." });
    });

    it("rejects a win total above winTotalMax", () => {
      const result = validatePredictionsForm({ ...BASE_INPUT, winTotal: "15" }, BASE_OPTS);
      expect(result).toEqual({ ok: false, error: "Win total has to be a whole number between 0 and 14." });
    });

    it("rejects a non-integer win total", () => {
      const result = validatePredictionsForm({ ...BASE_INPUT, winTotal: "7.5" }, BASE_OPTS);
      expect(result.ok).toBe(false);
    });

    it("respects a different winTotalMax (per-season regSeasonWeeks, never hardcoded)", () => {
      const opts = { ...BASE_OPTS, winTotalMax: 12 };
      expect(validatePredictionsForm({ ...BASE_INPUT, winTotal: "12" }, opts).ok).toBe(true);
      expect(validatePredictionsForm({ ...BASE_INPUT, winTotal: "13" }, opts)).toEqual({
        ok: false,
        error: "Win total has to be a whole number between 0 and 12.",
      });
    });

    it("requires a win total when the manager has a franchise", () => {
      const result = validatePredictionsForm({ ...BASE_INPUT, winTotal: "" }, BASE_OPTS);
      expect(result).toEqual({ ok: false, error: "Give your own team a win total." });
    });

    it("skips win total entirely (never fabricates 0) when the manager has no franchise", () => {
      const result = validatePredictionsForm({ ...BASE_INPUT, winTotal: "" }, { ...BASE_OPTS, hasFranchise: false });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.winTotal).toBeNull();
    });

    it("ignores a stray win total value when the manager has no franchise", () => {
      // Defensive: the page never renders this input for a franchise-less manager, but a crafted
      // request could still include it — it must be silently dropped, not validated/stored.
      const result = validatePredictionsForm({ ...BASE_INPUT, winTotal: "999" }, { ...BASE_OPTS, hasFranchise: false });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.winTotal).toBeNull();
    });
  });

  describe("bold take", () => {
    it("rejects an empty bold take", () => {
      const result = validatePredictionsForm({ ...BASE_INPUT, boldTake: "   " }, BASE_OPTS);
      expect(result).toEqual({ ok: false, error: "Give us a bold take." });
    });

    it("rejects a bold take over the max length", () => {
      const result = validatePredictionsForm({ ...BASE_INPUT, boldTake: "x".repeat(501) }, BASE_OPTS);
      expect(result).toEqual({ ok: false, error: "Keep the bold take under 500 characters." });
    });

    it("accepts a bold take at exactly the max length", () => {
      expect(validatePredictionsForm({ ...BASE_INPUT, boldTake: "x".repeat(500) }, BASE_OPTS).ok).toBe(true);
    });
  });
});

describe("toPredictionRows", () => {
  it("emits all five category rows when winTotal is set", () => {
    const rows = toPredictionRows({ champion: 1, sacko: 2, topScorer: 3, winTotal: 9, boldTake: "Bold." });
    expect(rows).toEqual([
      { category: "champion", subject: "1" },
      { category: "sacko", subject: "2" },
      { category: "top_scorer", subject: "3" },
      { category: "bold_take", subject: "Bold." },
      { category: "win_total", subject: "9" },
    ]);
  });

  it("omits the win_total row entirely when winTotal is null (no franchise) — never a fabricated 0", () => {
    const rows = toPredictionRows({ champion: 1, sacko: 2, topScorer: 3, winTotal: null, boldTake: "Bold." });
    expect(rows.some((r) => r.category === "win_total")).toBe(false);
    expect(rows).toHaveLength(4);
  });
});
