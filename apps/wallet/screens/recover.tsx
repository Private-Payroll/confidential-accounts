import { useState } from 'react';
import type { ReactNode } from 'react';
import { progress } from 'midnight-identity';
import { hrefOf } from '../routes.js';
import { useSession } from '../session.js';
import { ErrorNote, Moon, StatusNote, WalletNameField } from '../ui.js';

/**
 * RECOVERY — a resumable session with states, never a function call (§7.11).
 * The session lives in the provider, so leaving this screen and coming back
 * loses nothing; a RELOAD loses the gathered pieces on purpose, because a
 * gathering session holds threshold-many pieces — the whole secret — and
 * writing that anywhere unsealed is forbidden (`SECURITY.md`). The
 * screen says so rather than letting a person find out — and says the other
 * half too (§7.15): the session cannot travel, so if the last piece is on
 * another machine, the CARDS go there.
 *
 * The threshold comes off the pieces themselves and they are held to agreeing
 * a piece the library cannot read is refused at the door in
 * its own words; a piece from a different set is refused at the rebuild;
 * cancelling drops the gathered pieces. Every error is shown verbatim.
 *
 * AND FINISHING IS A LANDING, ANSWERED RATHER THAN WARNED ABOUT.
 *
 * **THE MOST DANGEROUS SENTENCE ON THIS SCREEN IS RETIRED.** Until this change
 * finishing a recovery could destroy something that was working: one browser
 * held one wallet, so the recovered account took the stored one's place, and
 * this screen carried two warning paragraphs and an explicit confirm — three
 * variants of it, because a wallet with no piece map was a different loss from
 * a wallet with one.
 *
 * **A recovery now lands in a compartment of its own** (`storage.ts`,
 * `slotForLanding`), so there is nothing here to replace and nothing for a
 * confirm to stand in front of. The design asks that
 * the screen *"make that plain before the passkey ceremony, not after"*, and
 * that is what the paragraph below now does: it names what this browser
 * already holds and says, in the same breath, that none of it is going
 * anywhere.
 *
 * THE ONE CASE THAT IS STILL WORTH A SENTENCE is the pieces belonging to a
 * wallet this browser ALREADY holds. That re-seals it in place rather than
 * adding a second copy of it, and it replaces that wallet's passkey —
 * both true, neither destructive, and a person who is not told will read the
 * unchanged wallet count as a failure.
 */
