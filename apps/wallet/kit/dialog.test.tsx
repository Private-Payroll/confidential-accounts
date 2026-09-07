// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DialogTrigger,
} from './dialog.js';
import { Button } from './button.js';

/*
 * THE FETCHED DIALOG. Four claims, and each one is a thing that would be a
 * defect rather than an ugly panel if it stopped being true.
 *
 *   1. THE BEHAVIOUR IS WHY IT WAS FETCHED. The design puts `dialog` on
 *      the Radix list because *"the behaviour is hard and getting it wrong is a
 *      keyboard trap"*. So the tests are about the keyboard and the accessible
 *      name, not about how it looks: Escape closes it, focus goes in and comes
 *      back, and the panel has a name a screen reader can read.
 *
 *   2. THE SUBSTITUTION THAT FAILS INVISIBLY IS PINNED BY NAME.
 *      `data-[state=open]:bg-accent` EMITS A RULE against this repo's `@theme`
 *      and it is the WRONG one — shadcn's `accent` is a neutral hover surface,
 *      ours is the indigo brand accent. A
 *      screenshot would not catch it going back; this does.
 *
 *   3. A `DialogContent` WITHOUT A `DialogTitle` IS SILENT, NOT A WARNING —
 *      read in the shipped source, not assumed. `aria-labelledby` is written
 *      only when a title mounted (`@radix-ui/react-dialog/dist/index.mjs:233`,
 *      `titlePresent ? context.titleId : void 0`), so a missing title is an
 *      omitted attribute and a modal a screen reader can only call "dialog".
 *      Nothing makes it a compile error, so the accessible-name test below is
 *      what keeps every call site honest.
 *
 *   4. NOTHING HERE LEAVES THE RUNNER. Every specimen is text and
 *      a way out; not one has a handler that does anything.
 */

function Specimen({ showCloseButton = true }: { readonly showCloseButton?: boolean }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary">Open it</Button>
      </DialogTrigger>
      <DialogContent showCloseButton={showCloseButton}>
        <DialogHeader>
          <DialogTitle>A dialog</DialogTitle>
          <DialogDescription>What it is for.</DialogDescription>
        </DialogHeader>
        <p>Body text.</p>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="primary">Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const panel = (): HTMLElement | null => document.querySelector('[role="dialog"]');

beforeEach(() => {
  cleanup();
});

describe('the dialog is closed until it is opened, and says what it is', () => {
  it('renders nothing until the trigger is pressed', () => {
    render(<Specimen />);
    expect(panel()).toBeNull();
    fireEvent.click(screen.getByText('Open it'));
    expect(panel()).not.toBeNull();
  });

  it('carries an accessible name from its title — and without one it is SILENT', () => {
    render(<Specimen />);
    fireEvent.click(screen.getByText('Open it'));
    const labelledBy = panel()?.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('A dialog');
    /* And the description is wired the same way, so a screen reader reads the
     * sentence under the title rather than the first paragraph it finds. */
    const describedBy = panel()?.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy!)?.textContent).toBe('What it is for.');
  });

  it('is modal — the page behind it is hidden from a screen reader', () => {
    /* MEASURED RATHER THAN ASSUMED: Radix does NOT write `aria-modal` here. It
     * marks every sibling of the portal `aria-hidden="true"` instead, which is
     * the stronger of the two — `aria-modal` asks a screen reader to ignore the
     * rest of the page and `aria-hidden` tells it to. The panel's own subtree is
     * the one thing left visible. */
    const { container } = render(<Specimen />);
    const app = container;
    expect(app.getAttribute('aria-hidden')).toBeNull();
    fireEvent.click(screen.getByText('Open it'));
    expect(app.getAttribute('aria-hidden')).toBe('true');
    expect(panel()?.getAttribute('aria-hidden')).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(app.getAttribute('aria-hidden')).toBeNull();
  });
});

describe('the ways out, and there is always one', () => {
  it('Escape closes it', () => {
    render(<Specimen />);
    fireEvent.click(screen.getByText('Open it'));
    expect(panel()).not.toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(panel()).toBeNull();
  });

  it('the corner control closes it, and it has a name rather than only a glyph', () => {
    render(<Specimen />);
    fireEvent.click(screen.getByText('Open it'));
    const close = screen.getByLabelText('Close');
    fireEvent.click(close);
    expect(panel()).toBeNull();
  });

  it('and with the corner control OFF, Escape still works — never a trap', () => {
    /* `showCloseButton={false}` is for a panel whose only way out should be a
     * deliberate one. It must not become a panel with NO way out, ever —
     * *"a refusal with no way back is worse than a refusal."* */
    render(<Specimen showCloseButton={false} />);
    fireEvent.click(screen.getByText('Open it'));
    expect(screen.queryByLabelText('Close')).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(panel()).toBeNull();
  });

  it('focus goes into the panel and comes back to the trigger', async () => {
    render(<Specimen />);
    const trigger = screen.getByText('Open it');
    trigger.focus();
    fireEvent.click(trigger);
    expect(panel()?.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    /* The return is asynchronous — Radix restores focus after the content
     * unmounts, so a synchronous read catches `<body>` mid-flight. */
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe('the substitution that fails invisibly — the collision table', () => {
  it('the close control never wears bg-accent, which here is the indigo', () => {
    /* THE PAYLOAD SHIPPED `data-[state=open]:bg-accent`. It compiles here, it
     * renders here, and it is wrong here: shadcn means a neutral hover surface
     * by `accent` and this repo's `--color-accent` is the one brand indigo. Put
     * the fetched class back and this goes red; nothing else would. */
    render(<Specimen />);
    fireEvent.click(screen.getByText('Open it'));
    const close = screen.getByLabelText('Close');
    expect(close.className).not.toMatch(/(^|[^-\w])bg-accent(\b|$)/);
    expect(close.className).toContain('data-[state=open]:bg-sunken');
    /* And the same family: shadcn's `text-muted-foreground` emits NOTHING
     * against this `@theme`, so a control wearing it would have no colour at
     * all rather than the wrong one. */
    expect(close.className).not.toContain('muted-foreground');
  });

  it('and the panel is drawn from this repo’s roles, not shadcn’s', () => {
    render(<Specimen />);
    fireEvent.click(screen.getByText('Open it'));
    const className = panel()?.className ?? '';
    /* `bg-background` emits nothing here — a transparent dialog. */
    expect(className).not.toContain('bg-background');
    expect(className).toContain('bg-raised');
    /* The radius scale has three steps and `lg` is not one of them. */
    expect(className).not.toMatch(/\brounded-lg\b/);
    /* Motion is the shell's, and it is `motion-safe:` at the call site. */
    expect(className).toContain('motion-safe:');
    expect(className).not.toContain('animate-in');
  });
});

describe('nothing on a specimen leaves the runner', () => {
  it('every control inside is either a close or an ordinary button with no handler', () => {
    render(<Specimen />);
    fireEvent.click(screen.getByText('Open it'));
    /* Pressing everything in the panel must not throw and must not navigate. */
    const before = window.location.hash;
    for (const control of panel()!.querySelectorAll('button')) {
      if (control.getAttribute('aria-label') === 'Close') continue;
      fireEvent.click(control);
    }
    expect(window.location.hash).toBe(before);
  });
});
