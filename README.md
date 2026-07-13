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
  docs by path (one file, or every changed `.tex` at once). `--dry-run` previews the exact ops;
  `--direct` sends plain edits instead of suggestions.
- 🔄 **`fetch`** — write Overleaf's current text back down into your repo (read-only on Overleaf, so
  it cannot disturb a single comment or tracked change).
- 🖼️ **`upload`** — push figures, PDFs, or new files into Overleaf.
- 💬 **`comment` / `reply` / `resolve` / `delete-comment` / `delete-message`** — full comment
  control: start a thread, reply, resolve/reopen, delete a whole thread or a single message.
- ✅ **`accept` / `reject`** — act on your collaborators' tracked changes from the CLI.
- 🔑 **`login`** — validated auth stored outside your repo (chmod 600); `--browser` mode is
  institutional-SSO friendly.

## ⚠️ Don't mix this with Overleaf's Git/GitHub sync

**Overleaf's Git integration writes documents by wholesale content replacement.** The review layer
is stored separately, anchored by character offsets — so a bulk overwrite orphans or displaces your
comments and tracked changes. (Overleaf's own docs advise against combining Git with track changes.)
This isn't something a tool can patch around; it's inherent to how the bridge writes.

`overleaf-review` writes through Overleaf's **real-time OT API** instead — incremental insert/delete
ops that Overleaf *transforms the review ranges against*, so comments and tracked changes survive.

**Recommended setup: unlink Overleaf's Git/GitHub sync and let `overleaf-review` be the only bridge.**

| Need | Command |
| --- | --- |
| Overleaf text → your repo | `fetch` |
| Your edits → Overleaf, as suggestions | `push` |
| Your edits → Overleaf, directly | `push --direct` |
| Figures / new files → Overleaf | `upload` |

Your Git repo stays a completely normal repo — commit whatever you like, `.tex` included — and
nothing bidirectional exists that can clobber the review record. (Renaming/deleting files is still
done in the Overleaf UI.)

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
| `fetch [--file <f>] [--dry-run]` | Write Overleaf's text down into local files (read-only on Overleaf) |
| `upload <path…> [--folder <name>]` | Upload figures / new files into Overleaf |
| `push [--file <f>] [--doc <name>] [--direct] [--dry-run]` | Send local edits as tracked suggestions (all changed `.tex` if no `--file`); `--direct` for plain edits |
| `comment --anchor <text> --message <text> [--doc <name>] [--nth <n>]` | Add a comment anchored on the given text |
| `reply --thread <id> --message <text>` | Reply to an existing comment thread |
| `resolve --thread <id> [--reopen]` | Resolve (or reopen) a comment thread |
| `delete-comment --thread <id>` | Delete a whole comment thread |
| `delete-message --message-id <id> [--thread <id>]` | Delete a single message within a thread |
| `accept --change <id> …` | Accept collaborators' tracked change(s) |
| `reject --change <id> …` | Reject collaborators' tracked change(s) |

Thread and change ids are listed by `pull` (in `.overleaf/reviews.md`).

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

- File rename / delete (currently done in the Overleaf UI)
- Trusted-publishing CI

## 📝 Changelog

Version history and notes are on the [Releases page](https://github.com/michu5696/overleaf-review/releases).

## 📄 License

MIT © [Miguel Castellano](https://github.com/michu5696)
