import { useState } from 'react';
import type { ReactNode } from 'react';
import { hrefOf } from '../routes.js';
import { useSession } from '../session.js';
import { securedSetupOnRecord } from '../accounts/storage.js';
import type { SecuredSetup } from '../accounts/storage.js';
import { PieceMap } from '../components/piece-map.js';
import { ErrorNote, Moon } from '../components/ui.js';

/**
 * Stored state nobody can open — the sealing key is gone, a record is
 * damaged, or the browser is refusing storage. Not retryable, so it is a
 * screen, not a red line: what happened, the map of where the pieces are if
 * one exists, and a door that works.
 *
 * AS AMENDED: what makes start-over dangerous is
 * not that recovery is unbuilt — it is that THIS BROWSER MAY HOLD THE ONLY
 * NOTE OF WHERE THE PIECES ARE. So the gate is the record, not a milestone:
 * no record on file → nothing to destroy → start over is offered; a record
 * on file → withheld until recovery is a working flow, and then only
 * behind the take-a-copy gate `StartOver` already implements. Gating on a
 * global flag instead of the record reproduced the fault — a refusal with no way
 * back — for exactly the person who had nothing to lose.
 */
export function Broken({ message }: { readonly message: string }): ReactNode {
  /* The compartment this window has open. Read during render, so it
   * is synchronous and there is nothing to capture. */
  const { walletId } = useSession();
  const setup = securedSetupOnRecord(walletId);
  return (
    <>
      <div className="hero">
        <Moon large />
        <h1>This wallet can&rsquo;t be opened here any&nbsp;more.</h1>
      </div>
      <ErrorNote message={message} />
      <p className="muted" style={{ marginTop: '1rem' }}>
        The message above says exactly what was found — it is the storage&rsquo;s own
        words, and different causes say different things. What they share: whatever
        is stored here can no longer open a wallet, and no retry changes that. It
        does not touch the account itself — pieces placed elsewhere still work.
      </p>

      {setup && <PieceMap setup={setup} />}

      <section className="card">
        <h2>
          <a href={hrefOf('recover')}>Recover from your pieces</a>
        </h2>
        <p className="muted small" style={{ marginBottom: 0 }}>
          {setup
            ? 'Enough of the pieces above put this account back — on this machine or any other.'
            : 'If you placed recovery pieces from another machine, they put this account '
              + 'back — here or there.'}
        </p>
      </section>

      <section className="card">
        <h2>
          <a href={hrefOf('add-device')}>Bring it over from another device</a>
        </h2>
        <p className="muted small" style={{ marginBottom: 0 }}>
          If another machine still opens this wallet, a scan and a two-digit check put
          it back on this one — the unopenable copy here is replaced, behind its own
          warning.
        </p>
      </section>

      <StartOver setup={setup} />
    </>
  );
}

/**
 * The destructive door, both halves now live: with no piece map there
 * is nothing to destroy but unopenable ciphertext, so the door is open; with
 * a map on file — recovery being a real flow beside it — the door
 * exists BEHIND the take-a-copy gate, because this button deletes the only
 * note of where the pieces are.
 */
function StartOver({ setup }: { readonly setup: SecuredSetup | null }): ReactNode {
  const { startOver } = useSession();
  const [tookTheMap, setTookTheMap] = useState(setup === null);
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="card">
      <h2>Start over</h2>
      <p className="muted small">
        {setup === null
          ? 'Forgets the unopenable account and its passkey record, so this browser '
            + 'can hold a wallet again.'
          : 'Forgets the stored account, its passkey record, and the list of where '
            + 'its pieces are, in this browser.'}
      </p>
      {setup !== null && !tookTheMap && (
        <>
          <p className="warn-text small">
            Copy or download the piece list above first — this browser is the only
            place it is written, and starting over erases it.
          </p>
          <button type="button" onClick={() => setTookTheMap(true)}>
            I have taken a copy of the list
          </button>
        </>
      )}
      {tookTheMap && !confirming && (
        <button type="button" onClick={() => setConfirming(true)}>Start over…</button>
      )}
      {tookTheMap && confirming && (
        <>
          <p className="warn-text small">
            {setup === null
              ? 'This account was never secured from this browser, so there are no '
                + 'pieces here to rebuild it from. Forgetting it is final: anything '
                + 'ever paid to its address is gone for good, unless pieces were '
                + 'placed somewhere else.'
              : 'If your pieces are not placed somewhere safe, the account — and '
                + 'anything ever paid to its address — is gone for good. There is '
                + 'nothing to find later.'}
          </p>
          <button type="button" className="danger" onClick={startOver}>
            I understand — forget this account
          </button>{' '}
          <button type="button" className="quiet" onClick={() => setConfirming(false)}>
            Keep it
          </button>
        </>
      )}
    </section>
  );
}
