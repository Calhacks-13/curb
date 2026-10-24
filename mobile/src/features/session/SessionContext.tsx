// Seeded demo session (spec section 7.1): pick Driver or Driveway Owner, get a
// stable backend user and token, remember the choice on the device. No
// registration, passwords, or profile editing.

import * as SecureStore from "expo-secure-store";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { getApi } from "@/api/client";
import type { DemoProfile, Session } from "@/api/types";

const PROFILE_KEY = "curb.demo-profile";

type SessionState = {
  /** True until the saved profile (if any) has been restored. */
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
  const [restoring, setRestoring] = useState(true);
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

  useEffect(() => {
    // Skip auto-restore: always show the profile picker on app start
    // so each demo session begins with the home screen.
    setRestoring(false);
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
