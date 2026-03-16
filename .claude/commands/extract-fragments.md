# Extract fragments

Search an Obsidian vault for notes related to a topic, decompose them into idea fragments re-voiced in the user's natural capture style, and interactively capture approved fragments into ContemPlace.

## Arguments

$ARGUMENTS — the topic to search for, described naturally. Examples: "I had thoughts about making a lap steel guitar", "notes about incremental formalization and PKM design", "my reflections on bookbinding techniques".

## Prerequisites

This command requires MCP access to both:
- **Obsidian vault** — semantic search and file read/update tools
- **ContemPlace** — `search_notes` and `capture_note` tools

## Workflow

### Phase 1: Gather source material and style reference

Run these in parallel:

1. **Search the Obsidian vault** for notes matching the topic in `$ARGUMENTS`. Use semantic search. Cast a wide net — the user may have written about the topic across multiple notes, under different headings, using different vocabulary.

2. **Search ContemPlace** via `search_notes` for existing fragments related to the same topic. These serve two purposes:
   - **Style reference**: The user's natural capture voice — sentence length, vocabulary, register, how they phrase claims vs. questions vs. observations. Pay attention to `raw_input` fields (their actual words) more than `body` (the capture agent's interpretation).
   - **Overlap detection**: If ContemPlace already has fragments covering an idea from the Obsidian notes, don't re-extract that idea. The goal is to bring in what's missing, not duplicate what exists.

3. **Also search ContemPlace** for fragments about writing style, tone of voice, or capture preferences. The user captures meta-preferences as fragments — these are direct instructions for how to re-voice.

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

Capture sequentially, one at a time. After each capture, briefly report the result (title and tags assigned by the capture pipeline). If a capture fails, report the error and ask whether to retry, skip, or stop.

After all captures complete, print a summary:
```
Captured N fragments:
  1. "Title assigned" — tags: [tag1, tag2]
  2. "Title assigned" — tags: [tag1, tag2]
Skipped: #4 (user rejected), #6 (reworked into #7)
```

### Phase 6: Mark processed Obsidian notes

For each Obsidian note that had fragments extracted and captured, update its frontmatter to add:
```yaml
contemplace: extracted
```

If the note already has frontmatter, add the field. If it doesn't, create a frontmatter block. This prevents re-processing in future sessions.

If only some fragments from a note were captured, still mark it — the user reviewed the full note and made editorial decisions. A future session can revisit if needed.

### Phase 7: Reflect

End the session by reflecting on the user's corrections and editorial decisions during Phase 4.

**Reflect on:**
- What re-voicing patterns the user corrected (too formal? too casual? wrong framing?)
- What fragment boundaries the user adjusted (too granular? too coarse?)
- What types of content the user rejected (already known? not worth capturing? wrong interpretation?)
- Any explicit preferences the user stated about how fragments should sound

**Output:** A brief reflection (3-5 bullet points) summarizing what was learned. Then ask: "Should I update the extract-fragments command to incorporate these lessons?"

If the user says yes, propose specific edits to this command file and apply them. The command evolves with use.

## Calibration

- **This is a small-batch, high-touch process.** Expect 1-15 fragments per session. The user wants close editorial control. Do not try to be efficient at the cost of curation quality.
- **Re-voicing is the hard part.** The quality bar is: would the user recognize this as something they'd plausibly say? If it sounds like an essay excerpt, it's not re-voiced enough. If it loses the idea's precision, it's over-simplified.
- **The user's corrections are the most valuable signal.** Pay close attention to how they rework fragments — that's direct evidence of their voice and standards.
- **Don't be precious about your decomposition.** If the user says "that's one idea, not three," they're right. Their editorial judgment is the ground truth.
- **Overlap detection is a courtesy, not a gate.** If the user wants to capture something similar to an existing fragment, that's their call. Flag it, don't block it.
- **The Obsidian files are source material, not source of truth.** After extraction, the ContemPlace fragments are the canonical versions. The Obsidian notes are historical artifacts that happened to contain ideas worth re-capturing.
