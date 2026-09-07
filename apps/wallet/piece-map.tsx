import type { ReactNode } from 'react';
import type { SecuredSetup } from './storage.js';
import { defaultNameOf } from './subwallets.js';
import { CopyButton } from './ui.js';

/**
 * THE MAP TO THE PIECES, shown where it is needed most — the screens where
 * the account itself cannot be opened. This read makes no security
 * claim: labels, holders and dates, never piece bytes, and never the tick —
 * `loadSecuredSetup` decides that, with the fingerprint check.
 *
 * SUBWALLET NAMES RIDE ON THE SAME SHEET — the answer (a), and
 * §5's own suggestion: a name is not a function of the secret,
 * so the sheet the securing flow prints is where names survive a lost
 * browser. `names` is optional and FINGERPRINT-CHECKED BY THE CALLER: the
 * securing screen has the secret in hand and passes `loadSubwallets`'
 * checked names; the broken and passkey-no-account screens cannot check, so
 * they pass nothing — dressing a rescue sheet in what might be another
 * account's labels is the same mistake with paper involved.
 *
 * AND THE SHEET SAYS IT IS A SNAPSHOT. A name given or changed after
 * printing is not on the paper, and a person who believes otherwise would
 * be wrong at the worst moment. The caveat is printed on the sheet itself,
 * and the rename flow says the sheet has aged (`home.tsx`).
 */

export const day = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export const verifiedWords = (lastVerified: number | 'never' | null): string => {
  /* Two idle states, two sentences — §7.12. */
  if (lastVerified === null) return 'unknown — can\u2019t be checked';
  if (lastVerified === 'never') return 'not yet checked';
  return `checked ${day(lastVerified)}`;
};

/** The named wallets, oldest slot first — only slots somebody actually
 * named; the unnamed ones need no sheet to come back. */
const namedWallets = (
  names: Readonly<Record<string, string>>,
): readonly { readonly account: number; readonly name: string }[] =>
  Object.entries(names)
    .map(([account, name]) => ({ account: Number(account), name: name.trim() }))
    .filter((entry) => entry.name !== '')
    .sort((a, b) => a.account - b.account);

const SNAPSHOT_CAVEAT =
  'This sheet is a snapshot: names given or changed after it was made are not on '
  + 'it. After renaming a wallet, print it again.';

export const mapAsText = (
  setup: SecuredSetup,
  names: Readonly<Record<string, string>> = {},
): string => [
  `Where the pieces of this account are (any ${setup.threshold} of ${setup.pieces.length} recover it):`,
  ...(setup.partial
    ? ['  (a partial list — these are the pieces used to recover; there may be others)']
    : []),
  ...setup.pieces.map((p) => `  - ${p.label} (${p.holder})`),
  /* Only sets cut from THIS account are its history; the rest is a
   * different account's map, kept, and exported as exactly that. */
  ...setup.superseded.filter((old) => old.fingerprint === setup.fingerprint)
    .flatMap((old, i) => [
      `Earlier set ${i + 1} — replaced, but its pieces still work (any ${old.threshold} of ${old.pieces.length}):`,
      ...old.pieces.map((p) => `  - ${p.label} (${p.holder})`),
    ]),
  ...setup.superseded.filter((old) => old.fingerprint !== setup.fingerprint)
    .flatMap((old, i) => [
      `A DIFFERENT account's piece list ${i + 1} — kept; these do NOT open this account (any ${old.threshold} of ${old.pieces.length} open that one):`,
      ...old.pieces.map((p) => `  - ${p.label} (${p.holder})`),
    ]),
  ...(namedWallets(names).length > 0
    ? [
      `Wallet names on this account, as of ${day(Date.now())} (the wallets themselves `
        + 'always come back with the account; only these labels live nowhere else):',
      ...namedWallets(names).map((entry) =>
        `  - ${defaultNameOf(entry.account)}: “${entry.name}”`),
      SNAPSHOT_CAVEAT,
    ]
    : []),
].join('\n');

export function PieceMap({ setup, names = {} }: {
  readonly setup: SecuredSetup;
  /** Fingerprint-checked by the CALLER — pass `loadSubwallets(secret).names`
   * where the secret is in hand, and nothing where it is not. */
  readonly names?: Readonly<Record<string, string>>;
}): ReactNode {
  return (
    <section className="card" aria-label="Where your pieces are">
      <h2>Where your pieces are</h2>
      <p className="muted small">
        {setup.partial
          ? `This account was put back from these ${setup.pieces.length} pieces, and any `
            + `${setup.threshold} of them do it again. It is a partial list — these are `
            + 'the pieces that were used; there may be others this browser does not know '
            + 'about. Take a copy — this browser is the only place it is written.'
          : `This account was secured. Any ${setup.threshold} of these ${setup.pieces.length} pieces `
            + 'put it back. Take a copy of this list — this browser is the only place it is written.'}
      </p>
      <div>
        {setup.pieces.map((piece) => (
          <div className="piece-row" key={`${piece.holder}:${piece.label}`}>
            <span className="who">{piece.label}</span>
            {piece.holder !== piece.label
              && <span className="faint small">{piece.holder}</span>}
            <span className={typeof piece.lastVerified === 'number' ? 'verified' : 'verified never'}>
              {verifiedWords(piece.lastVerified)}
            </span>
          </div>
        ))}
      </div>
      {setup.superseded.some((old) => old.fingerprint === setup.fingerprint) && (
        <p className="warn-text small" style={{ marginTop: '0.75rem' }}>
          {setup.superseded.filter((old) => old.fingerprint === setup.fingerprint).length === 1
            ? 'An earlier, replaced set also still works: '
            : 'Earlier, replaced sets also still work, including: '}
          {setup.superseded.filter((old) => old.fingerprint === setup.fingerprint)
            .flatMap((old) => old.pieces.map((p) => p.label)).join('; ')}.
          Replaced pieces cannot be switched off.
        </p>
      )}
      {setup.superseded.some((old) => old.fingerprint !== setup.fingerprint) && (
        /* A different account's map, kept because destroying a map is
         * never ours to do — and never dressed as this account's history. */
        <p className="muted small" style={{ marginTop: '0.75rem' }}>
          A different account&rsquo;s piece list is also on file here — kept, but its
          pieces do <strong>not</strong> open this account:{' '}
          {setup.superseded.filter((old) => old.fingerprint !== setup.fingerprint)
            .flatMap((old) => old.pieces.map((p) => p.label)).join('; ')}.
        </p>
      )}
      {namedWallets(names).length > 0 && (
        <div style={{ marginTop: '0.75rem' }}>
          <h2 style={{ fontSize: '0.95rem' }}>Wallet names on this account</h2>
          <p className="faint small" style={{ margin: '0.15rem 0 0.35rem' }}>
            The wallets themselves always come back with the account; only these
            labels live nowhere else. {SNAPSHOT_CAVEAT}
          </p>
          {namedWallets(names).map((entry) => (
            <div className="piece-row" key={entry.account}>
              <span className="who">{defaultNameOf(entry.account)}</span>
              <span className="faint small">“{entry.name}”</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: '0.75rem' }}>
        <CopyButton text={mapAsText(setup, names)} label="Copy this list" />
        {' '}
        <button
          type="button"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([mapAsText(setup, names)], { type: 'text/plain' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'where-my-pieces-are.txt';
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download it
        </button>
      </div>
    </section>
  );
}
