import React, { useState } from 'react';
import * as keyring from './keyring.js';

/**
 * Sign in, and account selection.
 *
 * **THERE IS ONE WAY IN AND IT IS A WALLET.**
 *
 * An email-and-password form was here, below the wallet button, with the
 * comment above that button saying so. It had two fields, a create-an-account
 * path that set a password, and a submit that spent about a second stretching
 * one with argon2id — and that second WAS the security property, which is why
 * it was labelled rather than hidden.
 *
 * **IT WAITED FOR `C129` AND `C129` IS ANSWERED.** A password did two jobs and
 * only one of them was letting you in: it also produced the key that unsealed
 * a person's keyring, and a wallet sign-in produces a signature, not a key. So
 * deleting the form early would have left a person proved to be themselves and
 * able to open nothing. `PI2a` built the other half — the wallet releases a
 * key for ONE company after a press on its own screen — and a person has since
 * walked the whole path: sign in, create a company, invite somebody, accept in
 * their own wallet, admit them.
 *
 * **DELETED, NOT DISABLED.** There is no flag, no branch and no dead handler
 * that would draw a password field. `src/web/no-password-in-the-bundle.test.ts`
 * builds the app and looks in the output, because reading this comment is not
 * the same claim.
 */
/**
 * WHERE THE WALLET IS.
 *
 * Absent means signing in with a wallet is not configured for this build, and
 * the button says so rather than opening `undefined/#/approve`.
 */
export const WALLET_ORIGIN = (import.meta.env.VITE_WALLET_ORIGIN ?? '').replace(/\/+$/, '');

