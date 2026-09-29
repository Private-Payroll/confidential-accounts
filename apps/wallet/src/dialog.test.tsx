// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render as renderBare } from '@testing-library/react';
import { cleanup, fireEvent, render, screen, waitFor } from './testing/render.js';
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DialogTrigger, KitProvider, languagesFrom,
} from 'vaults-ui';
import { DialogClose } from 'vaults-ui/components/dialog';

/*
 * THE WALLET'S DIALOGS ARE THE KIT'S DIALOG. Three claims, and each one is a
 * thing that would be a defect rather than an ugly panel if it stopped being
 * true for the switcher, Receive and every other panel the wallet opens.
 *
 *   1. THE BEHAVIOUR IS WHY IT IS A LIBRARY PART. The keyboard and the
 *      accessible name, not the look: Escape closes it, focus goes in and comes
 *      back, and the panel has a name a screen reader can read. A panel
 *      without a title is silent - Radix writes `aria-labelledby` only when a
 *      title mounted - so the name test is what keeps every call site honest.
 *
 *   2. ITS WORDS ARE THE WALLET'S. The corner control is named by the kit
 *      from the language file the wallet hands it, so a wallet whose file
 *      lost the phrase would show a key where the word "Close" should be.
 *
 *   3. NOTHING HERE LEAVES THE RUNNER. Every specimen is text and a way out.
 */

function Specimen({ showCloseButton = true }: { readonly showCloseButton?: boolean }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">Open it</Button>
      </DialogTrigger>
      <DialogContent showCloseButton={showCloseButton}>
        <DialogHeader>
          <DialogTitle>A dialog</DialogTitle>
          <DialogDescription>What it is for.</DialogDescription>
        </DialogHeader>
        <p>Body text.</p>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button">Done</Button>
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
    const close = screen.getByRole('button', { name: 'Close' });
    fireEvent.click(close);
    expect(panel()).toBeNull();
  });

  it('and with the corner control OFF, Escape still works — never a trap', () => {
    /* `showCloseButton={false}` is for a panel whose only way out should be a
     * deliberate one. It must not become a panel with NO way out, ever —
     * *"a refusal with no way back is worse than a refusal."* */
    render(<Specimen showCloseButton={false} />);
    fireEvent.click(screen.getByText('Open it'));
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
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

describe('its words are the wallet\'s', () => {
  /* RED WHEN: the wallet's language file loses the close control's phrase. */
  it('the corner control is named from the wallet\'s language file', () => {
    render(<Specimen />);
    fireEvent.click(screen.getByText('Open it'));
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  /* And the test above can fail: with a file that lacks the phrase, the
   * control is named by its key, so the name really comes from the file. */
  it('and a file without the phrase names it by its key instead', () => {
    const bare = languagesFrom({ './locales/en.json': {} });
    renderBare(createElement(KitProvider, { languages: bare }, createElement(Specimen)));
    fireEvent.click(screen.getByText('Open it'));
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.getByRole('button', { name: 'kit.close' })).toBeTruthy();
  });
});

describe('nothing on a specimen leaves the runner', () => {
  it('every control inside is either a close or an ordinary button with no handler', () => {
    render(<Specimen />);
    fireEvent.click(screen.getByText('Open it'));
    const before = window.location.hash;
    for (const control of panel()!.querySelectorAll('button')) {
      if (control.textContent === 'Close') continue;
      fireEvent.click(control);
    }
    expect(window.location.hash).toBe(before);
  });
});
