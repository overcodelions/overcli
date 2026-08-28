// What this install knows about its user, learned from personalization
// answers. One JSON object at <userData>/user-profile.json.
//
// This exists so importing a SECOND borrowed worker is cheap. The first one
// asks who you report to and which channel your digests go to; the second one
// arrives with those already filled in and only asks what is genuinely new.
// Without it the personalization pass is a form you fill in from scratch every
// time, which is the kind of feature people use once.
//
// Deliberately not part of AppSettings: settings are configuration the user
// goes and edits, and this is a by-product of answering questions in a flow
// they were already in. It is also the only place in the app that stores facts
// ABOUT the user rather than about their projects, and keeping that in one
// small file makes it one file to delete.

import fs from 'node:fs';
import path from 'node:path';
import { host } from '../host';
import { log } from '../diagnostics';

import { coerceProfile, type UserProfile } from '../../shared/flows/personalize';

function filePath(): string {
  return path.join(host().dataDir(), 'user-profile.json');
}

let cache: UserProfile | null = null;

export function loadUserProfile(): UserProfile {
  if (cache) return cache;
  try {
    cache = coerceProfile(JSON.parse(fs.readFileSync(filePath(), 'utf8')));
  } catch {
    // Missing or unreadable — an install that has never answered anything.
    cache = { facts: [] };
  }
  return cache;
}

/// Replace the stored profile. Callers fold with `rememberAnswers` first; this
/// is the dumb write half, so the merge rules stay testable without Electron.
export function saveUserProfile(profile: UserProfile): UserProfile {
  const next = coerceProfile(profile);
  cache = next;
  const target = filePath();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    log('warn', 'workers.personalize', `Failed to persist user profile: ${String(err)}`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
  return next;
}

/// Forget one fact, or all of them. The profile is a small pile of personal
/// details the user typed once in a hurry; there has to be a way to take one
/// back that is not "find the JSON file".
export function forgetProfileFact(key?: string): UserProfile {
  const current = loadUserProfile();
  if (!key) return saveUserProfile({ facts: [] });
  return saveUserProfile({ facts: current.facts.filter((f) => f.key !== key) });
}