export function AuthScreen({ onDone }: { onDone: (u: keyring.Me) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  /**
   * THE WALLET PATH, AND NOW THE ONLY PATH.
   * `docs/scope-payroll-identity.md` §10 step 1.
   */
  const withWallet = async () => {
    setErr(''); setBusy(true);
    try {
      if (!WALLET_ORIGIN) {
        throw new Error(
          'this build does not know where your wallet is served from, so it cannot open '
          + 'it. VITE_WALLET_ORIGIN has to be set when the site is built.');
      }
      onDone(await keyring.signInWithWallet(WALLET_ORIGIN));
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="authwrap">
      <div className="authcard">
        <div className="authmark">CA</div>
        <h1>Sign in</h1>

        <button type="button" className="primary" disabled={busy} onClick={withWallet}>
          {busy ? 'Waiting for your wallet' : 'Sign in with your wallet'}
        </button>
        <p className="authsub">
          Your wallet signs one message saying this is you, on this site, once.
          Nothing else is asked for and no key leaves it.
        </p>

        {err && <div className="autherr">{err}</div>}
      </div>
    </div>
  );
}

/** Shown after sign in when the user is on zero or several accounts. */
export function AccountPicker({
  user, accounts, onOpen, onUnlock, onCreate, onCreateWithWallet, onFinishSetup,
  awaitingSetup, onDemo, onSignOut, busy, err,
}: {
  user: keyring.Me;
  accounts: any[];
  onOpen: (id: string) => void;
  /** `PI2a` — ask the wallet for this company's key, then open it. */
  onUnlock: (id: string) => void;
  onCreate: (name: string) => void;
  /**
   * **PI3.** Create a company from a wallet session — three steps in
   * an order the ordinary button cannot perform, because sealing needs a key
   * that does not exist until the company does.
   */
  onCreateWithWallet: (name: string) => void;
  /** Finish one that was created but whose keys were never sealed. */
  onFinishSetup: () => void;
  /** The company this tab created and has not finished sealing, if any. */
  awaitingSetup: string | null;
  onDemo: () => void;
  onSignOut: () => void;
  busy: boolean;
  err?: string;
}) {
  const [name, setName] = useState('');
  const wallet = keyring.signedInWallet();

  /**
   * **A WALLET SIGN-IN OPENS NOTHING UNTIL THE WALLET IS ASKED FOR A KEY.**
   * `PI1` wrote this screen to say the second half was not built; `PI2a` built
   * it, and this is what that screen says now.
   *
   * The company's data is sealed under a key, and the key is made by the
   * person's own wallet from their seed and this company's address on the
   * chain. So there is a button per company, and pressing it opens the wallet:
   * nothing here can produce the key on its own, which is the property being
   * bought rather than a limitation.
   *
   * **THE COMPANY IS NOT NAMED ON THIS SCREEN**, because its name is sealed
   * under the very key that has not been released yet. It is identified by what
   * the record makes public and by nothing else.
   */
  if (!keyring.canOpenCompanies()) {
    return (
      <div className="authwrap">
        <div className="authcard wide">
          <div className="authmark">CA</div>
          <h1>Signed in with your wallet</h1>
          <p className="authsub">
            Your wallet signed one message and this platform knows you by the address it
            came from. Your company's records are sealed, and the key that opens them is
            made by your wallet — not by us, and not from a password.
          </p>

          {accounts.length > 0 && (
            <div className="acctlist">
              {accounts.map(a => (
                <button key={a.id} className="acctrow" disabled={busy}
                  onClick={() => onUnlock(a.id)}>
                  <div>
                    <b>A company you are a signer on</b>
                    <span>{a.signers} signers, {a.threshold} approvals required</span>
                  </div>
                  <span className="chev">{busy ? 'Waiting for your wallet' : 'Unlock'}</span>
                </button>
              ))}
            </div>
          )}

          {accounts.length === 0 && !awaitingSetup && (
            <p className="authsub">
              You are not a signer on any company here yet. Start one below, or ask a
              colleague to invite you — an invitation brings you back to this screen.
            </p>
          )}

          {/*
            * **A COMPANY THAT EXISTS AND IS NOT FINISHED.** PI3.
            *
            * Its records are created and this tab is holding the only copy of
            * the keys that open them, unsealed. Saying so plainly is the whole
            * point: a person who declined the wallet needs to know that the
            * company is real, that nothing is lost, and that closing this tab
            * is the one thing that would lose it.
            */}
          {awaitingSetup && (
            <div className="empty">
              <b>Your company is created and not finished</b>
              Your wallet has not yet given this page the key that seals your keys. Nothing
              is lost — but do not close this tab until it has, because the keys are only
              here.
              <button className="primary" disabled={busy} onClick={onFinishSetup}>
                {busy ? 'Waiting for your wallet' : 'Finish setting up'}
              </button>
            </div>
          )}

          {/*
            * **AND THIS IS `C141` CLOSED.** Until PI3 this screen told a person
            * with a wallet to go and be invited by somebody else, because
            * starting a company needed a password. It no longer does.
            */}
          {!awaitingSetup && (
            <form className="acctnew"
              onSubmit={e => { e.preventDefault(); onCreateWithWallet(name.trim()); }}>
              <input value={name} onChange={e => setName(e.target.value)}
                placeholder="Start your own company" />
              <button className="primary" disabled={busy || name.trim().length < 2}>
                {busy ? 'Waiting for your wallet' : 'Create'}
              </button>
            </form>
          )}

          <p className="authsub">
            Your wallet will show you which company is being opened and the address of the
            site asking. Check both before you approve. The key it gives back stays in this
            tab, is never sent to us, and is forgotten when you close it.
          </p>

          {err && <div className="autherr">{err}</div>}
          {wallet && <p className="authsub"><b>You signed in as</b><br />{wallet}</p>}
          <div className="authswap"><a onClick={onSignOut}>Sign out</a></div>
        </div>
      </div>
    );
  }

  return (
    <div className="authwrap">
      <div className="authcard wide">
        <h1>Your accounts</h1>
        <p className="authsub">Signed in as {user.email}</p>

        {accounts.length > 0 && (
          <div className="acctlist">
            {accounts.map(a => (
              <button key={a.id} className="acctrow" onClick={() => onOpen(a.id)} disabled={busy}>
                <div>
                  <b>{a.name}</b>
                  <span>{a.signers} signers, {a.threshold} approvals required</span>
                </div>
                <span className="chev">Open</span>
              </button>
            ))}
          </div>
        )}

        {accounts.length === 0 && (
          <div className="empty">
            <b>No accounts yet</b>
            Create one, or ask a colleague to invite you to theirs.
          </div>
        )}

        <form className="acctnew" onSubmit={e => { e.preventDefault(); onCreate(name.trim()); }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="New company name" />
          <button className="primary" disabled={busy || name.trim().length < 2}>Create</button>
        </form>

        <div className="authswap">
          <a onClick={onDemo}>Load a demo company</a>
          <span> · </span>
          <a onClick={onSignOut}>Sign out</a>
        </div>
      </div>
    </div>
  );
}
