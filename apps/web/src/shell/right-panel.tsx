import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from 'vaults-ui';

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
  if (panel === null) throw new RangeError();
  return panel;
}

/** The panel itself, drawn by the frame once. */
export function RightPanel() {
  const { shown, close } = usePanel();
  return (
    <Sheet open={shown !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <SheetContent side="end" data-panel>
        {shown === null ? null : (
          <>
            <SheetHeader>
              <SheetTitle>{shown.title}</SheetTitle>
              {shown.description === undefined ? null : <SheetDescription>{shown.description}</SheetDescription>}
            </SheetHeader>
            <div className="flex-1 overflow-auto px-4 pb-4">{shown.body}</div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
