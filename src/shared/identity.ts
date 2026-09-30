import type { FranchiseNameFlags } from "../components/league/FranchiseName";

export interface IdentityFlags {
  championFranchiseId: number | null;
  beltHolderFranchiseId: number | null;
  sackoFranchiseId: number | null;
  viewerFranchiseId: number | null;
}

export function resolveFranchiseFlags(flags: IdentityFlags, franchiseId: number): FranchiseNameFlags {
  return {
    isChampion: flags.championFranchiseId === franchiseId,
    holdsBelt: flags.beltHolderFranchiseId === franchiseId,
    isSacko: flags.sackoFranchiseId === franchiseId,
    isViewer: flags.viewerFranchiseId === franchiseId,
  };
}
