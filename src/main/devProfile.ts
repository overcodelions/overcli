// `OVERCLI_PROFILE=fresh npm run dev` runs the app against a userData folder
// of its own, so a first run can be seen — and tested — without touching the
// projects, conversations and settings in the real one. It also takes its own
// single-instance lock, so it can run beside the everyday app.
//
// Dev builds only: a packaged app that quietly moved its userData would look
// exactly like data loss. Imported first in index.ts, because anything that
// reads the userData path before this runs would pin the real one.

import { app } from 'electron';
import path from 'node:path';

const profile = process.env.OVERCLI_PROFILE?.trim();
if (profile && !app.isPackaged) {
  const safe = profile.replace(/[^a-zA-Z0-9_-]+/g, '-');
  app.setPath('userData', path.join(app.getPath('appData'), `Overcli-${safe}`));
}
