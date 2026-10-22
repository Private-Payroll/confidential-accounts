import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from 'vaults-ui';
import { Fault, FAULT } from '../faults.js';

/**
 * THE RIGHT-HAND PANEL: the frame's one place for a detail or an action that
 * opens over the page and leaves the page behind it where it was. It is empty
 * until a page opens it; Esc, or its close button, closes it. In a
 * right-to-left language it opens from the left, because it opens from the
 * end of the line.
 */
export interface PanelContent {
  title: string;
  description?: string;
  body: ReactNode;
}

interface Panel {
  shown: PanelContent | null;
  open: (content: PanelContent) => void;
  close: () => void;
}

const PanelContext = createContext<Panel | null>(null);

/** Where the panel's footer is: undefined outside a panel, null while the panel has not drawn it yet. */
const FooterContext = createContext<HTMLElement | null | undefined>(undefined);

/**
 * WHAT A PANEL KEEPS IN VIEW WHILE ITS BODY SCROLLS: the footer of the panel, below the body. A page puts the press that
 * finishes what the panel asks, and the words that refuse it, here, so neither is ever below the fold. Drawn in a panel, it
 * is in the panel's footer; drawn anywhere else, it is where it is written.
 */
export function PanelFooter({ children }: { children?: ReactNode }) {
  const footer = useContext(FooterContext);
  if (footer === undefined) return <>{children}</>;
  return footer === null ? null : createPortal(children, footer);
}

export function PanelProvider({ children }: { children?: ReactNode }) {
  const [shown, setShown] = useState<PanelContent | null>(null);
  const close = useCallback(() => setShown(null), []);
  const value = useMemo<Panel>(() => ({ shown, open: setShown, close }), [shown, close]);
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>;
}

/** The panel, for a page that opens it. */
export function usePanel(): Panel {
  const panel = useContext(PanelContext);
  /* The frame always provides it. */
  if (panel === null) throw new Fault(FAULT.noRightPanel);
  return panel;
}

/** The panel itself, drawn by the frame once. */
/** A press in the wallet's window, which opens over the panel, is not a press outside the panel: it leaves the panel open. */
const keepOpenForTheWalletWindow = (e: { target: EventTarget | null; preventDefault: () => void }): void => {
  if (e.target instanceof Element && e.target.closest('[data-account-frame]') !== null) e.preventDefault();
};

/** The names of the browser events the panel hears before its own library does. */
const HEARD = ['focusin', 'focusout'] as const;

const inTheWalletWindow = (where: EventTarget | null): boolean => where instanceof Element && where.closest('[data-account-frame]') !== null;

/** Esc pressed in the wallet's window, which opens over the panel, is not Esc for the panel: it leaves the panel open. */
const keepOpenForEscInTheWalletWindow = (e: { target: EventTarget | null; preventDefault: () => void }): void => {
  if (inTheWalletWindow(e.target)) e.preventDefault();
};

/**
 * THE WALLET'S WINDOW IS NOT INSIDE THE PANEL'S FOCUS TRAP. A modal panel keeps focus inside itself: focus that goes
 * anywhere else is sent back, which would keep a keyboard out of the account's window opened over it. So focus
 * going into that window (or out of the panel to it) is the window's own and does not reach the panel, which keeps the
 * trap for everything else; Esc pressed in it does not close the panel. Heard before the panel hears them, on the window.
 */
function useLeaveTheWalletWindowItsOwn(): void {
  useEffect(() => {
    const own = (e: Event): void => {
      const where = e.type === 'focusout' ? (e as FocusEvent).relatedTarget : e.target;
      if (inTheWalletWindow(where)) e.stopPropagation();
    };
    for (const type of HEARD) window.addEventListener(type, own, true);
    return () => { for (const type of HEARD) window.removeEventListener(type, own, true); };
  }, []);
}

export function RightPanel() {
  const { shown, close } = usePanel();
  const [footer, setFooter] = useState<HTMLElement | null>(null);
  useLeaveTheWalletWindowItsOwn();
  return (
    <Sheet open={shown !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <SheetContent side="end" data-panel onInteractOutside={keepOpenForTheWalletWindow} onEscapeKeyDown={keepOpenForEscInTheWalletWindow}>
        {shown === null ? null : (
          <>
            <SheetHeader>
              <SheetTitle>{shown.title}</SheetTitle>
              {shown.description === undefined ? null : <SheetDescription>{shown.description}</SheetDescription>}
            </SheetHeader>
            <FooterContext.Provider value={footer}>
              <div className="flex-1 overflow-auto px-4 pb-4">{shown.body}</div>
              <SheetFooter ref={setFooter} className="mt-0 border-t pt-3 empty:hidden" />
            </FooterContext.Provider>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
