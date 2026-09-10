/**
 * The strip that says an approval is being proved, and the panel behind it.
 *
 * ── A BAR AND A PANEL, NEVER A MODAL, AND THE REASON IS THE WHOLE POINT ──
 *
 * Proving takes 140 seconds, measured, and it used to take the page with it:
 * across one such proof the page answered 0 times out of an expected 2,807.
 * Moving the work to another thread buys exactly one thing - **the person keeps
 * their application while their own approval is being proved.** A modal would
 * hand that straight back: it blocks the thing that was just unblocked, and it
 * would do it for over two minutes.
 *
 * So this is a strip along the top that never takes the page, and a panel
 * beside it that can be opened and closed while the work carries on either way.
 *
 * ── WHAT MAY BE DRAWN AS A FRACTION, AND WHAT MAY NEVER BE ───────────────
 *
 * **The fetch has a real one.** Every artefact arrives with a length, so bytes
 * received over bytes expected is a ratio about a real thing, and about 30 MB
 * of it arrives the first time a device ever proves anything.
 *
 * **The proof has none.** The prover emits nothing while it runs and there is
 * nowhere to put a callback - the package's whole surface is `prove`, `check`,
 * `provingProvider`, `jsonIrToBinary` and a class that reads a size. So the
 * proving stage shows elapsed time and what is happening, and nothing here
 * converts that into a percentage. **A bar that crawls to ninety and sits there
 * is a lie told to somebody waiting on their own money.**
 *
 * ── AND IT SAYS *RESTARTABLE*, NOT *RESUMED* ─────────────────────────────
 *
 * A proof is one opaque call with no checkpoint. A tab closed at 130 seconds
 * has saved nothing, and a reopened page starts that proof again from nothing.
 * That costs time and only time, because proving reaches no chain and spends no
 * fee - so the panel says the approval is safe and will start again, and never
 * implies that anything was picked up where it left off.
 */
import React, { useState } from 'react';
import { elapsed, megabytes, type ProofStage, type ProofStatus, type ProofStatusList } from './proving-session.js';

/** One line of plain language per stage. Nothing here is a number pretending. */
export const describeStage = (stage: ProofStage): string => {
  switch (stage.name) {
    case 'waiting':
      return 'waiting to start';
    case 'fetching':
      return stage.total === null
        ? `${stage.what} - ${megabytes(stage.received)} so far`
        : `${stage.what} - ${megabytes(stage.received)} of ${megabytes(stage.total)}`;
    case 'proving':
      /*
       * The elapsed time and nothing else. The measured wait is 140 seconds
       * warm and 176.9 seconds the first time on a device, and a person who can
       * see the seconds moving can tell a slow thing from a stuck one - which
       * is the actual question they are asking, and the one a frozen percentage
       * answers wrongly.
       */
      return `proving on this device - ${elapsed(stage.elapsedMs)}`;
    case 'submitting':
      return 'sending it';
    case 'done':
      return 'done';
    case 'stopped':
      return stage.reason;
  }
};

/** Only one stage has a fraction. Everything else answers null, deliberately. */
export const fractionOf = (stage: ProofStage): number | null => {
  if (stage.name !== 'fetching' || stage.total === null || stage.total <= 0) return null;
  return Math.min(1, stage.received / stage.total);
};

const isFinished = (s: ProofStatus) => s.stage.name === 'done' || s.stage.name === 'stopped';

/**
 * The strip.
 *
 * Absent when there is nothing in flight: a permanent bar saying *nothing is
 * happening* is a line of furniture that teaches people not to look at it, and
 * this one has to be worth looking at on the day it is not empty.
 */
