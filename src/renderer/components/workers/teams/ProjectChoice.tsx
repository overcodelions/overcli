// Where a team works: one of your projects or workspaces, or nowhere in
// particular — each member in their own. Shared by the team editor (the
// team's project) and the brief box (one task's).

import { useMemo } from "react";

import { useStore } from "../../../store";

export interface ProjectOption {
  name: string;
  path: string;
  kind: "workspace" | "project";
}

/// Workspaces first, as main lists them to the drafters.
export function useProjectOptions(): ProjectOption[] {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  return useMemo(
    () => [
      ...workspaces.map((w) => ({ name: w.name, path: w.rootPath, kind: "workspace" as const })),
      ...projects.map((p) => ({ name: p.name, path: p.path, kind: "project" as const })),
    ],
    [projects, workspaces],
  );
}

export function projectName(options: ProjectOption[], path: string | undefined): string | undefined {
  if (!path) return undefined;
  return options.find((o) => o.path === path)?.name ?? path.split(/[\\/]/).filter(Boolean).pop();
}

export function ProjectSelect({
  id,
  value,
  onChange,
  noneLabel,
  className,
}: {
  id: string;
  value: string;
  onChange: (path: string) => void;
  /// What the empty choice means here.
  noneLabel: string;
  className?: string;
}) {
  const options = useProjectOptions();
  const workspaces = options.filter((o) => o.kind === "workspace");
  const projects = options.filter((o) => o.kind === "project");
  // A project removed since it was chosen stays visible rather than
  // silently reading as "none".
  const missing = value && !options.some((o) => o.path === value);
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">{noneLabel}</option>
      {missing && <option value={value}>{projectName(options, value)} (no longer in Overcli)</option>}
      {workspaces.length > 0 && (
        <optgroup label="Workspaces">
          {workspaces.map((o) => (
            <option key={o.path} value={o.path}>
              {o.name}
            </option>
          ))}
        </optgroup>
      )}
      {projects.length > 0 && (
        <optgroup label="Projects">
          {projects.map((o) => (
            <option key={o.path} value={o.path}>
              {o.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
