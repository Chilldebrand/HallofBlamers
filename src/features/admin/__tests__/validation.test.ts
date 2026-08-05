import { describe, expect, it } from "vitest";
import { validateDraftDate, validateEspnCookiesForm, validateManagerForm } from "../validation";

describe("validateDraftDate", () => {
  it("accepts a real YYYY-MM-DD date", () => {
    expect(validateDraftDate("2026-08-29")).toEqual({ ok: true, value: "2026-08-29" });
  });

  it("trims surrounding whitespace", () => {
    expect(validateDraftDate("  2026-08-29  ")).toEqual({ ok: true, value: "2026-08-29" });
  });

  it("rejects a malformed string", () => {
    const result = validateDraftDate("08/29/2026");
    expect(result.ok).toBe(false);
  });

  it("rejects a non-existent calendar date (Feb 30) rather than silently rolling it forward", () => {
    const result = validateDraftDate("2026-02-30");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(validateDraftDate("").ok).toBe(false);
  });

  it("accepts a real leap-day date", () => {
    expect(validateDraftDate("2028-02-29")).toEqual({ ok: true, value: "2028-02-29" });
  });

  it("rejects Feb 29 on a non-leap year", () => {
    expect(validateDraftDate("2026-02-29").ok).toBe(false);
  });
});

describe("validateManagerForm", () => {
  it("accepts a well-formed submission with a franchise", () => {
    const result = validateManagerForm({ name: "Alice", role: "manager", franchiseId: "3" });
    expect(result).toEqual({ ok: true, value: { name: "Alice", role: "manager", franchiseId: 3 } });
  });

  it("accepts an empty franchiseId as null (no franchise assigned yet)", () => {
    const result = validateManagerForm({ name: "Alice", role: "commissioner", franchiseId: "" });
    expect(result).toEqual({ ok: true, value: { name: "Alice", role: "commissioner", franchiseId: null } });
  });

  it("trims the name", () => {
    const result = validateManagerForm({ name: "  Alice  ", role: "manager", franchiseId: "" });
    expect(result.ok && result.value.name).toBe("Alice");
  });

  it("rejects an empty name", () => {
    expect(validateManagerForm({ name: "   ", role: "manager", franchiseId: "" }).ok).toBe(false);
  });

  it("rejects a role outside the enum", () => {
    expect(validateManagerForm({ name: "Alice", role: "superadmin", franchiseId: "" }).ok).toBe(false);
  });

  it("rejects a non-numeric franchiseId", () => {
    expect(validateManagerForm({ name: "Alice", role: "manager", franchiseId: "abc" }).ok).toBe(false);
  });
});

describe("validateEspnCookiesForm", () => {
  const REAL_SWID = "{ABCDEF12-3456-7890-ABCD-EF1234567890}";
  const REAL_S2 = "A".repeat(120); // ESPN's real espn_s2 values run several hundred chars; 120 is comfortably over the 50-char floor

  it("accepts a well-formed submission", () => {
    const result = validateEspnCookiesForm({ espnS2: REAL_S2, swid: REAL_SWID });
    expect(result).toEqual({ ok: true, value: { espnS2: REAL_S2, swid: REAL_SWID } });
  });

  it("rejects a SWID missing its curly braces", () => {
    const result = validateEspnCookiesForm({ espnS2: REAL_S2, swid: REAL_SWID.slice(1, -1) });
    expect(result.ok).toBe(false);
  });

  it("rejects a SWID with only one brace", () => {
    expect(validateEspnCookiesForm({ espnS2: REAL_S2, swid: `{${REAL_SWID.slice(1, -1)}` }).ok).toBe(false);
    expect(validateEspnCookiesForm({ espnS2: REAL_S2, swid: `${REAL_SWID.slice(1, -1)}}` }).ok).toBe(false);
  });

  it("rejects a SWID containing characters outside hex/dash", () => {
    expect(validateEspnCookiesForm({ espnS2: REAL_S2, swid: "{not-a-real-guid-!!}" }).ok).toBe(false);
  });

  it("rejects an espn_s2 that's too short", () => {
    const result = validateEspnCookiesForm({ espnS2: "short", swid: REAL_SWID });
    expect(result.ok).toBe(false);
  });

  it("preserves the SWID's braces verbatim in the returned value — never strips them", () => {
    const result = validateEspnCookiesForm({ espnS2: REAL_S2, swid: REAL_SWID });
    expect(result.ok && result.value.swid).toBe(REAL_SWID);
    expect(result.ok && result.value.swid.startsWith("{")).toBe(true);
    expect(result.ok && result.value.swid.endsWith("}")).toBe(true);
  });

  it("never trims or otherwise transforms espn_s2 — a URL-encoded-looking value passes through byte-for-byte", () => {
    const encodedLooking = `${"B".repeat(60)}%2F%3D${"C".repeat(60)}`; // real espn_s2 values often contain %-encoded chars
    const result = validateEspnCookiesForm({ espnS2: encodedLooking, swid: REAL_SWID });
    expect(result.ok && result.value.espnS2).toBe(encodedLooking);
  });

  it("does NOT trim incidental leading/trailing whitespace — a stray copy-paste space fails validation rather than being silently fixed", () => {
    const result = validateEspnCookiesForm({ espnS2: REAL_S2, swid: `  ${REAL_SWID}  ` });
    expect(result.ok).toBe(false);
  });
});
