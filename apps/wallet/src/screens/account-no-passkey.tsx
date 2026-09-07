import type { ReactNode } from 'react';
import { hrefOf } from '../routes.js';
import { useSession } from '../session.js';
import { ErrorNote, Moon, StatusNote } from '../components/ui.js';

/**
 * A readable sealed account with no usable passkey record — cleanly absent,
 * or damaged. Both get the same door: register a fresh passkey, which
 * opens the same sealed account (the click path opens the account FIRST, so
 * the promise below is kept before anything is minted). For the
 * damaged variant the door also discards the unreadable record, which the
 * button says out loud — a pressed door, not a silent repair.
 */
export function AccountNoPasskey({ recordDamaged }: {
  readonly recordDamaged: boolean;
}): ReactNode {
  const { adoptPasskey, busy, error } = useSession();
  return (
    <>
      <div className="hero">
        <Moon large />
        <h1>
          {recordDamaged
            ? 'Your wallet is here. Its passkey record is damaged.'
            : 'Your wallet is here. Its passkey went missing.'}
        </h1>
        <p className="lede">
          {recordDamaged
            ? 'The sealed account in this browser is readable, but the record matching '
              + 'a passkey to it cannot be read any more. The record holds only public '
              + 'data — ids and counters — so nothing of value is in it. Making a new '
              + 'passkey discards it and puts things back; the wallet itself is untouched.'
            : 'The sealed account is intact in this browser, but the record that matches a '
              + 'passkey to it is gone — that happens when site data is partly cleared. '
              + 'Making a new passkey puts things back; nothing about the wallet changes.'}
        </p>
        <div className="actions">
          <button
            type="button"
            className="primary big"
            onClick={() => { void adoptPasskey(); }}
            disabled={busy !== null}
          >
            {recordDamaged
              ? 'Discard the damaged record and make a new passkey'
              : 'Make a new passkey for this wallet'}
          </button>
          <StatusNote message={busy} />
          <ErrorNote message={error} />
        </div>
        <p className="faint small" style={{ marginTop: '2.5rem' }}>
          The passkey guards this screen, not the sealed bytes themselves — which is
          why replacing it here is possible at all, and why it asks nothing further.
        </p>
      </div>

      <section className="card">
        <h2>
          <a href={hrefOf('recover')}>Prefer to recover from your pieces?</a>
        </h2>
        <p className="muted small" style={{ marginBottom: 0 }}>
          If you secured this account, enough of your placed pieces also put it
          back — here or on any other machine.
        </p>
      </section>
    </>
  );
}
