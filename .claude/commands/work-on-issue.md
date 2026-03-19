# Work on issue

Execute the full planning-before-implementation workflow for a GitHub issue. The user provides an issue number or description — you handle the rest.

## Arguments

$ARGUMENTS — the issue number (e.g., "#47", "47") or a short description of what to build. If a number, fetch the issue first. If a description, open a new issue.

## Workflow

### Phase 1: Gather context

1. **Fetch the issue** (or create one if only a description was given). Read the full issue body. Use the GitHub MCP `get_issue` tool for individual issues.
2. **Fetch related issues** referenced in the body or that share labels/topics. For bulk listing, use `gh issue list -R freegyes/project-ContemPlace --json number,title,labels` via Bash — the GitHub MCP `list_issues` tool returns enormous payloads (200K+ characters) that waste context.
3. **Read the relevant source files** — whatever the issue touches. Use the project layout in CLAUDE.md to find the right files. Read them, don't guess.
4. **Check memory** — search MEMORY.md and topic files in the memory directory for prior context on this area.
5. **Check the note database** — if the issue touches capture quality, linking, search, or tag behavior, use `search_notes` or `list_recent` via MCP to surface real-world examples. The notes themselves are evidence of how the system behaves.

### Phase 2: Hypothesis check

Before sending anything to specialist reviewers, assess whether the problem statement itself is sound. The goal is to catch a wrong frame before optimizing within it. Answer these questions and present them to the user:

