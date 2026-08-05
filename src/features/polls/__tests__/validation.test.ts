import { describe, expect, it } from "vitest";
import { validatePollForm, type PollFormInput } from "../validation";

const BASE: PollFormInput = {
  question: "Draft date?",
  description: "",
  kind: "single",
  anonymous: false,
  allowWriteIn: false,
  closesAt: "",
  options: ["Saturday", "Sunday"],
};

describe("validatePollForm", () => {
  it("accepts a well-formed single-choice poll", () => {
    const result = validatePollForm(BASE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.options).toEqual(["Saturday", "Sunday"]);
      expect(result.value.description).toBeNull();
    }
  });

  it("rejects an empty question", () => {
    const result = validatePollForm({ ...BASE, question: "   " });
    expect(result).toEqual({ ok: false, error: "Question is required." });
  });

  it("rejects an invalid kind", () => {
    const result = validatePollForm({ ...BASE, kind: "ranked" });
    expect(result).toEqual({ ok: false, error: "Kind must be single or multi." });
  });

  it("rejects fewer than 2 options when write-ins are not allowed", () => {
    const result = validatePollForm({ ...BASE, options: ["Only one"] });
    expect(result).toEqual({ ok: false, error: "Add at least 2 options, or enable write-ins." });
  });

  it("allows zero (or one) options when write-ins ARE allowed", () => {
    expect(validatePollForm({ ...BASE, allowWriteIn: true, options: [] }).ok).toBe(true);
    expect(validatePollForm({ ...BASE, allowWriteIn: true, options: ["Only one"] }).ok).toBe(true);
  });

  it("dedupes options case-insensitively rather than rejecting the form", () => {
    const result = validatePollForm({ ...BASE, options: ["Saturday", "saturday", "Sunday", "  Sunday  "] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.options).toEqual(["Saturday", "Sunday"]);
  });

  it("filters out blank option rows", () => {
    const result = validatePollForm({ ...BASE, options: ["Saturday", "", "  ", "Sunday"] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.options).toEqual(["Saturday", "Sunday"]);
  });

  it("rejects a malformed closesAt date", () => {
    const result = validatePollForm({ ...BASE, closesAt: "2026-02-30" });
    expect(result).toEqual({ ok: false, error: "2026-02-30 is not a real calendar date." });
  });

  it("accepts a well-formed closesAt date", () => {
    const result = validatePollForm({ ...BASE, closesAt: "2026-08-29" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.closesAt).toEqual(new Date(Date.UTC(2026, 7, 29)));
  });

  it("treats an empty closesAt as no deadline", () => {
    const result = validatePollForm({ ...BASE, closesAt: "" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.closesAt).toBeNull();
  });

  it("trims the question and converts an empty description to null", () => {
    const result = validatePollForm({ ...BASE, question: "  Padded question  ", description: "   " });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.question).toBe("Padded question");
      expect(result.value.description).toBeNull();
    }
  });
});
