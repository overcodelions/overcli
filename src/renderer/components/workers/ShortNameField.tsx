import { useState } from "react";
import type { Team } from "../../../shared/flows/team";
import { SHORT_NAME_MAX, resolveShortNames, suggestShortName } from "../../../shared/shortName";

/// A team's or process's short name. Left empty, its initials are used.
export function ShortNameField({
  id,
  value,
  name,
  command,
  onChange,
}: {
  id: string;
  value: string;
  /// Its full name, the initials come from.
  name: string;
  command: "/idea" | "/team";
  onChange: (next: string) => void;
}) {
  const short = value.trim();
  const auto = short ? "" : suggestShortName(name);
  const shown = short || auto;
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
      <label htmlFor={id}>Short name</label>
      <input
        id={id}
        value={value}
        maxLength={SHORT_NAME_MAX}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value.toLowerCase().replace(/\s+/g, ""))}
        placeholder={auto || "optional"}
        className="field w-28 px-2 py-0.5 font-mono text-xs"
      />
      {shown ? (
        <span>
          {auto ? "Automatic. " : ""}In Slack: <code>{command} {shown} …</code>
        </span>
      ) : (
        <span>so Slack takes a few letters instead of the whole name</span>
      )}
    </span>
  );
}

/// A short name on a page's header: how to reach it from Slack, copied on click.
export function ShortNameChip({ command, short }: { command: "/idea" | "/team"; short: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(`${command} ${short} `).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={`Reach it in Slack with ${command} ${short} …  Click to copy.`}
      aria-label={`Short name ${short}. Copy ${command} ${short}`}
      className="inline-flex shrink-0 items-center gap-0.5 self-center rounded-md bg-violet-500/10 px-1.5 py-[3px] text-[11.5px] font-medium leading-none text-violet-700 ring-1 ring-inset ring-violet-500/20 transition-colors hover:bg-violet-500/15 hover:ring-violet-500/35 dark:text-violet-300"
    >
      <span aria-hidden className="text-violet-500/60">/</span>
      {copied ? "copied" : short}
    </button>
  );
}

/// Every team's short name, as Slack takes it: its own, or its initials while free.
export function teamShortNames(teams: Record<string, Team>): Map<string, string> {
  return resolveShortNames(
    Object.values(teams)
      .filter((t) => !t.disbanded)
      .sort((a, b) => a.createdAt - b.createdAt),
  );
}
