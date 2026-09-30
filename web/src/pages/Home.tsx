import type {PageData} from '../api/pages';
import Link from '../components/Link';
import {GameCards} from './Matchups';
import {Empty,Franchise,GridTable,number,PageHeader,Section} from './LeagueParts';
export default function Home({data}:{data:PageData}){
 const current=data.seasons.find(s=>s.season===data.season);const belt=data.beltReigns.find(r=>r.isCurrent);
 const ladder=[...data.careerStats].sort((a,b)=>b.currentElo-a.currentElo).filter(c=>data.teamSeasons.some(t=>t.season===data.season&&t.franchiseId===c.franchiseId)).slice(0,8);
 return <div><PageHeader eyebrow="Hall of Blamers" title={current?.status==='active'?`Week ${data.week}`:'The League'} right={<span>{data.season} · {current?.status??'No season'}</span>}/>
 <Section title="This week"><GameCards data={data}/></Section><div className="grid gap-8 lg:grid-cols-2"><div><Section title="The Belt">{belt?<div className="border-l-4 border-gold-fill bg-sheet-raised p-5"><p className="display mb-3 text-xs tracking-widest text-gold-ink">CURRENT HOLDER · REIGN {belt.reignNo}</p><Franchise data={data} id={belt.franchiseId}/><p className="mt-3 text-sm">{belt.defenses} defenses · {belt.weeksHeld} weeks held</p><Link href="/belt" className="mt-4 block text-kelly">Full lineage →</Link></div>:<Empty>The belt is currently vacant.</Empty>}</Section><Section title="Latest recap">{data.recaps[0]?<Link href={`/recaps/${data.recaps[0].season}/${data.recaps[0].week}`} className="text-kelly">{data.recaps[0].season} · Week {data.recaps[0].week} →</Link>:<Empty>No recap has been published yet.</Empty>}</Section></div><Section title="Power ladder"><GridTable head={['Rank','Franchise','Elo']} rows={ladder.map((c,i)=>[i+1,<Franchise key={c.franchiseId} data={data} id={c.franchiseId}/>,number(c.currentElo,0)])}/></Section></div>
 <Section title="Explore the league"><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[['/history','History'],['/transactions','Transactions'],['/what-if','What If'],['/standings','Standings']].map(([href,title])=><Link key={href} href={href} className="display border border-line-sheet p-4 text-kelly">{title} →</Link>)}</div></Section></div>;
}
