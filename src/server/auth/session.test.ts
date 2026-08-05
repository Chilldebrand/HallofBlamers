import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "./session";

const ORIGINAL_SECRET = process.env.SESSION_SECRET;

beforeEach(() => {
  process.env.SESSION_SECRET = "a".repeat(32);
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.SESSION_SECRET;
  } else {
    process.env.SESSION_SECRET = ORIGINAL_SECRET;
  }
});

describe("createSessionToken / verifySessionToken", () => {
  it("round-trips a manager id", async () => {
    const token = await createSessionToken(42);
    const payload = await verifySessionToken(token);
    expect(payload).toEqual({ managerId: 42 });
  });

  it("rejects a tampered token", async () => {
    const token = await createSessionToken(42);
    const [header, body] = token.split(".");
    // Swap in a bogus signature segment — guaranteed to fail verification
    // deterministically, unlike flipping a single base64url character (which
    // can land on an unused padding bit and decode to the same byte).
    const tampered = `${header}.${body}.invalidsignatureinvalidsignature`;

    const payload = await verifySessionToken(tampered);
    expect(payload).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken(42);
    process.env.SESSION_SECRET = "b".repeat(32);
    const payload = await verifySessionToken(token);
    expect(payload).toBeNull();
  });

  it("rejects an expired token", async () => {
    const key = new TextEncoder().encode(process.env.SESSION_SECRET);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ managerId: 7 })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(nowSeconds - 1000)
      .setExpirationTime(nowSeconds - 10)
      .sign(key);

    const payload = await verifySessionToken(expired);
    expect(payload).toBeNull();
  });

  it("throws when SESSION_SECRET is missing", async () => {
    delete process.env.SESSION_SECRET;
    await expect(createSessionToken(1)).rejects.toThrow(/SESSION_SECRET/);
  });

  it("throws when SESSION_SECRET is too short", async () => {
    process.env.SESSION_SECRET = "too-short";
    await expect(createSessionToken(1)).rejects.toThrow(/SESSION_SECRET/);
  });
});
