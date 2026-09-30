"use client";

import Link from "./Link";
import { useLocation } from "react-router-dom";
import { cn } from "@/components/ui/cn";
import { PHONE_TAB_ITEMS, isNavItemActive } from "@/components/layout/nav-items";

/**
 * Mobile bottom tab bar — visible below `md`, replaced by TopNav on
 * desktop. `position: sticky` (not `fixed`) per README's Shell spec: it
 * takes up real space in the flex column, so it sits right after short
 * content and only pins to the viewport bottom once content overflows —
 * `main`'s `flex-1` in (league)/layout.tsx does the rest, no manual bottom
 * padding needed to keep it from overlapping content. Fixed 5 columns
 * (PHONE_TAB_ITEMS) — see nav-items.ts for why that's a curated subset of
 * the desktop nav, not the full list.
 */
export function BottomTabBar() {
  const { pathname } = useLocation();

  return (
    <nav className="sticky bottom-0 z-40 grid grid-cols-5 border-t border-line bg-chrome md:hidden">
      {PHONE_TAB_ITEMS.map((item) => {
        const active = isNavItemActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "display flex min-h-[44px] flex-col items-center justify-center gap-0.5 py-[14px] text-[11px] tracking-wide transition-colors",
              active ? "text-kelly-bright" : "text-muted-on-chrome",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
