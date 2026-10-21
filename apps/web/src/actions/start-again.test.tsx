// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useState } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KitProvider, languagesFrom } from 'vaults-ui';
import { DEFAULT_PREFERENCES } from '../preferences.js';
import { SessionProvider, type Session } from '../session.js';
import { VIEWS } from '../pages.js';

/*
 * EVERY PRESS OF START IT AGAIN ENDS IN WORDS ON THE SCREEN, drawn with the real control and the real lane that
 * holds a start-again back while a step is being sent; only what the adapter comes to is set by each test.
 */
const kr = vi.hoisted(() => ({ next: null as Promise<unknown> | null, asked: [] as unknown[][] }));
vi.mock('../adapters/start-again.js', async (real) => ({
  ...(await real<typeof import('../adapters/start-again.js')>()),
  startAgain: async (...args: unknown[]) => { kr.asked.push(args); return kr.next; },
}));

const { StartAgain, StartAgainWords, forgetWhatStartAgainSaid } = await import('./start-again.js');
const { lane } = await import('../adapters/sends.js');

const EN = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../locales/en.json'), 'utf8')) as Record<string, string>;
const LANGUAGES = languagesFrom({ './locales/en.json': EN });
const sessionWith = (): Session => ({
  person: { id: 'u1', name: 'Priya' }, companies: [], company: 'c-1', chooseCompany: vi.fn(),
  viewer: { signedIn: true, view: VIEWS.employee, signs: false }, chooseView: vi.fn(), preferences: DEFAULT_PREFERENCES,
  choose: vi.fn(), signOut: vi.fn(), mac: true, companiesChanged: vi.fn(async () => {}),
});

/** The screen that offers the button: the control can be swapped out for another part of the screen, the words stay. */
function Screen({ companyId, onStartNew }: { companyId: string | null; onStartNew?: () => void }) {
  const [shown, setShown] = useState(true);
  return (
    <div>
      <button data-swap onClick={() => setShown((s) => !s)}>swap</button>
      {shown ? <StartAgain companyId={companyId} /> : <p data-other>another part of the screen</p>}
      <StartAgainWords shown={companyId} onStartNew={onStartNew} />
    </div>
  );
}
const draw = (companyId: string | null = 'c-1', onStartNew?: () => void) => render(
  <KitProvider languages={LANGUAGES} pick="en">
    <SessionProvider session={sessionWith()}><Screen companyId={companyId} onStartNew={onStartNew} /></SessionProvider>
  </KitProvider>,
);
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const press = async (c: HTMLElement) => {
  fireEvent.click(c.querySelector('[data-action=start-again]')!);
  const sure = [...c.querySelectorAll('[data-slot=confirm-in-your-account] button')].find((b) => b.textContent === EN['kit.confirm.confirm'])!;
  await act(async () => { fireEvent.click(sure); await Promise.resolve(); });
};
const said = (c: HTMLElement) => c.querySelector('[data-start-again-said]')?.textContent ?? '';

beforeEach(() => {
  forgetWhatStartAgainSaid();
  kr.asked = []; kr.next = Promise.resolve({ of: 'done' });
  lane.carrying = null; lane.pressing = null; lane.holding = null;
});
afterEach(() => { cleanup(); lane.carrying = null; lane.pressing = null; lane.holding = null; });

