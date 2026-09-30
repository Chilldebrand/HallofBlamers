import type * as S from '../../../src/server/db/schema';
import type {JsonDto} from '../../../src/contracts/cloud';
import type {LeagueShell} from './league';
import {supabase} from '../lib/supabase';

interface RowTypes {
 seasons:Pick<S.Season,'season'|'status'|'teamCount'|'regSeasonWeeks'>; franchises:S.Franchise; teamSeasons:S.TeamSeason;
 matchups:S.Matchup; weeks:S.Week; rosterSlots:S.RosterSlot; players:S.Player; teamWeek:S.TeamWeek;
 seasonStats:S.SeasonStat; careerStats:S.CareerStat; beltReigns:S.BeltReign; beltMatches:S.BeltMatch;
 records:S.RecordEntryRow; h2hPairs:S.H2HPair; eloHistory:S.EloHistory; achievements:typeof S.achievements.$inferSelect;
 contextNotes:typeof S.contextNotes.$inferSelect; recaps:Pick<S.Recap,'id'|'season'|'week'|'style'|'status'|'markdownFinal'|'createdAt'> & {markdownDraft?:string|null};
 draftPicks:S.DraftPick; events:S.Event; transactions:Omit<S.Transaction,'rawJson'>; transactionItems:S.TransactionItem;
 managers:Pick<S.Manager,'id'|'name'|'role'|'franchiseId'|'createdAt'>;
 memberships:{managerId:number;revokedAt:string|null}; syncRuns:Omit<S.SyncRun,'errorText'>;statBuilds:Pick<S.StatBuild,'id'|'startedAt'|'finishedAt'|'status'|'durationMs'>;
 settings:{key:string;valueJson:unknown};
}
export type PageData={shell:LeagueShell;season:number;week:number}&{[K in keyof RowTypes]:JsonDto<RowTypes[K]>[]};
const rowKeys:(keyof RowTypes)[]=['seasons','franchises','teamSeasons','matchups','weeks','rosterSlots','players','teamWeek','seasonStats','careerStats','beltReigns','beltMatches','records','h2hPairs','eloHistory','achievements','contextNotes','recaps','draftPicks','events','transactions','transactionItems','managers','memberships','syncRuns','statBuilds','settings'];
export function decodePage(raw:unknown):PageData {
 if(!raw||typeof raw!=='object'||!('shell' in raw)) throw Error('Invalid page response');
 const source=raw as Record<string,unknown>;const out={...source};
 for(const key of rowKeys){
  const rows=source[key]??[];
  if(!Array.isArray(rows)) throw Error('Invalid page rows');
  out[key]=rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()),v])));
 }
 return out as PageData;
}
export function pageRequest(path:string,search:string) {
 const query=new URLSearchParams(search); const parts=path.split('/').filter(Boolean);
 let route=parts[0]??'home'; let year:string|null=query.get('season'),week:string|null=null,id:string|null=null;
 if(route==='matchups'){if(parts.length>4)return null;year=parts[1]??year;week=parts[2]??null;id=parts[3]??null;}
 else if(route==='franchises'){if(parts.length>2)return null;id=parts[1]??null;}
 else if(route==='h2h'){if(parts.length!==1&&parts.length!==3)return null;id=parts[1]??null;if(parts[2]&&!/^\d+$/.test(parts[2]))return null;}
 else if(route==='seasons'){if(parts.length>2)return null;year=parts[1]??null;}
 else if(route==='recaps'){if(parts.length!==1&&parts.length!==3)return null;year=parts[1]??year;week=parts[2]??null;}
 else if(route==='admin'){if(parts.length>3||parts[1]&&parts[1]!=='recaps')return null;if(parts[1]){route='admin-recaps';id=parts[2]&&parts[2]!=='voice'?parts[2]:null;}}
 else if(parts.length>1)return null;
 if(!['home','matchups','history','franchises','h2h','seasons','records','belt','timeline','transactions','what-if','recaps','admin','admin-recaps'].includes(route))return null;
 const offset=query.get('offset')??'0';
 if([year,week,id,offset].some(v=>v!==null&&(!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v)))))return null;
 return {page_route:route,requested_season:year===null?null:Number(year),requested_week:week===null?null:Number(week),requested_id:id===null?null:Number(id),requested_offset:Number(offset)};
}
export async function fetchPage(request:NonNullable<ReturnType<typeof pageRequest>>,signal:AbortSignal){
 if(!supabase)throw Error('Connection unavailable');
 const {data,error}=await supabase.rpc('hob_page',request).abortSignal(signal);
 if(error)throw Object.assign(Error(error.code==='42501'?'You do not have access to this page.':error.code==='22023'?'This page could not be found.':'Unable to load this page. Please try again.'),{code:error.code});
 return decodePage(data);
}
export function matchupScore(final:boolean,score:number,projected:number|null){
 return final?score.toFixed(1):score!==0?`${score.toFixed(1)} · in progress`:projected!==null?`${projected.toFixed(1)} projected`:'Not played';
}
