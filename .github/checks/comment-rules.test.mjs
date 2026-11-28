// The comment rules refuse what they name and pass what they allow, through ESLint's own rule tester.

import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import rules from '../../lint/comment-rules.mjs';

const { RuleTester } = createRequire(new URL('../../lint/package.json', import.meta.url))('eslint');
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
const tester = new RuleTester();
const code = (comment) => `${comment}\nexport const a = 1;\n`;
const doc = '/**\n * Doubles it.\n * @param x a number\n * @returns twice x\n * @throws never\n */\n';

// RED WHEN a three-line block passes, or a licence header or an export's tag lines count.
tester.run('at-most-two-lines', rules.rules['at-most-two-lines'], {
  valid: [
    code('// one\n// two'),
    code('/*\n * Licensed under the Apache License.\n * one\n * two\n * three\n */'),
    `${doc}export function f(x) { return x * 2; }\n`
  ],
  invalid: [
    { code: code('// one\n// two\n// three'), errors: [{ messageId: 'long' }] },
    { code: code('/*\n * one\n * two\n * three\n */'), errors: [{ messageId: 'long' }] },
    { code: `${doc}function f(x) { return x * 2; }\nexport { f };\n`, errors: [{ messageId: 'long' }] }
  ]
});

// RED WHEN a date, a time or a finding id passes, or a decision named as one, or a plain number is refused.
tester.run('no-dates-or-ids', rules.rules['no-dates-or-ids'], {
  valid: [code('// A key is 32 bytes; 2048 at most are read.')],
  invalid: [
    'written 26 Nov',
    'as of 2026',
    'changed on Nov 3',
    'run at 6:30 pm',
    'run at 18:30 IST',
    'finding F12',
    'per the ruling'
  ].map((said) => ({ code: code(`// ${said}`), errors: [{ messageId: 'carries' }] }))
});

// RED WHEN a disable comment with no reason after "--" passes, or one with a reason is refused.
tester.run('disable-needs-reason', rules.rules['disable-needs-reason'], {
  valid: [code('// eslint-disable-next-line no-console -- the command prints its result'), code('// a plain comment')],
  invalid: [
    { code: code('// eslint-disable-next-line no-console'), errors: [{ messageId: 'bare' }] },
    { code: code('/* eslint-disable no-console */'), errors: [{ messageId: 'bare' }] },
    { code: 'console.log(1); // eslint-disable-line no-console\n', errors: [{ messageId: 'bare' }] }
  ]
});
