import type {ReactNode} from 'react';
import {FranchiseName} from '../../../src/components/league/FranchiseName';
import {resolveFranchiseFlags} from '../../../src/shared/identity';
import type {PageData} from '../api/pages';
import Link from '../components/Link';
export {PageHeader} from '../../../src/components/broadcast/PageHeader';
export const number=(n:number|null|undefined,digits=1)=>n==null?'—':n.toLocaleString(undefined,{minimumFractionDigits:digits,maximumFractionDigits:digits});
export const label=(s:string)=>s.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
export const name=(data:PageData,id:number|null)=>data.franchises.find(f=>f.id===id)?.canonicalName??'Unknown franchise';
export function Franchise({data,id}:{data:PageData;id:number|null}) {
 if(id===null)return <>Bye</>;
 return <Link href={`/franchises/${id}`} className="hover:underline"><FranchiseName franchise={{id,name:name(data,id),...resolveFranchiseFlags(data.shell.flags,id)}} /></Link>;
}
export function Section({title,children}:{title:string;children:ReactNode}){return <section className="mt-8"><h2 className="display mb-4 border-b-2 border-ink pb-2 text-xl tracking-wide text-ink">{title}</h2>{children}</section>;}
export function Empty({children='No archived data is available for this section yet.'}:{children?:ReactNode}){return <p className="border border-line-sheet bg-sheet-raised p-5 text-sm text-muted">{children}</p>;}
export function GridTable({head,rows}:{head:string[];rows:ReactNode[][]}){return rows.length?<div className="overflow-x-auto"><table className="w-full border-collapse text-left text-sm"><thead><tr className="border-b-2 border-ink">{head.map(h=><th key={h} className="display whitespace-nowrap px-3 py-3 text-xs tracking-wider text-muted">{h}</th>)}</tr></thead><tbody>{rows.map((row,i)=><tr key={i} className="border-b border-line-sheet">{row.map((cell,j)=><td key={j} className="px-3 py-3 tabular-nums">{cell}</td>)}</tr>)}</tbody></table></div>:<Empty/>;}
export function SeasonLinks({data,path}:{data:PageData;path:string}){return <nav aria-label="Seasons" className="my-5 flex flex-wrap gap-3">{data.seasons.map(s=><Link key={s.season} href={path==='matchups'?`/matchups/${s.season}`:path==='seasons'?`/seasons/${s.season}`:`/${path}?season=${s.season}`} className={`display border px-3 py-2 ${data.season===s.season?'border-kelly bg-kelly-deep text-white':'border-line-sheet text-kelly'}`}>{s.season}</Link>)}</nav>;}
export function Pagination({path,search,count}:{path:string;search:string;count:number}){const q=new URLSearchParams(search);const offset=Number(q.get('offset')??0);const href=(n:number)=>{const next=new URLSearchParams(q);next.set('offset',String(n));return path+'?'+next;};return <nav aria-label="Pagination" className="mt-5 flex justify-between text-kelly">{offset>0?<Link href={href(Math.max(0,offset-100))}>← Previous</Link>:<span/>}{count===100&&<Link href={href(offset+100)}>Next →</Link>}</nav>;}

