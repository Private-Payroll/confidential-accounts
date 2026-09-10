// @vitest-environment jsdom
/**
 * **THE SCREEN THAT SAYS AN APPROVAL IS BEING PROVED, RENDERED.**
 *
 * Three things are being held here, and each of them is something this
 * repository has paid for once already.
 *
 * **IT IS NOT A MODAL.** Proving takes over two minutes on this device,
 * measured, and moving it to another thread bought exactly one thing: the
 * person keeps their application while it happens. A modal hands that straight
 * back for the whole of the wait.
 *
 * **IT DOES NOT DRAW A PERCENTAGE OVER THE PROOF.** There is no progress to
 * report - the prover emits nothing and there is nowhere to put a callback - so
 * a bar over that stage would be invented. The download has a real one and gets
 * a real bar.
 *
 * **AND THE CONTROLS FOR WHAT THIS DEPLOYMENT CANNOT DO ARE SHOWN, DISABLED,
 * WITH THEIR REASON.** A screen built only for what works today cannot tell a
 * person the difference between a thing the product will not do and a thing
 * this deployment has not been given.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { ProofStatusStrip, describeStage, fractionOf } from './ProofStatus.js';
import type { ProofStatus } from './proving-session.js';

afterEach(cleanup);

const proof = (over: Partial<ProofStatus> = {}): ProofStatus => ({
  jobId: 'job_1', accountId: 'acc_1', attempts: 1,
  stage: { name: 'proving', elapsedMs: 94_000 },
  ...over,
});

describe('what the strip draws', () => {
  it('nothing at all when nothing is in flight', () => {
    /*
     * RED WHEN: the empty case renders a bar. A permanent strip saying nothing
     * is happening is furniture, and it teaches people not to look at the one
     * place that has to be worth looking at on the day it is not empty.
     */
    const { container } = render(<ProofStatusStrip proofs={[]} />);
    expect(container.textContent).toBe('');
  });

  it('elapsed time for the proof, and no rail beside it', () => {
    /*
     * **THE RAIL IS THE ASSERTION.** A track with nothing in it beside
     * *proving - 1m 34s* reads as a bar that is stuck, which is the exact
     * misreading this design exists to prevent - so the element is absent
     * rather than empty.
     *
     * RED WHEN: `fractionOf` answers anything for `proving`, or the strip
     * renders the rail unconditionally.
     */
    const { container } = render(<ProofStatusStrip proofs={[proof()]} />);
    expect(screen.getByRole('status').textContent).toMatch(/proving on this device - 1m 34s/);
    expect(container.querySelector('.proofrail'),
      'a progress rail was drawn beside a stage that has no progress to report').toBeNull();
    /*
     * **THE TEXT PATH ONLY, AND SAYING SO IS THE POINT.** The percentage lives
     * in the rail's width and never in the text, so this alone would pass
     * against a page that drew a full bar. The assertion above - that no rail
     * exists at all - is what carries the property; this one catches a
     * percentage written into the sentence.
     */
    expect(container.textContent, 'a percentage was written into the text of a stage with none')
      .not.toMatch(/%/);
  });

  it('a real rail for the download, because those bytes are real', () => {
    // RED WHEN: the fetch stage stops carrying its total, or the rail is
    // dropped for it too.
    const { container } = render(<ProofStatusStrip proofs={[proof({
      stage: { name: 'fetching', what: 'fetching the proving key', received: 10_233_333, total: 30_700_000 },
    })]} />);
    const fill = container.querySelector('.prooffill') as HTMLElement;
    expect(fill, 'the one stage with a real fraction was drawn without one').not.toBeNull();
    /*
     * A third rather than a half, deliberately: a browser normalises `50.0%` to
     * `50%`, so a round fraction cannot tell a width computed to one decimal
     * from one rounded to none - and the difference between those two is
     * whether the bar visibly moves during a 30 MB download.
     */
    expect(fill.style.width).toBe('33.3%');
    expect(screen.getByRole('status').textContent).toMatch(/9\.8 MB of 29\.3 MB/);
  });

  it('and no rail when the server sent no length, rather than a made-up one', () => {
    /*
     * RED WHEN: a null total is treated as zero, or the received bytes are used
     * as the denominator. Either draws a full bar over an unknown.
     */
    const { container } = render(<ProofStatusStrip proofs={[proof({
      stage: { name: 'fetching', what: 'fetching the proving key', received: 15_350_000, total: null },
    })]} />);
    expect(container.querySelector('.proofrail')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/14\.6 MB so far/);
  });
});

