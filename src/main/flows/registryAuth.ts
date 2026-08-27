// Registry bearer tokens, held wherever the host keeps secrets.
//
// This file used to BE the store: a JSON file next to the flows cache, values
// encrypted with electron's `safeStorage` when the platform had a keychain and
// base64'd when it didn't. That logic now lives in `hostElectron.ts`, because
// it was never a fact about registry tokens — it was a fact about running
// under Electron on a desktop. Headless the same question has a different
// answer (`$OVERCLI_REGISTRY_TOKEN_<ID>`, see `hostNode.ts`), and a CI job must
// not write a bearer token into a directory it is about to cache and upload.
//
// What is left here is the naming: the registry id IS the secret key.

import { host } from '../host';

/// Store (or, with `null`/empty, clear) the bearer header for a registry.
/// Returns false when the host cannot persist secrets — headless, where the
/// environment is the store — so the caller can tell the user where to put it
/// rather than reporting a save that did not happen.
export function setAuthHeader(registryId: string, value: string | null): boolean {
  return host().secrets.set(registryId, value);
}

export function getAuthHeader(registryId: string): string | undefined {
  return host().secrets.get(registryId) ?? undefined;
}

export function removeAuthHeader(registryId: string): boolean {
  return setAuthHeader(registryId, null);
}
