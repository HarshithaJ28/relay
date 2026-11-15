"use client";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useSession } from "../auth/context";
import { type LiveEvent, runStream } from "./stream";

type Status = "off" | "connecting" | "open" | "waiting";
type Listener = (event: LiveEvent) => void;

const Ctx = createContext<{ status: Status; subscribe: (fn: Listener) => () => void } | null>(null);

/**
 * Runs the live stream while logged in. Screens subscribe to events; after a reconnect
 * every active query is refetched, because missed events are not replayed.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const { session, state } = useSession();
  const queryClient = useQueryClient();
  const listeners = useRef(new Set<Listener>());
  const [status, setStatus] = useState<Status>("off");
  const authenticated = state.status === "authenticated";

  useEffect(() => {
    if (!authenticated) {
      setStatus("off");
      return;
    }
    const controller = new AbortController();
    void runStream(
      {
        getToken: () => session.getToken(),
        refresh: () => session.refresh(),
        onEvent: (e) => {
          for (const fn of listeners.current) fn(e);
        },
        onReconnect: () => void queryClient.invalidateQueries({ refetchType: "active" }),
        onStatus: setStatus,
      },
      controller.signal,
    );
    return () => controller.abort();
  }, [authenticated, session, queryClient]);

  const value = {
    status,
    subscribe: (fn: Listener) => {
      listeners.current.add(fn);
      return () => listeners.current.delete(fn);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLive must be used inside LiveProvider");
  return ctx;
}

/** Call `fn` for every live event while the component is mounted. */
export function useLiveEvents(fn: Listener) {
  const { subscribe } = useLive();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}
