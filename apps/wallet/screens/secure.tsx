import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  MAX_PIECES, checkPlan, splitSecret, suggestDefault, toBase64Url, warningsFor,
} from 'midnight-identity';
import type { PieceSet, Placement, Secret } from 'midnight-identity';
import { hrefOf } from '../routes.js';
import { loadSecuredSetup, loadSubwallets, saveSecuredSetup } from '../storage.js';
import { PieceMap, day } from '../piece-map.js';
import { ErrorNote } from '../ui.js';
import { describeFailure } from '../failure-text.js';

/**
 * SECURING THE ACCOUNT — the flow the standing notice points at.
 *
 * Where the interface IS the security on this screen (§2, §7.14):
 * the plan is validated by `checkPlan` — THE SAME RULES THAT CUT — shown
 * live; N-of-N is warned loudly in `warningsFor`'s words; the default comes
 * from `suggestDefault` and never counts this device (§7.3); ONE PRINT JOB
 * NEVER CONTAINS TWO PIECES (the set must never be a document); and
 * the finish step CONSUMES EVIDENCE, not a checkbox (§7.14): one
 * piece's bytes are re-entered from its card, with no bytes on screen,
 * proving at least one piece exists outside this tab before the record is
 * written by the evidence-carrying `saveSecuredSetup`.
 */

type PlaceKind = 'cloud' | 'paper' | 'device' | 'key' | 'person' | 'file';

const KINDS: Record<PlaceKind, { readonly label: string; readonly hint: string }> = {
  /* The hints ask for WHO CONTROLS THE PLACE, never the medium: the
   * same Google login reached as "a cloud account" and as "a file I keep" is
   * one holder in the world, so it must be one holder to `checkPlan`. */
  cloud: { label: 'A cloud account of mine', hint: 'which account — e.g. “you@example.com”' },
  paper: { label: 'Printed on paper', hint: 'where it will live — e.g. “the safe at home”' },
  device: { label: 'Another device of mine', hint: 'which machine — e.g. “the old laptop”' },
  key: { label: 'A hardware key', hint: 'which key — e.g. “yubikey in the drawer”' },
  person: { label: 'Somebody I trust', hint: 'who — e.g. “my sister”' },
  file: { label: 'A file I keep', hint: 'which account or disk holds it — e.g. “you@example.com”' },
};

export interface Candidate {
  readonly id: number;
  readonly kind: PlaceKind;
  readonly detail: string;
  readonly isThisDevice?: boolean;
}

type Row = Pick<Candidate, 'id' | 'kind' | 'detail'>;

/**
 * WHO CONTROLS THE PLACE — the detail alone, normalised. The kind lives only
 * in the label: two rows naming the same place collide whatever
 * medium they wear; an empty detail becomes an empty holder, which
 * `checkPlan` refuses with its own sentence about not saying who controls it.
 */
export const holderOf = (row: { kind: PlaceKind; detail: string }): string =>
  row.detail.trim().toLowerCase().replace(/\s+/g, ' ');

const labelOf = (row: { kind: PlaceKind; detail: string }): string =>
  row.detail.trim() ? `${KINDS[row.kind].label} — ${row.detail.trim()}` : KINDS[row.kind].label;

const toPlacement = (row: Row): Placement => ({ label: labelOf(row), holder: holderOf(row) });

/** The candidates the default is chosen FROM — including the machine the
 * person is standing at, so `suggestDefault` can be seen dropping it. */
export const DEFAULT_CANDIDATES: readonly Candidate[] = [
  { id: 1, kind: 'cloud', detail: 'my own cloud drive' },
  { id: 2, kind: 'paper', detail: 'a safe place at home' },
  { id: 3, kind: 'person', detail: 'someone I would call' },
  { id: 4, kind: 'device', detail: 'this browser', isThisDevice: true },
];

/** The suggested plan, FROM the library — §7.3 enforced by `suggestDefault`,
 * wherever the this-device candidate sits in the list. */
export function planFromCandidates(candidates: readonly Candidate[]): {
  rows: Row[]; threshold: number;
} {
  const suggestion = suggestDefault(candidates.map((c) => ({
    ...toPlacement(c), isThisDevice: c.isThisDevice ?? false,
  })));
  const rows = candidates
    .filter((c) => suggestion.placements.some((p) => p.holder === holderOf(c)))
    .map(({ id, kind, detail }) => ({ id, kind, detail }));
  return { rows, threshold: suggestion.threshold };
}

const normalise = (typed: string): string => typed.replace(/\s+/g, '');

