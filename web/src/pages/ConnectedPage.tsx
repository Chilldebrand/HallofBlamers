import {isAccessError} from '../api/access-error';
import {useCallback,useEffect,useState} from 'react';
import {useLocation} from 'react-router-dom';
import {fetchPage,pageRequest,type PageData} from '../api/pages';
import {useViewer} from '../auth/session';
import Home from './Home';
import Matchups from './Matchups';
import {History,Franchises,H2H,Seasons,Records,Belt} from './Archive';
import {Recaps,Transactions,Timeline} from './Activity';
import WhatIf from './WhatIf';
import {Admin,RecapAdmin} from './Admin';
import {Empty} from './LeagueParts';
import Link from '../components/Link';

export function PageContent({data,path,search,reload}:{data:PageData;path:string;search:string;reload:()=>void}){
 const request=pageRequest(path,search);if(!request)return <Empty>Page not found. <Link href="/">Return home</Link></Empty>;
 switch(request.page_route){
  case 'home':return <Home data={data}/>;
  case 'matchups':return <Matchups data={data} detail={request.requested_id!==null}/>;
  case 'history':return <History/>;
  case 'franchises':return <Franchises data={data} id={request.requested_id}/>;
  case 'h2h':return <H2H data={data} a={request.requested_id} b={path.split('/')[3]?Number(path.split('/')[3]):null}/>;
  case 'seasons':return <Seasons data={data} detail={request.requested_season!==null}/>;
  case 'records':return <Records data={data}/>;
  case 'belt':return <Belt data={data}/>;
  case 'timeline':return <Timeline data={data}/>;
  case 'transactions':return <Transactions data={data} search={search}/>;
  case 'what-if':return <WhatIf key={data.season} data={data}/>;
  case 'recaps':return <Recaps data={data} detail={request.requested_week!==null}/>;
  case 'admin':return <Admin data={data} reload={reload}/>;
  case 'admin-recaps':return <RecapAdmin key={request.requested_id??path} data={data} id={request.requested_id} voice={path.endsWith('/voice')} reload={reload}/>;
  default:return <Empty>Page not found.</Empty>;
 }
}
export default function ConnectedPage(){
 const {pathname,search}=useLocation();const {refresh}=useViewer();const [data,setData]=useState<PageData|null>(null),[error,setError]=useState(''),[version,setVersion]=useState(0);
 const reload=useCallback(()=>setVersion(n=>n+1),[]);
 const valid=pageRequest(pathname,search)!==null;
 useEffect(()=>{
  const request=pageRequest(pathname,search);if(!request)return;
  const controller=new AbortController();let active=true;
  const load=async()=>{try{const value=await fetchPage(request,controller.signal);if(active){setData(value);setError('');}}catch(e){if(active){if(isAccessError(e))setData(null);setError(e instanceof Error?e.message:'Unable to load this page.');void refresh();}}};
  void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},60000);
  return()=>{active=false;controller.abort();clearInterval(timer);};
 },[pathname,search,version,refresh]);
 if(!valid)return <Empty>Page not found. <Link href="/">Return home</Link></Empty>;
 if(error&&!data)return <div role="alert"><p>{error}</p><button className="mt-4 text-kelly underline" onClick={reload}>Try again</button></div>;
 if(!data)return <p role="status">Loading this page…</p>;
 return <>{error&&<p role="alert" className="mb-4 border border-line-sheet p-3">Connection interrupted. Your editing work is preserved; retrying automatically.</p>}<PageContent data={data} path={pathname} search={search} reload={reload}/></>;
}
