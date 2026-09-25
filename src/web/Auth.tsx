import React, { useState } from 'react';
import { LedgerMark } from './ledger-mark.js';
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

export function AuthScreen({ onDone, notice = '' }: {
  onDone: (u: keyring.Me) => void;
  /** Something the screen before this one left true, such as a sign-out the server did not confirm. */
  notice?: string;
}) {
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

        {notice && <div className="autherr" data-notice>{notice}</div>}
        {err && <div className="autherr">{err}</div>}
      </div>
    </div>
  );
}

/** Shown after sign in when the user is on zero or several accounts. */
export function AccountPicker({
  user, accounts, onOpen, onUnlock, onCreateWithWallet, onFinishSetup,
  awaitingSetup, onDemo, onSignOut, employers = [], onOpenEmployer, onAddEmployer, onUnlockEmployers,
  busy, err,
}: {
  user: keyring.Me;
  accounts: any[];
  onOpen: (id: string) => void;
  /** Ask the wallet for the key your saved keys here are sealed under, then open this company. */
  onUnlock: (id: string) => void;
  /**
   * Create a company from a wallet session: open the keys saved for you if this
   * tab has not, create it, and save its keys beside them.
   */
  onCreateWithWallet: (name: string) => void;
  /** Finish one that was created but whose keys were never saved. */
  onFinishSetup: () => void;
  /** The company this tab created and has not finished sealing, if any. */
  awaitingSetup: string | null;
  onDemo: () => void;
  /**
   * The companies that pay this person, by contract address: from their saved
   * keys once those are open here, and from what this browser holds for them.
   */
  employers?: string[];
  /** Opens one of them: that person's own payslips from it, and nothing a signer sees. */
  onOpenEmployer?: (company: string) => void;
  /** Saves one more company that pays this person, with them. */
  onAddEmployer?: (company: string) => void;
  /** Opens the keys saved for this person, which is where the list of companies that pay them is kept. */
  onUnlockEmployers?: () => void;
  onSignOut: () => void;
  busy: boolean;
  err?: string;
}) {
  const [name, setName] = useState('');
  const [adding, setAdding] = useState('');
  const wallet = keyring.signedInWallet();

  /*
   * **THE COMPANIES THAT PAY YOU, BESIDE THE ONES YOU SIGN FOR, EACH MARKED.**
   * A company that pays you and that you also sign for has a row of each kind,
   * one for each thing you are there. Opening one of these shows your payslips
   * from it and nothing else.
   */
  const paidBy = onOpenEmployer && (
    <>
      {employers.length > 0 && (
        <div className="acctlist" data-employers>
          {employers.map(c => (
            <button key={c} className="acctrow" data-employer={c} disabled={busy}
              onClick={() => onOpenEmployer(c)}>
              <div>
                <b>A company that pays you</b>
                <span><code>{c}</code></span>
              </div>
              <span className="chev">Open</span>
            </button>
          ))}
        </div>
      )}
      {!keyring.canOpenCompanies() && onUnlockEmployers && (
        <div className="acctlist">
          <button className="acctrow" data-unlock-employers disabled={busy} onClick={onUnlockEmployers}>
            <div><b>Companies that pay you</b></div>
            <span className="chev">{busy ? 'Waiting for your wallet' : 'Unlock'}</span>
          </button>
        </div>
      )}
      {/* Not a form: the form on this screen is the one that starts a company. */}
      {onAddEmployer && (
        <div className="acctnew" data-add-employer>
          <input value={adding} onChange={e => setAdding(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !busy && adding.trim() !== '') { onAddEmployer(adding.trim()); setAdding(''); } }}
            placeholder="Add a company's address" />
          <button type="button" disabled={busy || adding.trim() === ''}
            onClick={() => { onAddEmployer(adding.trim()); setAdding(''); }}>Add</button>
        </div>
      )}
    </>
  );
  const setupProblem = keyring.companyAwaitingSetupProblem();

  /**
   * **A WALLET SIGN-IN OPENS NOTHING UNTIL THE WALLET IS ASKED FOR A KEY.**
   * `PI1` wrote this screen to say the second half was not built; `PI2a` built
   * it, and this is what that screen says now.
   *
   * The keys that open every company this person belongs to here are saved
   * sealed, under a key their own wallet makes for them on this site. So a row's
   * button opens the wallet, and one press opens them all: nothing here can
   * produce the key on its own, which is the property being bought rather than a
   * limitation.
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
                    <b>A company you are a signer on <LedgerMark of={a} /></b>
                    <span>{a.signers} signers, {a.threshold} approvals required</span>
                  </div>
                  <span className="chev">{busy ? 'Waiting for your wallet' : 'Unlock'}</span>
                </button>
              ))}
            </div>
          )}

          {paidBy}

          {/*
            * **AN ADDRESS THIS DEPLOYMENT HAS NEVER SEEN.** A person here is one
            * wallet address, so an address that is new here has nothing, even when
            * the same wallet has companies under another of its addresses. Said
            * only when the server reported this sign-in as the address's first.
            */}
          {accounts.length === 0 && !awaitingSetup && keyring.signedInForTheFirstTimeHere() && (
            <p className="authsub" data-new-here>
              This wallet address has not signed in here before. Each address is a separate
              person here, so companies started with another address from the same wallet are
              not listed.
            </p>
          )}

          {accounts.length === 0 && employers.length === 0 && !awaitingSetup && (
            <p className="authsub">
              You are not a signer on any company here yet. Start one below, or ask a
              colleague to invite you — an invitation brings you back to this screen.
            </p>
          )}

          {awaitingSetup && (
            <AwaitingSetup busy={busy} onFinishSetup={onFinishSetup} problem={setupProblem} />
          )}

          {/*
            * **A PERSON WITH A WALLET STARTS A COMPANY HERE, HOWEVER MANY THEY
            * ALREADY BELONG TO.** Its keys are saved beside the keys already saved
            * for them, under the same key.
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
            Your wallet will show you the address of the site asking and the wallet address
            you signed in with. Check both before you approve. The key it gives back opens the
            keys saved for you here, stays in this tab, is never sent to us, and is forgotten
            when you close it.
          </p>

          {err && <div className="autherr">{err}</div>}
          {wallet && <p className="authsub"><b>You signed in as</b><br />{wallet}</p>}
          <div className="authswap">
            <a onClick={onSignOut}>Sign out</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="authwrap">
      <div className="authcard wide">
        <h1>Your accounts</h1>
        {/* A wallet sign-in stores no email, so this line shows what there is and
          * is left out when there is nothing, rather than ending in a blank. */}
        {(wallet ?? user.email) && <p className="authsub">Signed in as {wallet ?? user.email}</p>}

        {accounts.length > 0 && (
          <div className="acctlist">
            {accounts.map(a => (
              <button key={a.id} className="acctrow" onClick={() => onOpen(a.id)} disabled={busy}>
                <div>
                  <b>{a.name} <LedgerMark of={a} /></b>
                  <span>{a.signers} signers, {a.threshold} approvals required</span>
                </div>
                <span className="chev">Open</span>
              </button>
            ))}
          </div>
        )}

        {paidBy}

        {accounts.length === 0 && employers.length === 0 && (
          <div className="empty">
            <b>No accounts yet</b>
            Create one, or ask a colleague to invite you to theirs.
          </div>
        )}

        {/* A company started here whose keys the server refused to save. The keys
          * are only here, so the way to finish it stays on screen. */}
        {awaitingSetup && (
          <AwaitingSetup busy={busy} onFinishSetup={onFinishSetup} problem={setupProblem} />
        )}

        {/* Your saved keys are open in this tab, so a new company's keys are saved
          * beside them with no wallet asked. Not while a started company is waiting:
          * its keys are only in this tab. */}
        {!awaitingSetup && (
          <form className="acctnew" onSubmit={e => {
            e.preventDefault();
            onCreateWithWallet(name.trim());
          }}>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="New company name" />
            <button className="primary" disabled={busy || name.trim().length < 2}>
              Create
            </button>
          </form>
        )}

        {/* Both faces of this screen report what failed. Without this line every
          * refusal on this face - opening, creating - left the screen unchanged. */}
        {err && <div className="autherr">{err}</div>}

        <div className="authswap">
          <a onClick={onDemo}>Load a demo company</a>
          <span> · </span>
          <a onClick={onSignOut}>Sign out</a>
        </div>
      </div>
    </div>
  );
}

