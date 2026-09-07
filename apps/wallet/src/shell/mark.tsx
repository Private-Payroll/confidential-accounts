import { sha256 } from '@noble/hashes/sha2.js';
import type { CSSProperties, ReactNode } from 'react';
import { hueOf } from '../accounts/subwallets.js';

/**
 * THE MARK — recognition before reading.
 *
 * A visual mark derived deterministically from the
 * address bytes, so *this does not look like my payroll account* lands faster
 * than comparing eight hex characters, and so it cannot be duplicated by
 * accident the way a NAME can.
 *
 * IT IS A RECOGNITION AID AND NOT A CHECK, and the difference is the whole
 * reason it is allowed to exist: the address fragment stays beside it on the
 * chip, and the full address appears at approval. Nothing anywhere decides
 * anything by comparing marks.
 *
 * TWO INPUTS, ON PURPOSE:
 *   the PATTERN comes from the address — sha256 of the bech32 string, five
 *     rows of five cells mirrored about the middle column, which is fifteen
 *     bits of the digest and the half that changes when the address does;
 *   the HUE comes from the SLOT (`hueOf`, `subwallets.ts`), so the mark is
 *     the same colour as the swatch and the left border the home screen
 *     already gives that wallet. A second, unrelated colour for the same
 *     wallet on the same screen would be a worse lie than no colour at all.
 *
 * The hue rides in as a custom property rather than a literal — the same
 * `--wallet-hue` device the existing screens use — so no colour is hardcoded
 * in a component and the theme still owns saturation and lightness.
 */

const SIDE = 5;
const MIDDLE = 2;

/** Bit `n` of the digest, most significant first — a stable order, so the
 * same address draws the same mark in every build. */
const bitAt = (digest: Uint8Array, n: number): boolean =>
  (((digest[n >> 3] ?? 0) >> (7 - (n & 7))) & 1) === 1;

export function markCells(address: string): readonly boolean[] {
  const digest = sha256(new TextEncoder().encode(address));
  const cells: boolean[] = [];
  for (let row = 0; row < SIDE; row += 1) {
    for (let column = 0; column < SIDE; column += 1) {
      /* Mirrored about the middle column: a symmetric shape is read as one
       * object at a glance, which is the only job this has. */
      const source = column > MIDDLE ? SIDE - 1 - column : column;
      cells.push(bitAt(digest, row * (MIDDLE + 1) + source));
    }
  }
  return cells;
}

export function Mark({ address, account, size = 28 }: {
  readonly address: string;
  readonly account: number;
  readonly size?: number;
}): ReactNode {
  const cells = markCells(address);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${SIDE} ${SIDE}`}
      className="shrink-0 rounded-tight bg-sunken ring-1 ring-line"
      style={{ '--wallet-hue': String(hueOf(account)) } as CSSProperties}
      aria-hidden="true"
      focusable="false"
    >
      {cells.map((on, index) => (on ? (
        <rect
          /* The grid is fixed and positional: the index IS the cell. */
          key={index}
          x={index % SIDE}
          y={Math.floor(index / SIDE)}
          width="1"
          height="1"
          fill="hsl(var(--wallet-hue) 68% 68%)"
        />
      ) : null))}
    </svg>
  );
}
