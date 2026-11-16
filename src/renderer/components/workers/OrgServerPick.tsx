// Which org server a Publish goes to, when this app is signed in to several.
// Nothing shows with one server (or none): publishing goes to the default,
// as before. The last pick is remembered for the rest of the session.

import { useState } from "react";
import { useStore } from "../../store";

let lastPicked: string | undefined;

export function useOrgServerPick(): { serverId: string | undefined; picker: JSX.Element | null } {
  const servers = useStore((s) => s.settings.orgServers ?? []);
  const defaultId = useStore((s) => s.settings.orgDefaultServerId);
  const [picked, setPicked] = useState<string | undefined>(lastPicked);
  const serverId = [picked, defaultId, servers[0]?.id].find((id) => !!id && servers.some((e) => e.id === id));
  if (servers.length < 2) return { serverId, picker: null };
  return {
    serverId,
    picker: (
      <select
        aria-label="Publish to which org"
        value={serverId}
        onChange={(e) => {
          lastPicked = e.target.value;
          setPicked(e.target.value);
        }}
        className="field rounded-md px-1.5 py-1 text-[11px]"
      >
        {servers.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name ?? e.url}
          </option>
        ))}
      </select>
    ),
  };
}
