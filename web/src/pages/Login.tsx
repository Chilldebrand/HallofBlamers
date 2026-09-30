import { useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { useViewer } from "../auth/session";

export function Login({allowSignUp=false}:{allowSignUp?:boolean}) {
  const { signedIn, refresh, error: sessionError } = useViewer();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [signUp,setSignUp]=useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    const values = new FormData(event.currentTarget);
    setBusy(true); setMessage(null);
    try {
      const credentials={ email: String(values.get("email")), password: String(values.get("password")) };
      const { error } = signUp?await supabase.auth.signUp({...credentials,options:{emailRedirectTo:window.location.href}}):await supabase.auth.signInWithPassword(credentials);
      if (error) { setMessage("Unable to sign in. Check your email and password."); return; }
      await refresh();
      if(signUp)setMessage('Check your email to confirm your account, then return to this invitation and sign in.');
    } catch { setMessage("Unable to connect. Please try again."); }
    finally { setBusy(false); }
  }
  return <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6">
    <div className="border-b-2 border-ink pb-[18px]">
      <p className="display text-[12px] tracking-[0.26em] text-kelly">Hall of Blamers</p>
      <h1 className="display mt-1.5 text-page-title tracking-normal text-kelly-deep">{signUp?'Create Account':'Sign In'}</h1>
    </div>
    {(message || sessionError) && <p role="alert" className="border border-line-sheet bg-sheet-raised p-4 text-sm">{message || sessionError}</p>}
    {!supabase ? <p className="text-sm text-muted">The league site isn’t available yet. Please check back shortly.</p> : signedIn ? <>
      <p className="text-sm text-muted">Your account does not have active league access. Open your invitation or contact the commissioner.</p>
      <button className="text-left text-kelly underline" onClick={() => void supabase?.auth.signOut()}>Sign out</button>
    </> : <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="text-sm">Email<input name="email" type="email" autoComplete="username" required className="mt-2 block w-full border border-line-sheet bg-sheet-raised p-3" /></label>
      <label className="text-sm">Password<input name="password" type="password" autoComplete="current-password" required className="mt-2 block w-full border border-line-sheet bg-sheet-raised p-3" /></label>
      <button disabled={busy} className="display bg-kelly-deep px-4 py-3 text-ink-on-chrome disabled:opacity-50">{busy ? "Please wait…" : signUp?'Create account':'Sign in'}</button>
      {allowSignUp&&<button type="button" onClick={()=>setSignUp(v=>!v)} className="text-kelly underline">{signUp?'Already have an account? Sign in':'New member? Create an account'}</button>}
      <p className="text-sm text-muted">League access is by invitation from the commissioner.</p>
    </form>}
  </div>;
}
