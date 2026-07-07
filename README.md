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
- **`push`** — turn your local edits into tracked-change suggestions in Overleaf (with a
  `--dry-run` preview so you see the exact ops first).
- **`comment` / `resolve`** — create a comment anchored on any text, and resolve/reopen threads.

> ⚠️ **Unofficial.** Overleaf has no public API for comments or tracked changes. This tool
> talks to the same real-time and thread endpoints the web editor uses. It is **not affiliated
> with or endorsed by Overleaf**, may break when Overleaf changes internals, and should be used
> on your own account and projects. MIT licensed — use at your own risk.

## Status

Early but functional. The full read/write path is **proven end-to-end against live overleaf.com**
(see [`src/probes/`](src/probes/)). Working commands: **`pull`**, **`push`** (with `--dry-run`),
**`comment`**, and **`resolve`** — comments *and* tracked changes, both directions. Next: a
browser-based `login` (SSO-friendly) and `npm publish`.

## Setup (development)

```bash
npm install
cp .env.example .env      # then fill in OVERLEAF_SESSION2 + OVERLEAF_PROJECT_ID
npm run pull              # writes .overleaf/reviews.md and .json
npm run push -- --file main.tex --dry-run   # preview local edits as suggestions
npm run push -- --file main.tex             # send them as tracked changes
npx tsx src/cli.ts comment --anchor "Introduction" --message "Expand this section"
npx tsx src/cli.ts resolve --thread <id>    # thread ids come from `pull`
```

`OVERLEAF_SESSION2` is the value of your `overleaf_session2` browser cookie. It grants full
account access — treat it like a password (`.env` is gitignored). A friendly `overleaf-review
login` command (opens a browser, works with institutional SSO) will replace this for end users.

## How it works

overleaf.com's editor speaks an old **socket.io 0.9** protocol over a WebSocket. The client
([`src/overleaf-socket.ts`](src/overleaf-socket.ts)) joins the project, reads each doc's
`ranges` (comments + tracked changes), and — to write — sends `applyOtUpdate` ops:
a tracked change is an insert/delete op with a `meta.tc` flag; a comment is a `c` op plus a
REST post of the message text. Comment message bodies come from the project's threads endpoint.

## License

MIT © Miguel Castellano
