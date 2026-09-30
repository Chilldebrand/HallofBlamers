import type { PageRequest } from "../../src/contracts/cloud";

export const routePatterns = [
  "/", "/login", "/join", "/standings", "/history", "/seasons", "/seasons/:year",
  "/franchises", "/franchises/:id", "/matchups", "/matchups/:year/:week", "/matchups/:year/:week/:matchupId",
  "/transactions", "/timeline", "/records", "/h2h", "/h2h/:a/:b", "/belt", "/what-if",
  "/pickem", "/polls", "/polls/:id", "/predictions", "/recaps", "/recaps/:year/:week",
  "/admin", "/admin/recaps", "/admin/recaps/voice", "/admin/recaps/:id", "/admin/polls", "/admin/polls/:id",
] as const;

export function internalHref(href: string): string {
  if (!href.startsWith("/") || href.startsWith("//") || /[\\\x00-\x20]/.test(href)) throw new Error("Invalid internal link");
  return "#" + href;
}

export function parseRoute(url: string): PageRequest {
  const notFound = { route: "/404", params: {}, query: {} };
  try {
    const hash = new URL(url).hash.slice(1) || "/";
    internalHref(hash);
    const parsed = new URL(hash, "https://hallofblamers.invalid");
    const path = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    for (const pattern of routePatterns) {
      const segments = pattern.split("/").filter(Boolean);
      if (segments.length !== path.length) continue;
      const params: Record<string, string> = {};
      if (segments.every((segment, i) => segment.startsWith(":") ? ((params[segment.slice(1)] = path[i]), true) : segment === path[i])) {
        return { route: pattern, params, query: Object.fromEntries(parsed.searchParams) };
      }
    }
    return notFound;
  } catch { return notFound; }
}
