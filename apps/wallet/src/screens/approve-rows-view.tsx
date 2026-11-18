/*
 * One line per detail a page asks for: one this wallet does not know, one the wallet works out itself from the chosen wallet, and one the person holds, with the choice to send it or not.
 * It shows who vouched for each held detail and lets a missing one be added once.
 */
import type { ReactNode } from 'react';
import { abbreviate } from 'midnight-identity/profile/definition';
import type { AttributeDefinition } from 'midnight-identity/profile/definition';
import type { Derived } from '../accounts/derived.js';
import { Button, Input } from 'vaults-ui';
/* The code is COPIED, never transcribed. By design, nobody
 * reads anything down a phone line in this design. */
import { CopyButton } from '../components/ui.js';
import { FINGERPRINT_TEXT, dateOf } from './approve-text.js';
import type { Row } from './approve-rows.js';
import type { Screen } from './approve-shape.js';

type RowShape = Pick<Screen, 'picked' | 'refused' | 'typed' | 'setPicked' | 'setRefused' | 'setTyped' | 'fill' | 'owned'>;

function unknownRow(v: { readonly row: Row }): ReactNode {
  const { row } = v;
  return (
    <li
      key={row.attribute}
      data-row={row.attribute}
      data-unknown
      className="rounded-md border border-border p-3"
    >
      <p className="m-0">
        {'They asked for '}
        <strong className="font-mono">{row.attribute}</strong>
        {row.required ? ' and marked it required.' : '.'}
      </p>
      <p className="m-0 text-sm text-muted-foreground">
        This wallet does not hold anything of that kind, and it will not invent
        it. Nothing will be sent for this.
      </p>
    </li>
  );
}

function derivedOptions(v: RowShape & { readonly row: Row; readonly definition: AttributeDefinition; readonly derived: Extract<Derived, { ok: true }> }): ReactNode {
  const { refused, setRefused, owned, row, derived } = v;
  return (
  <div className="flex flex-col gap-1">
    <label
      className="flex items-baseline gap-2 text-sm"
      data-option="derived"
    >
      <input
        type="radio"
        name={`pick-${row.attribute}`}
        checked={refused[row.attribute] !== true}
        onChange={() => setRefused((c) => {
          const next = { ...c };
          delete next[row.attribute];
          return next;
        })}
      />
      <span className="font-mono break-all" data-derived-value>
        {derived.value}
      </span>
    </label>
    {/* §3.1's rule, extended by the arm it needed: self and
      * issued never look alike, and neither of them looks
      * like a value nobody stated at all. */}
    <p className="m-0 text-sm text-muted-foreground" data-provenance="wallet">
      {`This wallet worked it out from ${owned.owner}. Nobody typed it, `}
      and choosing a different wallet above changes it.
    </p>
    {/*
      * **THE CODE FOR THE ADDRESS ABOVE.**
      *
      * The address itself is sealed on this device and the
      * page that asked never sees it, which is the property
      * it bought — so the person on the other end has no
      * way to tell that the address they received is the one
      * this wallet showed. **This is that way.** It is a
      * rendering of the value on the line above and of
      * nothing else, so their machine computes the same
      * twenty characters from what arrives.
      *
      * It moves when the wallet picker moves, because it is
      * computed from `derived.value` — the same object the
      * radio above sends. There is no path where the code
      * says one wallet and the disclosure carries another.
      */}
    {row.code !== null && refused[row.attribute] !== true && (
      <div
        className="mt-1 rounded-md border border-border p-3"
        data-confirmation
      >
        <p className="m-0 text-sm text-muted-foreground">
          The code for this address
        </p>
        <p
          className={`m-0 font-mono ${FINGERPRINT_TEXT} text-foreground`}
          data-confirmation-code
        >
          {row.code}
        </p>
        <p className="m-0 text-sm text-muted-foreground">
          Copy this and paste it where you were asked for it. Whoever
          receives your address works out the same code from what
          reaches them, so the two are compared and a different address
          does not match.
        </p>
        <CopyButton
          kit
          text={row.code}
          label="Copy the code"
          copied="Copied the code"
        />
      </div>
    )}
    <label
      className="flex items-baseline gap-2 text-sm"
      data-option="none"
    >
      <input
        type="radio"
        name={`pick-${row.attribute}`}
        checked={refused[row.attribute] === true}
        onChange={() => setRefused((c) => ({ ...c, [row.attribute]: true }))}
      />
      <span>Do not send this</span>
    </label>
  </div>
  );
}

function derivedRow(v: RowShape & { readonly row: Row; readonly definition: AttributeDefinition; readonly derived: Derived }): ReactNode {
  const { row, definition, derived } = v;
  return (
    <li
      key={row.attribute}
      data-row={row.attribute}
      data-required={row.required ? 'yes' : 'no'}
      data-sensitivity={definition.sensitivity}
      data-derived
      className="rounded-md border border-border p-3"
    >
      <p className="m-0 text-base text-foreground">
        {definition.render.label}
        <span className="text-sm text-muted-foreground">
          {row.required ? ' — they require this' : ' — optional'}
        </span>
      </p>
      {row.reason !== undefined && (
        <p className="m-0 text-sm text-muted-foreground" data-reason>
          {`They say: ${row.reason}`}
        </p>
      )}
      {derived.ok ? (
          derivedOptions({ ...v, derived })
      ) : (
        <p className="m-0 text-sm text-muted-foreground" data-derived-refused>
          {derived.says}
        </p>
      )}
    </li>
  );
}

