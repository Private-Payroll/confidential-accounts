import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  acceptKeys, answerCommitment, askToPair, beginOffer, checkAndShow, fingerprintOf,
  revealAndShow, sealKeys, toBase64Url,
} from 'midnight-identity';
import type { PairingRequest, PendingOffer, Reveal, Secret } from 'midnight-identity';
import { hrefOf } from '../routes.js';
import { useSession } from '../session.js';
import { loadSecret, readKeyringRecord } from '../accounts/storage.js';
import { openWalletId } from '../accounts/wallets-held.js';
import { QrPanel, ScanInput } from '../components/qr.js';
import { ErrorNote, Moon, StatusNote, WalletNameField } from '../components/ui.js';
import { describeFailure } from '../lib/failure-text.js';

/**
 * ADDING A DEVICE. Two machines, five messages, one human check.
 *
 * The protocol is the library's (`packages/identity/src/devices/pairing.ts`)
 * and these screens only carry its messages and its refusals. What the
 * interface itself is responsible for — §2 — is:
 *
 *   - THE TWO DIGITS ARE NEVER TRANSMITTED. Each device computes its own
 *     number and shows it in a `<div>`; the only place a number crosses is a
 *     person reading one screen and typing on the other. There is no field
 *     anywhere that displays a number from a message.
 *   - "THEY DO NOT MATCH" IS AS PROMINENT AS "THEY MATCH", and it means
 *     STOP. The whole defence is somebody noticing; a design where continue
 *     is the obvious button defeats it.
 *   - NOTHING IS SEALED UNTIL THE PERSON CONFIRMS. `sealKeys` runs only from
 *     the match button's handler, after the comparison — the library already
 *     refuses to seal before a number has been shown, and the screen keeps
 *     the rest of the promise.
 *
 * Neither side's pairing state is ever written anywhere: `PendingOffer`
 * holds an ephemeral secret and `PairingRequest` holds the code's secret
 * key, both alive for about as long as a person takes to read two digits.
 * They live in component state, so navigating away abandons the pairing —
 * which is the safe direction to fail.
 */

/* ================= the OLD device: it has the wallet ================= */

type OfferStep = 'scan' | 'commitment' | 'digits' | 'sealed' | 'stopped';

