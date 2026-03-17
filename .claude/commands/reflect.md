# Reflect

Session-closing ritual. Review what happened, find what could be better, improve the system that produces the work — not just the work itself.

## Arguments

$ARGUMENTS — optional focus area (e.g., "commands", "docs", "capture voice"). Without arguments, reviews everything.

## Philosophy

Every session teaches something. Pushbacks are the highest-signal data — they reveal where the system's instructions diverge from the user's actual expectations. The goal is to close that gap so the same correction never needs to happen twice.

Document heavily. If something was decided, write it down. If something was learned, persist it. The cost of writing too much is low; the cost of forgetting is high. Prefer updating existing documents over hoping the next session will remember.

## Workflow

### Phase 1: Reconstruct the session

Scan the full conversation and build a map of what happened. Do this analytically — do not output anything yet.

**Identify:**
- **Pushbacks and corrections**: Every instance where the user redirected, corrected, or overrode your approach. These are the primary signal. For each one, note: what you did, what the user wanted instead, and why the gap existed.
- **Commands run**: Which custom commands (`/audit-captures`, `/work-on-issue`, `/extract-fragments`, `/harvest-ideas`) were invoked? What was their output quality?
- **Decisions made**: Any architectural, design, or process decisions — explicit or implicit. Include decisions the user made by choosing one recommendation over another.
- **Friction points**: Moments where the user had to repeat themselves, ask clarifying questions about your output, or wait for information that should have been obvious.
- **What worked well**: Interactions that flowed smoothly — these confirm existing instructions are correct. Don't skip this; it prevents over-correction.

### Phase 2: Root-cause analysis

For each pushback or friction point, classify the root cause:

| Root cause | Fix location |
|---|---|
| Command produced wrong output or missed a step | `.claude/commands/<command>.md` |
| Agent didn't follow an existing instruction | Feedback memory (behavioral correction) |
| Agent lacked context it should have had | `CLAUDE.md`, project memory, or reference memory |
| A convention or constraint changed during the session | `CLAUDE.md`, `docs/decisions.md` |
| Documentation is stale or missing after session's work | `docs/` files, `README.md` |
| Capture voice or system prompt needs tuning | DB update + migration seed |

Map each finding to a specific file and a specific change. Vague findings ("could be better") are not actionable — skip them or sharpen them.

### Phase 3: Propose improvements

Present all proposed changes to the user **before applying any of them.** Do not edit files, save memories, or update the DB until the user approves. The user is the curator here — same principle as the capture pipeline.

Structure the proposal as a numbered list of changes, grouped by type. For each change, show:
- **File**: the exact file path
- **What**: the specific edit (quote the old text and the new text, or describe the new content for new files/memories)
- **Why**: the pushback or finding that motivated it

Group by type in this order:

#### 3a. Commands

For each command that was run during the session:
1. Re-read the command file
2. Compare what it instructed vs. what actually happened vs. what the user wanted
3. Look for: missing steps, wrong calibration, ambiguous instructions that led to wrong choices, output format issues
4. Propose the edit. Be precise — change the specific lines that caused the issue. Don't rewrite sections that worked fine.

For commands that weren't run but are affected by session decisions (e.g., a schema change that affects `/audit-captures`), propose updates for those too.

#### 3b. Feedback memories

For each behavioral correction — something the user had to tell you that isn't a document issue but a pattern issue:
1. Check existing feedback memories for duplicates
2. If new, propose saving with the **Why** and **How to apply** structure
3. If an existing memory needs sharpening, propose the update

#### 3c. CLAUDE.md

Check whether the session produced changes that affect:
- Architecture, hard constraints, or key commands
- File layout (new files, moved files, deleted files)
- Conventions or workflows
- Phase scope or project status

If yes, propose the edit. If nothing changed, skip.

#### 3d. Documentation sweep

Go through each doc that could be affected by the session's work. For each:
- `docs/decisions.md` — Were decisions made? Even small ones (capture voice tweaks, command improvements) can warrant an ADR if they reflect a principle. Append-only.
- `docs/roadmap.md` — Did any feature ship or phase close?
- `docs/capture-agent.md` — Did capture behavior change?
- `docs/schema.md` — Did the schema change?
- `docs/architecture.md` — Did the architecture change?
- `docs/philosophy.md` — Did a principle get refined?
- `docs/usage.md` — Did user-facing behavior change?
- `docs/development.md` — Did test layout or dev workflow change?
- `README.md` — Does the status table, tool list, or project layout need updating?

Skip files where nothing changed. But when something did change, be thorough — propose what to write and why, not just "update this file."

#### 3e. Project and reference memories

Propose saves or updates for:
- New project context (decisions, status changes, active work)
- New reference pointers (external systems, URLs, dashboards)
- User context updates (preferences, role changes, knowledge revealed)

### Phase 4: Wait for approval

After presenting the full proposal, **stop and wait.** The user may:
- Approve everything ("go ahead", "looks good", "apply all")
- Approve selectively ("do 1, 3, and 5 but skip 2 and 4")
- Modify a proposed change ("change the wording on #3 to ...")
- Reject everything ("actually, none of this")

Do not interpret silence as approval. Do not begin applying changes until the user explicitly responds.

### Phase 5: Apply approved changes

Apply only what the user approved, incorporating any modifications they requested. Work through the changes and then output a concise summary:

```
## Session reflection — [date]

### Applied
- [numbered list matching the proposal, with file paths]

### Skipped
- [anything the user rejected, with their reason if given]
```

Keep the report tight. The changes speak for themselves — the report just indexes them.

### Phase 6: Commit check

After applying changes, check git status. If there are uncommitted changes (from the reflection edits or from earlier in the session), present them and offer to commit and push. This is the last step — nothing should leave the session uncommitted.

## Calibration

- **Pushbacks are gifts, not complaints.** Treat every correction as a system improvement opportunity. The user shouldn't have to give the same feedback twice.
- **Change the system, not just the output.** If you made a mistake because a command was ambiguous, fix the command. If you lacked context, persist the context. Don't just acknowledge the issue — close the loop.
- **Don't over-correct.** One pushback doesn't mean the entire approach was wrong. Change the specific thing that caused the issue. If 9/10 things worked, don't rewrite the command — fix the 1.
- **Document decisions, not just changes.** "Updated capture voice" is insufficient. "Updated capture voice to include assessment-type evaluative expressions alongside emotions, because the Rotring Isograph audit showed the previous emotion-only examples didn't prevent stripping of 'possibly the best'" — that's a decision record.
- **When in doubt, write it down.** The user prefers heavy documentation. Err on the side of recording too much. A stale document is a problem; a missing document is a bigger one.
- **Don't touch what's working.** If a command ran perfectly, say so and move on. Unnecessary rewrites introduce new bugs.