export function Recover(): ReactNode {
  const {
    recovery, offerRecoveryPiece, withdrawRecoveryPiece, finishRecovery, abandonRecovery,
    resetRecovery, busy, error, phase, wallets,
  } = useSession();
  const [text, setText] = useState('');
  const [holder, setHolder] = useState('');
  const [replacedNote, setReplacedNote] = useState<string | null>(null);
  /* A WALLET COMING BACK, WHICH IS NOT THE SAME QUESTION AS A NEW ONE.
   * The person may or may not remember what they called it, and this browser
   * usually has never heard of it; so the field is offered empty, and leaving
   * it empty KEEPS whatever this browser already holds for this very secret
   * (fingerprint-checked in `session.tsx`) rather than erasing it. */
  const [walletName, setWalletName] = useState('');

  const state = recovery === null ? null : progress(recovery);

  if (state && state.state === 'completed') {
    /* The rebuild and the gate are two different facts, and this
     * screen says each as its own. The rebuild is done — that is what
     * `completed` means. Whether THIS MACHINE can open the account is the
     * ceremony's outcome, read off the phase, never assumed from the
     * rebuild. */
    const opened = phase.name === 'unlocked';
    return (
      <div className="hero">
        <Moon large />
        <h1>
          {opened && <><span className="ok" aria-hidden="true">✓</span>{' '}</>}
          The account is back{opened ? '.' : ' — one step left.'}
        </h1>
        <p className="lede">
          Rebuilt from {recovery?.usedCount} pieces and sealed on this machine. The
          pieces themselves stay wherever they are — this changed nothing about them.
        </p>
        {opened ? (
          <p className="muted">A new passkey opens it here.</p>
        ) : (
          <>
            <p className="warn-text small">
              The passkey for this machine was <strong>not</strong> made — that step
              did not finish:
            </p>
            <ErrorNote message={error} />
            <p className="muted small">
              The account itself is safely sealed here. The wallet screen offers
              &ldquo;Make a new passkey for this wallet&rdquo; — that finishes the job.
            </p>
          </>
        )}
        <p>
          <a href={hrefOf('home')}>
            <button type="button" className="primary">Go to your wallet</button>
          </a>
        </p>
      </div>
    );
  }

  if (state && state.state === 'cancelled') {
    return (
      <>
        <h1>This recovery was stopped.</h1>
        <p className="lede">
          {recovery?.cancelledBecause ?? 'Cancelled.'} The pieces it had gathered were
          dropped — a cancelled recovery keeps nothing (that is the rule, not an
          accident). The pieces themselves are untouched, wherever they live.
        </p>
        <button type="button" onClick={resetRecovery}>Start a new recovery</button>
        <p style={{ marginTop: '1.25rem' }}><a href={hrefOf('home')}>← Back</a></p>
      </>
    );
  }

  const add = (): void => {
    const result = offerRecoveryPiece(text, holder);
    if (!result.ok) return;
    setText('');
    setHolder('');
    /* A replacement is said out loud — the count not moving would
     * otherwise be the only clue that a piece was swapped rather than added. */
    setReplacedNote(result.replaced === null
      ? null
      : `That replaced the piece already entered from “${result.replaced}” — `
        + 'two pieces from one place count once.');
  };

  /* WHAT THIS BROWSER ALREADY HOLDS, to be named rather than warned
   * about. The list comes from the session, which reads the records; the name
   * of each is `walletNameOnRecord` scoped to its compartment, which is the
   * unchecked reader `storage.ts` documents for exactly this — talking ABOUT
   * a wallet whose secret is sealed. A wallet with no name falls back to a
   * phrase, never to silence. */
  const already = wallets.map((wallet, i) => wallet.name ?? `an unnamed wallet (${i + 1})`);

  return (
    <>
      <h1>Recover an account.</h1>
      <p className="lede">
        Enter your pieces from their cards, one at a time. How many are needed is
        written on the pieces themselves — there is nothing to remember — and pieces
        from a different set are refused rather than quietly rebuilding the wrong
        account.
      </p>
      <p className="faint small">
        Gathered pieces live only on this screen until recovery finishes: a reload
        drops them and you start again. That is deliberate — several pieces together
        are the whole account, and this wallet refuses to store that. If the last
        piece you need is on another machine, take your cards <em>there</em> and
        gather them on it — this half-finished recovery cannot travel.
      </p>

      <section className="card">
        <h2>Add a piece</h2>
        <textarea
          rows={3}
          autoComplete="off"
          spellCheck={false}
          aria-label="The piece's letters, from its card"
          placeholder="the piece's letters, exactly as its card shows them — spaces don't matter"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <input
          type="text"
          aria-label="Where this piece came from"
          placeholder="where it came from — e.g. “my Google Drive”, “the safe”"
          value={holder}
          onChange={(event) => setHolder(event.target.value)}
          style={{ marginTop: '0.5rem', width: '100%' }}
        />
        <div style={{ marginTop: '0.75rem' }}>
          <button
            type="button"
            className="primary"
            disabled={text.trim() === '' || busy !== null}
            onClick={add}
          >
            Add this piece
          </button>
        </div>
        {replacedNote !== null && (
          <p className="muted small" style={{ marginTop: '0.6rem', marginBottom: 0 }}>
            {replacedNote}
          </p>
        )}
      </section>

      {state && recovery && (
        <section className="card" aria-label="Recovery progress">
          <h2>
            {state.state === 'ready'
              ? `Enough pieces — ${state.have} of the ${state.need} needed are in.`
              : `${state.have} of ${state.need} pieces.`}
          </h2>
          <div>
            {recovery.gathered.map((piece) => (
              <div className="piece-row" key={piece.holder}>
                <span className="who">{piece.holder}</span>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => { setReplacedNote(null); withdrawRecoveryPiece(piece.holder); }}
                >
                  Take it back out
                </button>
              </div>
            ))}
          </div>
          {state.state === 'ready' && (
            <div style={{ marginTop: '0.75rem' }}>
              {/* Above every finish button, because all of them run the
                * ceremony that fixes the new passkey's label for good. */}
              <WalletNameField
                label="What you call this wallet (optional)"
                value={walletName}
                onChange={setWalletName}
                hint={(
                  <>
                    Optional. Names are not part of the pieces, so a recovered wallet
                    arrives without one; what you type here goes on the passkey this
                    machine is about to make, and a passkey&rsquo;s label can never be
                    changed afterwards. Left empty, a name this browser already holds
                    for this same wallet is kept.
                  </>
                )}
              />
              <button
                type="button"
                className="primary big"
                disabled={busy !== null}
                onClick={() => { void finishRecovery(walletName); }}
              >
                Put the account back on this machine
              </button>
              {already.length === 0 ? (
                <p className="faint small" style={{ marginTop: '0.5rem' }}>
                  Nothing is stored in this browser, so nothing is replaced. A new
                  passkey is made for this machine as part of finishing.
                </p>
              ) : (
                <>
                  {/* SAID BEFORE THE CEREMONY, AND IT IS NOW GOOD NEWS.
                    * The two warning paragraphs and the confirm that stood
                    * here refused a destruction that can no longer happen. */}
                  <p className="small" style={{ marginTop: '0.5rem' }}>
                    <strong>
                      This browser already holds {already.length === 1
                        ? 'one wallet' : `${already.length} wallets`}: {already.join(', ')}.
                    </strong>{' '}
                    The recovered account is added <em>beside</em> {already.length === 1
                      ? 'it' : 'them'}. Nothing stored here is replaced and nothing here
                    is lost — this browser holds several wallets and opens one at a time,
                    and after finishing the recovered one is the one that is open.
                  </p>
                  <p className="faint small">
                    If these pieces belong to a wallet this browser already holds,
                    finishing re-seals that same wallet rather than adding a second copy
                    of it — and the passkey made here replaces the one it had. A new
                    passkey is made for this machine either way.
                  </p>
                </>
              )}
            </div>
          )}
          <p style={{ marginTop: '0.9rem', marginBottom: 0 }}>
            <button type="button" className="quiet" onClick={abandonRecovery}>
              Stop this recovery (drops the gathered pieces)
            </button>
          </p>
        </section>
      )}

      <StatusNote message={busy} />
      <ErrorNote message={error} />
      <p style={{ marginTop: '1.5rem' }}>
        <a href={hrefOf('home')}>← Back</a>
      </p>
    </>
  );
}