export function ProofStatusStrip({ proofs, onCancel }: {
  proofs: ProofStatusList;
  /** Withdraws one. Absent while nothing can be withdrawn. */
  onCancel?: (jobId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const live = proofs.filter((p) => !isFinished(p));
  if (proofs.length === 0) return null;

  const lead = live[0] ?? proofs[proofs.length - 1];
  const fraction = fractionOf(lead.stage);

  return (
    <>
      <div className="proofbar" role="status" aria-live="polite">
        <span className={`proofdot ${lead.stage.name}`} aria-hidden="true" />
        <span className="proofwhat">
          {live.length > 1 ? `${live.length} approvals - ` : ''}{describeStage(lead.stage)}
        </span>

        {/*
          * THE BAR IS DRAWN ONLY WHERE THERE IS SOMETHING TO DRAW. Not a track
          * with nothing in it, and not an indeterminate shimmer standing in for
          * a measurement: an empty rail beside "proving - 1m 14s" reads as a
          * bar that is stuck, which is the exact misreading this whole design
          * exists to prevent.
          */}
        {fraction !== null && (
          <span className="proofrail" aria-hidden="true">
            <span className="prooffill" style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
          </span>
        )}

        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => setOpen((o) => !o)}
          aria-expanded={open} aria-controls="proofpanel">
          {open ? 'Hide' : 'Details'}
        </button>
      </div>

      {open && <ProofPanel proofs={proofs} onClose={() => setOpen(false)} onCancel={onCancel} />}
    </>
  );
}

/**
 * The panel.
 *
 * **NOT A DIALOG AND NOT FOCUS-TRAPPED**, because the application behind it is
 * meant to stay usable - that is the property the whole round bought, and a
 * panel that stole the keyboard would give it back for over two minutes.
 */
export function ProofPanel({ proofs, onClose, onCancel }: {
  proofs: ProofStatusList;
  onClose: () => void;
  onCancel?: (jobId: string) => void;
}) {
  return (
    <aside className="proofpanel" id="proofpanel" aria-label="Approvals in progress">
      <div className="hd">
        <h3>Approvals in progress</h3>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={onClose}>Close</button>
      </div>

      <div className="bd">
        {proofs.map((p) => <ProofRow key={p.jobId} proof={p} onCancel={onCancel} />)}

        {/*
          * **THE SENTENCE THAT STOPS SOMEBODY WAITING WITH THEIR LAPTOP OPEN
          * FOR NO REASON, AND IT IS ALSO THE ONE THAT MUST NOT OVERPROMISE.**
          *
          * The approval is durable: it is written to this device's storage
          * before any work starts, so closing the tab does not lose it. The
          * PROOF is not durable and cannot be - it is a single opaque
          * computation with nothing to checkpoint - so a reopened page starts
          * it again from nothing.
          *
          * Every word here is chosen to say *starts again* rather than
          * *continues*, and to say why that is only time: proving reaches no
          * chain and spends no fee.
          */}
        <p className="proofnote">
          You can close this page. The approval is saved on this device and picks itself up when
          you come back - though the proof itself starts again from the beginning, because there
          is no way to save one half done. That costs time and nothing else: proving sends
          nothing and spends no fee.
        </p>
      </div>
    </aside>
  );
}

function ProofRow({ proof, onCancel }: { proof: ProofStatus; onCancel?: (jobId: string) => void }) {
  const { stage } = proof;
  const fraction = fractionOf(stage);
  /*
   * **CONTROLS FOR THINGS THAT DO NOT EXIST YET ARE SHOWN DISABLED WITH THEIR
   * REASON, NEVER HIDDEN.** A screen built only for what works today is a
   * screen that has to be re-laid-out for every feature, and - worse - a person
   * cannot tell the difference between a thing this product will not do and a
   * thing this deployment has not been given.
   */
  const canWithdraw = stage.name === 'waiting' || stage.name === 'proving';
  const withdrawReason =
    stage.name === 'submitting'
      ? 'it has already been sent, so it can only be cancelled on the account itself'
      : 'it has finished';

  return (
    <div className="proofrow">
      <div className="proofrowtop">
        <span className={`proofdot ${stage.name}`} aria-hidden="true" />
        <span className="proofrowwhat">{describeStage(stage)}</span>
        <span className="spacer" />
        {proof.attempts > 1 && (
          /*
           * Shown from the second attempt only. The count is on the job and
           * survives reloads, so this is the honest way a person learns that
           * something has been started more than once - which is otherwise
           * completely invisible to them.
           */
          <span className="sub2">started {proof.attempts} times</span>
        )}
      </div>

      {fraction !== null && (
        <div className="proofrail wide" aria-hidden="true">
          <span className="prooffill" style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
        </div>
      )}

      <div className="proofrowacts">
        <button
          className="btn ghost sm"
          disabled={!canWithdraw || !onCancel}
          title={canWithdraw
            ? (onCancel ? 'Withdraw this approval before it is sent' : 'this page cannot withdraw approvals')
            : `Cannot be withdrawn: ${withdrawReason}`}
          onClick={() => onCancel?.(proof.jobId)}
        >
          Withdraw
        </button>

        {/*
          * **DISABLED BECAUSE NOTHING IN THIS DEPLOYMENT PAYS A NETWORK FEE**,
          * not because the button is unfinished. A device can prove an approval
          * without a wallet - proving is pure - and cannot send one without a
          * wallet, and those are genuinely different halves. The title says
          * which half is missing rather than leaving a person to guess whether
          * they did something wrong.
          */}
        <button className="btn sm" disabled
          title="No wallet has been set up to pay the network fee, so nothing can be sent from here yet.">
          Send it
        </button>

        <button className="btn ghost sm" disabled
          title="A transaction reference appears here once an approval has been sent.">
          View on the explorer
        </button>
      </div>
    </div>
  );
}
