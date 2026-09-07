import { useState } from 'react';
import type { ReactNode } from 'react';
import { hrefOf } from '../routes.js';
import { useSession } from '../session.js';
import { ErrorNote, Moon, StatusNote, WalletNameField } from '../components/ui.js';

/**
 * Nothing in this browser yet: one button, and the honest fine print.
 *
 * AND ONE OPTIONAL QUESTION IN FRONT OF THE BUTTON. This is a NEW
 * wallet, so there is nothing on record to reuse and the name can only come
 * from the person. It is asked here because the button below runs the passkey
 * ceremony, and a passkey's label is fixed the moment it is made.
 */
export function Welcome(): ReactNode {
  const { createAccount, busy, error } = useSession();
  const [walletName, setWalletName] = useState('');
  return (
    <>
      <div className="hero">
        <Moon large />
        <h1>Your wallet on Midnight.</h1>
        <p className="lede">
          Created with a passkey — one touch, no password, nothing to write down.
          The keys live in this browser and never leave it on their own.
        </p>
        <WalletNameField
          label="A name for this wallet (optional)"
          value={walletName}
          onChange={setWalletName}
        />
        <div className="actions">
          <button
            type="button"
            className="primary big"
            onClick={() => { void createAccount(walletName); }}
            disabled={busy !== null}
          >
            Create your wallet
          </button>
          <StatusNote message={busy} />
          <ErrorNote message={error} />
        </div>
      </div>

      <section className="card">
        <h2>Already have a wallet?</h2>
        <div className="step">
          <div className="dot" aria-hidden="true">→</div>
          <div className="body">
            <h2>
              <a href={hrefOf('add-device')}>Move it onto this machine</a>
            </h2>
            <p className="muted small">
              Scan a code shown by a device that already has it, then compare two digits.
            </p>
          </div>
        </div>
        <div className="step">
          <div className="dot" aria-hidden="true">→</div>
          <div className="body">
            <h2>
              <a href={hrefOf('recover')}>Recover it from pieces</a>
            </h2>
            <p className="muted small">
              Gather enough of the pieces you placed, and the account comes back —
              even on a machine that never had it.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
