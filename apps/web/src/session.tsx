import { createContext, useContext, type ReactNode } from 'react';
import type { Company, Person } from './adapters/session.js';
import type { Viewer, View } from './pages.js';
import type { Preferences } from './preferences.js';
import { Fault, FAULT } from './faults.js';

/**
 * WHAT EVERY SCREEN OF A SIGNED-IN PERSON MAY READ: who they are, the
 * companies they sign for, which view they are in, and what they chose for
 * how the application looks. Each change goes through the one function here
 * that makes it.
 */
export interface Session {
  person: Person;
  companies: readonly Company[];
  /** The company shown, by id; null when they sign for none. */
  company: string | null;
  chooseCompany: (id: string) => void;
  viewer: Viewer;
  chooseView: (view: View) => void;
  preferences: Preferences;
  choose: (change: Partial<Preferences>) => void;
  signOut: () => void;
  /**
   * Ask the service again which companies the person signs for, after one was
   * created, and show `choose` when given. The one list of companies every
   * screen reads is the one this refreshes.
   */
  companiesChanged: (choose?: string) => Promise<void>;
  /** Whether this is a Mac, where the command key is held for shortcuts. */
  mac: boolean;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ session, children }: { session: Session; children?: ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** The signed-in person's session. Only screens shown to a signed-in person ask for it. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  /* Only the frame of a signed-in person shows these screens, and it always provides the session. */
  if (session === null) throw new Fault(FAULT.noSession);
  return session;
}

/** The session, or null for a visitor, for a screen shown to both. */
export const useSessionIfAny = (): Session | null => useContext(SessionContext);
