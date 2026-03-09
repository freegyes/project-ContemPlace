# Review 10 — v2 Prompt Engineering Analysis

> Reviewing the revised system prompt and parser in `reviews/06-implementation-plan-v2.md` (Task 5) against the production prompt in `src/capture.ts` and the research recommendations in `planning-inputs/note_taking_recommendations.md`.

---

## 1. Prompt Size and Token Budget

### [Advisory] The v2 prompt fits comfortably but leaves less margin than v1

**Token estimates** (using ~4 characters per token as a rough guide for mixed English/JSON):

| Component | v1 tokens (est.) | v2 tokens (est.) |
|---|---|---|
| System prompt | ~650 | ~950 |
| User message (date + raw input) | ~50–200 | ~50–200 |
| Related notes (5 x ~100 tokens each) | ~500 | ~500 |
| **Total input** | **~1,200–1,350** | **~1,500–1,650** |
| Max output (`max_tokens: 1024`) | 1,024 | 1,024 |
| **Total input + output budget** | **~2,350** | **~2,650** |

Claude Haiku 3.5 (the model behind `anthropic/claude-haiku-4-5` on OpenRouter) has a 200K context window. Even the worst-case budget of ~2,650 tokens is 1.3% of the context window. There is no context window concern.

The v2 system prompt is roughly 300 tokens larger than v1 — a ~46% increase. This adds a fraction of a cent per call. Not a problem in isolation, but worth noting that the prompt is now doing more work per call (see section 5 on JSON reliability).

**Recommendation:** No action needed. The budget is comfortable. If related notes grow longer (e.g., including `raw_input` in the related notes section), revisit.

---

## 2. New Field Reliability

### [Important] `intent` has too many options with overlapping boundaries

The 7 `intent` values have at least three pairwise ambiguities that will produce inconsistent classification from Haiku:

1. **`remember` vs `reference`** — "Check out this article about kettle stitch binding" could be `remember` (storing a detail for later), `reference` (saving external content), or even `lookup`. The prompt defines `reference` as "saving external content (articles, links, quotes)" and `remember` as "storing a fact, name, detail, or reference for later." The word "reference" appears in both definitions.

2. **`plan` vs `create`** — "I want to build a bookbinding jig this weekend" is both planning future action and capturing something to make. The prompt says `create` is "capturing something to make or build" and `plan` is "thinking about future action." These overlap whenever the future action is building something.

3. **`wish` vs `plan`** — "Would be nice to try screen printing someday" is both a wish and a plan. The boundary is vague — `wish` says "a desire or aspiration" while `plan` says "thinking about future action." Every wish is a future action at low commitment.

**Fix:** Reduce `intent` to 5 values by merging the ambiguous pairs. Drop `reference` (subsume into `remember` — the `source` type and `source_ref` field already capture the external-content signal). Drop `wish` (subsume into `plan` — commitment level is a spectrum, not a binary). This leaves `reflect`, `plan`, `create`, `remember`, `log` — each with a clear boundary. Alternatively, keep 7 but add a disambiguation tiebreaker rule to the prompt (e.g., "If the input could be `plan` or `wish`, use `plan`. If the input could be `remember` or `reference`, use `remember` when no URL is present, `reference` when a URL is present.").

### [Advisory] `modality` detection will struggle with inline lists

The `list` modality is defined as "bullet points, numbered items, comma-separated items." But many real inputs are inline lists embedded in prose: "I need eggs, milk, and bread for the frittata recipe." This is simultaneously `text` (a sentence) and `list` (comma-separated items). The prompt provides `mixed` as an escape hatch, but Haiku will likely default to `text` for inline lists because the input reads as a sentence.

**Fix:** Add an explicit example to the `modality` instructions: "A sentence that enumerates items ('I need eggs, milk, and bread') is `list`, not `text`. Use `text` only when the content is purely prose with no enumeration." Or accept that `modality` will be approximate and let the gardening pipeline refine it later — which is the plan's stated philosophy anyway.

