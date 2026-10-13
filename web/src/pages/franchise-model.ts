import type {PageData} from '../api/pages';

const categories:Record<string,string>={weekly_high:'Scoring',lucky_winner:'Scoring',narrow_escape:'Margin',heartbreaker:'Margin',perfect_lineup:'Lineup Management',bench_disaster:'Lineup Management',belt_thief:'Belt',belt_defender:'Belt',giant_killer:'Upsets',record_breaker:'Record Book'};
const order=['Scoring','Margin','Lineup Management','Belt','Upsets','Record Book','Other'];
export function groupProfileAchievements(rows:PageData['achievements']) {
 const awards=new Map<string,{key:string;label:string;count:number;season:number;week:number}>();
 for(const row of rows){
  const previous=awards.get(row.achievementKey);
  const recent=!previous||row.season>previous.season||(row.season===previous.season&&row.week>previous.week);
  awards.set(row.achievementKey,{key:row.achievementKey,label:row.achievementKey.replace(/_/g,' '),count:(previous?.count??0)+1,season:recent?row.season:previous!.season,week:recent?row.week:previous!.week});
 }
 return order.map(category=>({category,awards:[...awards.values()].filter(a=>(categories[a.key]??'Other')===category).sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label))})).filter(g=>g.awards.length);
}
export function profileOpponents(data:PageData,id:number){
 const franchiseByTeam=new Map(data.teamSeasons.map(t=>[t.id,t.franchiseId]));
 const games=[...data.matchups].filter(m=>m.isFinal&&!['WINNERS_CONSOLATION_LADDER','LOSERS_CONSOLATION_LADDER'].includes(m.playoffTier??'')&&m.awayTeamSeasonId!==null&&m.winner!==null).sort((a,b)=>a.season-b.season||a.week-b.week||a.id-b.id);
 return data.h2hPairs.filter(p=>p.franchiseA===id||p.franchiseB===id).map(p=>{
  const isA=p.franchiseA===id,opponent=isA?p.franchiseB:p.franchiseA;
  const aWins=p.regW+p.playoffW,aLosses=p.regL+p.playoffL,ties=p.regT+p.playoffT;
  const results=games.flatMap(m=>{
   const home=franchiseByTeam.get(m.homeTeamSeasonId),away=franchiseByTeam.get(m.awayTeamSeasonId!);
   if(!((home===id&&away===opponent)||(away===id&&home===opponent)))return [];
   return [m.winner==='tie'?'T':(m.winner==='home')===(home===id)?'W':'L'];
  }).slice(-11);
  return {id:opponent,name:data.franchises.find(f=>f.id===opponent)?.canonicalName??'Unknown franchise',wins:isA?aWins:aLosses,losses:isA?aLosses:aWins,ties,games:aWins+aLosses+ties,results};
 });
}
