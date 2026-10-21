/*
 * THE ID OF EACH SETUP STEP, which is also its key in the list of steps
 * (`steps.ts`). A step that leads the person to another names it by one of
 * these, never by its words.
 */
export const STEP = {
  createCompany: 'createCompany',
  finishCompany: 'finishCompany',
  signers: 'signers',
  vault: 'vault',
  people: 'people',
} as const;

export type StepId = (typeof STEP)[keyof typeof STEP];

/** What a step's component is handed by whichever screen shows it: the setup wizard, or the step's own page. */
export interface StepProps {
  /** Take the person to another step, the one that makes this one possible. */
  leadTo: (step: StepId) => void;
  /** Called when the step has changed something, so what shows its progress reads it again. */
  onChanged: (startedCompany?: string) => void;
  /** The company this wizard is finishing when none is open yet: the one just created here. */
  creation?: string | null;
  /** Starts the wizard again at creating a new company, shown as if no company were. Absent where a step is shown outside the wizard. */
  startNewCompany?: () => void;
}
