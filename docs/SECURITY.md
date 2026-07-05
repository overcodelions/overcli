# Is Overcli safe? — Security & Privacy

Overcli is a desktop app that can read your code, run commands, and touch the
credentials your coding CLIs already use. That's a lot of trust, so this page
lays out — in plain terms — what it does, what it doesn't, and how you can
verify the copy you downloaded is the real thing.

For **reporting a vulnerability**, see [`../SECURITY.md`](../SECURITY.md).

---

## The short version

- **No API keys, no accounts, no sign-up.** Overcli runs on top of the official
  `claude`, `codex`, `gemini`, `copilot` CLIs and the open-source `ollama`
  runtime. Whatever auth those tools already have on your machine is the auth
  Overcli uses. It never asks you for a key.
- **No telemetry, no analytics, no tracking.** Overcli ships no analytics SDK
  and sends no usage data anywhere. Your prompts, code, and conversations stay
  on your machine (and go to whichever AI provider *your* CLI is configured to
  talk to — the same as running that CLI in a terminal).
- **Open source.** Every line is on GitHub under Apache-2.0. Read it, build it
  yourself, or diff a release against the tag it was built from.
- **Signed, notarized, and provably built by CI.** macOS builds are code-signed
  and notarized by Apple, and every release carries a cryptographic build
  provenance attestation (see [Verify your download](#verify-your-download)).

## What Overcli reads and writes

- **Your project directory** — the folder you explicitly pick. Overcli reads the
  source tree to show diffs and file contents, and writes edits the agent makes
  (in git worktrees you can review before merging).
- **App data** (`userData`) — conversation history and metadata, settings, and
  MCP configuration, stored locally under your OS app-data directory.
- **The CLIs' own config** — Overcli reads the config/usage data the wrapped
  CLIs keep (e.g. token/usage stats shown on the Stats page). It does not
  exfiltrate any of it.

It does not read files outside the project you point it at as part of normal
operation.

## What talks to the network

Three things, and nothing else originates from Overcli itself:

1. **The wrapped CLIs make their own API calls** to their providers (Anthropic,
   OpenAI, Google, GitHub, or your local Ollama) — exactly as they would in a
   terminal. Overcli doesn't proxy or intercept that traffic.
2. **Update checks** — Overcli checks the project's GitHub Releases feed for new
   versions (`electron-updater`) and can auto-download and install on quit. This
   is the only server Overcli itself contacts by default.
3. **MCP servers you explicitly configure** — if you add an MCP server (remote
   or local), Overcli connects to it because you asked it to. Nothing is
   pre-connected without your action.

## Permissions & approvals

Agents don't get a free hand. Command execution, file edits, and other
sensitive actions flow through an approval/permission UI, and the boundary
between the UI (renderer) and the privileged process (main) is a defined IPC
contract — the renderer can't bypass the approval gates. Keeping those gates
honest is explicitly in-scope for security reports.

## macOS hardening

Release builds run with Apple's **hardened runtime** and are **notarized**. The
app requests a small set of entitlements, and each one is there for a concrete
reason:

- `allow-jit` / `allow-unsigned-executable-memory` — so Electron's V8 engine can
  run normally.
- `disable-library-validation` / `allow-dyld-environment-variables` — so Overcli
  can inherit your shell's `PATH` and launch the CLI you already installed (e.g.
  `/opt/homebrew/bin/claude`). Launching those external binaries is the entire
  point of the app.
- `network.client` — so the CLIs' API calls can go out.
- `files.user-selected.read-write` / `files.downloads.read-write` — so the file
  editor and git-worktree flow work in the directory you choose.

## Verify your download

Every release ships with a `SHA256SUMS.txt` file and a build provenance
attestation. To confirm a download was built by Overcli's CI from this source —
not tampered with in transit — using the [GitHub CLI](https://cli.github.com):

```sh
# Checksums
shasum -a 256 -c SHA256SUMS.txt

# Cryptographic provenance (proves it was built by our CI from our source)
gh attestation verify Overcli-<version>-arm64.dmg -R overcodelions/overcli
```

A passing `gh attestation verify` means the artifact's SLSA provenance is
signed by GitHub's OIDC identity for this repository's release workflow.

## Supply chain

- **Dependencies** are watched by Dependabot and updated regularly.
- **Static analysis** runs on every push via CodeQL.
- **Posture** is scored publicly by [OpenSSF Scorecard](https://securityscorecards.dev/viewer/?uri=github.com/overcodelions/overcli).
- **An SBOM** (CycloneDX) is attached to every release so you can see exactly
  what's inside.

## What's out of scope

Overcli wraps third-party CLIs. Bugs in `claude`, `codex`, `gemini`, `copilot`,
or `ollama` themselves belong upstream. And Overcli can't protect you from a
command you personally approve — if you tell an agent to `rm -rf` something and
click approve, it will. Review the diffs and the commands; that's what the
approval UI is for.
