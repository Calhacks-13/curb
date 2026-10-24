// Seeded demo session (spec section 7.1): pick Driver or Driveway Owner and get
// a stable backend user and token. No registration, passwords, or profile editing.

import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { getApi } from "@/api/client";
import type { DemoProfile, Session } from "@/api/types";

const PROFILE_KEY = "curb.demo-profile";

type SessionState = {
  /** Always false: profiles aren't restored on launch. */
  restoring: boolean;
  session: Session | null;
  starting: boolean;
  error: string | null;
  start: (profile: DemoProfile) => Promise<boolean>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  // Each launch starts at the picker so every demo begins from the home screen;
  // the saved profile is kept but not restored.
  const [restoring] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async (profile: DemoProfile) => {
    setStarting(true);
    setError(null);
    try {
      const api = getApi();
      const s = await api.startSession(profile);
      api.setToken(s.token);
      setSession(s);
      await SecureStore.setItemAsync(PROFILE_KEY, profile).catch(() => {});
      return true;
    } catch {
      setError("Couldn't start the demo session. Check your connection and try again.");
      return false;
    } finally {
      setStarting(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    getApi().setToken(null);
    setSession(null);
    await SecureStore.deleteItemAsync(PROFILE_KEY).catch(() => {});
  }, []);

  const value = useMemo(
    () => ({ restoring, session, starting, error, start, signOut }),
    [restoring, session, starting, error, start, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
