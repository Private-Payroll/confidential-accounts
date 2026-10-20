import { Alert, AlertDescription, AlertTitle, useText } from 'vaults-ui';
import { ACT_REFUSAL, type ActRefusal } from './adapters/refusals.js';

/** Why an action on a company did not happen, and what to do about it, in the person's language. */
export function ActRefused({ why }: { why: ActRefusal }) {
  const t = useText();
  const says: Record<ActRefusal, string> = {
    [ACT_REFUSAL.notSetUp]: t('act.refused.notSetUp'),
    [ACT_REFUSAL.notSignedIn]: t('act.refused.notSignedIn'),
    [ACT_REFUSAL.anotherPerson]: t('act.refused.anotherPerson'),
    [ACT_REFUSAL.signInAgain]: t('act.refused.signInAgain'),
    [ACT_REFUSAL.keysDidNotOpen]: t('act.refused.keysDidNotOpen'),
    [ACT_REFUSAL.keysWentBack]: t('act.refused.keysWentBack'),
    [ACT_REFUSAL.companyKept]: t('act.refused.companyKept'),
    [ACT_REFUSAL.declined]: t('act.refused.declined'),
    [ACT_REFUSAL.expired]: t('act.refused.expired'),
    [ACT_REFUSAL.ranOut]: t('act.refused.ranOut'),
    [ACT_REFUSAL.unreadable]: t('act.refused.unreadable'),
    [ACT_REFUSAL.payChainUnreadable]: t('act.refused.payChainUnreadable'),
    [ACT_REFUSAL.payNotEnough]: t('act.refused.payNotEnough'),
    [ACT_REFUSAL.payNotAsApproved]: t('act.refused.payNotAsApproved'),
    [ACT_REFUSAL.payDidNotFinish]: t('act.refused.payDidNotFinish'),
    [ACT_REFUSAL.noWindow]: t('act.refused.noWindow'),
    [ACT_REFUSAL.windowGone]: t('act.refused.windowGone'),
    [ACT_REFUSAL.gaveUp]: t('act.refused.gaveUp'),
    [ACT_REFUSAL.silent]: t('act.refused.silent'),
    [ACT_REFUSAL.noKeysHere]: t('act.refused.noKeysHere'),
    [ACT_REFUSAL.committeeDisagrees]: t('act.refused.committeeDisagrees'),
    [ACT_REFUSAL.nothingToSign]: t('act.refused.nothingToSign'),
    [ACT_REFUSAL.nothingSent]: t('act.refused.nothingSent'),
    [ACT_REFUSAL.unreachable]: t('act.refused.unreachable'),
    [ACT_REFUSAL.didNotFinish]: t('act.refused.didNotFinish'),
    [ACT_REFUSAL.noSeat]: t('act.refused.noSeat'),
    [ACT_REFUSAL.notYourSeat]: t('act.refused.notYourSeat'),
    [ACT_REFUSAL.entryNotFiled]: t('act.refused.entryNotFiled'),
    [ACT_REFUSAL.entryWaitsForItsInvitation]: t('act.refused.entryWaitsForItsInvitation'),
    [ACT_REFUSAL.seatUnknown]: t('act.refused.seatUnknown'),
    [ACT_REFUSAL.seatNotBelieved]: t('act.refused.seatNotBelieved'),
    [ACT_REFUSAL.seatMayNotRaise]: t('act.refused.seatMayNotRaise'),
    [ACT_REFUSAL.committeeUnread]: t('act.refused.committeeUnread'),
    [ACT_REFUSAL.committeeNotInstallable]: t('act.refused.committeeNotInstallable'),
    [ACT_REFUSAL.pageOutOfDate]: t('act.refused.pageOutOfDate'),
    [ACT_REFUSAL.vaultNotTheCompanys]: t('act.refused.vaultNotTheCompanys'),
    [ACT_REFUSAL.vaultInfoRefused]: t('act.refused.vaultInfoRefused'),
  };
  return (
    <Alert data-refusal={why}>
      <AlertTitle>{t('act.refused.title')}</AlertTitle>
      <AlertDescription>{says[why]}</AlertDescription>
    </Alert>
  );
}
