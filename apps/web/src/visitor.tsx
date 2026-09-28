import { createContext, useContext, type ReactNode } from 'react';
import { Fault, FAULT } from './faults.js';

/**
 * WHAT THE LANDING PAGE NEEDS OF THE APPLICATION: a way to say the person has
 * just signed in, so the application can ask who they are and show them their
 * companies, or take them on to the page they asked for.
 */
interface Visitor {
  signedInNow: () => Promise<void>;
}

const VisitorContext = createContext<Visitor | null>(null);

export function VisitorProvider({ signedInNow, children }: Visitor & { children?: ReactNode }) {
  return <VisitorContext.Provider value={{ signedInNow }}>{children}</VisitorContext.Provider>;
}

/** The visitor's side of the application. Only the landing page asks for it. */
export function useVisitor(): Visitor {
  const visitor = useContext(VisitorContext);
  /* The application always provides it around a visitor's page. */
  if (visitor === null) throw new Fault(FAULT.noVisitor);
  return visitor;
}