export function OfferDevice({ secret }: { readonly secret: Secret }): ReactNode {
  const [step, setStep] = useState<OfferStep>('scan');
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<PendingOffer | null>(null);
  const [commitment, setCommitment] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [sealed, setSealed] = useState<string | null>(null);

  const startAgain = (): void => {
    pendingRef.current = null;
    setCommitment(null);
    setReveal(null);
    setSealed(null);
    setError(null);
    setStep('scan');
  };

  if (step === 'stopped') {
    return (
      <>
        <div className="hero">
          <Moon large />
          <h1>Stopped. Nothing was sent.</h1>
          <p className="lede">
            Two screens showing different numbers is what somebody sitting between the
            machines has to cause — or a mistake in reading, which costs nothing to
            rule out. The wallet here is untouched and the other machine has received
            nothing it can open.
          </p>
        </div>
        <p className="muted small">
          Start again from the beginning on both machines. If the numbers differ a
          second time, stop trusting the connection between them — pair the devices
          somewhere else, on a network you trust.
        </p>
        <p>
          <button type="button" onClick={startAgain}>Start again</button>{' '}
          <a href={hrefOf('home')}><button type="button" className="quiet">Back to your wallet</button></a>
        </p>
      </>
    );
  }

  if (step === 'sealed' && sealed !== null) {
    return (
      <>
        <h1>Last step — show this to the new machine.</h1>
        <p className="lede">
          This is the wallet, sealed so that only the machine whose code you scanned
          can open it. When the new machine reads it, the wallet opens there.
        </p>
        <QrPanel
          payload={sealed}
          caption="The sealed wallet — scan it on the new machine"
          testId="offer-sealed"
        />
        <p className="muted small">
          It is safe to leave this showing while you carry it across: it opens only
          on the machine whose code you scanned, and photographing it is worth
          nothing to anybody else.
        </p>
        <p className="muted small">
          Nothing changes on this machine: the wallet stays here, and the new machine
          now has its own sealed copy behind its own passkey. If you ever stop
          trusting that machine, remove it — the device list is a later milestone;
          until then, treat every paired machine as the wallet.
        </p>
        <p><a href={hrefOf('home')}>← Back to your wallet</a></p>
      </>
    );
  }

  if (step === 'digits' && reveal !== null) {
    return (
      <>
        <h1>Compare the two numbers.</h1>
        <p className="lede">
          This machine says the number below. The new machine shows its own — computed
          there, never sent. Look at both screens yourself.
        </p>
        <div className="digits-big" data-testid="offer-digits" aria-label="This machine's number">
          {reveal.digits}
        </div>
        <QrPanel
          payload={reveal.ephemeralPublic}
          caption="First, show this to the new machine — it needs it to compute its own number"
          testId="offer-reveal"
        />
        <div className="match-actions">
          <button
            type="button"
            className="danger big"
            onClick={() => { pendingRef.current = null; setStep('stopped'); }}
          >
            They do NOT match — stop
          </button>
          <button
            type="button"
            className="primary big"
            onClick={() => {
              const pending = pendingRef.current;
              if (!pending) return;
              try {
                /* Only here, after the person has compared — never before. */
                setSealed(sealKeys(pending, secret, Date.now()).sealed);
                setStep('sealed');
              } catch (e) {
                setError(describeFailure(e));
              }
            }}
          >
            They match — send the wallet
          </button>
        </div>
        <p className="muted small" style={{ marginTop: '0.75rem' }}>
          Different numbers mean the machines are not talking to each other — stop is
          the safe answer and costs one restart.
        </p>
        <ErrorNote message={error} />
      </>
    );
  }

  if (step === 'commitment' && commitment !== null) {
    return (
      <>
        <h1>Now show this back, then read its answer.</h1>
        <p className="lede">
          This code commits this machine to its half of the pairing before the number
          exists — which is what makes the number worth comparing at all.
        </p>
        <QrPanel
          payload={commitment}
          caption="Scan this on the new machine"
          testId="offer-commitment"
        />
        <section className="card">
          <h2>Then the new machine answers with a code of its own</h2>
          <ScanInput
            label="The new machine's answer"
            actionLabel="Use this answer"
            onPayload={(nonce) => {
              const pending = pendingRef.current;
              if (!pending) return;
              setError(null);
              try {
                setReveal(revealAndShow(pending, nonce, Date.now()));
                setStep('digits');
              } catch (e) {
                setError(describeFailure(e));
              }
            }}
          />
        </section>
        <ErrorNote message={error} />
        <p><a href={hrefOf('home')}>← Back (abandons this pairing)</a></p>
      </>
    );
  }

  return (
    <>
      <h1>Add another device.</h1>
      <p className="lede">
        Puts this wallet on a second machine. On the new machine, open{' '}
        <em>&ldquo;Move it onto this machine&rdquo;</em> — it shows a code. Read that
        code here.
      </p>
      <p className="muted small">
        Codes last a few minutes on purpose. You will compare a two-digit number
        across both screens before anything moves, and nothing is sent until you say
        the numbers match.
      </p>
      <section className="card">
        <h2>The new machine&rsquo;s code</h2>
        <ScanInput
          label="The code the new machine shows"
          actionLabel="Use this code"
          onPayload={(code) => {
            setError(null);
            try {
              const begun = beginOffer(code, Date.now());
              pendingRef.current = begun.pending;
              setCommitment(begun.message.commitment);
              setStep('commitment');
            } catch (e) {
              setError(describeFailure(e));
            }
          }}
        />
      </section>
      <ErrorNote message={error} />
      <p><a href={hrefOf('home')}>← Back to your wallet</a></p>
    </>
  );
}

/* ================= the NEW device: it wants the wallet ================= */

type ReceiveStep = 'intro' | 'code' | 'nonce' | 'digits' | 'stopped';

