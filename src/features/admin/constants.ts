/**
 * Shared between actions.ts ("use server" — every export there must be an
 * async function, so this constant can't live there) and the /admin page
 * that reads the cookie back.
 */
export const ADMIN_REVEAL_COOKIE = "wbb_admin_reveal";
