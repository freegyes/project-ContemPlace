# Extract fragments

Search an Obsidian vault for notes related to a topic, decompose them into idea fragments re-voiced in the user's natural capture style, and interactively capture approved fragments into ContemPlace.

## Arguments

$ARGUMENTS — the topic to search for, described naturally. Examples: "I had thoughts about making a lap steel guitar", "notes about incremental formalization and PKM design", "my reflections on bookbinding techniques". Can be empty.

## Prerequisites

This command requires MCP access to both:
- **Obsidian vault** — semantic search and file read/update tools
- **ContemPlace** — `search_notes` and `capture_note` tools

## Workflow

### Phase 0: Topic selection (when no argument given)

If `$ARGUMENTS` is empty, help the user pick a topic:

1. **Report extraction progress.** Count notes with `contemplace: extracted` in frontmatter (grep) and total notes with `type: idea` or `type: reflection` in frontmatter (grep). Exclude non-note files (CLAUDE.md, command files). Report:
   ```
   Extraction progress: X / Y notes extracted (Z%)
   ```

2. **Identify unextracted clusters.** Glob for `MOC*.md` files. Read each MOC and check which of its linked notes lack `contemplace: extracted`. Rank MOCs by number of unextracted notes. Pick the top 3-5 MOCs with the most unextracted material.

3. **Present recommendations:**
   ```
   Suggested topics for extraction:
     - "topic description" — N unextracted notes (MOC Name)
     - "topic description" — N unextracted notes (MOC Name)
     ...
   ```

4. Wait for the user to pick one, then proceed to Phase 1 with that topic.

### Phase 1: Gather source material and style reference

Run these in parallel:

1. **Search the Obsidian vault** for notes matching the topic in `$ARGUMENTS`. Use semantic search. Cast a wide net — the user may have written about the topic across multiple notes, under different headings, using different vocabulary.

2. **Search ContemPlace** via `search_notes` for existing fragments related to the same topic. This serves **overlap detection**: if ContemPlace already has fragments covering an idea from the Obsidian notes, don't re-extract that idea. The goal is to bring in what's missing, not duplicate what exists.

3. **Also search ContemPlace** for fragments about writing style, tone of voice, or capture preferences. The user captures meta-preferences as fragments — these tell you what to avoid (generalizations, principle-speak, cross-references baked in).

4. **Search ContemPlace for real fragments in the same domain** — not the topic itself, but the same register. If the topic is lap steel guitar building, search for other making/building/fabrication fragments. Retrieve 5-10 of these. These are your primary voice calibration: they show you what the user's captures actually sound like in practice, not just what the user says they should sound like. The meta-preferences (step 3) define the guardrails; the domain fragments (this step) define the target.

Read the full content of each relevant Obsidian note found in step 1. **Skip notes that have the frontmatter tag `contemplace: extracted`** — those were processed in a prior session.

### Phase 2: Identify idea fragments

For each relevant Obsidian note, identify discrete idea fragments. A fragment is one idea — a claim, observation, question, reflection, reference, or insight that could stand on its own as a ContemPlace capture.

**Decomposition guidance:**
- A paragraph that makes one point is one fragment.
- A paragraph with two distinct points should be split.
- List items are fragments when each is a standalone claim. They are NOT separate fragments when they are subordinate examples of a single parent idea — in that case, the list and its parent form one fragment together.
- Quotes with attribution are standalone fragments.
- Headers mark topic boundaries but are not fragments themselves.
- Err on preserving the document's natural structure. If a paragraph is already a focused idea, take it whole. Do not try to extract sub-claims from well-integrated prose. Over-splitting is worse than under-splitting.
- Watch for **conceptual bridges** hiding behind the primary idea. A note might describe what a specific instrument does (primary fragment) *and* name a broader design space that connects it to other ideas (separate fragment). These are distinct captures. Example: "the LOG has a sliding pickup" is one fragment; "electromagnetic pickups can be expressive sensing tools beyond string amplification" is another.

