import { useState } from 'react';
import type { ReactNode } from 'react';
import { hrefOf } from '../routes.js';
import { useSession } from '../session.js';
import { ErrorNote, StatusNote, WalletNameField } from '../ui.js';

/**
 * THE WALLETS THIS BROWSER HOLDS, and the surface the whole change
 * exists to put on screen.
 *
 * It renders on the LOCKED screen, and that is the deliberate choice rather
 * than a new place in the navigation. The design keeps the bar
 * at four places; and more to the point, **choosing a wallet is something you
 * do while none is open.** Two wallets are never unlocked at once
 * (by design), so the moment you turn to another
 * one you are locked out of the first — which is exactly the state this screen
 * already is.
 *
 * SWITCHING IS NOT A CEREMONY, AND THIS DOES NOT MAKE IT ONE. Pressing a wallet
 * here points this window at it and then calls `unlock` — the SAME `unlock`
 * the button above this card calls. It is not a copy of that ceremony and not
 * a variant of it; it is the identical function off the identical session, and
 * `session.tsx` has exactly one of them, and this change added none.
 *
 * Said exactly, because "one code path" is the sentence this list's whole
 * design rests on: `session.tsx` has six functions that set the `unlocked`
 * phase. Four are LANDINGS — `createAccount`, `startFresh`, `finishRecovery`,
 * `finishPairing` — and each one PUTS a wallet into this browser rather than
 * opening one that is already here. The fifth, `adoptPasskey`, opens a stored
 * wallet but is not a route into it: it exists for a damaged record, mints a
 * REPLACEMENT credential, and is reachable only from the screen that says so.
 * `unlock` is the one door for a wallet this browser already holds, and it is
 * the door this row presses. So "two are never unlocked at once" is still a
 * fact about the code rather than a promise about the buttons.
 *
 * **WHY THE PRESS HAD TO GROW THE SECOND HALF.** Observed on a real
 * machine: the press succeeded, the screen barely changed, and nothing said
 * what to do next. `switchTo` re-points the window and re-derives the phase;
 * the wallet was still locked and `Unlock with your passkey` was far above the
 * list, off the top of a normal window. A control whose entire visible effect
 * is that a name moves into bold is a control a person presses twice and then
 * stops trusting.
 *
 * **AND THE ROW OF THE WALLET ALREADY SELECTED IS A BUTTON TOO.** It used to be
 * a bare `<strong>`, on the reasoning that switching to the current wallet is a
 * no-op. It is a no-op for the SWITCH; it is not a no-op for the person, who
 * did not know or care which one this window happened to be pointing at and
 * wanted that wallet open. Every row now does the same thing, so the list has
 * no dead entry in it.
 *
 * AND THE BROWSER'S CHOOSER CAN DO THE SWITCHING TOO. Unlock offers every
 * credential for this origin and `walletOfCredential` resolves whichever is
 * picked, so a person who recognises their passkey by its label never has to
 * touch this list. The list is for the person who does not.
 */
export function WalletsHere(): ReactNode {
  const { wallets, switchTo, unlock, busy } = useSession();
  if (wallets.length < 2) return null;
  const label = (wallet: { name: string | null }, index: number): string =>
    wallet.name ?? `Unnamed wallet ${index + 1}`;
  /**
   * ONE PRESS: TURN TO IT, THEN OPEN IT THE ONLY WAY A WALLET OPENS.
   *
   * **THE SWITCH'S ANSWER IS THE GUARD.** `switchTo` hands back the phase it
   * landed in, and the ceremony runs only for `locked` — the state that means
   * "a sealed keyring and a credential are both on record here". The other
   * landings are real: a compartment whose keyring is damaged derives
   * `broken`, one whose credential was deleted from the platform keychain
   * derives `account-no-passkey`, and each of those has its own screen with
   * its own doors. Firing the browser's chooser at one of them would be a
   * biometric prompt that cannot succeed, whose failure then writes a red line
   * onto a screen that has already been replaced underneath it.
   *
   * **WHICH WALLET ACTUALLY OPENS IS STILL DECIDED BY THE CREDENTIAL**, not by
   * the row. `session.tsx`'s `unlock` resolves `walletOfCredential(assertion
   * .credentialId)` and calls `openWallet` with the answer, so a person who
   * presses `Employee` and then picks the Founder passkey out of the chooser
   * opens Founder. That is `session.test.tsx`'s pinned behaviour and this
   * change does not touch it. The row is a request, and the passkey is the
   * decision — which is the same sentence the screen above already tells the
   * person: *"your passkey says which one opens."*
   */
  const open = (walletId: string): void => {
    if (switchTo(walletId).name !== 'locked') return;
    void unlock();
  };
  return (
    <section className="card" data-wallets-here="">
      <h2>Wallets in this browser</h2>
      <p className="muted small">
        This browser holds {wallets.length}. One is open at a time; each opens with
        its own passkey. Press one to unlock it.
      </p>
      <ul className="plain">
        {wallets.map((wallet, index) => (
          <li key={wallet.id}>
            <button
              type="button"
              className="quiet"
              disabled={busy !== null}
              onClick={() => open(wallet.id)}
              data-current-wallet={wallet.current ? '' : undefined}
            >
              {wallet.current
                ? <strong>{label(wallet, index)}</strong>
                : label(wallet, index)}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * ADDING ONE MORE — the three doors, said in the same words as `Welcome`'s,
 * because they are the same three acts.
 *
 * **THE SENTENCE THAT MATTERS IS THE FIRST ONE, AND IT IS SAID BEFORE THE
 * PASSKEY CEREMONY** — §4: *"A person who has one wallet and creates a second
 * must not be able to lose the first, and the screen must make that plain
 * before the passkey ceremony, not after."* So it is above the button, not in
 * the fine print under it.
 *
 * BEHIND A DISCLOSURE, because the locked screen's job is to open the wallet
 * that is here. A person arriving to unlock should not have to read past three
 * ways to acquire another one.
 */
export function AddAnotherWallet(): ReactNode {
  const { createAccount, wallets, busy, error } = useSession();
  const [open, setOpen] = useState(false);
  const [walletName, setWalletName] = useState('');
  if (!open) {
    return (
      <p className="faint small">
        <button type="button" className="quiet" onClick={() => setOpen(true)}>
          Add another wallet to this browser
        </button>
      </p>
    );
  }
  return (
    <section className="card" data-add-wallet="">
      <h2>Add another wallet</h2>
      <p className="small">
        <strong>
          The {wallets.length === 1 ? 'wallet' : `${wallets.length} wallets`} already in
          this browser stay exactly as they are.
        </strong>{' '}
        A new wallet is kept beside them, in its own place, with its own passkey —
        nothing here is replaced and nothing here is lost.
      </p>
      <WalletNameField
        label="A name for the new wallet (optional)"
        value={walletName}
        onChange={setWalletName}
      />
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy !== null}
          onClick={() => { void createAccount(walletName); }}
        >
          Create a new wallet here
        </button>
        <StatusNote message={busy} />
        <ErrorNote message={error} />
      </div>
      <p className="muted small" style={{ marginTop: '1rem' }}>
        Already have one elsewhere?{' '}
        <a href={hrefOf('add-device')}>Move it onto this machine</a>, or{' '}
        <a href={hrefOf('recover')}>recover it from its pieces</a>. Both land beside
        what is here too.
      </p>
      <p className="faint small">
        <button type="button" className="quiet" onClick={() => setOpen(false)}>
          Not now
        </button>
      </p>
    </section>
  );
}
