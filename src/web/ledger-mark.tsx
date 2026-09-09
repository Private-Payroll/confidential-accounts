import React from 'react';
import { provenanceOf, type Marked, type Provenance } from '../core/provenance.js';

/**
 * **WHAT A PERSON IS TOLD ABOUT WHERE A RECORD CAME FROM.**
 *
 * One definition, used by every screen that shows a list, because the words
 * matter more here than almost anywhere else in this product: a record that
 * never reached a chain and a record that did look identical on a page unless
 * something says otherwise, and the person reading is deciding whether money
 * has moved.
 *
 * ── THREE STATES, AND THE THIRD IS NOT A SOFTER SECOND ───────────────────
 *
 * *On chain* is shown as nothing at all. It is the ordinary case, and a badge
 * on every row is a badge nobody reads within a week - which would leave the
 * two states that matter competing with noise.
 *
 * *Rehearsal* means this product wrote the record without a chain being
 * involved. Nothing was settled and nobody was paid.
 *
 * *Not recorded* means the record predates anything writing down which ledger
 * produced it, and there is no way to establish it afterwards. It is NOT a
 * polite way of saying rehearsal, and it must never be shown as one: the two
 * carry different obligations, and guessing which of them applies is the
 * failure this whole path exists to prevent.
 */
const WORDS: Record<Provenance, { readonly label: string; readonly title: string; readonly tone: string }> = {
  chain: { label: '', title: '', tone: '' },
  simulated: {
    label: 'Rehearsal',
    tone: 'pend',
    title: 'This was written while the product was rehearsing against no chain. '
      + 'Nothing was settled and nobody was paid.',
  },
  unknown: {
    label: 'Ledger not recorded',
    tone: 'off',
    title: 'This record does not say which ledger produced it, and there is no way to '
      + 'establish that now. It is not treated as settled.',
  },
};

/** Renders nothing for a record a chain wrote, which is the ordinary case. */
export function LedgerMark({ of }: { of: Marked }) {
  const seen = provenanceOf(of);
  if (seen === 'chain') return null;
  const w = WORDS[seen];
  return <span className={'chip ' + w.tone} title={w.title}>{w.label}</span>;
}