### [Important] Entity extraction needs stronger guardrails

The instruction "Do not invent entities from generic nouns" is necessary but insufficient. Haiku will face two failure modes:

**Over-extraction:** Input like "I've been thinking about creativity and how constraints help" has no named entities, but `creativity` and `constraints` are plausible `concept` entities. The prompt says not to invent from "generic nouns," but the entity type `concept` is defined as "named frameworks, methodologies, movements" — and "creativity" sits right on the border between a generic noun and a named concept. Haiku will sometimes extract it, sometimes not.

**Under-extraction of corrected names:** If voice dictation garbles "PlugData" as "plug data," the corrections field will record `"plug data → PlugData"`, but the entity extraction instruction doesn't say to use the corrected version. It will sometimes extract the garbled form, sometimes the corrected one, sometimes nothing.

**Fix for over-extraction:** Add a positive-only rule: "Only extract entities that are proper nouns (capitalized in standard writing) or specific named things. Generic abstract nouns like 'creativity', 'constraints', 'productivity' are NOT entities even if they match the `concept` type." This is a sharper boundary than "do not invent."

**Fix for under-extraction with corrections:** See section 6 below.

---

## 3. Default Fallback Strategy

### [Advisory] The defaults are correct but should be logged

The parser defaults `intent` to `'remember'` and `modality` to `'text'` when the LLM returns an invalid value. These are the right choices:

- `remember` is the most general intent — it's the "I'm storing something" baseline, equivalent to `idea` being the default type.
- `text` is the most common modality for Telegram messages.

However, the current parser applies these defaults silently. If Haiku consistently returns an invalid value for a field, the system won't know — every note will look correctly classified. This masks prompt failures.

**Fix:** Add a `console.warn` when a default is applied:

```typescript
const intent: Intent = VALID_INTENTS.includes(obj['intent'] as Intent)
  ? (obj['intent'] as Intent)
  : (() => {
      console.warn(JSON.stringify({
        event: 'field_defaulted',
        field: 'intent',
        raw_value: obj['intent'],
        default: 'remember',
      }));
      return 'remember' as Intent;
    })();
```

This is a small change that provides early warning if the prompt needs tuning. Apply the same pattern to `modality` and `type`.

---

## 4. Prompt Clarity and Ambiguity

### [Critical] `type` and `intent` have overlapping semantics that will confuse the model

The prompt asks Haiku to assign both `type` (4 options) and `intent` (7 options) to the same input. Several pairings are near-synonyms:

| `type` | `intent` | Overlap |
|---|---|---|
| `reflection` | `reflect` | Same word, same meaning. The prompt defines `reflection` type as "first-person, personal insight" and `reflect` intent as "processing an experience or feeling." A personal insight about an experience triggers both. |
| `source` | `reference` | The `source` type is "from an external source with a URL" and `reference` intent is "saving external content (articles, links, quotes)." Any URL share triggers both. |
| `lookup` | `reference` | The `lookup` type is "research or investigation prompt" and `reference` intent is "saving external content." "Check out this article on X" straddles both. |

The risk: Haiku may treat these as redundant signals and make them agree (always pairing `reflection` type with `reflect` intent, `source` type with `reference` intent). This produces zero additional information — the two fields become mirrors of each other instead of orthogonal facets.

The research doc explicitly proposes `intent` and `type` as independent facets from different systems (LATCH+IM vs. Tana/Anytype). They're supposed to cross-cut: a `reflection` could have `plan` intent (reflecting on what to do next), a `source` could have `remember` intent (bookmarking without planning action).

**Fix:** Add an explicit instruction to the prompt that breaks the mirroring:

```
**Type and intent are independent.** Type describes the *form* of the note (is it an idea, a reflection, a source reference, or a research prompt?). Intent describes *what the user is doing* (planning, reflecting, creating, remembering, etc.). A `source` type note can have `plan` intent (saving a link to act on later). A `reflection` type note can have `remember` intent (recording a personal realization for future reference). Do not assume they must match.
```

