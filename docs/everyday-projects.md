# Everyday projects

## What this is

Everyday projects make Overcli useful for people who do not have a repo and should not need one.

## The three doors

The path has three doors: create an everyday project, offer history for an existing folder, and use plain language in the changes bar.

## Where files live

Everyday projects live at `~/Documents/Overcli Projects/<name>/`, holding a `BRIEF.md` and whatever documents you put there. This is chosen over an app-support path so people can find their own documents.

The folder also carries a hidden `.overcli-project.json` — a marker, not a settings file, holding only `{ "kind": "everyday", "version": 1 }`. Everything else that knows a project is an everyday project lives in the app's own store, keyed by an id, so it is lost the moment the folder outlives that record: a reinstall, a second machine, a folder handed to a colleague. The marker is what survives those, and it replaces a path check that would otherwise claim any directory a user happened to name "Overcli Projects". Adding a folder that already carries one makes it an everyday project immediately; Overcli never writes a marker into a folder that was not one already.

There is deliberately no `inbox/` or `output/`. Separating "what I gave it" from "what it made" is the job the undo history already does, invisibly and without being taught — a folder convention that duplicates it is one more thing to explain to someone who came here to review a document. Files go in the folder; the history says what changed.

## Why there is no separate "safe mode" runner

`isGitRepo` (`src/main/index.ts:358` and `:377`) is evaluated live per call via `currentBranch`. The moment history is turned on, the two `effectiveRunIn` ternaries (`src/main/flows/scheduler.ts:475`, `src/main/flows/workerEngine.ts:1991`) return `'worktree'` on their own — no restart, no edit to either file, and no pre-run auto-commit needed.

## What it does not do

There is no cloud sync, no teaching git, no change to how agents run, and only the changes bar is translated in this slice.

## How to turn history off

`git:removeHistory` deletes only `.git`, refuses when the folder sits inside a larger repository, and never touches user files.

## The open question we did not close

“Project setup is the first blocker for non-engineers” is a hypothesis, not a measured finding; validate with real non-engineer users before expanding the template library beyond three.
