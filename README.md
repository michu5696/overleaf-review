# overleaf-review

**The missing review layer for Overleaf's Git bridge.**

Overleaf's Git integration syncs your `.tex` source — but silently drops the entire
collaborative review layer: co-authors' **comments** (with their text anchors) and
**tracked changes** live in Overleaf's own data model and never reach your repo. So if you
draft in your editor (e.g. VSCode + an AI assistant) and sync via Git, you can't see the
feedback your co-authors leave in Overleaf, and you can't push suggestions back.

`overleaf-review` bridges that gap, **both directions**:

- **`pull`** — read comments + tracked changes into a Git-friendly sidecar (`.overleaf/reviews.md`
  and `.json`) so your tools have every co-author note in context.
- **`push`** — turn your local edits into tracked-change suggestions in Overleaf, mapping files
  to Overleaf docs by path (push one with `--file`, or every changed `.tex` at once). `--dry-run`
  previews the exact ops first.
- **`comment` / `resolve`** — create a comment anchored on any text, and resolve/reopen threads.

> ⚠️ **Unofficial.** Overleaf has no public API for comments or tracked changes. This tool
> talks to the same real-time and thread endpoints the web editor uses. It is **not affiliated
> with or endorsed by Overleaf**, may break when Overleaf changes internals, and should be used
> on your own account and projects. MIT licensed — use at your own risk.

## Status

Early but functional. The full read/write path is **proven end-to-end against live overleaf.com**
(see [`src/probes/`](src/probes/)). Working commands: **`login`**, **`link`**, **`pull`**,
**`push`** (with `--dry-run`), **`comment`**, and **`resolve`** — comments *and* tracked changes,
both directions. Next: multi-file mapping and `npm publish`.

## Install

```bash
npm install -g overleaf-review
```

Then run `overleaf-review <command>` anywhere. For local development, clone the repo and use
`npx tsx src/cli.ts <command>` (as shown below).

## Getting started

```bash
npm install

# 1. Authenticate (stored in ~/.config/overleaf-review/, chmod 600 — never in the repo)
npx tsx src/cli.ts login             # paste your overleaf_session2 cookie, or:
npx tsx src/cli.ts login --browser   # opens your Chrome, log in normally (SSO works)

# 2. Link this repo to an Overleaf project (id from the project URL)
npx tsx src/cli.ts link --project <projectId>

# 3. Sync the review layer
npx tsx src/cli.ts pull                              # comments + changes → .overleaf/
npx tsx src/cli.ts push --dry-run                    # preview ALL changed .tex as suggestions
npx tsx src/cli.ts push                              # send them as tracked changes
npx tsx src/cli.ts push --file sections/intro.tex    # or just one file
npx tsx src/cli.ts comment --anchor "Introduction" --message "Expand this section"
npx tsx src/cli.ts resolve --thread <id>             # thread ids come from `pull`
```

Auth grants full account access, so it's treated like a password: `login` stores it in
`~/.config/overleaf-review/credentials.json` (chmod 600), never in the repo. `--browser` needs
Playwright (`npm i -D playwright`) and drives your installed Chrome — no extra download — and
works with institutional SSO. For dev you can instead put `OVERLEAF_SESSION2` and
`OVERLEAF_PROJECT_ID` in a gitignored `.env` (env vars take priority).

## How it works

overleaf.com's editor speaks an old **socket.io 0.9** protocol over a WebSocket. The client
([`src/overleaf-socket.ts`](src/overleaf-socket.ts)) joins the project, reads each doc's
`ranges` (comments + tracked changes), and — to write — sends `applyOtUpdate` ops:
a tracked change is an insert/delete op with a `meta.tc` flag; a comment is a `c` op plus a
REST post of the message text. Comment message bodies come from the project's threads endpoint.

## License

MIT © Miguel Castellano
