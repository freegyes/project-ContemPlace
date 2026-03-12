# Work on issue

Execute the full planning-before-implementation workflow for a GitHub issue. The user provides an issue number or description — you handle the rest.

## Arguments

$ARGUMENTS — the issue number (e.g., "#47", "47") or a short description of what to build. If a number, fetch the issue first. If a description, open a new issue.

## Workflow

### Phase 1: Gather context

1. **Fetch the issue** (or create one if only a description was given). Read the full issue body.
2. **Fetch related issues** referenced in the body or that share labels/topics.
3. **Read the relevant source files** — whatever the issue touches. Use the project layout in CLAUDE.md to find the right files. Read them, don't guess.
4. **Check memory** — search MEMORY.md and topic files in the memory directory for prior context on this area.

### Phase 2: Hypothesis check

Before sending anything to specialist reviewers, assess whether the problem statement itself is sound. The goal is to catch a wrong frame before optimizing within it. Answer these questions and present them to the user:

1. **What problem does this issue solve?** State it in one sentence.
2. **Is the problem real and current?** What's the evidence — a bug, user friction, architectural smell, or an assumption? If the evidence is thin, flag it.
3. **Does the issue frame the solution space correctly?** Or does it constrain it prematurely? (Example: issue #46 presented four options that all assumed the problem was code duplication. The actual problem was process duplication. The right answer wasn't among the four options.)
4. **Are there better solutions if we step back from the issue's framing?** Consider whether the issue is solving a symptom rather than the root cause.
5. **Is this the most valuable thing to work on right now?** Given what else is open, does this earn its place?

This doesn't need to be heavy. For a clear bug fix, it's one line: "The problem is X, the evidence is Y, fix it." For a design question or a large change, this is the step that prevents two specialist agents from spending their time optimizing a wrong starting point.

**If the hypothesis check reframes the problem**, the specialist reviews in Phase 3 work from the reframed version, not the original issue body. Note the reframing explicitly so the user can see what shifted.

### Phase 3: Specialist review (parallel)

Launch **two Plan agents in parallel** to evaluate the design before any code is written:

**Agent A — Best practices and design concerns:**
- Research best practices relevant to the task
- Surface edge cases, architectural concerns, interaction with existing systems
- Flag risks and anti-patterns
- Identify decisions that need to be made before implementation

**Agent B — Gap analysis and implementation specifics:**
- Read the actual source files that will change
- Identify what's missing, what could break, what depends on what
- Draft the minimal set of changes needed
- Flag prerequisites (schema changes, seed data, config, etc.)

Both agents receive: the **validated problem statement from Phase 2** (not just the raw issue body), relevant source code, and the project's hard constraints from CLAUDE.md. Both return structured findings. Both are told to do research only — no code writing.

### Phase 4: Synthesize and present the plan

Combine both reviews into a clear plan:
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

### Phase 6: Verify

1. **Deploy** to the live stack if the change touches a Worker
2. **Run smoke/integration tests** against the live deployment
3. **Verify manually** if the tests don't cover the specific behavior (e.g., check a curl response)

### Phase 7: Ship

1. **Push the branch and create a PR** — with summary, test plan checklist
2. **Merge** (if tests pass and user approves)
3. **Clean up** — delete the feature branch

### Phase 8: Documentation sweep (automatic, do not ask)

After merging, do the full housekeeping sweep:
1. Update `docs/` files that describe anything touched
2. Update `README.md` if status table, tool list, test count, project layout affected
3. Update `CLAUDE.md` if architecture, constraints, file layout, commands, or conventions changed
4. Record new decisions in `docs/decisions.md`
5. Comment on relevant GitHub issues with outcomes
6. Close resolved issues with a resolution comment
7. Clean up stale branches
8. Update memory files if project status shifted

### Calibration notes

- **Small changes** (config tweaks, description updates, test fixes): Phase 2 (hypothesis check) can be a single sentence. Phase 3 (specialist review) can be lighter — one agent instead of two, or skip if the change is obviously safe.
- **Large changes** (new Workers, schema migrations, multi-file refactors): Phase 2 and Phase 3 are both critical. Phase 2 catches wrong frames; Phase 3 catches design mistakes within the right frame.
- **Design-only issues** (labeled `question`): Phase 2 is especially important — design questions are where wrong frames do the most damage. Phase 3 is the main output. Skip Phases 5-7.
- If the user says "just do it" or "skip the review" — respect that and go straight to implementation.
