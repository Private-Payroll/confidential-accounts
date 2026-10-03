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
    [ACT_REFUSAL.declined]: t('act.refused.declined'),
    [ACT_REFUSAL.expired]: t('act.refused.expired'),
    [ACT_REFUSAL.noWindow]: t('act.refused.noWindow'),
    [ACT_REFUSAL.windowGone]: t('act.refused.windowGone'),
    [ACT_REFUSAL.gaveUp]: t('act.refused.gaveUp'),
    [ACT_REFUSAL.silent]: t('act.refused.silent'),
    [ACT_REFUSAL.noKeysHere]: t('act.refused.noKeysHere'),
    [ACT_REFUSAL.rosterDisagrees]: t('act.refused.rosterDisagrees'),
    [ACT_REFUSAL.nothingToSign]: t('act.refused.nothingToSign'),
    [ACT_REFUSAL.nothingSent]: t('act.refused.nothingSent'),
    [ACT_REFUSAL.unreachable]: t('act.refused.unreachable'),
    [ACT_REFUSAL.didNotFinish]: t('act.refused.didNotFinish'),
    [ACT_REFUSAL.noSeat]: t('act.refused.noSeat'),
    [ACT_REFUSAL.notYourSeat]: t('act.refused.notYourSeat'),
  };
  return (
    <Alert data-refusal={why}>
      <AlertTitle>{t('act.refused.title')}</AlertTitle>
      <AlertDescription>{says[why]}</AlertDescription>
    </Alert>
  );
}
