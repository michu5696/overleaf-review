<div align="center">

<img src="assets/logo.svg" alt="overleaf-review" width="120" height="120" />

# overleaf-review

**The missing review layer for Overleaf's Git bridge.**

Sync **comments** *and* **tracked changes** between Overleaf and your local repo — both directions.

[![npm version](https://img.shields.io/npm/v/overleaf-review?color=3AA655&label=npm)](https://www.npmjs.com/package/overleaf-review)
[![npm downloads](https://img.shields.io/npm/dm/overleaf-review?color=3AA655)](https://www.npmjs.com/package/overleaf-review)
[![license](https://img.shields.io/npm/l/overleaf-review?color=3AA655)](LICENSE)
[![node](https://img.shields.io/node/v/overleaf-review?color=3AA655)](package.json)

`Overleaf`  ⇄  **overleaf-review**  ⇄  `your git repo + editor + AI tools`

</div>

---

## The problem

Overleaf's Git integration syncs your `.tex` source — but silently **drops the entire
collaborative review layer**. Co-authors' comments (with their text anchors) and tracked changes
live in Overleaf's own database and never reach your repo. So if you draft locally (say, in VS Code
with an AI assistant) and sync via Git, you can't see the feedback your co-authors leave in
Overleaf, and you can't push suggestions back.

`overleaf-review` bridges that gap — a direct Overleaf client that runs *alongside* your Git
workflow and carries the review layer Git can't represent.

## ✨ Features

- 📥 **`pull`** — read comments + tracked changes (with anchors) into a Git-friendly sidecar
  (`.overleaf/reviews.md` + `.json`), so your tools have every co-author note in context.
- 📤 **`push`** — turn local edits into **tracked-change suggestions**, mapping files to Overleaf
  docs by path (one file, or every changed `.tex` at once). `--dry-run` previews the exact ops.
- 💬 **`comment` / `resolve`** — anchor a comment on any text, and resolve/reopen threads.
- 🔑 **`login`** — validated auth stored outside your repo (chmod 600); `--browser` mode is
  institutional-SSO friendly.

## 📦 Install

```bash
npm install -g overleaf-review
```

## 🚀 Quick start

```bash
# 1. Authenticate (stored in ~/.config/overleaf-review/, never in the repo)
overleaf-review login             # paste your overleaf_session2 cookie, or:
overleaf-review login --browser   # opens your Chrome, log in normally (SSO works)

# 2. Link this repo to an Overleaf project (id from the project URL)
overleaf-review link --project 6a4c…bec5a

# 3. Sync the review layer
overleaf-review pull                        # comments + changes → .overleaf/
overleaf-review push --dry-run              # preview local edits as suggestions
overleaf-review push                        # send them as tracked changes
overleaf-review comment --anchor "Introduction" --message "Expand this section"
overleaf-review resolve --thread <id>       # thread ids come from `pull`
```

## 🧭 Commands

| Command | What it does |
| --- | --- |
| `login [--cookie <v>] [--browser]` | Authenticate and store your session (SSO-friendly `--browser`) |
| `link --project <id>` | Link this repo to an Overleaf project (`.overleaf/config.json`) |
| `pull [--out <dir>]` | Read comments + tracked changes into a sidecar |
| `push [--file <f>] [--doc <name>] [--dry-run]` | Send local edits as tracked-change suggestions (all changed `.tex` if no `--file`) |
| `comment --anchor <text> --message <text> [--doc <name>] [--nth <n>]` | Add a comment anchored on the given text |
| `resolve --thread <id> [--reopen]` | Resolve (or reopen) a comment thread |

## 🧠 How it works

overleaf.com's editor speaks an old **socket.io 0.9** protocol over a WebSocket. The client
([`src/overleaf-socket.ts`](src/overleaf-socket.ts)) joins the project and reads each doc's
`ranges` (comments + tracked changes). To write, it sends `applyOtUpdate` ops:

- a **tracked change** is an insert/delete op with a `meta.tc` flag;
- a **comment** is a `c` op plus a REST post of the message text.

`push` diffs your local file against Overleaf's current content and translates the hunks into
sequential OT ops, so your edits land as reviewable suggestions rather than silent changes.

## ⚠️ Disclaimer

**Unofficial.** Overleaf has no public API for comments or tracked changes, so this tool talks to
the same internal real-time and thread endpoints the web editor uses. It is **not affiliated with
or endorsed by Overleaf**, may break when Overleaf changes internals, and should be used on your
own account and projects. Use at your own risk.

## 🗺️ Roadmap

- Reply-to-thread and delete-comment
- A `pull` that also writes doc content (not just the review sidecar)
- Trusted-publishing CI

## 📄 License

MIT © [Miguel Castellano](https://github.com/michu5696)
