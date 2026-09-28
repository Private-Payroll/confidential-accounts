import type { ReactNode } from 'react';
import { Button } from 'vaults-ui/components/button';
import { useText } from 'vaults-ui/i18n/provider';

export interface ConfirmInYourAccountProps {
  /**
   * What is being confirmed, in the person's language, said before they
   * answer: what the action does, and anything it makes public.
   */
  summary: ReactNode;
  /** Called when the person confirms. What confirming does is the caller's. */
  onConfirm: () => void;
  /** Called when the person turns it down. */
  onCancel: () => void;
  /** While the answer is being carried out: both buttons wait. */
  busy?: boolean;
}

/**
 * THE STEP BEFORE AN ACTION IS SIGNED: "Confirm in your account", with what
 * is being confirmed beneath it. It asks and reports the answer. It signs
 * nothing and opens nothing: whether an action is signed on the page or in
 * the account is up to the `onConfirm` the caller passes.
 */
export function ConfirmInYourAccount({ summary, onConfirm, onCancel, busy = false }: ConfirmInYourAccountProps) {
  const t = useText();
  return (
    <section className="flex flex-col gap-3" data-slot="confirm-in-your-account" aria-busy={busy}>
      <h2 className="text-base font-medium">{t('kit.confirm.title')}</h2>
      <div className="text-sm text-muted-foreground">{summary}</div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>{t('kit.confirm.cancel')}</Button>
        <Button onClick={onConfirm} disabled={busy}>{t('kit.confirm.confirm')}</Button>
      </div>
    </section>
  );
}
