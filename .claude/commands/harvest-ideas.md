# Harvest ideas

Search the ContemPlace corpus for captured thoughts about ContemPlace itself, PKM, and related topics. Cross-reference with open GitHub issues. Surface ideas worth acting on — as new issues, comments on existing ones, or notes that a prior idea has evolved.

## Arguments

$ARGUMENTS — optional search focus (e.g., "synthesis", "gardening", "capture quality"). Defaults to a broad sweep of ContemPlace/PKM-related fragments.

## Workflow

### Phase 1: Pull relevant fragments from the corpus

Run these MCP searches in parallel. Cast a wide net — the user captures thoughts about their own system in many registers:

1. **`search_notes`** — query: "ContemPlace"
2. **`search_notes`** — query: "personal knowledge management"
3. **`search_notes`** — query: "note-taking workflow"
4. **`search_notes`** — query: "capture and retrieval"
5. **`search_notes`** — query: "linking and synthesis"
6. If `$ARGUMENTS` provides a focus term, add a targeted search for that term.

Deduplicate results by note ID. The search results already include body text — only call **`get_note`** for fragments that look actionable (to get `raw_input` for quoting). Don't fetch full records for everything; it's expensive and most older fragments won't survive filtering.

Also call **`list_recent`** with limit 20 and scan for any fragments that touch ContemPlace/PKM topics but didn't match the keyword searches. The user often captures system ideas without naming the system explicitly — look for fragments about workflows, information structure, tagging, memory, curation, friction, tools.

**Weight recent fragments heavily.** Fragments from the last 48-72 hours are where actionable material lives. Older fragments from the initial corpus load are likely already encoded in `docs/philosophy.md`, existing issues, or ADRs. Don't re-surface design principles that are already planted — only older fragments that represent genuinely untracked ideas.

### Phase 2: Pull open GitHub issues

Fetch the current issue landscape using `gh` CLI via Bash to get a concise list (the GitHub MCP list_issues tool returns enormous payloads):

```bash
gh issue list -R freegyes/project-ContemPlace --state open --limit 100 --json number,title,labels
```

Also **check memory** for project status and recent decisions — some captured ideas may already be resolved.

Run in parallel with Phase 1.

### Phase 3: Classify each fragment

For each relevant fragment from Phase 1, classify it:

- **Actionable idea** — a concrete suggestion, feature request, or workflow improvement that could become a GitHub issue. Example: "I wish the system would show me clusters of what I've been thinking about this week."
- **Design reflection** — a thought about how the system should work, what it's for, or what it should avoid. Enriches an existing issue or philosophy discussion. Example: "The value of this system is that it doesn't try to organize for me — it just holds things until I'm ready."
- **Problem report** — friction, confusion, or something that didn't work as expected. Could be a bug or a UX gap. Example: "Tags keep coming back too broad — I said 'cimbalom' and got 'music'."
- **Stale or resolved** — the idea was captured before a change that addressed it. Note what resolved it.
- **Not actionable** — a passing thought that doesn't suggest a change. Skip these silently.

### Phase 4: Match fragments to issues

For each actionable or design-reflection fragment:

1. **Check whether an existing issue *actually covers* this idea.** Don't force-match to the closest issue — if the fragment is about a distinct concern that only looks adjacent, it's a new issue, not a comment. The bar for "already covered" is high: the existing issue must address the same core question, not merely touch a related topic.
2. **Check closed issues** — was this already shipped? If so, note the resolution.
3. **Check memory and ADRs** — is this tension already resolved by a decision? If so, it belongs in "already resolved," not "tensions with current direction." Only flag a tension if the fragment genuinely challenges a decision that might need revisiting.
4. **Assess freshness** — when was the fragment captured vs. when was the matching issue last updated? Has the user's thinking evolved since the issue was written?

Categorize each fragment into one of:
- **New issue candidate** — no existing issue covers this. Worth opening.
- **Comment on existing issue** — enriches an open issue with the user's own words and evolved thinking.
- **Already resolved** — the idea was addressed. No action needed.
- **Contradicts current direction** — the fragment tensions with a decision already made (check `docs/decisions.md`). Worth flagging as an open question.

### Phase 5: Present the harvest

**Lead with what's actionable.** Group by category, not by search query.

#### New issue candidates

For each, present:
- The fragment's `raw_input` (the user's actual words)
- When it was captured
- A proposed issue title and 1-2 sentence body (in the user's voice, not yours)
- Suggested label(s)
- Why this isn't already covered by an existing issue

#### Comments on existing issues

For each, present:
- The fragment's `raw_input`
- The target issue (number + title)
- What the fragment adds — new angle, evolved thinking, supporting evidence, or a concrete example
- A draft comment (short, in the user's voice)

#### Tensions with current decisions

For each, present:
- The fragment vs. the decision (cite the ADR or issue)
- Whether this suggests the decision should be revisited or is just natural ambivalence

#### Already resolved

Brief list — fragment title, what resolved it. Confirms the system is working.

### Phase 6: Wait for the user

**Do not create issues or post comments.** Present the harvest and let the user decide what to act on. They may say:
- "Open issues 1, 3, and 5" — create those issues
- "Comment on #120 with that fragment" — post the draft comment
- "Skip all of these" — done
- "That one's interesting, let's think about it" — shift to discussion mode

## Calibration

- **The user's words are the material.** Quote `raw_input`, don't paraphrase. The whole point is surfacing what the user actually said.
- **Don't manufacture relevance.** If a fragment mentions "notes" in a completely unrelated context, skip it. Only surface fragments where the user is genuinely thinking about their knowledge system.
- **Freshness matters.** A fragment captured yesterday about synthesis is more interesting than one from two weeks ago that predates a major architectural decision. Weight recent thinking higher.
- **Respect closed decisions and check timestamps.** If a fragment's concern is resolved by a known decision or shipped feature, classify it as resolved. Check temporal ordering: if the capture *predates* the decision, it's almost certainly resolved — the user considered it and moved on. ContemPlace doesn't track its own idea resolution trail, so the absence of a follow-up fragment doesn't mean the tension is live. Only flag a tension when the fragment *postdates* the decision — that's genuine second-guessing.
- **Don't force-match fragments to issues.** A fragment about URL metadata is not a comment on #9 (bare link capture) just because both mention URLs. If the fragment raises a distinct concern, it's a new issue. The bar for "this enriches an existing issue" is that the fragment addresses the *same core question* the issue tracks.
- **Present with less interpretation.** Show what was found and let the user decide what category it fits. Don't assert classifications with high confidence when the fragment could reasonably be read multiple ways. When unsure whether something is a comment on an existing issue or a new issue, say so. Never dismiss a fragment as "just a thought experiment" or "not really proposing a change" — the user decides what's worth investigating. A challenge question or architectural what-if can be more valuable than a concrete feature request.
- **Skip fragments already encoded in docs.** Design principles that are in `docs/philosophy.md` or well-established ADRs aren't harvest material — they're already planted. Only re-surface older fragments if they represent genuinely untracked ideas.
- **Keep it tight.** A harvest with 3 strong candidates is better than 10 padded ones. If the corpus has nothing actionable right now, say so in one line.
- **This is a curatorial tool, not an idea generator.** You're surfacing the user's own thinking, not adding yours. If you see a gap the user hasn't thought about, you can mention it as an open question — but the harvest itself is their material.
