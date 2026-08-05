type ClassValue = string | false | null | undefined;

/** Minimal classname joiner — no conflict resolution, just filters falsy values. */
export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(" ");
}
