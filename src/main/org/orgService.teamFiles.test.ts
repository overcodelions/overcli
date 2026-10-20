import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { Worker } from '../../shared/flows/worker';
import { DEFAULT_ORG_POLICY, type OrgCaller } from '../../shared/org/policy';
import { OrgService } from './orgService';
import type { Rating } from './orgStores';
import type { ToolCall } from './mcpDirect';
import { buildZip, readZip } from './zip';
import { classifyServer, pickUploadTool, uploadArgs } from './teamFiles';

const PAT = 'U0ACMEPAT';
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };
const sam: OrgCaller = { slackUserId: 'U0ACMESAM', name: 'Sam', admin: false };

const triage: Worker = {
  id: 'triage',
  name: 'Triage',
  jobDescription: 'Scores roadmap items for delivery risk.',
  projectPath: '/data/Workers',
  cadence: null,
  trust: 'probation',
  caps: { maxItemsPerShift: 1, runIn: 'worktree', allowExternalActions: false } as Worker['caps'],
  budgetUSDPerMonth: 20,
  heartbeatModel: 'sonnet',
  flowIds: ['triage-flow'],
  enabled: true,
  createdAt: 0,
  manager: { name: 'Pat', slackUserId: PAT },
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function folder(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-team-task-'));
  dirs.push(root);
  const put = (name: string, body: string | Buffer, mtime: number) => {
    const abs = path.join(root, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    fs.utimesSync(abs, mtime / 1000, mtime / 1000);
  };
  put('brief.md', 'Rank the Acme roadmap.', 1_000_000);
  put('plan.md', '# The plan\nScore, then write it up.', 2_000_000);
  put('pieces/triage.md', '# Delivery scores\nSee https://tracker.acme.test/board/7 for the board.', 3_000_000);
  put('files/triage/scores.csv', 'item,score\nsearch,3\n', 4_000_000);
  put('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]), 500_000);
  put('.scratch', 'hidden', 5_000_000);
  put('.cache/x.md', 'hidden too', 5_000_000);
  return root;
}

interface Opts {
  tools?: string[];
  schemas?: Record<string, Array<{ name: string; inputSchema?: unknown }>>;
  call?: (server: string, tool: string, args: Record<string, unknown>) => Promise<ToolCall>;
}

function harness(opts: Opts = {}) {
  const root = folder();
  const task = {
    id: 'task-1',
    teamId: 'team-1',
    teamName: 'Council',
    brief: 'Rank the roadmap',
    title: 'Roadmap ranking: Q3!',
    status: 'running',
    createdAt: 500,
    updatedAt: 2_000,
    stageIndex: 1,
    spentUSD: 0.2,
    budgetUSD: 40,
    folder: root,
    requestedBy: { name: 'Pat', slackUserId: PAT },
    files: [
      { name: 'brief.md', author: 'You', at: 1 },
      { name: 'plan.md', author: 'Coordinator', stage: 0, at: 2 },
      { name: 'pieces/triage.md', author: 'Triage', stage: 1, at: 3 },
      { name: 'files/triage/scores.csv', author: 'Triage', stage: 1, at: 4 },
    ],
    stages: [
      { kind: 'draft', title: 'Plan it', status: 'done', file: 'plan.md', assignments: [] },
      { kind: 'contribute', title: 'Score it', status: 'running', assignments: [{ workerId: 'triage', workerName: 'Triage', ask: 'Score each item for delivery risk.', status: 'done', file: 'pieces/triage.md' }] },
    ],
  };
  let ratings: Rating[] = [];
  const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
  const audit: string[] = [];
  const svc = new OrgService({
    workers: {
      roster: () => [triage],
      get: (id) => (id === triage.id ? triage : null),
      save: (w) => ({ ok: true, worker: w }),
      setEnabled: () => ({ ok: true }),
      remove: () => ({ ok: true }),
      runErrand: async () => ({ ok: false, error: 'no' }),
      journalFor: () => [],
      spentThisMonth: () => new Map(),
      workerNames: () => [triage.name],
    },
    runs: { listRuns: () => [], getRun: () => null, steerRun: () => ({ ok: true }), resumeRun: () => ({ ok: true }) },
    rejectRun: () => ({ ok: true }),
    policy: () => ({ ...DEFAULT_ORG_POLICY, hirers: '*' }),
    draft: async () => ({ ok: false, error: 'no' }),
    saveHire: () => ({ ok: false, error: 'no' }),
    hires: { list: () => [], save: () => {} },
    teams: {
      list: () => ({
        teams: [{ id: 'team-1', name: 'Council', purpose: 'Rank things', budgetUSDPerTask: 40, members: [{ workerId: 'triage', role: 'delivery' }], createdAt: 0 }],
        tasks: [task],
      }) as never,
      brief: () => ({ ok: false, error: 'no' }),
      answer: () => ({ ok: true }),
      approve: () => ({ ok: true }),
      revise: () => ({ ok: true }),
      continueTask: () => ({ ok: true }),
      cancel: () => ({ ok: true }),
    },
    tools: {
      list: () => ({ tools: (opts.tools ?? []).map((name) => ({ name, kind: 'command' as const, target: 'npx', secrets: [], usedBy: [] })), missing: [] }),
      install: () => ({ ok: true }),
      uninstall: () => ({ ok: true }),
      check: async () => null,
    },
    serverToolSchemas: async (name) => ({ ok: true, tools: opts.schemas?.[name] ?? [] }),
    callServerTool: async (server, tool, args) => {
      calls.push({ server, tool, args });
      return opts.call ? opts.call(server, tool, args) : { ok: true, text: 'done', json: null };
    },
    ratings: { list: () => ratings, save: (r) => (ratings = structuredClone(r)) },
    audit: { append: (e) => audit.push(e.what), recent: () => [], all: () => [] },
    now: () => 9_000_000,
  });
  return { svc, root, calls, audit, ratings: () => ratings };
}

describe('a team task page', () => {
  it('is the same task the team page shows, with its team, for people who can see it', () => {
    const h = harness();
    const page = h.svc.teamTaskPage(pat, 'task-1');
    const team = h.svc.teamPage(pat, 'council');
    if (!page.ok || !team.ok) throw new Error('not visible');
    expect(page.task).toEqual(team.tasks[0]);
    expect(page.team).toEqual({ id: 'team-1', name: 'Council', purpose: 'Rank things', members: team.team.members });
    expect(h.svc.teamTaskPage(sam, 'task-1')).toEqual({ ok: false, error: 'No team task with that id.' });
    expect(h.svc.teamTaskPage(pat, 'nope').ok).toBe(false);
  });
});

describe("a team task's files", () => {
  it('lists the folder newest first, skipping hidden files, with who wrote each and in which stage', async () => {
    const h = harness();
    const res = await h.svc.teamTaskFiles(pat, 'task-1');
    if (!res.ok) throw new Error(res.error);
    expect(res.files.map((f) => f.name)).toEqual(['files/triage/scores.csv', 'pieces/triage.md', 'plan.md', 'brief.md', 'logo.png']);
    const by = Object.fromEntries(res.files.map((f) => [f.name, [f.writtenBy, f.stage]]));
    expect(by['pieces/triage.md']).toEqual([{ workerId: 'triage', name: 'Triage' }, { index: 2, title: 'Score it' }]);
    expect(by['files/triage/scores.csv']).toEqual([{ workerId: 'triage', name: 'Triage' }, { index: 2, title: 'Score it' }]);
    expect(by['plan.md']).toEqual([null, { index: 1, title: 'Plan it' }]);
    expect(by['brief.md']).toEqual([null, null]);
    expect(by['logo.png']).toEqual([null, null]);
    expect(res.files[0]).toMatchObject({ size: 20, modifiedAt: 4_000_000, kept: { library: false, saved: [] } });
    // No storage tool: the Library, and Drive and SharePoint to connect.
    expect(res.destinations).toEqual([
      { id: 'library', label: 'Library', kind: 'library', ready: true },
      { id: 'drive', label: 'Google Drive', kind: 'drive', ready: false, why: 'Install a Google Drive tool on Setup → Tools' },
      { id: 'sharepoint', label: 'SharePoint', kind: 'sharepoint', ready: false, why: 'Install a SharePoint or OneDrive tool on Setup → Tools' },
    ]);
    expect(await h.svc.teamTaskFiles(sam, 'task-1')).toEqual({ ok: false, error: 'No team task with that id.' });
  });

  it('offers an installed Drive with an upload call, and says why a SharePoint without one is not ready', async () => {
    const h = harness({
      tools: ['gdrive', 'onedrive-acme', 'tracker'],
      schemas: { gdrive: [{ name: 'search_files' }, { name: 'create_file' }], 'onedrive-acme': [{ name: 'list_items' }] },
    });
    const res = await h.svc.teamTaskFiles(pat, 'task-1');
    if (!res.ok) throw new Error(res.error);
    expect(res.destinations).toEqual([
      { id: 'library', label: 'Library', kind: 'library', ready: true },
      { id: 'mcp:gdrive', label: 'Google Drive (Gdrive)', kind: 'drive', ready: true },
      { id: 'mcp:onedrive-acme', label: 'SharePoint (Onedrive Acme)', kind: 'sharepoint', ready: false, why: 'Onedrive Acme has no tool that uploads a file.' },
    ]);
  });

  it('keeps files in the Library once, where they can be found and rated', () => {
    const h = harness();
    expect(h.svc.keepTeamFiles(pat, 'task-1', ['pieces/triage.md', 'plan.md'])).toEqual({ ok: true, kept: 2 });
    expect(h.svc.keepTeamFiles(pat, 'task-1', ['pieces/triage.md'])).toEqual({ ok: true, kept: 0 });
    expect(h.svc.keepTeamFiles(pat, 'task-1', ['../../etc/passwd']).ok).toBe(false);
    expect(h.svc.keepTeamFiles(pat, 'task-1', ['.scratch']).ok).toBe(false);
    expect(h.svc.keepTeamFiles(sam, 'task-1', ['plan.md']).ok).toBe(false);
    const files = h.svc.library(pat).filter((x) => x.kind === 'file');
    expect(files).toHaveLength(2);
    const piece = files.find((x) => x.title === 'Delivery scores')!;
    expect(piece).toMatchObject({
      kind: 'file',
      workerId: 'triage',
      workerName: 'Triage',
      at: 9_000_000,
      status: 'delivered',
      links: ['https://tracker.acme.test/board/7'],
      source: { kind: 'team', teamId: 'team-1', teamName: 'Council', taskId: 'task-1', file: 'pieces/triage.md' },
    });
    expect(piece.id).toMatch(/^file:/);
    expect(piece.body).toContain('# Delivery scores');
    expect(files.find((x) => x.title === 'The plan')).toMatchObject({ workerId: '', workerName: 'Council' });
    expect(h.svc.library(pat, { workerId: 'triage' }).filter((x) => x.kind === 'file')).toHaveLength(1);
    expect(h.svc.library(sam).filter((x) => x.kind === 'file')).toEqual([]);

    expect(h.svc.rate(pat, { entryId: piece.id, useful: true, note: 'Spot on' })).toEqual({ ok: true });
    expect(h.ratings()).toMatchObject([{ entryId: piece.id, workerId: 'triage', useful: true, note: 'Spot on', by: 'Pat' }]);
    expect(h.svc.library(pat).find((x) => x.id === piece.id)?.rating).toEqual({ useful: true, by: 'Pat' });
    expect(h.svc.rate(sam, { entryId: piece.id, useful: false }).ok).toBe(false);

    // The listing knows what is kept.
    return h.svc.teamTaskFiles(pat, 'task-1').then((res) => {
      if (!res.ok) throw new Error(res.error);
      expect(res.files.find((f) => f.name === 'plan.md')?.kept.library).toBe(true);
      expect(res.files.find((f) => f.name === 'brief.md')?.kept.library).toBe(false);
    });
  });

  it('saves to the Library like keeping does', async () => {
    const h = harness();
    expect(await h.svc.saveTeamFiles(pat, 'task-1', ['plan.md', 'nope.md'], 'library')).toEqual({
      ok: true,
      saved: [{ name: 'plan.md' }],
      failed: [{ name: 'nope.md', error: 'No such file in this task.' }],
    });
    expect(h.svc.library(pat).filter((x) => x.kind === 'file').map((x) => x.title)).toEqual(['The plan']);
  });

  it("saves to a Drive through its upload tool, filling the arguments from the tool's schema", async () => {
    const h = harness({
      tools: ['gdrive'],
      schemas: {
        gdrive: [
          {
            name: 'upload_file',
            inputSchema: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' }, mimeType: { type: 'string' }, folderId: { type: 'string' } }, required: ['name', 'content'] },
          },
        ],
      },
      call: async (_s, _t, args) =>
        args.name === 'scores.csv' ? { ok: false, error: 'Quota exceeded' } : { ok: true, text: 'Created file. View it at https://drive.acme.test/file/abc123', json: null },
    });
    const res = await h.svc.saveTeamFiles(pat, 'task-1', ['pieces/triage.md', 'files/triage/scores.csv', 'logo.png'], 'mcp:gdrive');
    expect(res).toEqual({
      ok: true,
      saved: [{ name: 'pieces/triage.md', link: 'https://drive.acme.test/file/abc123' }],
      failed: [
        { name: 'files/triage/scores.csv', error: 'Quota exceeded' },
        { name: 'logo.png', error: 'Only text files can be saved to Google Drive (Gdrive) for now.' },
      ],
    });
    expect(h.calls[0]).toEqual({ server: 'gdrive', tool: 'upload_file', args: { name: 'triage.md', content: expect.stringContaining('# Delivery scores'), mimeType: 'text/markdown' } });
    expect(h.calls[1].args.mimeType).toBe('text/csv');
    const listed = await h.svc.teamTaskFiles(pat, 'task-1');
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.files.find((f) => f.name === 'pieces/triage.md')?.kept.saved).toEqual([
      { destination: 'mcp:gdrive', label: 'Google Drive (Gdrive)', at: 9_000_000, link: 'https://drive.acme.test/file/abc123' },
    ]);
    expect(h.audit.at(-1)).toContain('to Google Drive (Gdrive)');
  });

  it('names the arguments it cannot fill, and never throws on a tool that does', async () => {
    const h = harness({
      tools: ['sharepoint'],
      schemas: { sharepoint: [{ name: 'upload_document', inputSchema: { properties: { siteId: {}, fileName: {}, text: {} }, required: ['siteId', 'fileName', 'text'] } }] },
    });
    expect(await h.svc.saveTeamFiles(pat, 'task-1', ['plan.md'], 'mcp:sharepoint')).toEqual({
      ok: true,
      saved: [],
      failed: [{ name: 'plan.md', error: "upload_document on sharepoint also needs siteId, which overcli can't fill in." }],
    });
    expect(h.calls).toEqual([]);

    const boom = harness({
      tools: ['gdrive'],
      schemas: { gdrive: [{ name: 'upload_file' }] },
      call: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(await boom.svc.saveTeamFiles(pat, 'task-1', ['plan.md'], 'mcp:gdrive')).toEqual({ ok: true, saved: [], failed: [{ name: 'plan.md', error: 'socket hang up' }] });
    expect((await boom.svc.saveTeamFiles(pat, 'task-1', ['plan.md'], 'sharepoint')) as unknown).toEqual({ ok: false, error: 'Install a SharePoint or OneDrive tool on Setup → Tools' });
    expect((await boom.svc.saveTeamFiles(sam, 'task-1', ['plan.md'], 'mcp:gdrive')).ok).toBe(false);
  });

  it('downloads the whole folder as a zip named after the task', () => {
    const h = harness();
    const res = h.svc.teamTaskZip(pat, 'task-1');
    if (!res.ok) throw new Error(res.error);
    expect(res.filename).toBe('roadmap-ranking-q3.zip');
    const entries = readZip(res.data);
    expect(entries.map((e) => e.name).sort()).toEqual(['brief.md', 'files/triage/scores.csv', 'logo.png', 'pieces/triage.md', 'plan.md']);
    expect(entries.find((e) => e.name === 'plan.md')?.data.toString()).toBe('# The plan\nScore, then write it up.');
    expect(h.svc.teamTaskZip(sam, 'task-1').ok).toBe(false);
  });
});

describe('the zip writer', () => {
  it('round-trips through its central directory, and through unzip when there is one', () => {
    const files = [
      { name: 'a.txt', data: Buffer.from('hello acme') },
      { name: 'dir/ü.md', data: Buffer.from('# Ünïcode') },
      { name: 'empty', data: Buffer.alloc(0) },
    ];
    const zip = buildZip(files.map((f) => ({ ...f, modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 6) })));
    expect(readZip(zip).map((e) => [e.name, e.data.toString()])).toEqual(files.map((f) => [f.name, f.data.toString()]));
    let unzip = true;
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    } catch {
      unzip = false;
    }
    if (!unzip) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-zip-'));
    dirs.push(dir);
    const file = path.join(dir, 'out.zip');
    fs.writeFileSync(file, zip);
    // -t checks every CRC.
    expect(execFileSync('unzip', ['-t', file], { encoding: 'utf8' })).toContain('No errors detected');
    expect(execFileSync('unzip', ['-l', file], { encoding: 'utf8' })).toContain('a.txt');
  });
});

describe('storage tools', () => {
  it('reads a server as a Drive or SharePoint, and picks its upload call', () => {
    expect(classifyServer('gdrive')).toBe('drive');
    expect(classifyServer('claude_ai_Google_Drive')).toBe('drive');
    expect(classifyServer('onedrive')).toBe('sharepoint');
    expect(classifyServer('ms-graph')).toBe('sharepoint');
    expect(classifyServer('tracker')).toBeNull();
    expect(pickUploadTool([{ name: 'write_file' }, { name: 'upload' }])?.name).toBe('upload');
    expect(pickUploadTool([{ name: 'search' }])).toBeNull();
    expect(uploadArgs({ properties: { title: {}, body: {}, contentType: {} }, required: ['title'] }, 'out/report.html', '<p>x</p>')).toEqual({
      args: { title: 'report.html', body: '<p>x</p>', contentType: 'text/html' },
      missing: [],
    });
  });
});
