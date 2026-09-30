import {optimalLineupSeason,type OptimalLineupSeasonResult} from '../../../src/engines/whatIf';
import type {PageData} from './pages';

export function pageSchedules(data:PageData){
 const regular=data.teamWeek.filter(r=>r.weekType==='regular'&&(r.result!==null||r.opponentFranchiseId===null));
 return data.teamSeasons.filter(t=>t.season===data.season).map(t=>({franchiseId:t.franchiseId,weeks:regular.filter(r=>r.franchiseId===t.franchiseId).map(r=>({week:r.week,ownScore:r.score,opponentFranchiseId:r.opponentFranchiseId,opponentScore:regular.find(o=>o.franchiseId===r.opponentFranchiseId&&o.week===r.week)?.score??null}))}));
}
export function pageOptimalLineup(data:PageData,franchiseId:number):OptimalLineupSeasonResult{
 const weeks=data.teamWeek.filter(r=>r.franchiseId===franchiseId&&r.result!==null).map(r=>({week:r.week,actualScore:r.score,optimalScore:r.optimalScore,opponentFranchiseId:r.opponentFranchiseId,opponentScore:data.teamWeek.find(o=>o.franchiseId===r.opponentFranchiseId&&o.week===r.week&&o.result!==null)?.score??null}));
 if(weeks.some(w=>w.opponentFranchiseId!==null&&w.opponentScore===null))return {season:data.season,franchiseId,available:false,record:null,unavailableReason:'Opponent scores are missing for a decided week, so Perfect Lineups is unavailable for this season.'};
 return optimalLineupSeason(data.season,franchiseId,weeks);
}
