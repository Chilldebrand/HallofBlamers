import { expect,test } from 'vitest';
import { buildFranchiseSeed,buildSeasonScopePayload,buildWeekScopePayload,buildTransactionsPeriodPayload } from '../../../src/server/sync/__fixtures__/season-2024';
import type { FetchLeagueParams } from '../../../src/server/espn/types';
import { refreshWorkspace, periodsToFetch } from '../run';
import type { DataSet } from '../workspace';

test('hourly catches missing weeks while daily refetches only elapsed periods',()=>{
 expect(periodsToFetch('hourly',4,new Set([1,2]),new Set([1,2]))).toEqual([3,4]);
 expect(periodsToFetch('daily',4,new Set([1,2,3,4]),new Set([1,2,3,4]))).toEqual([1,2,3,4]);
 expect(periodsToFetch('live',0,new Set(),new Set())).toEqual([]);
});
function input():DataSet {
 const seed=buildFranchiseSeed();
 return {franchises:seed.franchises.map(f=>({id:f.id,canonical_name:f.canonicalName,manager_name:f.managerName,joined_season:f.joinedSeason,departed_season:f.departedSeason,active:f.active,accent_color:f.accentColor,notes:f.notes})),franchise_managers:seed.franchises.flatMap(f=>f.managers.map((m,i)=>({id:f.id*10+i,franchise_id:f.id,manager_name:m.managerName,espn_owner_swid:m.espnOwnerSwid,from_season:m.fromSeason,to_season:m.toSeason}))),team_seasons:[],snapshots:[],app_settings:[]};
}
test('builds a complete generation from ESPN without a local database file',async()=>{
 const client={async fetchLeague(p:FetchLeagueParams){const json=p.scoringPeriodId===undefined?buildSeasonScopePayload():p.views.includes('mRoster')?buildWeekScopePayload(p.scoringPeriodId as 1|2):buildTransactionsPeriodPayload(p.scoringPeriodId,[]);return {json,payload:JSON.stringify(json),status:200,url:'https://example.test/fixture'};}};
 const result=await refreshWorkspace(input(),{},client,{season:2024,tier:'daily',leagueId:555,sleep:async()=>{}});
 expect(result.viewsFetched).toBe(5);
 expect(result.rows.team_seasons).toHaveLength(4);
 expect(result.rows.team_week).toHaveLength(8);
 expect(result.rows.stat_builds[0].status).toBe('ok');
});
test('fetch failure aborts computation without a partial generation',async()=>{
 const client={async fetchLeague(){throw new Error('authentication failed');}};
 await expect(refreshWorkspace(input(),{},client,{season:2024,tier:'daily',leagueId:555,sleep:async()=>{}})).rejects.toThrow('authentication failed');
});

test('manual roster corrections survive rebuilding and restoring durable team IDs',async()=>{
 const client={async fetchLeague(p:FetchLeagueParams){const json=p.scoringPeriodId===undefined?buildSeasonScopePayload():p.views.includes('mRoster')?buildWeekScopePayload(p.scoringPeriodId as 1|2):buildTransactionsPeriodPayload(p.scoringPeriodId,[]);return {json,payload:JSON.stringify(json),status:200,url:'https://example.test/fixture'};}};
 const options={season:2024,tier:'daily' as const,leagueId:555,sleep:async()=>{}};
 const first=await refreshWorkspace(input(),{},client,options);
 const target=first.rows.roster_slots[0];
 const next={...input(),team_seasons:first.rows.team_seasons,corrections:[{id:1,target_table:'roster_slots',target_key_json:{season:2024,week:target.week,team_season_id:target.team_season_id,player_id:target.player_id},field:'points',value_json:77,reason:'Fixture correction',created_by:'test',created_at:new Date().toISOString(),active:true}]};
 const second=await refreshWorkspace(next,{team_seasons:100},client,options);
 expect(second.rows.roster_slots.find(r=>r.week===target.week && r.team_season_id===target.team_season_id && r.player_id===target.player_id)?.points).toBe(77);
});

