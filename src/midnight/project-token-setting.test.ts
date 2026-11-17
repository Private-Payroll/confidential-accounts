import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { endpointsOf, networkRecord } from '../core/networks.js';
import { settingOrProjectToken } from './project-token-setting.js';
import { ENDPOINTS, exportTestkitEnv } from './network.js';

/** The setting name preprod's record gives its project token, read from the record. */
const TOKEN = networkRecord('preprod').endpoints!.projectToken!.setting;

/** An `.env` in a folder of its own, holding the lines given. */
const envFileOf = (...lines: string[]): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'project-token-')), '.env');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
};

describe('a tool on this machine reaches a network with the project token in .env beside it', () => {
  /* RED WHEN: a tool started with no token in its environment is refused for one .env holds. */
  it('takes the token from .env when the process carries none, and the endpoints carry it', () => {
    const path = envFileOf('OTHER=1', `${TOKEN}=preprodTokenFromTheFile`);
    expect(settingOrProjectToken({}, path)(TOKEN)).toBe('preprodTokenFromTheFile');
    expect(endpointsOf('preprod', settingOrProjectToken({}, path)).indexer).toContain('preprodTokenFromTheFile');
  });

  /* RED WHEN: .env overrides a token the process was started with. */
  it('keeps the token the process carries over the one in .env', () => {
    const path = envFileOf(`${TOKEN}=fromTheFile`);
    expect(settingOrProjectToken({ [TOKEN]: 'fromTheProcess' }, path)(TOKEN)).toBe('fromTheProcess');
  });

  /* RED WHEN: any other line of .env, a database address among them, reaches the process this way. */
  it('reads nothing else from .env', () => {
    const path = envFileOf('DATABASE_URL=postgresql://someone:secret@db/x', `${TOKEN}=t`);
    expect(settingOrProjectToken({}, path)('DATABASE_URL')).toBeUndefined();
  });

  /* RED WHEN: a quoted token keeps its quotes and is sent as part of the address. */
  it('takes a quoted token without its quotes', () => {
    expect(settingOrProjectToken({}, envFileOf(`${TOKEN}="quoted"`))(TOKEN)).toBe('quoted');
  });

  /* RED WHEN: a line written as a shell would write it, a later line for the same name, a trailing note or an empty value is read otherwise than a shell reads it. */
  it('reads the file as a shell would: export, the last line, no trailing note, and an empty value as none', () => {
    expect(settingOrProjectToken({}, envFileOf(`export ${TOKEN}=exported`))(TOKEN)).toBe('exported');
    expect(settingOrProjectToken({}, envFileOf(`${TOKEN}=first`, `${TOKEN}=last`))(TOKEN)).toBe('last');
    expect(settingOrProjectToken({}, envFileOf(`${TOKEN}=value # a note`))(TOKEN)).toBe('value');
    expect(settingOrProjectToken({}, envFileOf(`${TOKEN}=`))(TOKEN)).toBeUndefined();
  });

  /* RED WHEN: a missing .env throws instead of leaving the record's own refusal to name the setting. */
  it('gives nothing when there is no .env, so the record refuses by the setting\'s name', () => {
    const none = join(mkdtempSync(join(tmpdir(), 'project-token-')), '.env');
    expect(settingOrProjectToken({}, none)(TOKEN)).toBeUndefined();
    expect(() => endpointsOf('preprod', settingOrProjectToken({}, none))).toThrow(TOKEN);
  });
});

describe('the tools that reach a network read the token .env holds', () => {
  /* RED WHEN: the endpoints the service and the doors' tools read stop taking the token from .env beside them. */
  it('the endpoints and the test kit\'s settings carry the token from .env when the process has none', () => {
    const folder = mkdtempSync(join(tmpdir(), 'project-token-'));
    writeFileSync(join(folder, '.env'), `${TOKEN}=fromTheFolder\n`);
    const kept = process.env[TOKEN];
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(folder);
    delete process.env[TOKEN];
    try {
      expect(ENDPOINTS.preprod!.indexerUrl).toContain('fromTheFolder');
      expect(exportTestkitEnv('preprod').MN_TEST_NODE).toContain('fromTheFolder');
    } finally {
      cwd.mockRestore();
      if (kept === undefined) delete process.env[TOKEN]; else process.env[TOKEN] = kept;
    }
  });
});
