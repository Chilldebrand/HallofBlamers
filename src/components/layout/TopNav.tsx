"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui/cn";
import { ADMIN_NAV_ITEM, NAV_ITEMS, isNavItemActive } from "./nav-items";

export interface TopNavProps {
  /** Appends the Admin link — only ever true for a commissioner session. */
  isCommissioner?: boolean;
  /** The signed-in manager's own display name, right slot. */
  managerName: string;
  /** Null when the manager has no franchise attached yet. */
  franchiseName: string | null;
}

/**
 * Desktop top navigation — hidden below `md`, replaced by BottomTabBar.
 * Full-bleed chrome bar per docs/design/redesign-2026-08/README.md's Shell
 * spec: wordmark block, nav items from nav-items.ts (Admin appended for
 * commissioners), active item gets a kelly-bright underline, right slot
 * shows "<manager> · <franchise>".
 */
export function TopNav({ isCommissioner = false, managerName, franchiseName }: TopNavProps) {
  const pathname = usePathname();
  const items = isCommissioner ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;

  return (
    <nav className="hidden border-b border-line bg-chrome md:block">
      <div className="flex items-stretch">
        <Link
          href="/"
          className="display shrink-0 border-r border-line px-[22px] py-4 text-[19px] tracking-[0.14em] text-ink-on-chrome"
        >
          Hall of Blamers
        </Link>
        <ul className="flex items-center">
          {items.map((item) => {
            const active = isNavItemActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "display block border-b-2 px-[18px] py-4 text-[15px] tracking-[0.12em] transition-colors",
                    active ? "border-kelly-bright text-ink-on-chrome" : "border-transparent text-muted-on-chrome hover:text-ink-on-chrome",
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="ml-auto flex shrink-0 items-center px-[22px] text-sm text-muted-on-chrome">
          {managerName}
          {franchiseName ? ` · ${franchiseName}` : null}
        </div>
      </div>
    </nav>
  );
}