1. **What problem does this issue solve?** State it in one sentence.
2. **Is the problem real and current?** What's the evidence — a bug, user friction, architectural smell, or an assumption? If the evidence is thin, flag it.
3. **Does the issue frame the solution space correctly?** Or does it constrain it prematurely? (Example: issue #46 presented four options that all assumed the problem was code duplication. The actual problem was process duplication. The right answer wasn't among the four options.)
4. **Do the project's first principles still apply here?** Check the relevant principles in `docs/philosophy.md` and `docs/decisions.md`. Usually they hold — but sometimes a new problem reveals that a principle was drawn from too narrow a base. If a principle feels like it's fighting the problem rather than illuminating it, flag that tension explicitly. Don't assume first principles are sacred.
5. **Are there better solutions if we step back from the issue's framing?** Consider whether the issue is solving a symptom rather than the root cause.
6. **Is this the most valuable thing to work on right now?** Given what else is open, does this earn its place?

This doesn't need to be heavy. For a clear bug fix, it's one line: "The problem is X, the evidence is Y, fix it." For a design question or a large change, this is the step that prevents two specialist agents from spending their time optimizing a wrong starting point.

**If the hypothesis check reframes the problem**, the specialist reviews in Phase 3 work from the reframed version, not the original issue body. Note the reframing explicitly so the user can see what shifted.

**Post findings to the issue.** After completing the hypothesis check, post a summary comment on the GitHub issue with the validated problem statement and any reframing. This creates a written trail — useful for the user, for future sessions, and for anyone reading the issue later.

### Phase 2.5: State the hypothesis

Before proceeding to specialist review or implementation, explicitly state:

1. **Hypothesis:** What do we believe this change will achieve? (e.g., "Recent temporal context in the capture pipeline improves tag consistency across burst captures")
2. **Expected outcome:** What does success look like? Be specific enough to measure.
3. **Verification plan:** How will we know if it worked? Options: before/after metric, experiment design, follow-up audit, calculation. If verification can't happen immediately (e.g., needs real-world usage data), create a follow-up issue for it.

This doesn't need to be heavy — for a clear bug fix, the hypothesis is "this fixes the bug" and verification is "the bug no longer reproduces." For features or design changes, the hypothesis prevents building infrastructure that can't be evaluated.

**If verification requires real-world data**, create a GitHub issue (label: `test`) that defines the baseline measurement and the post-deployment comparison. The implementation can proceed while measurement runs independently — but the issue must exist so the hypothesis isn't forgotten.

### Phase 3: Specialist review

Scale the review to the size of the change:

- **Small changes** (config tweaks, test fixes, description updates): Skip Phase 3 entirely. State why in one line: "Skipping specialist review — single-file config change with no architectural impact."
- **Medium changes** (new tool handler, prompt tuning, single-feature additions): Launch **one Plan agent** covering both design concerns and implementation specifics.
- **Large changes** (new Workers, schema migrations, multi-file refactors, architectural shifts): Launch **two Plan agents in parallel:**

**Agent A — Best practices, prior art, and design concerns:**
- **Research prior art first** — has this problem been solved before? Search for existing libraries, published patterns, community approaches, or prior implementations of the same idea. The goal is to avoid reinventing the wheel. If prior art exists, evaluate whether to adopt, adapt, or deliberately diverge (and document why).
- Research best practices relevant to the task
- Surface edge cases, architectural concerns, interaction with existing systems
- Flag risks and anti-patterns
- Identify decisions that need to be made before implementation

**Agent B — Gap analysis and implementation specifics:**
- Read the actual source files that will change
- Identify what's missing, what could break, what depends on what
- Draft the minimal set of changes needed
- Flag prerequisites (schema changes, seed data, config, etc.)

All agents receive: the **validated problem statement from Phase 2** (not just the raw issue body), relevant source code, and the project's hard constraints from CLAUDE.md. All return structured findings. All are told to do research only — no code writing.

**Post findings to the issue.** After synthesizing the specialist review, post a summary comment on the GitHub issue with key findings, confirmed decisions, and identified risks. This creates a written trail for the user and for any future session that picks up this issue.

### Phase 3.5: Persist research findings

For medium and large changes where specialist reviews were run: save the key findings, confirmed decisions, and identified risks to memory. This makes the research available to future sessions if implementation spans multiple conversations. Skip for small changes where no specialist review ran.

### Phase 4: Synthesize and present the plan

Combine the review findings into a clear plan:
- **Scope assessment** — If the implementation touches more than one Worker or more than ~8 files, evaluate whether splitting into multiple PRs would improve risk isolation, verification quality, or rollback safety. Look for natural seams (deployment boundaries, read/write splits, schema vs. logic). Present the split recommendation alongside the plan. For smaller changes, skip this — state "single PR, no split needed" and move on.
- **Priority-ordered list of changes** — what to do first, what depends on what
- **Design decisions surfaced** — with recommendations, presented as a table
- **Risks and mitigations** — anything the reviews flagged
- **Files that will change** — explicit list

Present this to the user. Wait for confirmation or adjustments before proceeding.

### Phase 5: Implement

1. **Create a feature branch** (`feat/<short-name>`)
2. **Write the code** — follow the plan from Phase 4
3. **Typecheck** — `npx tsc --noEmit` (and `-p` for sub-projects if touched)
4. **Run relevant unit tests** — the ones that cover the changed code
5. **Commit** with conventional commit message, refs the issue number
6. **Push the branch and create a PR** — with summary and test plan checklist. Creating the PR early makes the diff visible and gives a URL to reference. The PR body can be updated as verification progresses.

### Phase 6: Verify

Verification means proving the feature works, not just proving the code compiles. Three layers:

**6a. Regression check — did we break anything?**
1. **Run the full unit test suite** — not just the tests for changed files. All Workers that could be affected.
2. **Typecheck all projects** — `npx tsc --noEmit` and `-p` for sub-projects.

**6b. Deployment + smoke tests**
3. **Deploy in dependency order** — MCP Worker → Telegram Worker → Gardener Worker. Only deploy Workers that changed or whose dependencies changed (e.g., Telegram Worker must redeploy if MCP Worker changed because of the Service Binding).
4. **Run smoke/integration tests** against the live deployment.

**6c. Real-world verification — try to do the thing**
5. **Design an ad-hoc test that proves this works from a user's perspective.** Don't just run existing test harnesses — ask: "If I were the user, how would I know this feature works?" Then do that thing. Send a real Telegram message. Call the MCP tool with realistic input. Check the database for expected state. Compare the actual output against specific expectations.
6. **Test MCP tools directly** if the change touches the MCP Worker or capture pipeline — call the affected tools via MCP and verify the response.
7. **Verify edge cases** the implementation handles — not just the happy path. If the specialist review flagged risks, verify those specifically.

**Pre-existing failures:** If verification surfaces a bug that predates your change (e.g., a test that was already broken), fix it in the same branch if it's small and related. If it's unrelated or large, open a separate issue and note it in the PR body. Don't let a pre-existing bug block the merge, but don't silently ignore it either.

### Phase 7: Ship

1. **Update the PR body** with completed test plan checkboxes
2. **Merge** (if tests pass and user approves)
3. **Clean up** — delete the feature branch

### Phase 8: Documentation sweep (automatic, do not ask)

After merging, do the full housekeeping sweep:
1. **Start with decisions.** Ask: "What did we decide during this work?" Specialist reviews, implementation trade-offs, and user feedback all produce decisions. The design ADR does not cover implementation decisions — those are separate entries in `docs/decisions.md`.
2. Update `docs/` files that describe anything touched
3. Update `README.md` if status table, tool list, test count, project layout affected
4. Update `CLAUDE.md` if architecture, constraints, file layout, commands, or conventions changed
5. Comment on relevant GitHub issues with outcomes
6. Close resolved issues with a resolution comment
7. Clean up stale branches
8. Update memory files if project status shifted

### Calibration notes

- **Design-only issues** (labeled `question`): Phase 2 is especially important — design questions are where wrong frames do the most damage. Phase 3 is the main output. Skip Phases 5-7.
- If the user says "just do it" or "skip the review" — respect that and go straight to implementation.
