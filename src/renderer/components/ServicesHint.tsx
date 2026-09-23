import { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { Project } from '@shared/types';

/// What each runner is, in words someone who has never opened a Tiltfile uses.
const RUNNER_WORDS: Record<string, string> = {
  npm: 'dev server',
  vite: 'dev server',
  'ng-serve': 'dev server',
  'docker-compose': 'docker compose',
  'spring-boot': 'Spring Boot app',
  gradle: 'Gradle app',
  python: 'Python app',
  go: 'Go app',
};

/// Per path for the session: the answer only changes when the repo does, and
/// the start page re-renders far more often than that.
const peeked = new Map<string, { name: string; runner: string }[]>();

/// Services is off until asked for, and nothing used to say it existed. This
/// card is the discovery: on a project whose files show something runnable
/// (a dev script, a compose file, a Spring Boot app), say so once, in plain
/// words, and offer to turn it on. "Not now" is per project.
export function ServicesHint({ project }: { project: Project }) {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const setDetailMode = useStore((s) => s.setDetailMode);
  const [found, setFound] = useState(() => peeked.get(project.path) ?? null);

  const dismissed = (settings.servicesHintDismissed ?? []).includes(project.path);
  const relevant = !settings.servicesEnabled && !dismissed;

  useEffect(() => {
    if (!relevant) return;
    const cached = peeked.get(project.path);
    if (cached) {
      setFound(cached);
      return;
    }
    let cancelled = false;
    void window.overcli
      .invoke('services:peek', { path: project.path, name: project.name })
      .catch(() => [])
      .then((res) => {
        peeked.set(project.path, res);
        if (!cancelled) setFound(res);
      });
    return () => {
      cancelled = true;
    };
  }, [relevant, project.path, project.name]);

  if (!relevant || !found || found.length === 0) return null;

  const shown = found.slice(0, 3).map((f) => {
    const what = RUNNER_WORDS[f.runner];
    return what && what !== f.name ? `${f.name} (${what})` : f.name;
  });
  const more = found.length > 3 ? ` and ${found.length - 3} more` : '';

  const dismiss = () =>
    void saveSettings({
      ...settings,
      servicesHintDismissed: [...(settings.servicesHintDismissed ?? []), project.path],
    });
  const turnOn = async () => {
    await saveSettings({ ...settings, servicesEnabled: true });
    setDetailMode('services');
  };

  return (
    <div className="mb-4 rounded-lg border border-accent/40 bg-accent/5 px-4 py-3 text-left flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-ink">
          {project.name} has things it can run: {shown.join(', ')}
          {more}.
        </div>
        <div className="text-[11px] text-ink-muted mt-0.5">
          Overcli can start and stop them for you, on whichever branch you are working on, and
          keep their logs in one place.
        </div>
      </div>
      <button
        onClick={dismiss}
        className="shrink-0 px-2.5 py-1 rounded text-xs text-ink-muted hover:text-ink hover:bg-card-strong"
      >
        Not now
      </button>
      <button
        onClick={() => void turnOn()}
        className="shrink-0 px-2.5 py-1 rounded text-xs border bg-accent/30 border-accent/60 text-accent hover:bg-accent/40"
      >
        Turn on Services
      </button>
    </div>
  );
}
