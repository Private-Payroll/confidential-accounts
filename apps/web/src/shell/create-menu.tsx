import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon } from '@hugeicons/core-free-icons';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, useText } from 'vaults-ui';
import { ChangeThreshold } from '../actions/change-threshold.js';
import { OneOffPayment } from '../actions/one-off.js';
import { RaiseRun } from '../actions/raise-run.js';
import { usePanel, type PanelContent } from './right-panel.js';


/** THE CREATE MENU: what a person can start from Home. Each entry opens the control that does it, in the side panel. */
export function CreateMenu() {
  const t = useText();
  const panel = usePanel();
  const start = (content: PanelContent) => (): void => panel.open(content);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button data-action="create-menu">
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
          {t('home.proposals.create')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-create-menu>
        <DropdownMenuItem data-create="new-run" onSelect={start({ title: t('raiseRun.title'), body: <RaiseRun /> })}>{t('home.create.newRun')}</DropdownMenuItem>
        <DropdownMenuItem data-create="one-off-payment" onSelect={start({ title: t('oneOff.title'), body: <OneOffPayment /> })}>{t('home.create.oneOff')}</DropdownMenuItem>
        <DropdownMenuItem data-create="change-approvals" onSelect={start({ title: t('changeThreshold.title'), description: t('changeThreshold.description'), body: <ChangeThreshold /> })}>{t('home.create.approvals')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