/*
 * **A COMPANY THAT EXISTS AND IS NOT FINISHED.**
 *
 * Its records are created and this tab is holding the only copy of the keys
 * that open them, unsaved. Saying so plainly is the whole point: the person
 * needs to know that the company is real, that nothing is lost yet, and that
 * closing this tab or signing out is what would lose it.
 *
 * **AND WHEN IT CAN NEVER BE FINISHED, IT SAYS THAT INSTEAD.** Telling a person
 * to keep a tab open for a Finish that always fails is the one thing this block
 * must not do. Finish is shown disabled, with the reason.
 */
function AwaitingSetup({ busy, onFinishSetup, problem }: {
  busy: boolean; onFinishSetup: () => void; problem: { canFinish: boolean; why: string } | null;
}) {
  if (problem && !problem.canFinish) {
    return (
      <div className="empty" data-awaiting-setup data-cannot-finish>
        <b>Your company is created and cannot be finished</b>
        <span data-setup-problem>{problem.why}</span>
        <button className="primary" disabled>Finish setting up</button>
      </div>
    );
  }
  return (
    <div className="empty" data-awaiting-setup>
      <b>Your company is created and not finished</b>
      Its keys are not saved yet: saving them was refused, and trying again straight away
      was refused too. Finishing reads what is saved now and tries again to save this
      company's keys beside it. Nothing is lost yet - but the keys are only in this tab, and they are
      lost if this tab closes or its sign-in ends for any reason: signing out here or on
      another device, another person signing in in this browser, or the sign-in running out.
      <button className="primary" disabled={busy} onClick={onFinishSetup}>
        Finish setting up
      </button>
    </div>
  );
}
