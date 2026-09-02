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
  docs by path (one file, or every changed `.tex` at once). A saved Base/Local/Live merge keeps
  non-overlapping co-author edits, while overlapping edits and active tracked-change ranges stop
  the push for inspection. `--direct` sends plain edits instead of suggestions.
- 🔄 **`fetch`** — write Overleaf's current text back down into your repo (read-only on Overleaf, so
  it cannot disturb a single comment or tracked change) and save the synchronization base used by
  future pushes. Existing local files are snapshotted before replacement.
- 📋 **`review plan` / `review submit`** — save a complete, binding push plan, inspect it, then
  submit it only if the local file, saved base, live document version, and review ranges are still
  unchanged.
- 🖼️ **`upload`** — push figures, PDFs, or new files into Overleaf.
- 💬 **`comment` / `reply` / `resolve` / `delete-comment` / `delete-message`** — full comment
  control: start a thread, reply, resolve/reopen, delete a whole thread or a single message.
  Identical recent comments and replies are retry-safe by default; `--force` deliberately posts
  another copy.
- ✅ **`accept` / `reject`** — act on collaborators' tracked changes and verify removal of every
  requested change id before reporting success; rejection also verifies the exact resulting text.
- 🧾 **Review receipts** — pushes, accept/reject actions, comments, and replies leave durable JSON
  records under `.overleaf/receipts/` showing what was verified or left ambiguous.
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
| Begin a local review session | `review start` |
| Overleaf text → your repo and save Base | `fetch` |
| Your edits → Overleaf, as suggestions | `push` |
| Your edits → Overleaf, directly | `push --direct` |
| Inspect, then submit the exact same change | `review plan --out plan.json`, then `review submit --plan plan.json` |
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

# 3. Start from Overleaf's current text and review state
overleaf-review review start                # fetch text + save Base + pull reviews

# 4. Edit locally, then inspect and submit a binding plan
overleaf-review review plan --out .overleaf/push-plan.json
overleaf-review review submit --plan .overleaf/push-plan.json

# Or use the safe one-shot form when a separate approval step is unnecessary
overleaf-review push --dry-run              # transient preview; sends nothing
overleaf-review push                        # plan, validate, send, and verify

