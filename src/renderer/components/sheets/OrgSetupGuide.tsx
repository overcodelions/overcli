// How to run workers for a whole team: the org server, three ways. On this
// Mac the app starts it for you, so trying the org setup takes one button and
// no clone. On AWS and Google Cloud it is a launch, not a recipe — the full
// guides live in the repo's deploy/ folder for anyone who wants the details.

import { useEffect, useState } from 'react';
import type { AppSettings, LocalOrgServerStatus } from '@shared/types';
import { Row } from './settingsChrome';

const DOCS = 'https://github.com/overcodelions/overcli/blob/master/deploy';
/// The CloudFormation template, once it is published to S3. Until then the
/// AWS card opens the guide that explains the launch.
const AWS_TEMPLATE_URL: string | null = null;

const open = (url: string) => void window.overcli.invoke('app:openExternal', url);

export function OrgSetupGuide({ local, patch }: { local: AppSettings; patch: (p: Partial<AppSettings>) => void }) {
  const [srv, setSrv] = useState<LocalOrgServerStatus | null>(null);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    void window.overcli.invoke('org:localServer', 'status').then(setSrv);
  }, []);

  const start = async () => {
    setSrv((s) => (s ? { ...s, starting: true, error: null } : s));
    const next = await window.overcli.invoke('org:localServer', 'start');
    setSrv(next);
    // Point the app at it, so publishing a worker goes to the server just made.
    if (next.url && !local.orgServerUrl) patch({ orgServerUrl: next.url });
  };
  const stop = async () => setSrv(await window.overcli.invoke('org:localServer', 'stop'));
  const signIn = () => {
    if (!srv?.firstAdminLink) return;
    open(srv.firstAdminLink);
    void window.overcli.invoke('org:localServer', 'linkUsed').then(setSrv);
  };
  const awsLaunch = () =>
    open(
      AWS_TEMPLATE_URL
        ? `https://console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?templateURL=${encodeURIComponent(AWS_TEMPLATE_URL)}&stackName=overcli-org`
        : `${DOCS}/aws/README.md`,
    );

  // Already signed in to a server that isn't the one this app started: say so,
  // rather than invite a second one.
  const elsewhere = local.orgServerUrl && (!srv?.url || local.orgServerUrl !== srv.url) ? local.orgServerUrl : null;

  return (
    <Row
      label="Run a server"
      help="A server runs your team’s workers around the clock: managers answer them in Slack, people use them from a web console or Claude, and you publish workers you build here to it."
    >
      <div className="flex flex-col divide-y divide-card rounded border border-card">
        <Option
          title="This Mac"
          note={
            srv?.running
              ? `Running at ${srv.url?.replace(/^http:\/\//, '')}, while the app is open.`
              : elsewhere
                ? `You’re signed in to ${elsewhere.replace(/^https?:\/\//, '')}. Start one here only to try things.`
                : 'To try it. Runs while the app is open, kept in ~/overcli-org.'
          }
          alpha={false}
        >
          {srv?.running ? (
            <>
              {srv.firstAdminLink ? (
                <Action onClick={signIn}>Sign in as first admin</Action>
              ) : (
                <Action onClick={() => srv.url && open(srv.url)}>Open console</Action>
              )}
              {srv.url && local.orgServerUrl !== srv.url && <Action onClick={() => patch({ orgServerUrl: srv.url! })}>Use it</Action>}
              <Action onClick={() => void stop()} quiet>
                Stop
              </Action>
            </>
          ) : (
            <Action onClick={() => void start()} disabled={srv?.starting}>
              {srv?.starting ? 'Starting…' : 'Start a server'}
            </Action>
          )}
        </Option>
        <Option title="AWS" note="One EC2 instance in a private subnet, a disk with daily snapshots, Claude through Bedrock." alpha>
          <Action onClick={awsLaunch}>{AWS_TEMPLATE_URL ? 'Launch…' : 'How to launch'}</Action>
        </Option>
        <Option title="Google Cloud" note="One VM with no public IP, a disk with snapshots, Claude through Vertex AI." alpha>
          <Action onClick={() => open(`${DOCS}/gcp.md`)}>How to set up</Action>
        </Option>
      </div>
      {srv?.error && (
        <div className="mt-2 text-[11px] text-red-400" role="alert">
          {srv.error}{' '}
          <button className="underline" onClick={() => setShowLog(!showLog)}>
            {showLog ? 'Hide' : 'Show'} its output
          </button>
        </div>
      )}
      {showLog && srv && srv.log.length > 0 && (
        <pre className="mt-2 max-h-48 overflow-auto rounded border border-card bg-card/60 p-2 text-[10.5px] leading-relaxed text-ink-muted">{srv.log.join('\n')}</pre>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <button className="text-accent hover:underline" onClick={() => open(`${DOCS}/README.md`)}>
          Docker on any server
        </button>
        <button className="text-accent hover:underline" onClick={() => open(`${DOCS}/docs/admins.md#setup--tools`)}>
          Giving workers tools
        </button>
        <button className="text-accent hover:underline" onClick={() => open(`${DOCS}/docs/README.md`)}>
          All the docs
        </button>
      </div>
    </Row>
  );
}

/// One way to run the server: what it is in a line, its action on the right.
function Option({ title, note, alpha, children }: { title: string; note: string; alpha: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs font-medium text-ink">
          {title}
          {alpha && <span className="text-[9px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">alpha</span>}
        </div>
        <div className="mt-0.5 text-[11px] leading-snug text-ink-muted">{note}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

/// The sheet's plain button, as "Choose what to publish…" is.
function Action({ onClick, disabled, quiet, children }: { onClick: () => void; disabled?: boolean; quiet?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        'whitespace-nowrap rounded px-3 py-1.5 text-xs disabled:opacity-50 ' +
        (quiet ? 'text-ink-muted hover:text-ink' : 'border border-card text-ink hover:bg-card-strong')
      }
    >
      {children}
    </button>
  );
}
