# Contributing to Overcli

Thanks for your interest. Overcli is a small project and we'd like to keep it explainable, so please open an issue before sending a non-trivial PR — a quick conversation about *shape* saves a lot of rework.

## Ground rules

- Be kind. See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
- Open an issue for anything bigger than a typo, dependency bump, or one-file fix.
- Keep PRs focused. One concern per PR; if it grows, split it.
- Match the existing code style. TypeScript strict, no clever tricks where a clear line will do. An `.editorconfig` covers indentation and line endings.

## Dev setup

```bash
git clone https://github.com/overcodelions/overcli
cd overcli
npm install
git config core.hooksPath .githooks
npm run dev
```

The repository hooks reject private maintainer identities and commit-message
trailers before commit, then scan outgoing history again before push. CI
enforces the same policy.

The full development loop runs the Vite renderer, the main-process TypeScript compiler, and Electron concurrently. See the [README](README.md#development) for the script reference.

## Before opening a PR

```bash
npm test          # vitest suite must pass
npm run build     # main + renderer must compile
```

If your change touches a backend adapter (`src/main/backends/`) or a parser (`src/main/parsers/`), add or update a test alongside it — most files in those directories already have a `*.test.ts` neighbor; please follow the pattern.

## Reporting bugs

[Open an issue](https://github.com/overcodelions/overcli/issues/new) with:

1. What you did
2. What you expected
3. What happened instead
4. Platform + Overcli version (Help → About, or `package.json`)
5. Which backend(s) the bug touches (claude / codex / gemini / ollama / copilot)

Attach a screenshot or a short transcript if relevant. Please scrub anything that looks like a credential or private path before sharing.

## Security

Don't file public issues for security bugs. See [`SECURITY.md`](SECURITY.md).

## Contribution terms

Small thing, stated once so it never has to be revisited.

By opening a pull request you confirm that:

1. **You wrote it, or you have the right to submit it.** This is the
   [Developer Certificate of Origin 1.1](https://developercertificate.org/).
   Sign your commits off with `git commit -s`.
2. **Your contribution is licensed to everyone under [Apache-2.0](LICENSE)**,
   the same terms as the rest of the project.
3. **You also grant Lionel Farr and Owen Farr a perpetual, worldwide, non-exclusive,
   irrevocable right to license your contribution under other terms** —
   a different open-source license, or a commercial one.

Point 3 exists so the project's license can change later without having to
track down every past contributor for permission. It does not take anything
away from you: you keep the copyright in your work, and everything you
contribute stays available to everyone under Apache-2.0, permanently.

## Trademarks

The code is Apache-2.0; the *name* and *logo* are not. Forks are welcome —
please give yours its own name. See [TRADEMARKS.md](TRADEMARKS.md).
