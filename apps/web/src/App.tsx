import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { registerDesktop } from "./lib/desktop";
import { Login } from "./components/Login";
import { AssignmentList } from "./components/AssignmentList";

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session) void registerDesktop(session);
  }, [session]);

  if (session === undefined) return <div className="splash" aria-busy="true" />;
  if (!session) return <Login />;
  return <AssignmentList userId={session.user.id} />;
}