Place this after the `intent` definition block, before `modality`. Without this instruction, expect ~70% of notes to have redundant type/intent pairings.

### [Advisory] "Transcription not interpretation" vs. entity extraction

The body rule says: "Your job is transcription, not interpretation. Use the user's own words and phrasing wherever possible." But entity extraction inherently requires interpretation — deciding that "PlugData" is a `tool` and "Prague" is a `place` requires understanding beyond transcription.

This isn't a real conflict because the "transcription" instruction applies to the `body` field specifically, not to the entire output. But a small model might generalize the instruction and become conservative about entity extraction.

**Fix:** Add one sentence to the entities section: "Entity extraction is separate from the body rule — extract entities based on meaning, even though the body preserves the user's exact words."

---

## 5. JSON Output Format Expansion

### [Important] 10 fields increases malformed JSON risk; `max_tokens` may need a bump

The v1 output had 7 fields (title, body, type, tags, source_ref, corrections, links). The v2 output has 10 fields (adding intent, modality, entities). The `entities` field contains nested objects, each with `name` and `type` — this is the first nested-object array in the output beyond `links`.

Haiku is generally reliable at JSON output, but the risk increases with:
- More fields to remember (the model must close all braces correctly)
- Nested object arrays (`entities` and `links` both need `[{...}, {...}]` syntax)
- Longer outputs (more tokens before the closing `}`)

A typical v2 response with 3 entities, 2 links, and 2 corrections will be roughly 350–500 tokens. This is well within the 1024 `max_tokens` limit, but a note with a longer body (5 sentences), several entities, and multiple links could push toward 600–700 tokens. There's headroom, but less than v1.

**Fix (temperature):** Keep `temperature: 0.3`. Lowering to 0.0–0.1 would reduce JSON formatting variance but also reduce the quality of title generation and body writing, which benefit from some creativity. The 0.3 setting is a good trade-off. The real safety net is the existing code-fence stripping and JSON parse error handling in the parser.

**Fix (max_tokens):** Consider bumping `max_tokens` to 1536 as a safety margin. The extra 512 tokens of headroom cost nothing unless used, and prevent truncated JSON on edge cases with many entities and long bodies. Truncated JSON is the most likely failure mode — the model runs out of tokens mid-object and the parser throws "invalid JSON."

**Fix (structural):** Add a `response_format: { type: "json_object" }` parameter to the API call if OpenRouter supports it for this model. This constrains the model to output valid JSON, eliminating the code-fence stripping and most parse failures. Check OpenRouter's docs for Haiku support.

---

## 6. Voice Correction Interaction with Entities

### [Important] Corrected names should explicitly flow into entities

The prompt handles voice corrections and entity extraction as separate tasks with no connection between them. Consider this input:

> "I was playing around with plug data and the granular synthesis patch is really cool"

The corrections field will record `["plug data → PlugData"]`. The body will use "PlugData." But the entity extraction instruction doesn't say to use corrected names. Haiku might:

1. Extract `{"name": "PlugData", "type": "tool"}` — correct, using the corrected form
2. Extract `{"name": "plug data", "type": "tool"}` — wrong, using the garbled form
3. Extract nothing — if the model is uncertain about the garbled input

Outcome 1 is the desired behavior but isn't guaranteed.

**Fix:** Add one sentence to the entities section: "If you corrected a name in the `corrections` field, use the corrected version in `entities`."

---

## 7. Related Notes Format

### [Advisory] The current format is adequate but could be more compact and informative

The related notes section currently formats each note as:

```
[uuid] "title"
body
```

With 5 related notes at ~100 tokens each, this adds ~500 tokens to the context. The body text is the most expensive part and provides the most linking context. Dropping it would save tokens but reduce link quality.

Two improvements that don't increase token count:

