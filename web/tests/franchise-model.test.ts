import {expect,test} from 'vitest';
import {decodePage} from '../src/api/pages';
import {groupProfileAchievements,profileOpponents} from '../src/pages/franchise-model';
const base={shell:{flags:{}},season:2026,week:5};
test('achievement cards count each type and choose the most recent occurrence regardless of input order',()=>{
 const data=decodePage({...base,achievements:[{achievement_key:'weekly_high',season:2024,week:12},{achievement_key:'weekly_high',season:2025,week:2},{achievement_key:'bench_disaster',season:2026,week:1}]});
 expect(groupProfileAchievements(data.achievements).find(g=>g.category==='Scoring')?.awards[0]).toMatchObject({key:'weekly_high',count:2,season:2025,week:2});
 expect(groupProfileAchievements([])).toEqual([]);
});
test('head-to-head reverses aggregate records for franchise B and uses chronological settled game results',()=>{
 const data=decodePage({...base,franchises:[{id:1,canonical_name:'Opponent'},{id:2,canonical_name:'Profile'}],teamSeasons:[{id:10,franchise_id:1},{id:20,franchise_id:2}],h2hPairs:[{franchise_a:1,franchise_b:2,reg_w:3,reg_l:1,reg_t:1,playoff_w:0,playoff_l:1,playoff_t:0}],matchups:[{id:2,season:2025,week:2,home_team_season_id:20,away_team_season_id:10,is_final:true,winner:'home'},{id:1,season:2025,week:1,home_team_season_id:10,away_team_season_id:20,is_final:true,winner:'home'},{id:3,season:2025,week:3,home_team_season_id:20,away_team_season_id:10,is_final:false,winner:null},{id:4,season:2025,week:15,home_team_season_id:20,away_team_season_id:10,is_final:true,winner:'away',playoff_tier:'WINNERS_CONSOLATION_LADDER'},{id:5,season:2025,week:16,home_team_season_id:20,away_team_season_id:10,is_final:true,winner:'away',playoff_tier:'LOSERS_CONSOLATION_LADDER'}]});
 expect(profileOpponents(data,2)).toEqual([{id:1,name:'Opponent',wins:2,losses:3,ties:1,games:6,results:['L','W']}]);
});
