// @vitest-environment jsdom
/**
 * **THE SIGN-IN SCREEN, RENDERED, WITH ONE WAY IN ON IT.** `PI4b`, `C129`,
 *
 *
 * ── WHY THIS IS RENDERED AND NOT GREPPED ─────────────────────────────────
 *
 * The round's words: *AND THE SCREEN IS RENDERED, NOT GREPPED. Payroll can
 * render screens since `X10`. A rendered `Auth.tsx` shows one way in.*
 *
 * A grep over `Auth.tsx` says the source has no `<input type="password">` in
 * it. **It says nothing about what a person is shown.** A field could arrive
 * from a component this file imports, from a branch a grep skims past, or from
 * a `mode` that renders a different card — and the failure the password left
 * behind would be a form on the screen, not a string in a file. `X10` built the
 * environment that can answer the question properly, and this is the answer.
 *
 * ── AND IT COUNTS RATHER THAN ASSERTING AN ABSENCE ───────────────────────
 *
 * *There is no password field* and *there is exactly one way in* are different
 * claims, and only the second one is what `C129` closed. A screen with no
 * password field and no wallet button either would pass the first and be a
 * product nobody can sign in to. So every input and every button on the
 * rendered screen is enumerated, and the counts are asserted.
 *
 * ── NO `waitFor`, NO `findBy*` ───────────────────────────────────────────
 *
 * `C134`, and `wallet-waiting.test.tsx` has the argument. Nothing here is
 * asynchronous: the screen is rendered and read.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AuthScreen } from './Auth.js';

afterEach(cleanup);

/** `onDone` is never called here — nothing on this screen is pressed. */
const drawIt = () => render(<AuthScreen onDone={() => {}} />);

describe('PI4b — the sign-in screen', () => {
  it('SHOWS ONE WAY IN, AND IT IS THE WALLET', () => {
    const { container } = drawIt();

    const buttons = [...container.querySelectorAll('button')];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe('Sign in with your wallet');

    /* And it is reachable by what it says, not only by being the only one. */
    expect(screen.getByRole('button', { name: 'Sign in with your wallet' })).toBeTruthy();
  });

  it('HAS NO FIELD OF ANY KIND — not a password one, and not an email one either', () => {
    /*
     * **EVERY INPUT, NOT EVERY PASSWORD INPUT.** `type="password"` is one
     * spelling; `type="text"` with `autocomplete="current-password"` is
     * another, and a `<textarea>` is a third. The claim this screen makes is
     * that it asks a person for NOTHING — `docs/scope-payroll-identity.md` §10
     * step 1, *sign-in first, nothing about profiles* — so what is counted is
     * every way a person could type into it.
     */
    const { container } = drawIt();
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.querySelectorAll('textarea')).toHaveLength(0);
    expect(container.querySelectorAll('select')).toHaveLength(0);
  });

  it('AND THERE IS NO FORM TO SUBMIT, so there is nothing for a field to come back into', () => {
    /*
     * The card was a `<form onSubmit={submit}>`, and `submit` is what called
     * `keyring.register` and `keyring.signIn`. Both are deleted; so is the
     * element. **A screen that still had a form would be one field away from
     * having the password back**, and this is the assertion that notices.
     */
    const { container } = drawIt();
    expect(container.querySelectorAll('form')).toHaveLength(0);
  });

  it('AND NOTHING ON IT OFFERS TO CREATE AN ACCOUNT OR SWAP TO A PASSWORD', () => {
    /*
     * The two links that used to sit under the card — *New here? Create an
     * account* and *or use an email and a password* — were how a person reached
     * the form. Read off the rendered text rather than the source, because a
     * link that came back from a component this file imports would not be in
     * the source at all.
     */
    const text = drawIt().container.textContent ?? '';
    expect(text).not.toMatch(/password/i);
    expect(text).not.toMatch(/create an account/i);
    expect(text).not.toMatch(/email/i);
    expect(text).not.toMatch(/already have an account/i);
    expect(text).not.toMatch(/new here/i);

    /*
     * A draft of this also forbade the words *sign in* except when followed by
     * *with your wallet*, **and it passed for the wrong reason**: `textContent`
     * runs the heading straight into the button, so `Sign inSign in with your
     * wallet` has no word boundary where the regex looked for one. It was
     * asserting nothing. The heading says *Sign in* and should — what must not
     * be there is a second way of doing it, which is what the lines above
     * name one at a time.
     *
     * And the sentence that IS there, so this is not passing on an empty
     * render.
     */
    expect(text).toContain('Your wallet signs one message saying this is you');
  });
});
