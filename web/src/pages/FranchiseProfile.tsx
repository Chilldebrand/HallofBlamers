import {useState,type ReactNode} from 'react';
import {EloChart} from '../../../src/components/history/EloChart';
import {BeltMark} from '../../../src/components/league/FranchiseName';
import {buildEloSeries,markSeasonEndDots} from '../../../src/shared/elo-series';
import {resolveFranchiseFlags} from '../../../src/shared/identity';
import {formatWLT,formatWinPctBaseball,formatEfficiency,formatSigned,formatSpan,endReasonLabel,weekTypeLabel} from '../../../src/components/history/format';
import {RECORD_KEY_META} from '../../../src/shared/records';
import type {RecordKey} from '../../../src/engines';
import type {PageData} from '../api/pages';
import Link from '../components/Link';
import {Empty,Franchise,number} from './LeagueParts';
import {groupProfileAchievements,profileOpponents} from './franchise-model';

function Heading({children,right,icon}:{children:ReactNode;right?:ReactNode;icon?:ReactNode}){
 return <div className="flex flex-wrap items-baseline justify-between gap-2 border-b-2 border-ink pb-2.5"><h2 className="display flex items-center gap-2 text-2xl tracking-wide text-ink">{icon}{children}</h2>{right&&<p className="text-xs text-muted sm:text-sm">{right}</p>}</div>;
}
const cell='px-2 py-3 text-right tabular-nums';
export function FranchiseProfile({data,id}:{data:PageData;id:number}){
 const [sort,setSort]=useState<'games'|'name'>('games');
 const f=data.franchises.find(f=>f.id===id),c=data.careerStats.find(c=>c.franchiseId===id);
 if(!f)return <Empty>Franchise not found.</Empty>;
 const seasons=data.seasonStats.filter(s=>s.franchiseId===id).sort((a,b)=>b.season-a.season);
 const elo=data.eloHistory.filter(e=>e.franchiseId===id);
 const series=buildEloSeries(elo);
 series.points=markSeasonEndDots(series.points,new Set(seasons.filter(s=>s.champion).map(s=>s.season)),new Set(seasons.filter(s=>s.sacko).map(s=>s.season)));
 const peak=series.points.reduce<(typeof series.points)[number]|null>((best,p)=>!best||p.elo>best.elo?p:best,null);
 const groups=groupProfileAchievements(data.achievements.filter(a=>a.franchiseId===id));
 const reigns=data.beltReigns.filter(r=>r.franchiseId===id).sort((a,b)=>a.reignNo-b.reignNo);
 const opponents=profileOpponents(data,id).sort((a,b)=>sort==='games'?b.games-a.games||a.name.localeCompare(b.name):a.name.localeCompare(b.name));
 const flags=resolveFranchiseFlags(data.shell.flags,id);
 const records=data.records.filter(r=>r.franchiseId===id).sort((a,b)=>a.rank-b.rank||a.recordKey.localeCompare(b.recordKey));
 const stats:[string,ReactNode,string?][]=[['Career',c?formatWLT(c.wins,c.losses,c.ties):'—'],['Win %',c?formatWinPctBaseball(c.winPct):'—'],['Points For',number(c?.pointsFor,0)],['Points Against',number(c?.pointsAgainst,0)],['Sackos',c?.sackos??'—',c?.sackos?'text-tarnish-ink':''],['Current Elo',number(c?.currentElo,0),'text-kelly-deep'],['Peak Elo',peak?number(peak.elo,0):'—'],['Belt Reigns',reigns.length,reigns.length?'text-gold-ink':'']];
 return <article className="min-w-0" aria-label={`${f.canonicalName} franchise history`}>
  <Link href="/franchises" className="display text-xs tracking-widest text-kelly hover:underline">← Franchises</Link>
  <header className="border-b-2 border-ink pb-6 pt-5">
   <p className={`display text-xs tracking-widest ${flags.isChampion?'text-gold-ink':flags.isSacko?'text-tarnish-ink':'text-kelly'}`}>Franchise{flags.isChampion?' · Reigning Champion':flags.isSacko?' · Reigning Sacko':''}</p>
   <h1 className={`display mt-2 break-words text-4xl leading-none tracking-normal sm:text-6xl ${flags.isChampion?'text-gold-ink':flags.isSacko?'text-tarnish-ink':'text-ink'}`}>{f.canonicalName}</h1>
   <p className="mt-3 text-sm text-muted">Managed by {f.managerName} · joined {f.joinedSeason} · {c?.seasons??seasons.length} seasons</p>
   <div className="mt-5 flex flex-wrap items-center gap-2">
    {!!c?.championships&&<span className="display bg-gold-fill px-2.5 py-1.5 text-xs tracking-wide text-sheet">{c.championships}× Champion</span>}
    {!!c?.sackos&&<span className="display bg-tarnish-fill px-2.5 py-1.5 text-xs tracking-wide text-sheet">{c.sackos}× Sacko</span>}
    <span className="display rounded-full border border-line-sheet-strong px-2.5 py-1 text-xs tracking-wide text-muted">{f.active?'Active':`Departed ${f.departedSeason??''}`}</span>
   </div>
  </header>
  <dl className="mt-6 grid grid-cols-2 gap-px border border-line-sheet bg-line-sheet sm:grid-cols-4 lg:grid-cols-8">{stats.map(([label,value,tone])=><div key={label} className="min-w-0 bg-sheet px-3 py-4"><dt className="display text-[10px] tracking-wider text-muted">{label}</dt><dd className={`display mt-1 text-[26px] font-bold leading-none tabular-nums ${tone||'text-ink'}`}>{value}</dd></div>)}</dl>
  <section className="mt-11"><Heading right={`${groups.reduce((n,g)=>n+g.awards.length,0)} types earned`}>Achievements</Heading>
   {groups.length?groups.map(g=><div key={g.category} className="mt-5"><h3 className="display mb-2 text-xs tracking-widest text-muted">{g.category}</h3><div className="grid grid-cols-2 gap-px border border-line-sheet bg-line-sheet sm:grid-cols-3 lg:grid-cols-5">{g.awards.map(a=><div key={a.key} className="min-w-0 bg-sheet px-3 py-3.5"><h4 className="display text-[11px] tracking-wide text-ink">{a.label}</h4><p className="display mt-2 text-2xl font-bold leading-none text-kelly-deep">×{a.count}</p><p className="mt-1.5 text-xs text-muted">Most recent: {a.season} Wk {a.week}</p></div>)}</div></div>):<p className="mt-4 text-sm text-muted">No achievements earned yet.</p>}
  </section>
  <section className="mt-11"><Heading right={peak?`${series.points[0].season}–${series.points.at(-1)!.season} · peak ${number(peak.elo,0)} in ${peak.season} Wk ${peak.week}`:undefined}>Elo History</Heading><div className="mt-5"><EloChart series={series}/></div></section>
  <section className="mt-11"><Heading>Season by Season</Heading><div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm" aria-label="Season by season"><thead><tr>{['Season','Team','W-L-T','PF','PA','All-Play','Luck','Efficiency','Finish','Playoffs'].map((h,i)=><th key={h} className={`display px-2 py-3 text-[11px] font-normal tracking-wide text-muted ${i>1?'text-right':''}`}>{h}</th>)}</tr></thead><tbody>{seasons.map(s=><tr key={s.season} className={`border-b border-line-sheet ${s.champion?'bg-sheet-raised':''}`}><th className="px-2 py-3 text-left font-semibold"><Link href={`/seasons/${s.season}`} className="hover:underline">{s.season}</Link></th><td className="max-w-[140px] truncate px-2 py-3 text-muted" title={data.teamSeasons.find(t=>t.franchiseId===id&&t.season===s.season)?.teamName}>{data.teamSeasons.find(t=>t.franchiseId===id&&t.season===s.season)?.teamName??f.canonicalName}</td><td className={cell}>{formatWLT(s.wins,s.losses,s.ties)}</td><td className={cell}>{number(s.pointsFor)}</td><td className={`${cell} text-muted`}>{number(s.pointsAgainst)}</td><td className={`${cell} text-muted`}>{formatWLT(s.allplayW,s.allplayL,s.allplayT)}</td><td className={`${cell} text-muted`}>{s.luckTotal===null?'—':formatSigned(s.luckTotal,2)}</td><td className={`${cell} text-muted`}>{formatEfficiency(s.efficiencyAvg)}</td><td className={`${cell} whitespace-nowrap`}>{s.finalStanding&&s.finalStanding>0?s.finalStanding:'—'}{(s.champion||s.sacko)&&<span className={`display ml-1 px-1.5 py-0.5 text-[9px] text-sheet ${s.champion?'bg-gold-fill':'bg-tarnish-fill'}`}>{s.champion?'Champ':'Sacko'}</span>}</td><td className={`${cell} text-muted`}>{s.madePlayoffs?'Yes':'—'}</td></tr>)}</tbody></table></div>{!seasons.length&&<p className="mt-4 text-sm text-muted">No seasons recorded yet.</p>}</section>
  <div className="mt-11 grid min-w-0 grid-cols-1 gap-11 lg:grid-cols-[1.2fr_1fr]">
   <div className="min-w-0 space-y-10">
    <section><Heading icon={<BeltMark size="heading" surfaceBehind="var(--color-sheet)"/>} right={`${reigns.length} reigns · ${reigns.reduce((n,r)=>n+r.defenses,0)} defenses · ${reigns.reduce((n,r)=>n+r.weeksHeld,0)} weeks held`}>Belt History</Heading>
     {reigns.length?<div className="overflow-x-auto"><table className="w-full min-w-[430px] text-left text-sm" aria-label="Belt history"><thead><tr>{['Reign','Span','Won From','Defenses','Ended'].map(h=><th key={h} className="display px-1 py-3 text-[10px] font-normal tracking-wide text-muted">{h}</th>)}</tr></thead><tbody>{reigns.map(r=><tr key={r.id} className="border-b border-line-sheet"><th className="display px-1 py-3 text-left">#{r.reignNo}</th><td className="px-1 py-3">{formatSpan(r.startSeason,r.startWeek,r.endSeason,r.endWeek)}</td><td className="max-w-[130px] px-1 py-3 text-muted">{r.wonFromFranchiseId!==null?<Franchise data={data} id={r.wonFromFranchiseId}/>: 'Vacancy'}</td><td className="px-1 py-3 text-right tabular-nums">{r.defenses}</td><td className="px-1 py-3 text-muted">{r.isCurrent?'Current holder':endReasonLabel(r.endReason)}</td></tr>)}</tbody></table></div>:<p className="py-6 text-sm text-muted">This franchise has never held the belt.</p>}
    </section>
    <section><Heading>Record Book Entries</Heading>{records.length?<ul>{records.map(r=>{const meta=RECORD_KEY_META[r.recordKey as RecordKey];return <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line-sheet py-3 text-sm"><span>#{r.rank} {meta?.label??r.recordKey.replace(/_/g,' ')}</span><Link className="text-muted hover:text-kelly hover:underline" href={r.week?`/matchups/${r.season}/${r.week}`:`/seasons/${r.season}`}>{meta?.format(r.value)??number(r.value)} — {r.season}{r.week?` Wk ${r.week}`:''}{r.weekType?` · ${weekTypeLabel(r.weekType)}`:''}</Link></li>;})}</ul>:<p className="mt-4 text-sm text-muted">No record book entries yet.</p>}</section>
   </div>
   <section className="min-w-0"><Heading>Head-to-Head</Heading><div className="my-2 flex justify-end"><button type="button" className="display text-xs tracking-wide text-muted underline decoration-dotted underline-offset-4 hover:text-ink" onClick={()=>setSort(s=>s==='games'?'name':'games')}>Sort: {sort==='games'?'Most Games':'A–Z'}</button></div>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm" aria-label="Head-to-head opponents"><thead><tr className="border-b border-line-sheet"><th className="display py-2 text-[11px] font-normal tracking-wide text-muted">Opponent</th><th className="display px-2 py-2 text-right text-[11px] font-normal tracking-wide text-muted">Record</th><th className="display py-2 text-right text-[11px] font-normal tracking-wide text-muted">Balance</th></tr></thead><tbody>{opponents.map(o=><tr key={o.id} className="border-b border-line-sheet"><th className="max-w-[150px] py-3 text-left font-normal"><Franchise data={data} id={o.id}/></th><td className="whitespace-nowrap px-2 py-3 text-right font-semibold tabular-nums"><Link className="hover:underline" href={`/h2h/${id}/${o.id}`}>{formatWLT(o.wins,o.losses,o.ties)}</Link></td><td className="py-3"><div className="flex justify-end gap-0.5" role="img" aria-label={o.results.length?`Recent results, oldest first: ${o.results.map(r=>r==='W'?'win':r==='L'?'loss':'tie').join(', ')}`:'No completed game results'}>{o.results.map((r,i)=><span key={i} aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 ${r==='W'?'bg-kelly':r==='L'?'bg-loss':'bg-line-sheet-strong'}`}/>)}</div></td></tr>)}</tbody></table></div>
    <p className="mt-3 text-xs text-muted">Green = win, red = loss, gray = tie. Most recent on the right.</p>{!opponents.length&&<p className="mt-4 text-sm text-muted">No head-to-head history yet.</p>}
   </section>
  </div>
 </article>;
}