function heldOptions(v: RowShape & { readonly row: Row; readonly definition: AttributeDefinition; readonly chosen: string | undefined }): ReactNode {
  const { setPicked, row, definition, chosen } = v;
  return (
  <div className="flex flex-col gap-1">
    {row.options.map((held) => (
      <label
        key={held.id}
        className="flex items-baseline gap-2 text-sm"
        data-option={held.id}
      >
        <input
          type="radio"
          name={`pick-${row.attribute}`}
          checked={chosen === held.id}
          onChange={() => setPicked((c) => ({ ...c, [row.attribute]: held.id }))}
        />
        <span>
          {held.says.of === 'value'
            ? abbreviate(definition, held.says.value)
            : `${held.says.predicate}: ${held.says.result ? 'yes' : 'no'}`}
          {held.label !== '' && ` (${held.label})`}
        </span>
        {/* §3.1 — self and issued NEVER look alike, and an
          * issued record never appears without its date. */}
        {held.asserted.by === 'issuer' ? (
          <span className="text-good" data-provenance="issuer">
            {`checked by ${held.asserted.issuer} on `}
            {dateOf(held.asserted.issuedAt)}
          </span>
        ) : (
          <span className="text-muted-foreground" data-provenance="self">
            you typed this; nobody has checked it
          </span>
        )}
      </label>
    ))}
    <label className="flex items-baseline gap-2 text-sm" data-option="none">
      <input
        type="radio"
        name={`pick-${row.attribute}`}
        checked={chosen === undefined}
        onChange={() => setPicked((c) => {
          const next = { ...c };
          delete next[row.attribute];
          return next;
        })}
      />
      <span>Do not send this</span>
    </label>
  </div>
  );
}

function heldRow(v: RowShape & { readonly row: Row; readonly definition: AttributeDefinition; readonly chosen: string | undefined }): ReactNode {
  const { typed, setTyped, fill, row, definition, chosen } = v;
return (
  <li
    key={row.attribute}
    data-row={row.attribute}
    data-required={row.required ? 'yes' : 'no'}
    data-sensitivity={definition.sensitivity}
    className="rounded-md border border-border p-3"
  >
    <p className="m-0 text-base text-foreground">
      {definition.render.label}
      <span className="text-sm text-muted-foreground">
        {row.required ? ' — they require this' : ' — optional'}
      </span>
    </p>
    {row.reason !== undefined && (
      <p className="m-0 text-sm text-muted-foreground" data-reason>
        {`They say: ${row.reason}`}
      </p>
    )}
    {row.options.length === 0 ? (
      definition.selfAssertable ? (
        <div className="flex flex-col gap-2" data-fill={row.attribute}>
          <p className="m-0 text-sm text-muted-foreground">
            You do not hold this yet. You can add it here, once, and it stays
            for the next company that asks.
          </p>
          <Input
            aria-label={`Add your ${definition.render.label.toLowerCase()}`}
            value={typed[definition.name] ?? ''}
            onChange={(e) => setTyped(
              (c) => ({ ...c, [definition.name]: e.target.value }))}
          />
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fill(definition, typed[definition.name] ?? '')}
            >
              Add it
            </Button>
          </div>
        </div>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">
          You hold nothing of this kind, and it is not something you can state
          about yourself. Nothing will be sent for this.
        </p>
      )
    ) : (
          heldOptions({ ...v, chosen })
    )}
  </li>
);
}

export function rowView(v: RowShape & { readonly row: Row }): ReactNode {
  const { picked, row } = v;
  const chosen = picked[row.attribute];
  /* An attribute this vocabulary does not know is SHOWN as unknown.
   * Dropping it would be a screen lying about what was asked; turning
   * it into an attribute would let a requester define one (§3.4). */
  if (row.definition === null) {
    return unknownRow({ row });
  }
  const definition = row.definition;
  /*
   * **A DERIVED ROW: NO LIST, NO BOX, AND THE VALUE IN FULL.**
   *
   * There is nothing to pick between, because nothing is held, and
   * nothing to type into, because nothing anybody typed would change
   * the answer. What a person can do is see it, see which wallet it
   * came from, and say no — which is a normal answer here as it is
   * anywhere else on this screen.
   *
   * **IT IS SHOWN WHOLE.** `render.abbreviate` exists for a list of
   * held values with no room; this is one value, it is where money
   * will arrive, and a shortened address is one a person cannot
   * check. That rule is about what to do when there is no room, and
   * here there is.
   */
  if (row.derived !== null) {
    const derived = row.derived;
    return derivedRow({ ...v, definition, derived });
  }
  return heldRow({ ...v, definition, chosen });
}
