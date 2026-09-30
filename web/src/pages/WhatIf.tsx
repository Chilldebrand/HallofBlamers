import {useState} from 'react';
import {bestWorstSchedule,scheduleSwap,validateWhatIfScheduleCoverage,HEAD_TO_HEAD_WEEK_RULE} from '../../../src/engines/whatIf';
import type {WhatIfSeasonRecord} from '../../../src/engines/whatIf';
import {pageSchedules,pageOptimalLineup} from '../api/what-if';
import type {PageData} from '../api/pages';
import {Empty,GridTable,name,number,PageHeader,Section,SeasonLinks} from './LeagueParts';
export default function WhatIf({data}:{data:PageData}){
 const teams=data.teamSeasons.filter(t=>t.season===data.season);const [a,setA]=useState(teams[0]?.franchiseId??0);const [b,setB]=useState(teams[1]?.franchiseId??0);const [mode,setMode]=useState('swap');
 const schedules=pageSchedules(data);
 const coverage=validateWhatIfScheduleCoverage(schedules,true,teams.map(t=>t.franchiseId));
 const own=schedules.find(s=>s.franchiseId===a)?.weeks??[],other=schedules.find(s=>s.franchiseId===b)?.weeks??[];
 const swap=coverage.available?scheduleSwap(data.season,a,own,b,other):null;
 const best=coverage.available?bestWorstSchedule(data.season,a,own,schedules.filter(s=>s.franchiseId!==a)):null;
 const lineup=pageOptimalLineup(data,a);
 function result(title:string,record:WhatIfSeasonRecord){return <Section title={title}><p className="mb-4 text-lg">{record.wins}–{record.losses}–{record.ties} · {number(record.pointsFor)} points</p><GridTable head={['Week','Own score','Opponent','Opponent score','Result']} rows={record.weeks.map(w=>[w.week,number(w.ownScore),w.opponentFranchiseId===null?'Bye':name(data,w.opponentFranchiseId),number(w.opponentScore),w.result??'—'])}/></Section>;}
 return <><PageHeader eyebrow="Alternate histories" title="What If"/><SeasonLinks data={data} path="what-if"/><div className="flex flex-wrap gap-4">{[['Franchise',a,setA],['Other franchise',b,setB]].map(([title,value,set])=><label key={String(title)} className="text-sm">{String(title)}<select className="ml-2 border border-line-sheet bg-sheet p-2" value={value as number} onChange={e=>(set as (n:number)=>void)(Number(e.target.value))}>{teams.map(t=><option key={t.id} value={t.franchiseId}>{name(data,t.franchiseId)}</option>)}</select></label>)}<label>Scenario <select className="border border-line-sheet bg-sheet p-2" value={mode} onChange={e=>setMode(e.target.value)}><option value="swap">Schedule swap</option><option value="best">Best / worst schedule</option><option value="lineup">Perfect lineups</option></select></label></div><p className="mt-4 text-sm text-muted">Hypothetical results use archived scores. {HEAD_TO_HEAD_WEEK_RULE}</p>
 {mode==='lineup'?lineup.available&&lineup.record?result('Perfect lineup record',lineup.record):<Section title="Perfect lineups"><Empty>{lineup.unavailableReason}</Empty></Section>:!coverage.available?<Section title="Schedule coverage"><Empty>{coverage.unavailableReason}</Empty></Section>:mode==='swap'&&swap?<>{result(name(data,a),swap.franchiseA.record)}{result(name(data,b),swap.franchiseB.record)}</>:best?<Section title="Every opponent schedule"><GridTable head={['Schedule','Wins','Losses','Ties']} rows={best.schedules.map(s=>[name(data,s.scheduleSourceFranchiseId),s.record.wins,s.record.losses,s.record.ties])}/></Section>:null}</>;
}

