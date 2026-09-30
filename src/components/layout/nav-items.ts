export interface NavItem {
  href: string;
  label: string;
}

/** Temporarily paused by the league owner; remove entries here to restore them. */
export const PAUSED_ROUTES = ["/polls", "/predictions", "/pickem", "/admin/polls"];

export function isRoutePaused(pathname: string): boolean {
  return PAUSED_ROUTES.some(route => pathname === route || pathname.startsWith(`${route}/`));
}

/** Shared by the existing app and Pages preview. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home" },
  { href: "/matchups", label: "Matchups" },
  { href: "/standings", label: "Standings" },
  { href: "/history", label: "History" },
  { href: "/belt", label: "Belt" },
  { href: "/recaps", label: "Recaps" },
  { href: "/polls", label: "Polls" },
  { href: "/predictions", label: "Predictions" },
  { href: "/pickem", label: "Pick'em" },
].filter(item => !isRoutePaused(item.href));

/** Appended only for a commissioner session — see (league)/layout.tsx. */
export const ADMIN_NAV_ITEM: NavItem = { href: "/admin", label: "Admin" };

/**
 * The phone sticky tab bar's fixed 5 columns (README Shell spec: "5 equal
 * columns"), a curated subset of NAV_ITEMS rather than the full (growing)
 * list TopNav shows on desktop — History stays reachable from the
 * Home page's own links, and Admin (desktop nav, commissioner-only) isn't
 * part of the primary mobile bar, matching README's own screen list (Admin
 * has no phone frame designed for it either).
 */
export const PHONE_TAB_ITEMS: NavItem[] = [
  { href: "/", label: "Home" },
  { href: "/matchups", label: "Matchups" },
  { href: "/standings", label: "Standings" },
  { href: "/belt", label: "Belt" },
  { href: "/recaps", label: "Recaps" },
];

export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
