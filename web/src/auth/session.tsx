import {isAccessError} from '../api/access-error';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Viewer } from "../../../src/contracts/cloud";
import { supabase } from "../lib/supabase";

type SessionState = { loading: boolean; signedIn: boolean; viewer: Viewer | null; error: string | null; refresh: () => Promise<void> };
const Context = createContext<SessionState>({ loading: true, signedIn: false, viewer: null, error: null, refresh: async () => {} });

export async function getViewer(): Promise<Viewer | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("hob_viewer");
  if (error) throw Object.assign(new Error("Unable to verify league membership. Please try again."),{code:error.code});
  return data as Viewer | null;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const version = useRef(0);
  const [state, setState] = useState<Omit<SessionState, "refresh">>({ loading: !!supabase, signedIn: false, viewer: null, error: null });
  const invalidate = useCallback(() => { version.current++; }, []);
  const refresh = useCallback(async () => {
    const current = ++version.current;
    try {
      if (!supabase) return;
      const { data: { session }, error } = await supabase.auth.getSession();
      if (error) throw error;
      setState(previous=>previous.viewer&&previous.viewer.authUserId!==session?.user.id?{loading:false,signedIn:!!session,viewer:null,error:null}:previous);
      const viewer = session ? await getViewer() : null;
      if (version.current === current) setState({ loading: false, signedIn: !!session, viewer, error: null });
    } catch (e) {
      if (version.current === current) setState(previous=>({ ...previous, loading:false, ...(isAccessError(e)?{signedIn:false,viewer:null}:{}), error:"Unable to verify league access. Please try again." }));
    }
  }, []);
  useEffect(() => {
    // INITIAL_SESSION loads the initial state. Start API work outside the Auth
    // callback to avoid holding its internal lock.
    const subscription = supabase?.auth.onAuthStateChange((event) => { if(event==="SIGNED_OUT"){invalidate();setState({loading:false,signedIn:false,viewer:null,error:null});} queueMicrotask(() => void refresh()); });
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(onVisible, 60_000);
    return () => { invalidate(); subscription?.data.subscription.unsubscribe(); document.removeEventListener("visibilitychange", onVisible); clearInterval(timer); };
  }, [refresh, invalidate]);
  return <Context.Provider value={{ ...state, refresh }}>{children}</Context.Provider>;
}
export const useViewer = () => useContext(Context);
