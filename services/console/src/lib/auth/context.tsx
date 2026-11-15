"use client";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { type Api, createApi } from "../api/client";
import { Session, type SessionState } from "./session";

interface AuthContext {
  session: Session;
  api: Api;
}

const Ctx = createContext<AuthContext | null>(null);

/** One Session per browser tab; refreshed once on load (the cookie decides if we are logged in). */
export function AuthProvider({ children, session: given }: { children: ReactNode; session?: Session }) {
  const [session] = useState(() => given ?? new Session());
  const value = useMemo(() => ({ session, api: createApi(session) }), [session]);
  useEffect(() => {
    if (session.state.status === "loading") void session.refresh();
  }, [session]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function useAuthContext(): AuthContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export function useSession(): { session: Session; state: SessionState } {
  const { session } = useAuthContext();
  const state = useSyncExternalStore(
    (fn) => session.subscribe(fn),
    () => session.state,
    () => session.state,
  );
  return { session, state };
}

export function useApi(): Api {
  return useAuthContext().api;
}
