import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { managers, type Manager } from "../db/schema";

/** Looks up a manager by invite token. Used by /join/[token]. */
export function findManagerByInviteToken(db: Db, token: string): Manager | null {
  const row = db.select().from(managers).where(eq(managers.inviteToken, token)).get();
  return row ?? null;
}