describe('the panel, which is not a modal', () => {
  const open = (proofs: ProofStatus[], onCancel?: (id: string) => void) => {
    const r = render(<ProofStatusStrip proofs={proofs} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Details'));
    return r;
  };

  it('does not cover the application, and takes no dialog role', () => {
    /*
     * **THE ROLE IS THE ASSERTION AND IT IS NOT PEDANTRY.** `role="dialog"` is
     * what tells a browser and a screen reader that everything behind it is
     * inert. This panel sits beside an application the person is meant to keep
     * using for the next two minutes, so claiming that role would be false as
     * well as unhelpful.
     *
     * RED WHEN: the panel becomes a `<dialog>`, gains `role="dialog"`, or
     * renders a backdrop over the page.
     */
    const { container } = open([proof()]);
    expect(container.querySelector('[role="dialog"]'),
      'the panel announces itself as a dialog, which says the application behind it is inert')
      .toBeNull();
    expect(container.querySelector('dialog, .backdrop, .overlay, .scrim')).toBeNull();
    expect(screen.getByLabelText('Approvals in progress')).toBeTruthy();
  });

  it('says the approval survives a closed tab AND that the proof starts again', () => {
    /*
     * **BOTH HALVES OR NEITHER.** *You can close this page* on its own is a
     * promise that something is being kept; a person who reads it and comes
     * back to a proof at nought will read that as a bug. Saying the proof
     * starts again, and that it costs only time because nothing is sent and no
     * fee is spent, is the whole of the truth and is not worse news.
     *
     * RED WHEN: the note claims a resume, or drops the sentence about starting
     * again, or stops saying that nothing is spent.
     */
    open([proof()]);
    const note = screen.getByText(/You can close this page/);
    expect(note.textContent).toMatch(/starts again from the beginning/);
    expect(note.textContent).toMatch(/spends no fee/);
    expect(note.textContent, 'the panel implies a proof can be picked up half done')
      .not.toMatch(/resume|resumed|continues where|picks up where it left/i);
  });

  it('offers to withdraw what has not been sent, and says why when it cannot', () => {
    /*
     * RED WHEN: the withdraw control is hidden rather than disabled once a job
     * is in flight. A control that disappears is a control a person believes
     * they imagined.
     */
    let cancelled: string | null = null;
    open([proof()], (id) => { cancelled = id; });
    fireEvent.click(screen.getByText('Withdraw'));
    expect(cancelled).toBe('job_1');

    cleanup();
    open([proof({ stage: { name: 'submitting' } })], () => {});
    const withdraw = screen.getByText('Withdraw') as HTMLButtonElement;
    expect(withdraw.disabled).toBe(true);
    expect(withdraw.title).toMatch(/already been sent/);
  });

  it('shows the controls this deployment cannot honour, disabled, with the reason', () => {
    /*
     * **THE REASON IS THE POINT, NOT THE DISABLED STATE.** A device can prove
     * an approval without a wallet and cannot send one without a wallet, and
     * those are different halves of the same operation. A greyed button with no
     * explanation leaves a person to guess whether they did something wrong.
     *
     * RED WHEN: either control is removed, enabled, or loses its title.
     */
    open([proof()]);
    const send = screen.getByText('Send it') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toMatch(/No wallet has been set up to pay the network fee/);

    const explorer = screen.getByText('View on the explorer') as HTMLButtonElement;
    expect(explorer.disabled).toBe(true);
    expect(explorer.title).toMatch(/once an approval has been sent/);
  });

  it('says how many times something has been started, from the second time', () => {
    /*
     * The count is on the job and survives reloads, so this is the only way a
     * person learns that an approval has been started more than once - which is
     * otherwise completely invisible to them.
     *
     * RED WHEN: the threshold moves to zero (every approval then reads as a
     * retry) or the line is dropped.
     */
    open([proof()]);
    expect(screen.queryByText(/started 1 times/)).toBeNull();
    cleanup();
    open([proof({ attempts: 3 })]);
    expect(screen.getByText('started 3 times')).toBeTruthy();
  });
});

describe('the two helpers the screen is built on', () => {
  it('only the fetch has a fraction', () => {
    // RED WHEN: `fractionOf` grows a branch for any other stage.
    expect(fractionOf({ name: 'proving', elapsedMs: 140_000 })).toBeNull();
    expect(fractionOf({ name: 'submitting' })).toBeNull();
    expect(fractionOf({ name: 'waiting' })).toBeNull();
    expect(fractionOf({ name: 'fetching', what: 'x', received: 1, total: 4 })).toBe(0.25);
    expect(fractionOf({ name: 'fetching', what: 'x', received: 1, total: null })).toBeNull();
  });

  it('a stopped job is described by its own reason and nothing else', () => {
    // RED WHEN: the reason is replaced by a generic word.
    expect(describeStage({ name: 'stopped', reason: 'the socket closed' })).toBe('the socket closed');
  });
});