**Strip Obsidian-specific syntax** during decomposition:
- `[[page name]]` → plain text "page name"
- `[[page name|display text]]` → display text only
- `![[embedded file]]` → remove entirely
- `> [!callout]` → keep the content, drop the callout marker
- Dataview queries, comments (`%%...%%`) → remove
- Standard markdown formatting → strip, keep plain text
- Inline `#tags` → remove (ContemPlace assigns its own tags)

**Skip entirely:**
- Fragments that are purely structural (tables of contents, link lists, navigation aids)
- Fragments already well-covered by existing ContemPlace captures (detected in Phase 1)
- Content that is metadata or formatting with no idea content

### Phase 3: Re-voice fragments

Rewrite each extracted fragment in the user's natural capture voice. This is the critical creative step.

**What re-voicing means:**
The Obsidian notes are heavily edited, LLM-synthesized prose. The user didn't write them in their natural voice — they were polished and formalized. Re-voicing recovers what the user might have said if they were capturing the idea fresh, as a quick thought in Telegram or a voice note.

**Use the ContemPlace style reference from Phase 1.** Match:
- Sentence length and rhythm
- Vocabulary — use the user's actual words for concepts, not academic equivalents
- Register — casual observation vs. firm claim vs. open question, matching how the user naturally frames similar ideas
- Specificity — the user's captures are concrete and grounded, not abstract

**Rules:**
- Preserve the idea faithfully. Re-voicing changes the surface form, not the meaning.
- Do not add, infer, or extend. If the Obsidian text says X, the fragment says X — in the user's voice, but the same claim.
- Do not merge ideas from different parts of the source. One fragment, one idea.
- Questions stay as questions. Claims stay as claims. Don't upgrade uncertainty to certainty.
- If a fragment references a specific source (book, person, article), keep the reference.
- **Strip cross-references.** Do not bake in connections like "same idea as X" or "same principle as Y." The Obsidian notes are full of wikilinks tying ideas together — those belong to the Obsidian graph, not to a raw capture. The ContemPlace capture pipeline discovers connections automatically through embedding similarity. A fragment should read like a standalone thought the user had, not a node in a knowledge graph. This includes **implicit cross-references** — suggesting a specific project's files as "a good first test" is still a cross-reference even without a wikilink. If removing the reference leaves the fragment too bare, that's fine: a short fragment is better than one with baked-in connections.
- **No principle-speak.** Fragments describe what to make, what was observed, or what happened — not universal truths or transferable principles. "Template-route a lap steel body from a single slab of wood" not "Template routing is a useful technique to learn for any shaped woodworking project." If a sentence could appear in a textbook, it's not re-voiced enough.
- **No synthesized jargon.** If a term came from LLM polishing rather than the user's own vocabulary, replace it with the simpler thing the user would actually say. "An engraved plate you can use in any printing process" not "a reusable intaglio printing matrix." When in doubt, check: would the user say this mid-conversation? If not, simplify.

### Phase 3b: Self-check against real fragments

Before presenting to the user, sanity-check the re-voiced fragments against 3-5 real ContemPlace fragments from the same domain (retrieved in Phase 1 step 4). Put them side by side and ask: does my output read like these? Check for:
- Cross-references that leaked in ("same idea as X", "connects to Y") — including implicit ones like "X files would be a good first test"
- Principle-speak or generalizations the user would never say mid-capture
- Synthesized jargon — terms that sound precise but came from LLM polishing, not the user's mouth
- Register mismatch — too formal, too abstract, too polished

If fragments fail the check, rework them before presenting. The user should see your best attempt, not a first draft that needs a correction round.

### Phase 4: Present for review

Present the proposed fragments as a numbered list. For each fragment:
- The re-voiced text (what will be sent as `raw_input`)
- Which Obsidian note and section it came from (for orientation)

**Format:**
```
Found N fragments across M Obsidian notes:

From "note-title.md" (section: Heading):
  1. "The re-voiced fragment text..."
  2. "Another fragment..."

From "other-note.md" (section: Heading):
  3. "Fragment from a different note..."
```