export function ReceiveDevice(): ReactNode {
  const {
    finishPairing, paired, phase, busy, error: sessionError, wallets,
  } = useSession();
  const [step, setStep] = useState<ReceiveStep>('intro');
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<PairingRequest | null>(null);
  const [nonce, setNonce] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [myDigits, setMyDigits] = useState<string | null>(null);
  const [typedDigits, setTypedDigits] = useState('');
  /* This machine's number is NOT shown until the other machine's has
   * been typed — asking for a number that is printed above the box is a
   * question that answers itself. */
  const [digitsRevealed, setDigitsRevealed] = useState(false);
  const [sealedText, setSealedText] = useState<string | null>(null);
  /* Pairing, unlike recovery, holds BOTH secrets before anything is
   * written — so the landing gate can know whether the incoming wallet IS
   * the stored one, and must not read a gone-for-good warning over an act
   * that destroys nothing. Null means "could not tell": wrong digits, an
   * unopenable stored copy, or inputs not yet complete — all of which keep
   * the cautious wording. */
  const [sameAccount, setSameAccount] = useState<boolean | null>(null);
  /* A WALLET ARRIVING, LIKE A RECOVERY, AND ASKED FOR AT THE LAST
   * MOMENT RATHER THAN THE FIRST. The name does not travel with the pairing:
   * it is a label the RECEIVING browser keeps, so this machine is the one
   * that says what the wallet is called here. It is deliberately NOT on the
   * digit-comparison step — that screen is one question, and a text box
   * beside it is something to do instead of comparing. It appears once the
   * sealed wallet is in hand, immediately above the press that makes the
   * passkey and fixes its label for good. */
  const [walletName, setWalletName] = useState('');

  useEffect(() => {
    /* CAPTURED AT THE TOP OF THE EFFECT, and this one is not
     * ceremony: the `loadSecret` below is inside an async body, so a
     * compartment read there would be whichever wallet another window has
     * turned to by the time the sealed copy opens. The comparison this effect
     * makes — is the incoming wallet the one already here? — would then
     * be against a different wallet than the screen is describing. */
    const walletId = openWalletId();
    if (request === null || revealedKey === null || sealedText === null
      || typedDigits.trim().length < 2
      || readKeyringRecord(walletId).state === 'absent') {
      setSameAccount(null);
      return undefined;
    }
    let stale = false;
    (async () => {
      try {
        const probe = acceptKeys(
          request, revealedKey, { sealed: sealedText }, typedDigits, Date.now());
        const held = await loadSecret(walletId);
        const same = held !== null
          && toBase64Url(fingerprintOf(probe.secret)) === toBase64Url(fingerprintOf(held));
        if (!stale) setSameAccount(same);
      } catch {
        if (!stale) setSameAccount(null);
      }
    })();
    return () => { stale = true; };
  }, [request, revealedKey, sealedText, typedDigits]);

  const startAgain = (): void => {
    setRequest(null);
    setNonce(null);
    setRevealedKey(null);
    setMyDigits(null);
    setTypedDigits('');
    setDigitsRevealed(false);
    setSealedText(null);
    setSameAccount(null);
    setWalletName('');
    setError(null);
    setStep('intro');
  };

  /* The landing, once a pairing in THIS session has sealed the account here.
   * Two facts, stated separately — the same rule as recovery. */
  if (paired) {
    const opened = phase.name === 'unlocked';
    return (
      <div className="hero">
        <Moon large />
        <h1>
          {opened && <><span className="ok" aria-hidden="true">✓</span>{' '}</>}
          The wallet is on this machine{opened ? '.' : ' — one step left.'}
        </h1>
        <p className="lede">
          Sealed here from the pairing you just confirmed. The other machine keeps its
          own copy; nothing changed there.
        </p>
        {opened ? (
          <p className="muted">A new passkey opens it here.</p>
        ) : (
          <>
            <p className="warn-text small">
              The passkey for this machine was <strong>not</strong> made — that step
              did not finish:
            </p>
            <ErrorNote message={sessionError} />
            <p className="muted small">
              The wallet itself is safely sealed here. The wallet screen offers
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

  if (step === 'stopped') {
    return (
      <>
        <div className="hero">
          <Moon large />
          <h1>Stopped. Nothing was opened.</h1>
          <p className="lede">
            Two screens showing different numbers is what somebody sitting between the
            machines has to cause. This machine accepted nothing, and the other
            machine&rsquo;s wallet is untouched.
          </p>
        </div>
        <p className="muted small">
          Start again from the beginning on both machines. If the numbers differ a
          second time, pair the devices somewhere else, on a network you trust.
        </p>
        <p>
          <button type="button" onClick={startAgain}>Start again</button>
        </p>
      </>
    );
  }

  if (step === 'digits' && request !== null && revealedKey !== null && myDigits !== null) {
    /* The landing model, applied to the other flow that lands keys on a machine:
     * what would this landing land ON?
     *
     * **IT LANDS BESIDE, SO THERE ARE TWO CASES LEFT INSTEAD OF FOUR.**
     * The two that named a destruction (`wallet-with-map`, `wallet-no-map`)
     * described one browser holding one wallet, which stopped being true this
     * change: `storage.ts`'s `slotForLanding` gives the incoming wallet a
     * compartment of its own. What survives is `same-wallet` — its
     * fingerprint comparison, which is now the difference between re-sealing
     * a wallet and gaining one — and the plain statement of what is here.
     * The recovery landing says the same thing about the same act; two
     * screens describing one landing must not describe it differently. */
    const landing: 'clean' | 'same-wallet' | 'beside' =
      wallets.length === 0 ? 'clean' : sameAccount === true ? 'same-wallet' : 'beside';
    /* Named rather than warned about. `walletNameOnRecord`, per compartment,
     * for the reason `storage.ts` gives: the secret that would check it is
     * the one sealed here. */
    const already = wallets.map((wallet, i) => wallet.name ?? `an unnamed wallet (${i + 1})`);
    const ready = sealedText !== null && typedDigits.trim().length > 0;

    const open = async (): Promise<void> => {
      setError(null);
      try {
        const accepted = acceptKeys(
          request, revealedKey, { sealed: sealedText ?? '' }, typedDigits, Date.now());
        /* The one-use request is spent ONLY once the secret is safely
         * down. A landing that could not store keeps the request live, says
         * the storage's own sentence on this screen, and the same press can
         * be tried again — never "already handed over the keys once" over a
         * wallet that never arrived. */
        const landed = await finishPairing(accepted.secret, walletName);
        if (landed) setRequest(accepted.request);
      } catch (e) {
        setError(describeFailure(e));
      }
    };

    if (!digitsRevealed) {
      /* The other machine's number first. This machine's number is
       * deliberately not on screen — a confirmation whose answer is printed
       * above the box confirms nothing. */
      return (
        <>
          <h1>Type the other machine&rsquo;s number.</h1>
          <p className="lede">
            The other machine now shows a two-digit number. Type it here — from
            <em> its</em> screen. This machine reveals its own number only after you
            type, so the comparison means something.
          </p>
          <div className="match-confirm" style={{ maxWidth: '20rem' }}>
            <label className="small" htmlFor="typed-digits">
              The number the <strong>other</strong> machine shows:
            </label>
            <input
              id="typed-digits"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              maxLength={2}
              aria-label="The number the other machine shows"
              value={typedDigits}
              onChange={(event) => setTypedDigits(event.target.value)}
            />
          </div>
          <div className="actions" style={{ marginTop: '1rem' }}>
            <button
              type="button"
              className="primary big"
              disabled={typedDigits.trim().length < 2}
              onClick={() => setDigitsRevealed(true)}
            >
              I typed it — show this machine&rsquo;s number
            </button>
          </div>
          <ErrorNote message={error} />
          <p style={{ marginTop: '1.25rem' }}>
            <button type="button" className="quiet" onClick={startAgain}>
              Start again
            </button>
          </p>
        </>
      );
    }

    return (
      <>
        <h1>Do they match?</h1>
        <p className="lede">
          This machine computed the number below — never sent, never received. You
          typed <strong>{typedDigits.trim()}</strong> from the other screen.
        </p>
        <div className="digits-big" data-testid="receive-digits" aria-label="This machine's number">
          {myDigits}
        </div>
        <div className="match-actions">
          <button
            type="button"
            className="danger big"
            onClick={() => { setRequest(null); setStep('stopped'); }}
          >
            They do NOT match — stop
          </button>
          <button
            type="button"
            className="quiet big"
            onClick={() => { setTypedDigits(''); setDigitsRevealed(false); }}
          >
            I mistyped — enter it again
          </button>
        </div>

        <section className="card">
          <h2>Then the other machine sends the wallet</h2>
          <p className="muted small">
            After you confirm the numbers match there, it shows one last code — the
            sealed wallet. Read it here.
          </p>
          {sealedText === null ? (
            <ScanInput
              label="The sealed wallet from the other machine"
              actionLabel="Use it"
              onPayload={(text) => setSealedText(text)}
            />
          ) : (
            <p className="muted small" style={{ marginBottom: 0 }}>
              The sealed wallet is in.{' '}
              <button type="button" className="quiet inline" onClick={() => setSealedText(null)}>
                Read it again
              </button>
            </p>
          )}
        </section>

        {/* NOT ASKED WHEN THIS BROWSER ALREADY HOLDS THIS SAME WALLET: it
          * already has whatever name it was given here, that name is kept by
          * the landing, and asking again is how one wallet ends up with two
          * passkeys claiming different names for it. */}
        {sealedText !== null && sameAccount !== true && (
          <WalletNameField
            label="A name for this wallet on this machine (optional)"
            value={walletName}
            onChange={setWalletName}
            hint={(
              <>
                Optional, and local: the name is not part of what the other machine
                sent, so this machine is the one that says what the wallet is called
                here. It goes on the passkey this machine is about to make, and a
                passkey&rsquo;s label can never be changed afterwards.
              </>
            )}
          />
        )}

        {landing === 'clean' && (
          <div className="actions">
            <button
              type="button"
              className="primary big"
              disabled={!ready || busy !== null}
              onClick={() => { void open(); }}
            >
              Open the wallet on this machine
            </button>
            <p className="faint small" style={{ marginTop: '0.5rem' }}>
              Nothing is stored in this browser, so nothing is replaced. A new passkey
              is made for this machine as part of finishing.
            </p>
          </div>
        )}
        {landing === 'same-wallet' && (
          <div className="actions">
            <p className="muted small">
              <strong>This is the wallet already stored here.</strong> The incoming
              copy and the stored copy are the same account — finishing only
              re-seals it, with a fresh passkey for this machine. Nothing is
              replaced and nothing is lost.
            </p>
            <button
              type="button"
              className="primary big"
              disabled={!ready || busy !== null}
              onClick={() => { void open(); }}
            >
              Re-seal the wallet on this machine
            </button>
          </div>
        )}
        {landing === 'beside' && (
          <div className="actions">
            {/* SAID BEFORE THE CEREMONY, AND IT IS NOW GOOD NEWS. Two
              * warning paragraphs and a confirm stood here, in front of a
              * destruction that can no longer happen. */}
            <p className="small">
              <strong>
                This browser already holds {already.length === 1
                  ? 'one wallet' : `${already.length} wallets`}: {already.join(', ')}.
              </strong>{' '}
              The incoming wallet is added <em>beside</em> {already.length === 1
                ? 'it' : 'them'}. Nothing stored here is replaced and nothing here is
              lost — this browser holds several wallets and opens one at a time, and
              after this the incoming one is the one that is open.
            </p>
            <button
              type="button"
              className="primary big"
              disabled={!ready || busy !== null}
              onClick={() => { void open(); }}
            >
              Open the wallet on this machine
            </button>
            <p className="faint small" style={{ marginTop: '0.5rem' }}>
              A new passkey is made for this machine as part of finishing.
            </p>
          </div>
        )}

        <StatusNote message={busy} />
        <ErrorNote message={error ?? sessionError} />
      </>
    );
  }

  if (step === 'nonce' && request !== null && nonce !== null) {
    return (
      <>
        <h1>Show this answer to the other machine.</h1>
        <p className="lede">
          This is a fresh random answer to what the other machine committed to. It is
          what makes the number on both screens impossible to arrange in advance.
        </p>
        <QrPanel
          payload={nonce}
          caption="Scan this on the other machine"
          testId="receive-nonce"
        />
        <section className="card">
          <h2>The other machine then reveals its key</h2>
          <ScanInput
            label="What the other machine reveals"
            actionLabel="Check it"
            onPayload={(revealed) => {
              setError(null);
              try {
                setMyDigits(checkAndShow(request, revealed, Date.now()));
                setRevealedKey(revealed);
                setStep('digits');
              } catch (e) {
                setError(describeFailure(e));
              }
            }}
          />
        </section>
        <ErrorNote message={error} />
      </>
    );
  }

  if (step === 'code' && request !== null) {
    return (
      <>
        <h1>Scan this on the device that has the wallet.</h1>
        <p className="lede">
          On that device, open <em>&ldquo;Add another device&rdquo;</em> and read this
          code there. The code lasts a few minutes, then this screen needs a fresh one.
        </p>
        <QrPanel
          payload={request.code}
          caption="This machine's pairing code"
          testId="receive-code"
        />
        <section className="card">
          <h2>The other machine answers with a code of its own</h2>
          <ScanInput
            label="The other machine's commitment"
            actionLabel="Use it"
            onPayload={(commitment) => {
              setError(null);
              try {
                const answered = answerCommitment(request, { commitment }, Date.now());
                setRequest(answered.request);
                setNonce(answered.nonce);
                setStep('nonce');
              } catch (e) {
                setError(describeFailure(e));
              }
            }}
          />
        </section>
        <ErrorNote message={error} />
        <p>
          <button type="button" className="quiet" onClick={startAgain}>
            Start again with a fresh code
          </button>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Move a wallet onto this machine.</h1>
      <p className="lede">
        A device that already has the wallet approves this machine: you scan a code,
        compare a two-digit number on both screens, and only then does the wallet
        cross — sealed so that only this machine can open it.
      </p>
      <p className="muted small">
        The number is computed by each machine and never sent. If the two screens
        ever disagree, stop — that is the whole point of the check.
      </p>
      <div className="actions">
        <button
          type="button"
          className="primary big"
          onClick={() => {
            setError(null);
            setRequest(askToPair(Date.now()));
            setStep('code');
          }}
        >
          Show a code to scan
        </button>
      </div>
      <section className="card">
        <h2>
          <a href={hrefOf('recover')}>No other device? Recover from your pieces</a>
        </h2>
        <p className="muted small" style={{ marginBottom: 0 }}>
          If the other machine is lost or broken, enough of your placed pieces put the
          account back here without it.
        </p>
      </section>
    </>
  );
}
