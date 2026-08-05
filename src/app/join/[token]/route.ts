import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getDb } from "@/server/db/client";
import { findManagerByInviteToken } from "@/server/auth/invite";
import { setSessionCookie } from "@/server/auth/session";

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const manager = findManagerByInviteToken(getDb(), token);

  if (!manager) {
    // Friendly error page: /login doubles as the "ask the commissioner for a
    // fresh link" landing when arriving with ?invalid=1.
    return NextResponse.redirect(new URL("/login?invalid=1", request.url));
  }

  await setSessionCookie(manager.id);
  return NextResponse.redirect(new URL("/", request.url));
}