# 5. Work with review threads
overleaf-review comment --anchor "Introduction" --message "Expand this section"
overleaf-review resolve --thread <id>       # thread ids come from `pull`
```

`fetch` and `review start` write Overleaf's text into the local files, so commit or otherwise
preserve local-only work before running them. They save `.overleaf/base.json`; edit only after that
base is established. Existing installations should run one of these commands once before their
first safe push. If an upgraded repository already has unpushed edits, copy or stash them, run
`fetch`, then restore the edits so the new Base remains the Overleaf version they were based on.

## 🧭 Commands

| Command | What it does |
| --- | --- |
| `login [--cookie <v>] [--browser]` | Authenticate and store your session (SSO-friendly `--browser`) |
| `link --project <id>` | Link this repo to an Overleaf project (`.overleaf/config.json`) |
| `pull [--out <dir>]` | Read comments + tracked changes into a sidecar |
| `fetch [--file <f>] [--dry-run]` | Write Overleaf text locally, snapshot replaced files, and save Base (read-only on Overleaf) |
| `review start [--file <f>] [--out <dir>]` | Fetch text, save the synchronization base, and pull the review sidecar |
| `review plan --out <plan.json> [--file <f>] [--doc <name>] [--direct] [--allow-overlap] [--unsafe-no-base]` | Create a complete binding plan without changing Overleaf |
| `review submit --plan <plan.json> [--acknowledge-ambiguous]` | Submit that plan only if all recorded preconditions still match |
| `upload <path…> [--folder <name>]` | Upload figures / new files into Overleaf |
| `push [--file <f>] [--doc <name>] [--direct] [--dry-run] [--plan-out <path>] [--plan <path>] [--allow-overlap] [--unsafe-no-base] [--acknowledge-ambiguous]` | Safely merge and send local edits (all changed `.tex` if no `--file`) |
| `comment --anchor <text> --message <text> [--doc <name>] [--nth <n>] [--force]` | Add an anchored comment; recent identical retries are skipped unless forced |
| `reply --thread <id> --message <text> [--force]` | Reply to a thread; recent identical retries are skipped unless forced |
| `resolve --thread <id> [--reopen]` | Resolve (or reopen) a comment thread |
| `delete-comment --thread <id>` | Delete a whole comment thread |
| `delete-message --message-id <id> [--thread <id>]` | Delete a single message within a thread |
| `accept --change <id> …` | Accept collaborators' tracked change(s) |
| `reject --change <id> …` | Reject collaborators' tracked change(s) |

Thread and change ids are listed by `pull` (in `.overleaf/reviews.md`).

### Safe pushes

A normal push compares three versions of each document:

- **Base** — the Overleaf text saved by the last `fetch` or successful push;
- **Local** — your current file;
- **Live** — the document as it exists in Overleaf when planning.

Your Base→Local intent is rebased onto Live. Non-overlapping live edits are preserved; genuinely
overlapping Base→Local and Base→Live edits abort instead of silently undoing a collaborator's
work. A proposed edit that intersects an active tracked-change range is also blocked by default and
the relevant change ids are listed.

Use `--allow-overlap` only after inspecting those tracked changes. `--unsafe-no-base` is a deliberate
legacy escape hatch that treats the current Live document as Base; it loses the protection against
co-author edits made since your local file was obtained. `--direct` changes how the validated ops
are represented in Overleaf, not the merge and conflict checks.

For a separate approval step, `review plan --out plan.json` stores the full operation list and its
preconditions, active tracked ranges, and any comment overlaps. `review submit --plan plan.json`
re-derives the plan from Base/Local/Live and aborts if preflight finds that the project, local source,
synchronization base, live document version/content, or active review ranges changed. Plans contain
manuscript fragments, so store or commit them with the same care as the source itself. `push
--plan-out <path>` and `push --plan <path>` expose the same workflow through the one-level command.

Overleaf can transform an update that races with a collaborator after the final preflight. The tool
therefore reads every result back and fails rather than claiming success when the exact planned text
is not present. A multi-file submission is not transactional; if a later file fails, its receipt
identifies every earlier file already verified on Overleaf.

Pushes, accept/reject actions, comments, and replies write audit receipts beneath
`.overleaf/receipts/`. Keep an ambiguous receipt: it means the request may have reached Overleaf but
readback could not prove the result, so inspect the live project before retrying. For comments and
replies, an identical recent message is treated as a retry and skipped; pass `--force` only when a
second identical message is intentional.

An ambiguous push quarantines its affected documents even if a newly generated plan has a different
timestamp or tracked-change seed. After waiting for delayed updates and manually reconciling the
receipt against live Overleaf, `--acknowledge-ambiguous` explicitly clears that submission-time
guard; it should never be used as an automatic retry flag.

Mutating commands are serialized by a working-tree-specific lock in the system temporary directory,
preventing two local agents from racing through the same preflight. A normal exit removes the lock.
If a process crashes and leaves it behind, the next command prints its exact path; inspect any
relevant receipt and the live Overleaf document before removing it manually.

## 🧠 How it works

overleaf.com's editor speaks an old **socket.io 0.9** protocol over a WebSocket. The client
([`src/overleaf-socket.ts`](src/overleaf-socket.ts)) joins the project and reads each doc's
`ranges` (comments + tracked changes). To write, it sends `applyOtUpdate` ops:

- a **tracked change** is an insert/delete op with a `meta.tc` flag;
- a **comment** is a `c` op plus a REST post of the message text.

`push` performs the Base/Local/Live merge described above, translates Live→merged text into
sequential OT ops, and waits for Overleaf's applied-update event. It then reads the document back
and verifies the final text—and, in suggestion mode, tracked-change ids—before updating the saved
base. Accept and reject operations verify that the requested ids disappeared; rejection also
verifies the exact planned text. Push, accept/reject, comment, and reply fail loudly when their
readback cannot prove success.

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
