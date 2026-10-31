import { useEffect, useRef, useState, type ReactNode } from 'react';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './input-group.js';

/** How long the button says it copied before it goes back to its first words. */
const COPIED_FOR_MS = 1600;

export interface CopyTextProps {
  /** What is shown, read-only, and what a press puts on the clipboard. */
  readonly text: string;
  /** The button's words, and the field's name for a screen reader. The kit holds no wording: the screen passes it in its language. */
  readonly label: string;
  /** The button's words for COPIED_FOR_MS after the text was copied. */
  readonly copied: string;
  /** What is said under the field when the browser would not copy (no permission, or a page that is not secure), until the next press or a change of `text`. */
  readonly refused: string;
}

/**
 * A line of text with a button that copies it: built from the input group, once, so no screen paints its own.
 * It goes back to `label` after its timer and as soon as `text` changes; its timer is cleared when it is removed.
 * When the browser would not copy, it says `refused` under the field instead of saying nothing.
 */
export function CopyText({ text, label, copied, refused }: CopyTextProps): ReactNode {
  const [done, setDone] = useState(false);
  const [wouldNot, setWouldNot] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = (): void => { if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => stop, []);
  useEffect(() => { stop(); setDone(false); setWouldNot(false); }, [text]);
  const press = (): void => {
    setWouldNot(false);
    const written = (): Promise<void> => {
      try { return navigator.clipboard.writeText(text); } catch (e) { return Promise.reject(e); }
    };
    void written().then(() => {
      stop();
      setDone(true);
      timer.current = setTimeout(() => { timer.current = null; setDone(false); }, COPIED_FOR_MS);
    }, () => { stop(); setDone(false); setWouldNot(true); });
  };
  return (
    <div className="flex flex-col gap-2">
      <InputGroup>
        <InputGroupInput readOnly value={text} aria-label={label} dir="ltr" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton type="button" variant="outline" size="sm" onClick={press}>{done ? copied : label}</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {wouldNot ? <p className="text-sm text-destructive" role="alert" data-copy-refused>{refused}</p> : null}
    </div>
  );
}
