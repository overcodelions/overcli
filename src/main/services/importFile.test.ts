import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importFile } from './manager';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-import-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, text: string): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

describe('importFile', () => {
  it('picks the reader by the file name, wherever the file lives', () => {
    const procfile = write('deep/down/Procfile', 'web: npm start\n');
    expect(importFile(procfile)).toMatchObject({ set: { source: 'procfile', file: procfile } });

    const launch = write('elsewhere/launch.json', '{"configurations":[{"name":"api","type":"node","program":"x.js"}]}');
    expect(importFile(launch)).toMatchObject({ set: { source: 'vscode' } });

    const compose = write('compose.override.yaml', 'services:\n  db:\n    image: mariadb\n');
    expect(importFile(compose)).toMatchObject({ set: { source: 'compose' } });
  });

  it('reads an IntelliJ workspace.xml and a single run configuration alike', () => {
    const one = `<component name="ProjectRunConfigurationManager">
  <configuration name="Api" type="SpringBootApplicationConfigurationType"><module name="api_main" /></configuration>
</component>`;
    const many = `<project><component name="RunManager">
  <configuration name="A" type="Application"><module name="a_main" /></configuration>
  <configuration name="B" type="Application"><module name="b_main" /></configuration>
</component></project>`;
    const single = importFile(write('Api.xml', one));
    const workspace = importFile(write('workspace.xml', many));
    expect('set' in single && single.set.services.map((s) => s.name)).toEqual(['Api']);
    expect('set' in workspace && workspace.set.services.map((s) => s.name)).toEqual(['A', 'B']);
  });

  it('says why when a file is not one it reads, or has nothing in it', () => {
    expect(importFile(write('notes.txt', 'hello'))).toMatchObject({ error: expect.stringContaining('not a file') });
    expect(importFile(write('Procfile', '# nothing\n'))).toMatchObject({ error: expect.stringContaining('Nothing') });
    expect(importFile(path.join(dir, 'missing.json'))).toMatchObject({ error: expect.stringContaining('Could not read') });
  });
});
