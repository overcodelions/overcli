// How to run workers for a whole team: the org server, in a few steps, for
// trying it on this Mac, on AWS, or on Google Cloud. The full guides live in
// the repo's deploy/ folder; this is the short version, in the app where
// someone who has built a few workers goes looking for "now for my team".

import { useState } from 'react';

const DOCS = 'https://github.com/overcodelions/overcli/blob/master/deploy';

type Where = 'try' | 'aws' | 'gcp';

const STEPS: Record<Where, Array<{ text: string; code?: string }>> = {
  try: [
    { text: 'Try it on this Mac first, from a clone of the overcli repo. Nothing leaves this machine.' },
    { text: 'Build and start the server, with its own state folder:', code: 'npm ci && npm run build:main\nnode dist/cli/index.js serve --state-dir ~/overcli-org --control 7420' },
    { text: 'It prints a one-time link: open it to sign in as the first admin. Then, above, paste http://127.0.0.1:7420 and press Sign in.' },
    { text: 'Publish a worker from its Share card, and ask it something from the console. Add Slack later (Settings → Slack, or the bot tokens in the server’s environment).' },
    { text: 'On this Mac the server shares your own Claude setup: tools installed from its console go into your ~/.claude.json, and its workers can use the tools you already have. A real server keeps its own.' },
  ],
  aws: [
    { text: 'One EC2 instance in a private subnet, with the state folder on an EBS volume that is snapshotted daily. Bedrock for the model, so no API key sits on the box.' },
    { text: 'Build the image and push it to ECR:', code: 'docker build -f deploy/Dockerfile -t <acct>.dkr.ecr.<region>.amazonaws.com/overcli-org:<version> .\ndocker push <acct>.dkr.ecr.<region>.amazonaws.com/overcli-org:<version>' },
    { text: 'On the instance, with the EBS volume mounted at /srv/overcli-data:', code: 'export OVERCLI_DATA=/srv/overcli-data\ndocker compose -f deploy/docker-compose.yml up -d' },
    { text: 'An internal load balancer with a certificate in front, then set its address as the console address on Admin → Rules. The container can be replaced any time: everything lives on the volume.' },
  ],
  gcp: [
    { text: 'One Compute Engine VM with no public IP, the state folder on a persistent disk with a snapshot schedule, and Vertex AI for the model.' },
    { text: 'Build the image and push it to Artifact Registry:', code: 'docker build -f deploy/Dockerfile -t <region>-docker.pkg.dev/<project>/overcli/overcli-org:<version> .\ndocker push <region>-docker.pkg.dev/<project>/overcli/overcli-org:<version>' },
    { text: 'On the VM, with the disk mounted at /srv/overcli-data:', code: 'export OVERCLI_DATA=/srv/overcli-data\ndocker compose -f deploy/docker-compose.yml up -d' },
    { text: 'An internal load balancer with a certificate in front, then set its address as the console address on Admin → Rules.' },
  ],
};

const GUIDE: Record<Where, string> = { try: 'README.md', aws: 'aws.md', gcp: 'gcp.md' };

export function OrgSetupGuide() {
  const [open, setOpen] = useState(false);
  const [where, setWhere] = useState<Where>('try');
  const [copied, setCopied] = useState<number | null>(null);
  return (
    <div className="rounded-lg border border-card-strong bg-card/50 px-3 py-2.5">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left text-xs text-ink">
        <span className="text-ink-faint">{open ? '▾' : '▸'}</span>
        <span className="font-medium">Run workers for your team</span>
        <span className="rounded-full border border-card-strong px-1.5 text-[9px] uppercase tracking-wider text-ink-faint">alpha</span>
        <span className="ml-auto text-[11px] text-ink-faint">set up a server</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-[11px] leading-relaxed text-ink-muted">
            A server runs your team&apos;s workers around the clock: managers answer them in Slack, people use them from a web
            console or Claude, and you publish workers you build here to it. It is early — expect rough edges.
          </p>
          <div role="tablist" aria-label="Where to run it" className="flex gap-1">
            {(['try', 'aws', 'gcp'] as const).map((w) => (
              <button
                key={w}
                role="tab"
                aria-selected={where === w}
                onClick={() => setWhere(w)}
                className={
                  'rounded px-2 py-1 text-[11px] ' + (where === w ? 'bg-card-strong text-ink' : 'text-ink-muted hover:text-ink')
                }
              >
                {w === 'try' ? 'Try it on this Mac' : w === 'aws' ? 'AWS' : 'Google Cloud'}
              </button>
            ))}
          </div>
          <ol className="space-y-2.5">
            {STEPS[where].map((step, i) => (
              <li key={`${where}-${i}`} className="space-y-1.5">
                <div className="text-[11px] leading-relaxed text-ink-muted">{step.text}</div>
                {step.code && (
                  <div className="relative">
                    <pre className="overflow-x-auto rounded bg-surface px-2.5 py-2 pr-16 font-mono text-[10.5px] text-ink">{step.code}</pre>
                    <button
                      onClick={() => {
                        void navigator.clipboard.writeText(step.code!);
                        setCopied(i);
                        window.setTimeout(() => setCopied(null), 1500);
                      }}
                      className="absolute right-1.5 top-1.5 rounded border border-card-strong px-1.5 py-0.5 text-[10px] text-ink-muted hover:text-ink"
                    >
                      {copied === i ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
            <button className="text-accent hover:underline" onClick={() => void window.overcli.invoke('app:openExternal', `${DOCS}/${GUIDE[where]}`)}>
              The full guide
            </button>
            <button className="text-accent hover:underline" onClick={() => void window.overcli.invoke('app:openExternal', `${DOCS}/README.md#tools-mcp-servers`)}>
              Giving workers tools on the server
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
