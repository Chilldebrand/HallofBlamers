/** Public API contracts. Type-only imports never pull SQLite into a browser bundle. */
export type SyncTier = "live" | "hourly" | "daily";
export type Viewer = { authUserId: string; managerId: number; role: "member" | "commissioner" };
export type SyncStatus = { state: "idle" | "pending" | "running" | "failed"; lastSuccessAt: string | null; generationId: string | null };
export type PageRequest = { route: string; params: Record<string, string>; query: Record<string, string> };
export type PageEnvelope<T> = { data: T; sync: SyncStatus };
export type MutationResult = { ok: true } | { ok: false; code: string; message: string };

/** Preserve result shapes while making every timestamp serializable. */
export type JsonDto<T> = T extends Date ? string : T extends readonly (infer Item)[] ? JsonDto<Item>[] : T extends object ? { [Key in keyof T]: JsonDto<T[Key]> } : T;
export type StandingsRowDto = JsonDto<import("../server/queries/standings").StandingsRealRow>;
export type CareerStandingsRowDto = JsonDto<import("../server/queries/standings").StandingsRealCareerRow>;
export type LuckStandingsRowDto = JsonDto<import("../server/queries/standings").StandingsLuckRow>;
export type SeasonOptionDto = import("../server/queries/standings").SeasonOption;
export type FranchiseIndexDto = JsonDto<import("../server/queries/franchises").FranchiseIndexRow>;
export type TransactionCenterDto = JsonDto<import("../server/queries/transactions").TransactionCenterModel>;
export type WhatIfPageDto = JsonDto<import("../server/queries/whatIf").WhatIfPageData>;
export type IdentityFlagsDto = import("../server/queries/identity").IdentityFlags;
export type BeltReignDto = JsonDto<import("../server/queries/belt").CurrentReignDetail>;
