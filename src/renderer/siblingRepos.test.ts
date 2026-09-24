import { describe, expect, it } from 'vitest';
import type { Project, StreamEvent } from '@shared/types';
import { siblingProjectsTouched } from './siblingRepos';

const project = (id: string, path: string): Project => ({
  id,
  name: path.split('/').pop()!,
  path,
  conversations: [],
  lastOpenedAt: 0,
});

const web = project('web', '/code/acme/acme-web');
const api = project('api', '/code/acme/acme-api');
const infra = project('infra', '/code/acme/acme-infra');
const nested = project('ui', '/code/acme/acme-web/packages/ui');
const all = [web, api, infra, nested];

let n = 0;
const typed = (text: string): StreamEvent =>
  ({ id: `e${n++}`, timestamp: 0, kind: { type: 'localUser', text } }) as unknown as StreamEvent;
const tool = (input: Record<string, unknown>, filePath?: string, name = 'Edit'): StreamEvent =>
  ({
    id: `e${n++}`,
    timestamp: 0,
    kind: {
      type: 'assistant',
      info: {
        model: null,
        text: '',
        thinking: [],
        toolUses: [{ id: 't', name, inputJSON: JSON.stringify(input), filePath }],
      },
    },
  }) as unknown as StreamEvent;

describe('siblingProjectsTouched', () => {
  it('finds a sibling the agent edited a file in', () => {
    const events = [tool({ file_path: '/code/acme/acme-api/src/login.ts' })];
    expect(siblingProjectsTouched(web, all, events)).toEqual([{ project: api, file: 'src/login.ts' }]);
  });

  it('counts a patch applied in a sibling', () => {
    const events = [
      {
        id: 'p',
        timestamp: 0,
        kind: {
          type: 'patchApply',
          info: {
            id: 'p',
            success: true,
            files: [{ id: 'f', path: '/code/acme/acme-infra/main.tf', kind: 'modify', additions: 1, deletions: 0 }],
          },
        },
      } as unknown as StreamEvent,
    ];
    expect(siblingProjectsTouched(web, all, events)).toEqual([{ project: infra, file: 'main.tf' }]);
  });

  it('ignores reading a sibling and commands that only name one', () => {
    // A git client's agent runs `git -C` over every repo it manages; that is
    // its job, not cross-repo work.
    const events = [
      tool({ file_path: '/code/acme/acme-api/src/login.ts' }, undefined, 'Read'),
      tool({ command: 'git -C /code/acme/acme-infra status' }, undefined, 'Bash'),
    ];
    expect(siblingProjectsTouched(web, all, events)).toEqual([]);
  });

  it('ignores an @mention: @ means a file to the composer and the CLIs', () => {
    expect(siblingProjectsTouched(web, all, [typed('also update @acme-api please')])).toEqual([]);
  });

  it('ignores the conversation’s own folder and nested projects', () => {
    const events = [
      tool({ file_path: '/code/acme/acme-web/src/app.ts' }),
      tool({ file_path: '/code/acme/acme-web/packages/ui/button.tsx' }),
    ];
    expect(siblingProjectsTouched(web, all, events)).toEqual([]);
  });

  it('does not mistake a shared prefix for a sibling', () => {
    const events = [tool({ path: '/code/acme/acme-api-old/readme.md' }, undefined, 'Write')];
    expect(siblingProjectsTouched(web, all, events)).toEqual([]);
  });

  it('survives malformed tool input', () => {
    const bad = tool({});
    (bad.kind as { info: { toolUses: { inputJSON: string }[] } }).info.toolUses[0].inputJSON = '{nope';
    expect(siblingProjectsTouched(web, all, [bad])).toEqual([]);
  });
});
