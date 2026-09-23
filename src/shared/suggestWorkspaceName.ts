/// A name for a workspace made of `names`, so creating one never starts with
/// a blank field. Shared prefixes read as the system's name (`acme-web` and
/// `acme-api` → `acme`); otherwise the members themselves are the name until
/// someone renames it.
export function suggestWorkspaceName(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  const prefix = commonPrefix(names).replace(/[-_.\s]+$/, '');
  if (prefix.length >= 3) return prefix;
  if (names.length === 2) return `${names[0]} + ${names[1]}`;
  return `${names[0]} + ${names.length - 1} more`;
}

function commonPrefix(names: readonly string[]): string {
  let prefix = names[0];
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}