**Include type and intent of related notes.** This helps the LLM make better linking decisions. A note with `type: reflection` is more likely to be `supports` than `extends` relative to an `idea` note. The format change is minimal:

```
[uuid] "title" (idea · plan)
body
```

This adds ~5 tokens per note (~25 total) and provides useful signal for link-type selection and for avoiding the type/intent mirroring problem (the model sees that related notes have diverse type/intent combinations).

**Truncate long bodies.** If a related note's body exceeds 3 sentences, truncate to 2 sentences. Most of the linking signal is in the title and first sentence. This bounds the worst case without losing much.

**Fix:** Update the `relatedSection` builder in `runCaptureAgent`:

```typescript
const relatedSection = relatedNotes.length > 0
  ? '\n\nRelated notes for context:\n' +
    relatedNotes.map(n => {
      const meta = [n.type, n.intent].filter(Boolean).join(' · ');
      const truncBody = n.body.split('. ').slice(0, 3).join('. ');
      return `[${n.id}] "${n.title}" (${meta})\n${truncBody}`;
    }).join('\n\n')
  : '';
```

---

## 8. Cost Estimation

### [Advisory] Per-capture cost is very low; the extra embedding call is negligible

**Pricing** (based on OpenRouter rates as of early 2026; verify against current pricing page):

| Component | Model | Rate | Est. tokens | Est. cost |
|---|---|---|---|---|
| Embedding (raw text) | text-embedding-3-small | ~$0.02/1M tokens | ~200 | $0.000004 |
| Embedding (augmented) | text-embedding-3-small | ~$0.02/1M tokens | ~250 | $0.000005 |
| Capture LLM input | claude-haiku-3.5 | ~$0.80/1M input tokens | ~1,600 | $0.00128 |
| Capture LLM output | claude-haiku-3.5 | ~$4.00/1M output tokens | ~450 | $0.00180 |
| **Total per capture** | | | | **~$0.0031** |

At $0.003 per capture, 100 notes per month costs ~$0.31. The v2 changes add roughly $0.0004 per capture compared to v1 (longer system prompt input + extra embedding call + slightly longer output). This is a ~15% cost increase that is immaterial.

The two-pass embedding strategy (raw for lookup, augmented for storage) adds one extra embedding call per capture. At $0.000005 per call, this is effectively free. The retrieval quality improvement documented in the recommendation doc (20–40% precision gain) is worth orders of magnitude more than the cost.

**Note:** OpenRouter adds a small markup over direct API pricing. The estimates above assume OpenRouter's published rates, which may differ slightly from Anthropic's direct pricing. Verify at `openrouter.ai/models/anthropic/claude-haiku-4-5`.

---

## Summary of Issues

| # | Severity | Issue | Section |
|---|---|---|---|
| 1 | **Critical** | `type` and `intent` will mirror each other without explicit independence instruction | 4 |
| 2 | **Important** | `intent` has 3 ambiguous pairs that will produce inconsistent classification | 2 |
| 3 | **Important** | Entity extraction lacks guardrail for proper-noun-only extraction | 2 |
| 4 | **Important** | Corrected voice names don't flow into entities | 6 |
| 5 | **Important** | `max_tokens: 1024` has reduced headroom for 10-field output; consider 1536 | 5 |
| 6 | **Advisory** | Silent fallback defaults mask prompt failures; add logging | 3 |
| 7 | **Advisory** | `modality` will misclassify inline lists as `text` | 2 |
| 8 | **Advisory** | Related notes format could include type/intent metadata | 7 |
| 9 | **Advisory** | "Transcription not interpretation" could suppress entity extraction | 4 |
| 10 | **Advisory** | Token budget and cost are fine; no action needed | 1, 8 |

The single highest-impact fix is adding the type/intent independence instruction (issue 1). Without it, the new `intent` field adds near-zero information because it will parrot `type`. That one paragraph in the prompt is the difference between a useful orthogonal facet and a redundant column.