Then ask: **"Review these fragments. You can approve all, pick specific numbers, ask me to rework any, or reject ones that don't belong."**

Wait for the user. This is an interactive session. The user may:
- Approve all or a subset ("capture 1, 3, 5")
- Ask to rework a fragment ("make 2 more casual" or "that's not what I meant — the idea is more like...")
- Reject fragments ("skip 4, that's already covered")
- Ask to split or combine ("split 3 into two" or "2 and 5 are really the same idea")
- Edit directly ("change 1 to: [their preferred wording]")

Iterate until the user is satisfied with the set.

### Phase 5: Capture

For each approved fragment, call `capture_note` with:
- `raw_input`: the approved fragment text — clean, no prefixes, no metadata wrappers
- `source`: `"obsidian-import"`

Capture in parallel batches of ~6 for efficiency. After each batch, briefly report progress. If a capture fails, report the error and ask whether to retry, skip, or stop.

After all captures complete, print a summary:
```
Captured N fragments:
  1. "Title assigned" — tags: [tag1, tag2]
  2. "Title assigned" — tags: [tag1, tag2]
Skipped: #4 (user rejected), #6 (reworked into #7)
```

### Phase 6: Coverage check and mark processed Obsidian notes

Before marking any note, review whether it contains ideas that weren't extracted. For each note, briefly assess: is the note fully covered by the captured fragments (including fragments captured in earlier sessions detected via overlap in Phase 1), or does it still hold ideas that weren't pulled out?

Present a coverage summary:
```
Coverage:
  - "note-title.md" — fully covered
  - "other-note.md" — partial: the monochord-as-test-project idea wasn't extracted
  - "third-note.md" — fully covered
```

Let the user decide whether to extract more or accept the gaps before marking.

Then, for each note the user approves, update its frontmatter to add:
```yaml
contemplace: extracted
```

If the note already has frontmatter, add the field. If it doesn't, create a frontmatter block. This prevents re-processing in future sessions.

### Phase 7: Reflect

End the session by reflecting on the user's corrections and editorial decisions during Phase 4.

**Reflect on:**
- What re-voicing patterns the user corrected (too formal? too casual? wrong framing?)
- What fragment boundaries the user adjusted (too granular? too coarse?)
- What types of content the user rejected (already known? not worth capturing? wrong interpretation?)
- Any explicit preferences the user stated about how fragments should sound

**Output:** A brief reflection (3-5 bullet points) summarizing what was learned. Then ask: "Should I update the extract-fragments command to incorporate these lessons?"

If the user says yes, propose specific edits to this command file and apply them. The command evolves with use.

### Phase 8: Progress report

After the session is complete, report overall extraction progress using the same method as Phase 0 step 1:

```
Extraction progress: X / Y notes extracted (Z%)
```

This gives the user a running sense of how much of the vault has been migrated to ContemPlace.

## Calibration

- **This is a small-batch, high-touch process.** Expect 1-25 fragments per session depending on cluster size. The user wants close editorial control but can review large batches efficiently when fragments are well-organized by theme. Do not try to be efficient at the cost of curation quality.
- **Re-voicing is the hard part.** The quality bar is: would the user recognize this as something they'd plausibly say? If it sounds like an essay excerpt, it's not re-voiced enough. If it loses the idea's precision, it's over-simplified.
- **The user's corrections are the most valuable signal.** Pay close attention to how they rework fragments — that's direct evidence of their voice and standards.
- **Don't be precious about your decomposition.** If the user says "that's one idea, not three," they're right. Their editorial judgment is the ground truth.
- **Overlap detection is a courtesy, not a gate.** If the user wants to capture something similar to an existing fragment, that's their call. Flag it, don't block it.
- **The Obsidian files are source material, not source of truth.** After extraction, the ContemPlace fragments are the canonical versions. The Obsidian notes are historical artifacts that happened to contain ideas worth re-capturing.
