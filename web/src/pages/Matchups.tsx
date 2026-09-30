import type {PageData} from '../api/pages';
import {matchupScore} from '../api/pages';
import Link from '../components/Link';
import {Empty,Franchise,GridTable,number,PageHeader,Section,SeasonLinks} from './LeagueParts';

export function GameCards({data}:{data:PageData}){return data.matchups.length?<div className="grid gap-4 md:grid-cols-2">{data.matchups.map(m=>{
 const home=data.teamSeasons.find(t=>t.id===m.homeTeamSeasonId),away=data.teamSeasons.find(t=>t.id===m.awayTeamSeasonId);
 return <article key={m.id} className="border border-line-sheet bg-sheet-raised p-5"><Link href={`/matchups/${m.season}/${m.week}/${m.id}`} className="display text-xs tracking-wider text-kelly">{m.isFinal?'Final':`Week ${m.week}`} · View matchup →</Link><div className="mt-4 flex justify-between gap-4"><Franchise data={data} id={home?.franchiseId??null}/><span className="tabular-nums">{matchupScore(m.isFinal,m.homeScore,m.homeProjected)}</span></div><div className="mt-3 flex justify-between gap-4"><Franchise data={data} id={away?.franchiseId??null}/><span className="tabular-nums">{away?matchupScore(m.isFinal,m.awayScore,m.awayProjected):'—'}</span></div>{m.playoffTier&&m.playoffTier!=='NONE'&&<p className="mt-3 text-xs text-muted">{m.playoffTier.replace(/_/g,' ')}</p>}</article>;
 })}</div>:<Empty>No matchups were found for this week.</Empty>;}

export default function Matchups({data,detail}:{data:PageData;detail:boolean}){
 const game=data.matchups[0];
 return <div><PageHeader eyebrow="League" title={detail?'Matchup Detail':'Matchups'} right={<p>{data.season} · Week {data.week}</p>}/><SeasonLinks data={data} path="matchups"/><nav aria-label="Weeks" className="mb-6 flex flex-wrap gap-2">{data.weeks.map(w=><Link key={w.week} href={`/matchups/${data.season}/${w.week}`} className={`border px-3 py-1 text-sm ${w.week===data.week?'border-kelly text-kelly':'border-line-sheet'}`}>W{w.week}</Link>)}</nav><GameCards data={data}/>{detail&&game&&<>
  <div className="grid gap-6 md:grid-cols-2">{[game.homeTeamSeasonId,game.awayTeamSeasonId].filter((id):id is number=>id!==null).map(id=>{
   const team=data.teamSeasons.find(t=>t.id===id);const slots=data.rosterSlots.filter(r=>r.teamSeasonId===id).sort((a,b)=>Number(b.isStarter)-Number(a.isStarter));
   return <Section key={id} title={team?.teamName??'Roster'}><GridTable head={['Slot','Player','Points','Projected']} rows={slots.map(r=>[r.lineupSlot,data.players.find(p=>p.espnPlayerId===r.playerId)?.fullName??`Player ${r.playerId}`,number(r.points),number(r.projectedPoints)])}/></Section>;
  })}</div>
  <Section title="Matchup context">{data.contextNotes.filter(n=>n.matchupId===game.id).length?data.contextNotes.filter(n=>n.matchupId===game.id).map(n=><p key={n.id} className="mb-3 text-sm">{n.renderedText}</p>):<Empty>No historical context notes for this matchup yet.</Empty>}</Section>
 </>}</div>;
}
