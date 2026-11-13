import { Button, useText } from 'vaults-ui';
import { retireVault } from '../adapters/proposal-acts.js';
import { ActedSays, useProposalAct } from '../records/proposal-act.js';
import { PanelFooter } from '../shell/right-panel.js';

/**
 * **RETIRE A VAULT**, asked of the person's own wallet: it reads the vault empty on the chain, raises the retire with
 * this signer's approval counted, and carries it out once the company's threshold is met. The page says what a retire
 * does and what it refuses; the wallet decides, from the chain, whether it may.
 */
export function RetireVault({ vault }: { vault: string }) {
  const t = useText();
  const act = useProposalAct();
  return (
    <div className="flex max-w-xl flex-col gap-4 text-sm" data-retire-vault={vault}>
      <p>{t('vault.retire.what')}</p>
      <p className="text-muted-foreground">{t('vault.retire.checked')}</p>
      <p className="text-muted-foreground">{t('vault.retire.again')}</p>
      <PanelFooter>
        <div className="flex flex-col items-start gap-2">
          <Button variant="destructive" disabled={act.phase !== null || act.done} data-action="retire"
            onClick={() => act.start((person, company, onStep) => retireVault(person, company, vault, onStep))}>
            {t('vault.retire')}
          </Button>
          <ActedSays phase={act.phase} result={act.result} done={t('vault.retire.done')} />
        </div>
      </PanelFooter>
    </div>
  );
}
