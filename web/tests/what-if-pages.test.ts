import {expect,test} from 'vitest';
import {decodePage} from '../src/api/pages';
import {pageSchedules,pageOptimalLineup} from '../src/api/what-if';

test('schedule inputs retain genuine byes',()=>{
 const data=decodePage({shell:{},week:1,season:2025,teamSeasons:[{season:2025,franchise_id:1}],teamWeek:[{franchise_id:1,week:1,week_type:'regular',result:null,score:100,opponent_franchise_id:null}]});
 expect(pageSchedules(data)[0].weeks).toHaveLength(1);
 expect(pageSchedules(data)[0].weeks[0].opponentFranchiseId).toBeNull();
});
test('perfect lineups reject partial opponent coverage',()=>{
 const data=decodePage({shell:{},week:1,season:2025,teamWeek:[
  {franchise_id:1,week:1,result:'W',score:100,optimal_score:110,opponent_franchise_id:2},
  {franchise_id:2,week:1,result:'L',score:90,optimal_score:100,opponent_franchise_id:1},
  {franchise_id:1,week:2,result:'W',score:100,optimal_score:110,opponent_franchise_id:2},
 ]});
 expect(pageOptimalLineup(data,1).available).toBe(false);
 expect(pageOptimalLineup(data,1).record).toBeNull();
});