describe('every press of Start it again ends in words', () => {
  /* RED WHEN: a press made while a step is being sent waits with no words, or the words never give way to what it came to. */
  it('says it waits for the send in flight, then says what it came to', async () => {
    let sent!: () => void;
    lane.carrying = new Promise<void>((r) => { sent = r; });
    let came!: (v: unknown) => void;
    kr.next = new Promise((r) => { came = r; });
    const { container } = draw();
    await press(container);
    expect(said(container)).toContain(EN['setup.again.queued']);
    expect(container.querySelector<HTMLButtonElement>('[data-action=start-again]')!.disabled).toBe(true);
    sent(); lane.carrying = null;
    await settle();
    await act(async () => { came({ of: 'landed' }); await Promise.resolve(); });
    expect(said(container)).toContain(EN['setup.again.landed']);
  });

  /* RED WHEN: the time spent looking at the network is silent. */
  it('says it is looking at the network while it looks', async () => {
    kr.next = new Promise(() => {});
    const { container } = draw();
    await press(container);
    expect(said(container)).toContain(EN['setup.again.working']);
  });

  /* RED WHEN: an error thrown by the start leaves the screen with no words. */
  it('says why when the start throws', async () => {
    kr.next = Promise.reject(new Error('boom'));
    const { container } = draw();
    await press(container);
    await settle();
    expect(container.querySelector('[data-refusal]')!.getAttribute('data-refusal')).toBe('did-not-finish');
    expect(said(container)).toContain(EN['act.refused.didNotFinish']);
  });

  /* RED WHEN: a set aside company navigates away or ends with nothing said, or offers no way on to a new company. */
  it('says a company was set aside, and leads to a new company only when asked', async () => {
    const onStartNew = vi.fn();
    const { container } = draw('c-1', onStartNew);
    await press(container);
    await settle();
    expect(said(container)).toContain(EN['setup.again.dropped']);
    expect(onStartNew).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('[data-action=start-new-company]')!);
    expect(onStartNew).toHaveBeenCalledTimes(1);
  });

  /* RED WHEN: a company that is on the network, may still land, or could not be confirmed is kept with no words, or with no number of minutes. */
  it('says why a company was kept, for each kind', async () => {
    for (const [again, words] of [
      [{ of: 'landed' }, EN['setup.again.landed']],
      [{ of: 'wait', minutes: 7 }, (EN['setup.again.wait'] ?? '').replace('{minutes}', '7')],
      [{ of: 'unsure' }, EN['setup.again.unsure']],
      [{ of: 'something-new' }, EN['setup.again.unsure']],
    ] as [Record<string, unknown>, string][]) {
      kr.next = Promise.resolve(again);
      const { container, unmount } = draw();
      await press(container);
      await settle();
      expect(said(container), String(again.of)).toContain(words);
      unmount();
      forgetWhatStartAgainSaid();
    }
  });

  /* RED WHEN: a refusal (wallet not open, signed out, page not set up) is not said. */
  it('says why it cannot, for a refusal', async () => {
    for (const why of ['no-window', 'not-signed-in', 'not-set-up']) {
      kr.next = Promise.resolve({ of: 'refused', why });
      const { container, unmount } = draw();
      await press(container);
      await settle();
      expect(container.querySelector('[data-refusal]')!.getAttribute('data-refusal')).toBe(why);
      unmount();
      forgetWhatStartAgainSaid();
    }
  });

  /* RED WHEN: a press with no company, or for a company this browser keeps nothing for, ends as if it set something aside, or in silence. */
  it('says there is nothing to set aside when no company is named or none is kept', async () => {
    kr.next = Promise.resolve({ of: 'nothing' });
    const { container } = draw(null, vi.fn());
    await press(container);
    await settle();
    expect(kr.asked).toEqual([['u1', null]]);
    expect(said(container)).toContain(EN['setup.again.nothing']);
    expect(said(container)).not.toContain(EN['setup.again.dropped']);
  });

  /* RED WHEN: dismissing the confirm ends with nothing said. */
  it('says nothing was changed when the confirm is dismissed', async () => {
    const { container } = draw();
    fireEvent.click(container.querySelector('[data-action=start-again]')!);
    const cancel = [...container.querySelectorAll('[data-slot=confirm-in-your-account] button')].find((b) => b.textContent === EN['kit.confirm.cancel'])!;
    fireEvent.click(cancel);
    expect(said(container)).toContain(EN['setup.again.cancelled']);
    expect(kr.asked).toEqual([]);
  });

  /* RED WHEN: the screen swapping the control for another part (as the creation steps do each look) loses the words, whether the press is still going or has ended. */
  it('keeps the words when the control is swapped out and back, mid-press and after it', async () => {
    let came!: (v: unknown) => void;
    kr.next = new Promise((r) => { came = r; });
    const { container } = draw();
    await press(container);
    fireEvent.click(container.querySelector('[data-swap]')!);
    expect(container.querySelector('[data-other]')).not.toBeNull();
    expect(said(container)).toContain(EN['setup.again.working']);
    await act(async () => { came({ of: 'wait', minutes: 3 }); await Promise.resolve(); });
    fireEvent.click(container.querySelector('[data-swap]')!);
    expect(said(container)).toContain((EN['setup.again.wait'] ?? '').replace('{minutes}', '3'));
    expect(container.querySelector<HTMLButtonElement>('[data-action=start-again]')!.disabled).toBe(false);
  });
});
