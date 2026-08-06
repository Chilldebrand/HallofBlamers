import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS, setSessionCookie, verifySessionToken } from "./session";

const ORIGINAL_SECRET = process.env.SESSION_SECRET;
const setCookie = vi.fn();

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: setCookie }),
}));

beforeEach(() => {
  process.env.SESSION_SECRET = "a".repeat(32);
  setCookie.mockReset();
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.SESSION_SECRET;
  } else {
    process.env.SESSION_SECRET = ORIGINAL_SECRET;
  }

  vi.unstubAllEnvs();
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

describe("setSessionCookie", () => {
  it("sets an HTTP-compatible session cookie in development", async () => {
    vi.stubEnv("NODE_ENV", "development");

    await setSessionCookie(42);

    expect(setCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, expect.any(String), {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: "/",
    });
  });

  it("retains a secure session cookie in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await setSessionCookie(42);

    expect(setCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, expect.any(String), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: "/",
    });
  });
});
