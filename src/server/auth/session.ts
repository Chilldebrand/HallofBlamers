import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE_NAME = "wbb_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 365 days

export interface SessionPayload {
  managerId: number;
}

/**
 * Reads and validates SESSION_SECRET on every call (rather than caching a
 * possibly-bad value from an earlier import) so a missing/short secret fails
 * loudly and immediately the first time any auth operation runs.
 */
function getSecretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "SESSION_SECRET is missing or too short (need at least 32 characters). Set it in .env — see .env.example.",
    );
  }
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(managerId: number): Promise<string> {
  return new SignJWT({ managerId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("365d")
    .sign(getSecretKey());
}

/** Verifies signature + expiry. Returns null (never throws) on any failure, including tampering. */
export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), { algorithms: ["HS256"] });
    if (typeof payload.managerId !== "number") return null;
    return { managerId: payload.managerId };
  } catch {
    return null;
  }
}

/**
 * Signs a fresh token for `managerId` and sets it as the session cookie.
 * Only callable from a Server Action or Route Handler (Next.js restriction
 * on mutating cookies during a plain render) — used by /join/[token].
 */
export async function setSessionCookie(managerId: number): Promise<void> {
  const token = await createSessionToken(managerId);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
  });
}