export function Secure({ secret }: { readonly secret: Secret }): ReactNode {
  const [view, setView] = useState<'existing' | 'plan' | 'cards' | 'prove' | 'done' | 'sheet'>(
    () => (loadSecuredSetup(secret) ? 'existing' : 'plan'));
  const [initial] = useState(() => planFromCandidates(DEFAULT_CANDIDATES));
  const [rows, setRows] = useState<Row[]>(initial.rows);
  const [threshold, setThreshold] = useState(initial.threshold);
  const [nextId, setNextId] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [set, setSet] = useState<PieceSet | null>(null);
  const [placed, setPlaced] = useState<ReadonlySet<number>>(new Set());
  const [printing, setPrinting] = useState<number | null>(null);
  const [proveIndex, setProveIndex] = useState(0);
  const [typed, setTyped] = useState('');
  /* The rows the cut was made from — kept for the verification map. */
  const [cutRows, setCutRows] = useState<Row[]>([]);

  const placements = useMemo(() => rows.map(toPlacement), [rows]);

  /* ONE PRINT JOB, ONE CARD. The card being printed gets a class the
   * print stylesheet shows alone; everything else on the page is hidden. */
  useEffect(() => {
    if (printing === null) return;
    window.print();
    setPrinting(null);
  }, [printing]);

  const planProblem = useMemo(() => {
    try {
      checkPlan(placements, threshold);
      return null;
    } catch (e) {
      return describeFailure(e);
    }
  }, [placements, threshold]);

  const warnings = useMemo(
    () => (planProblem === null ? warningsFor(placements, threshold) : []),
    [placements, threshold, planProblem]);

  const cut = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const fresh = await splitSecret(secret, placements, threshold);
      setSet(fresh);
      setCutRows(rows);
      setPlaced(new Set());
      setView('cards');
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      setBusy(false);
    }
  };

  const startProof = (): void => {
    if (!set) return;
    /* One piece, chosen by the wallet, not the person — reading it back from
     * its card is what proves a card exists away from this screen. */
    const pick = new Uint32Array(1);
    crypto.getRandomValues(pick);
    setProveIndex((pick[0] ?? 0) % set.pieces.length);
    setTyped('');
    setError(null);
    setView('prove');
  };

  const finish = async (): Promise<void> => {
    if (!set) return;
    const expected = toBase64Url(set.pieces[proveIndex]?.bytes ?? new Uint8Array());
    if (normalise(typed) !== expected) {
      setError(
        `that does not match piece ${proveIndex + 1}. Read it from the card itself — `
        + 'letter for letter — not from memory. If the card is not to hand, that is '
        + 'exactly what this step exists to find out.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      /* Verification seeds — §7.12: paper can never be asked (null);
       * every other home could be and has not been ('never'). */
      const verification: Record<string, number | 'never' | null> = {};
      for (const row of cutRows) {
        verification[holderOf(row)] = row.kind === 'paper' ? null : 'never';
      }
      await saveSecuredSetup(secret, set, verification);
      setView('done');
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      setBusy(false);
    }
  };

  /* THE SHEET — the map of the pieces with the subwallet names on it, on its
   * own page so printing it prints nothing else. The names come through
   * `loadSubwallets(secret)`, so they are fingerprint-checked: this is the
   * one screen with the secret in hand, which is why the sheet lives here
   * and not on the rescue screens (the wrong-wallet risk on paper). */
  if (view === 'sheet') {
    const current = loadSecuredSetup(secret);
    return (
      <>
        <h1>Your sheet: the pieces, and your wallet names.</h1>
        <p className="lede">
          Print it or save it with your records. It is a snapshot — after renaming a
          wallet, come back and print it again.
        </p>
        {current
          ? <PieceMap setup={current} names={loadSubwallets(secret).names} />
          : <p className="muted">Nothing is on record for this account yet.</p>}
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button type="button" className="primary" onClick={() => window.print()}>
            Print this sheet
          </button>
        </div>
        <p style={{ marginTop: '1.25rem' }}>
          <button
            type="button"
            className="quiet"
            onClick={() => setView(loadSecuredSetup(secret) ? 'existing' : 'plan')}
          >
            ← Back
          </button>
        </p>
      </>
    );
  }

  if (view === 'existing') {
    const current = loadSecuredSetup(secret);
    return (
      <>
        <h1>This account is secured.</h1>
        {current && (
          <p className="muted">
            On {day(current.rebuiltAt)} it was cut into {current.pieces.length} pieces and
            proved rebuildable from any {current.threshold}. One piece was read back from
            its card; you said the rest are placed.
          </p>
        )}
        <section className="card">
          <h2>The sheet</h2>
          <p className="muted small">
            Where each piece lives, and the names you have given your subwallets — the
            one part of this account that lives only in this browser. A printed copy
            ages: reprint it after renaming.
          </p>
          <button type="button" onClick={() => setView('sheet')}>
            Print the sheet…
          </button>
        </section>
        <section className="card">
          <h2>Cut a new set</h2>
          <p className="muted small">
            Replaces the plan on record with a new one and new pieces.
          </p>
          <p className="warn-text small">
            Re-cutting adds a way in — it never removes one. The pieces of the set you
            are replacing{current && current.pieces.length > 0
              ? ` — ${current.pieces.map((p) => p.label).join('; ')} — `
              : ' '}still rebuild this account for as long as they exist, and nothing
            can switch them off. The record here will keep naming them.
          </p>
          <button type="button" onClick={() => setView('plan')}>Choose a new plan…</button>
        </section>
        <p><a href={hrefOf('home')}>← Back to your wallet</a></p>
      </>
    );
  }

  if (view === 'done') {
    return (
      <>
        <h1><span className="ok" aria-hidden="true">✓</span> Account secured.</h1>
        <p className="lede">
          Cut into {set?.pieces.length} pieces, proved rebuildable from any{' '}
          {set?.threshold}, and one piece read back from its card — so at least one
          demonstrably exists outside this page. You said the rest are placed.
        </p>
        <p className="muted">
          Each piece shows on your wallet as <em>not yet checked</em> — or, for paper,
          <em> can&rsquo;t be checked</em>, which is its honest, permanent answer.
        </p>
        <p className="muted small">
          One more thing worth paper: <button type="button" className="quiet inline" onClick={() => setView('sheet')}>
            print the sheet
          </button> — where each piece lives, with your subwallet names on it. It is a
          snapshot; reprint it after renaming.
        </p>
        <p><a href={hrefOf('home')}><button type="button" className="primary">Back to your wallet</button></a></p>
      </>
    );
  }

  if (view === 'prove' && set) {
    const piece = set.pieces[proveIndex];
    return (
      <>
        <h1>Read one piece back from its card.</h1>
        <p className="lede">
          A tick can be pressed without moving from the chair; this cannot. Type the
          bytes of <strong>piece {proveIndex + 1} — {piece?.placement.label}</strong>{' '}
          from its printed or written card. The pieces are no longer on this screen.
        </p>
        <textarea
          rows={3}
          autoComplete="off"
          spellCheck={false}
          aria-label={`The bytes of piece ${proveIndex + 1}, from its card`}
          placeholder="the piece's letters, exactly as the card shows them — spaces don't matter"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        <ErrorNote message={error} />
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button
            type="button"
            className="primary big"
            disabled={busy || normalise(typed).length === 0}
            onClick={() => { void finish(); }}
          >
            This is piece {proveIndex + 1} — finish
          </button>
        </div>
        <p style={{ marginTop: '1.25rem' }}>
          <button type="button" className="quiet" onClick={() => setView('cards')}>
            ← Back to the cards
          </button>
        </p>
      </>
    );
  }

  if (view === 'cards' && set) {
    const allPlaced = placed.size === set.pieces.length;
    return (
      <>
        <h1>Put each piece where its card says.</h1>
        <p className="lede">
          {set.pieces.length} pieces. Every combination of {set.threshold} of them was
          actually rebuilt and checked before you were shown this. Fewer than{' '}
          {set.threshold} tell whoever holds them nothing at all.
        </p>
        <p className="warn-text small">
          Print each card on its own — the button on the card does exactly that. Pieces
          kept together are one piece: never the same file, the same drawer, or the
          same print job.
        </p>

        <div className="print-cards">
          {set.pieces.map((piece, index) => (
            <div
              className={printing === index ? 'piece-card print-target' : 'piece-card'}
              key={piece.placement.holder}
            >
              <div className="piece-card-head">
                <span className="faint small">piece {index + 1} of {set.pieces.length}</span>
                <span className="small">keep apart from the others</span>
              </div>
              <h2>{piece.placement.label}</h2>
              <div className="piece-bytes mono" data-testid={`piece-bytes-${index}`}>
                {(toBase64Url(piece.bytes).match(/.{1,4}/g) ?? []).join(' ')}
              </div>
              <p className="small piece-card-note">
                Midnight Identity recovery piece {index + 1} of {set.pieces.length}. On
                its own it reveals nothing. It must not be kept beside the others —
                never in one file, one drawer, or one print job. Its place:{' '}
                {piece.placement.label}.
              </p>
              <div className="piece-card-actions">
                <button type="button" onClick={() => setPrinting(index)}>
                  Print this card
                </button>
                <label className="place-check">
                  <input
                    type="checkbox"
                    checked={placed.has(index)}
                    onChange={() => {
                      const next = new Set(placed);
                      if (next.has(index)) next.delete(index);
                      else next.add(index);
                      setPlaced(next);
                    }}
                  />
                  {' '}This piece is where the card says
                </label>
              </div>
            </div>
          ))}
        </div>

        <ErrorNote message={error} />
        <div className="actions" style={{ marginTop: '1.25rem' }}>
          <button
            type="button"
            className="primary big"
            disabled={!allPlaced || busy}
            onClick={startProof}
          >
            All {set.pieces.length} are placed — continue
          </button>
          {!allPlaced && (
            <p className="faint small" style={{ marginTop: '0.6rem' }}>
              Tick each card once its piece is really there. Before anything is
              recorded, one piece — the wallet picks which — is read back from its
              card, off this screen.
            </p>
          )}
        </div>
        <p style={{ marginTop: '1.5rem' }}>
          <button type="button" className="quiet" onClick={() => setView('plan')}>
            ← Back to the plan (these pieces are discarded if none were placed)
          </button>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Secure your account.</h1>
      <p className="lede">
        Your account is cut into pieces you place. You choose how many exist and how
        many put it back; anything fewer than that tells whoever holds it nothing.
      </p>
      <p className="muted small">
        The suggested plan is {initial.threshold} of {initial.rows.length} — and it
        never includes the machine you are standing at, because a lost or broken
        device is the usual reason people are recovering. When this one goes, its
        piece would go with it.
      </p>

      <section className="card">
        <h2>Where the pieces will live</h2>
        <p className="muted small">
          Name who controls each place — the account, the person, the spot — not the
          gadget. Two pieces reachable through the same account are one piece, and the
          plan below is checked for exactly that.
        </p>
        <div>
          {rows.map((row) => (
            <div className="place-edit" key={row.id}>
              <select
                aria-label="Kind of place"
                value={row.kind}
                onChange={(event) => {
                  const kind = event.target.value as PlaceKind;
                  setRows(rows.map((r) => (r.id === row.id ? { ...r, kind } : r)));
                }}
              >
                {(Object.keys(KINDS) as PlaceKind[]).map((kind) => (
                  <option key={kind} value={kind}>{KINDS[kind].label}</option>
                ))}
              </select>
              <input
                type="text"
                aria-label="Who controls it"
                placeholder={KINDS[row.kind].hint}
                value={row.detail}
                onChange={(event) => {
                  setRows(rows.map((r) => (r.id === row.id ? { ...r, detail: event.target.value } : r)));
                }}
              />
              <button
                type="button"
                className="quiet"
                aria-label={`Remove ${labelOf(row)}`}
                onClick={() => setRows(rows.filter((r) => r.id !== row.id))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          disabled={rows.length >= MAX_PIECES}
          onClick={() => {
            setRows([...rows, { id: nextId, kind: 'device', detail: '' }]);
            setNextId(nextId + 1);
          }}
        >
          Add a place
        </button>
      </section>

      <section className="card">
        <h2>How many put it back</h2>
        <div className="stepper">
          <button
            type="button"
            aria-label="Fewer pieces needed"
            onClick={() => setThreshold(Math.max(2, threshold - 1))}
            disabled={threshold <= 2}
          >
            −
          </button>
          <span className="stepper-value" data-testid="threshold">
            any <strong>{threshold}</strong> of {rows.length}
          </span>
          <button
            type="button"
            aria-label="More pieces needed"
            onClick={() => setThreshold(Math.min(rows.length, threshold + 1))}
            disabled={threshold >= rows.length}
          >
            +
          </button>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Losing pieces is normal. A plan with a spare — needing fewer than all of
          them — survives a lost one.
        </p>
      </section>

      {planProblem && <div className="error" role="alert">{planProblem}</div>}
      {warnings.map((warning) => (
        <div className="warn-banner" role="alert" key={warning.kind}>{warning.says}</div>
      ))}
      <ErrorNote message={error} />

      <div className="actions" style={{ marginTop: '1.25rem' }}>
        <button
          type="button"
          className="primary big"
          disabled={planProblem !== null || busy}
          onClick={() => { void cut(); }}
        >
          {busy ? 'Cutting, and proving it can be put back…' : 'Cut the account into pieces'}
        </button>
      </div>
      <p style={{ marginTop: '1.5rem' }}>
        <a href={hrefOf('home')}>← Back to your wallet</a>
      </p>
    </>
  );
}
