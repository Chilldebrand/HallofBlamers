import {useState} from 'react';
import {useLocation,useNavigate} from 'react-router-dom';
import {useViewer} from '../auth/session';
import {supabase} from '../lib/supabase';
import {Login} from './Login';
export function Join(){const {signedIn,refresh}=useViewer();const {search}=useLocation();const navigate=useNavigate();const token=new URLSearchParams(search).get('token');const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 if(!token||!/^[a-f0-9]{64}$/.test(token))return <p className="p-8">This invitation is invalid. Contact the commissioner for a new link.</p>;
 if(!signedIn)return <Login allowSignUp/>;
 return <div className="mx-auto max-w-lg p-8"><h1 className="display text-4xl text-kelly">Join Hall of Blamers</h1><p className="my-5">Accept this invitation to link your account to your league manager.</p>{message&&<p role="alert" className="my-4">{message}</p>}<button disabled={busy} className="bg-kelly-deep p-3 text-white" onClick={async()=>{if(!supabase)return;setBusy(true);try{const {error}=await supabase.rpc('hob_redeem_invite',{token});if(error){setMessage('This invitation is expired, already used, or your account already has access. Contact the commissioner.');return;}await refresh();navigate('/');}catch{setMessage('Unable to connect. Please try again.');}finally{setBusy(false);}}}>{busy?'Joining…':'Accept invitation'}</button></div>;
}
