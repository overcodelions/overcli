// Deploying a worker to CI. Lifted out of WorkersPane.tsx when the preview
// moved into a modal — see ../CiDeployModal.tsx for why it is a modal and not
// a card, and ../flows/FlowDeployCard.tsx for the flow twin.
//
// A worker needs less configuration than a flow: no prompt (it plans its own
// shift) and no project picker (it already has a projectPath). Just the
// target.

import { useState } from 'react';

import type { Worker } from '@shared/flows/worker';
import { useWorkersStore } from '../../workersStore';
import { CiDeployModal, type CiDeployPlanView, type CiDeployWriteResult } from '../CiDeployModal';

type Target = 'github' | 'jenkins';

export function WorkerDeployCard({ worker }: { worker: Worker }) {
  const ciDeploy = useWorkersStore((s) => s.ciDeploy);
  const ciDeployWrite = useWorkersStore((s) => s.ciDeployWrite);

  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Target>('github');
  const [plan, setPlan] = useState<CiDeployPlanView | null>(null);
  const [written, setWritten] = useState<CiDeployWriteResult | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = 'rounded-md border border-accent/50 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/10';
  const unselected = 'rounded-md border border-card-strong px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink';

  return (
    <>
      <div className="rounded-xl border border-card-strong p-3">
        <div className="flex items-center gap-2">
          <div className="text-[11px] uppercase tracking-wider text-ink-faint">Deploy to CI</div>
          <button
            onClick={() => setOpen(true)}
            className="ml-auto text-[11px] text-accent hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 rounded"
          >
            Set up…
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-muted">
          Work its shifts on GitHub Actions or Jenkins instead of this machine — its cadence becomes
          the schedule, its trust becomes the permission policy.
        </p>
      </div>

      {open && (
        <CiDeployModal
          title={`Deploy ${worker.name} to CI`}
          subtitle="Writes the worker bundle and a pipeline file into its project. Overcli writes them; committing and pushing is yours."
          canPreview
          plan={plan}
          written={written}
          busy={busy}
          onClose={() => setOpen(false)}
          onPreview={() => {
            setBusy(true);
            setWritten(null);
            void ciDeploy(worker.id, target)
              .then((res) => setPlan(res))
              .finally(() => setBusy(false));
          }}
          onWrite={() => {
            setBusy(true);
            void ciDeployWrite(worker.id, target)
              .then(setWritten)
              .finally(() => setBusy(false));
          }}
          configSlot={
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => {
                  setTarget('github');
                  setPlan(null);
                  setWritten(null);
                }}
                className={target === 'github' ? selected : unselected}
              >
                GitHub Actions
              </button>
              <button
                onClick={() => {
                  setTarget('jenkins');
                  setPlan(null);
                  setWritten(null);
                }}
                className={target === 'jenkins' ? selected : unselected}
              >
                Jenkins
              </button>
            </div>
          }
        />
      )}
    </>
  );
}
