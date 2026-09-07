import { useState } from 'react';
import type { ReactNode } from 'react';
import { hrefOf } from '../routes.js';
import { useSession } from '../session.js';
import { securedSetupOnRecord } from '../storage.js';
import { PieceMap } from '../piece-map.js';
import { ErrorNote, Moon, StatusNote, WalletNameField } from '../ui.js';

/**
 * Passkey records with no sealed account behind them — the reverse
 * half-state. The passkey ceremony would succeed and open nothing, so it is
 * not offered; the honest doors are recovery, another device, and starting
 * fresh. If a piece map is on record it is the most valuable thing on this
 * screen, and the take-a-copy gate stands in front of the one button
 * that would erase it.
 */
export function PasskeyNoAccount(): ReactNode {
  /* As `broken.tsx`: the open compartment, off the session, read
   * during render and therefore synchronous. */
  const { walletId } = useSession();
  const setup = securedSetupOnRecord(walletId);
  return (
    <>
      <div className="hero">
        <Moon large />
        <h1>A passkey, but no wallet behind it.</h1>
        <p className="lede">
          This browser remembers a passkey for this site, but the sealed account it
          used to open is gone — that happens when site data is partly cleared.
          Signing in with it would open nothing, so it isn&rsquo;t offered.
        </p>
      </div>

      {setup && <PieceMap setup={setup} />}

      <section className="card">
        <h2>
          <a href={hrefOf('recover')}>Recover the old wallet from its pieces</a>
        </h2>
        <p className="muted small" style={{ marginBottom: 0 }}>
          {setup
            ? 'Enough of the pieces above put the old account back — on this machine or any other.'
            : 'If you secured the old account, enough of its placed pieces put it back — '
              + 'on this machine or any other.'}
        </p>
      </section>

      <section className="card">
        <h2>
          <a href={hrefOf('add-device')}>Bring it over from another device</a>
        </h2>
        <p className="muted small" style={{ marginBottom: 0 }}>
          If another machine still has the wallet, a scan and a two-digit check move
          it onto this one.
        </p>
      </section>

      <StartFresh hasMap={setup !== null} />
    </>
  );
}

/**
 * A new wallet, from nothing. Destructive only of the stale records here —
 * and of the piece map, which is why the map, when present, must be copied
 * away first. The OLD account is untouched by this: if its pieces are
 * placed, they recover it anywhere, today or in ten years.
 */
function StartFresh({ hasMap }: { readonly hasMap: boolean }): ReactNode {
  const { startFresh, busy, error } = useSession();
  const [tookTheMap, setTookTheMap] = useState(!hasMap);
  const [confirming, setConfirming] = useState(false);
  /* Asked in the CONFIRMING step and nowhere earlier: this screen's
   * first press is a decision about destroying stale records, and a name
   * field beside it would be a question about a wallet that may never be
   * made. By the time it appears, the next press is the ceremony. */
  const [walletName, setWalletName] = useState('');
  return (
    <section className="card">
      <h2>Start fresh with a new wallet</h2>
      <p className="muted small">
        Creates a brand-new wallet with a new passkey and a <strong>new address</strong>.
        The stale records here are forgotten; the passkey itself can be removed in your
        device&rsquo;s own settings whenever you like.
      </p>
      {hasMap && !tookTheMap && (
        <>
          <p className="warn-text small">
            Copy or download the piece list above first — this browser is the only
            place it is written, and starting fresh erases it.
          </p>
          <button type="button" onClick={() => setTookTheMap(true)}>
            I have taken a copy of the list
          </button>
        </>
      )}
      {tookTheMap && !confirming && (
        <button type="button" onClick={() => setConfirming(true)} disabled={busy !== null}>
          Start fresh…
        </button>
      )}
      {tookTheMap && confirming && (
        <>
          <p className="warn-text small">
            The new wallet is a different account with a different address — money sent
            to the old address stays with the old account. The old account itself is
            not touched: if its pieces are placed, they still recover it, anywhere.
          </p>
          <WalletNameField
            label="A name for the new wallet (optional)"
            value={walletName}
            onChange={setWalletName}
          />
          <button
            type="button"
            className="danger"
            onClick={() => { void startFresh(walletName); }}
            disabled={busy !== null}
          >
            Create a new wallet
          </button>{' '}
          <button type="button" className="quiet" onClick={() => setConfirming(false)}>
            Keep things as they are
          </button>
          <StatusNote message={busy} />
        </>
      )}
      <ErrorNote message={error} />
    </section>
  );
}
