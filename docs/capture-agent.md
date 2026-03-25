# Capture agent

*What the capture pipeline does to your input and why — field descriptions, linking logic, voice correction, traceability rules. Read this to understand or tune capture behavior.*

The capture agent is an LLM that turns raw user input into a structured fragment. It runs once per message, produces 6 fields in a single pass, and never asks the user for clarification.

> **Note (2026-03-13):** `type`, `intent`, and `modality` were removed from the capture pipeline (#110, decision in #104). The classification complexity didn't justify the marginal retrieval value. The fields below — title, body, tags, links, corrections, source_ref — are the capture output. Existing notes may still have type/intent/modality values from before the change.

## Output at a glance

| Field | Purpose |
|---|---|
| **title** | A claim or question — never a topic label. States the fragment's point so you can scan a list without opening each one. |
| **body** | Faithful to your words, as long as needed — no compression. Typically 1–4 sentences. |
| **tags** | 2–7 kebab-case labels, anchored to existing tags from related notes when applicable |
| **links** | Edges to related notes (`contradicts` or `related`) |
| **corrections** | Voice dictation fixes, applied silently and reported |
| **source_ref** | URL if one was included |

The body follows a strict traceability rule: every sentence must trace back to something you actually said. The agent transcribes, not interprets. Voice dictation input is fully supported — the agent detects and silently corrects transcription errors, cross-referencing proper nouns against existing notes.

Each field is detailed in the sections below.

## What goes in?

The system captures idea fragments — whatever the user sends, in their own voice. A fragment can be a focused single thought, a rough observation, a question, a quote, a reflection. No pressure to be atomic or complete. The capture pipeline structures each fragment (title, body, tags, links) and preserves the user's exact words in `raw_input`.

Fragments with these properties produce the best immediate results from the capture pipeline:
- **One central claim or question.** A single claim title covers the fragment honestly.
- **Self-contained.** A reader gets the point without chasing dependencies.
- **Voice-preserving.** Reads like the user talking — their words, their phrasing. Mid-thought starts are fine.
- **Complete but not padded.** Enough to land the idea, no more.

These are ideals, not requirements. Every fragment is captured faithfully regardless of how close it is to these properties. The value of a fragment doesn't come only from its individual structure — it also comes from how it connects to and accumulates with other fragments over time. The synthesis layer (planned) builds higher-order structures from accumulated fragments.

### Title model

The title states the fragment's claim or poses its question. It never merely labels a topic.

- **Claim title** (default): "Espresso workflow needs a dedicated grinder"
- **Question title** (for exploratory input): "Is SKOS overkill for a personal tag vocabulary?"
- **Never a label**: "Coffee thoughts", "PKM ideas"

The claim must be the user's claim, derivable from their words — never editorialized. If the user's input is exploratory and doesn't arrive at a position, use a question title rather than manufacturing a conclusion.

### Descriptive range (not prescriptive)

- Sweet spot: 20–150 words in the body, 1–4 sentences
- Below 20 words: thin but captured — may gain value through links and accumulation
- Above 300 words: likely contains multiple ideas — the capture pipeline picks one for the title, which means the others get weaker structuring

These are descriptions of where focused fragments tend to land, not targets. Word count is a weak proxy. The real test is the title: if a single claim title covers the fragment honestly, the pipeline will produce good structure regardless of length.

### Multi-fragment input

The system captures everything faithfully — it never rejects input. When input contains multiple ideas, the structured output is degraded: the title can only name one idea, tags blur across topics, links become ambiguous. The fragment is still stored with `raw_input` preserved.

Detection heuristics (used as quality signals for the capture LLM, not as user-facing warnings):

| Signal | Threshold |
|---|---|
| Word count < 10 | Thin fragment |
| Word count > 300 | Likely multi-idea |
| Enumerated list | 3+ items |
| Multiple paragraphs | 3+ |
| Tag spread across 3+ domains | Scatter signal |
| Title requires "and" between unrelated clauses | Multi-idea signal |

These heuristics help the capture LLM assess how to structure its output. The implications for user-facing behavior (whether/how to surface these signals) need design work — see #116.

For the original research basis, see [#108](https://github.com/freegyes/project-ContemPlace/issues/108).

## Multilingual capture

The capture agent accepts input in any language. The capture voice instructs the LLM to always produce English output (title, body, tags) regardless of input language. Translation is faithful — meaning, tone, and specificity are preserved. The language conversion is logged in the `corrections` field (e.g., `"hu → en"`).

`raw_input` always preserves the user's original words in their original language, untouched. Translation is structural interpretation — the same category as titling and tagging.

The stored embedding uses the English body (not raw_input), keeping the embedding space monolingual. This ensures gardening, clustering, and retrieval all operate in a single language space. The capture-time related-note lookup still embeds raw_input (any language) against stored English embeddings — the lower match threshold (0.35) compensates for the cross-language penalty.

Search queries must be in English (the system language). The system language is currently English, encoded in the capture voice — not yet a configurable setting.

For the full experiment data and design rationale, see ADR "Multilingual capture" in `decisions.md` and [#210](https://github.com/freegyes/project-ContemPlace/issues/210).

## Temporal context

The capture agent receives the user's most recent fragments (titles and tags only, no bodies) as temporal context alongside the semantic matches. This helps with:

- **Tag vocabulary consistency** — if a recent fragment uses `pen-plotting`, the agent reuses that tag phrasing instead of inventing `plotter-art`
- **Voice correction** — domain terms appearing in recent fragments are likely to recur in the current input

Recent fragments are presented separately from related notes and are explicitly not linking targets. The agent only creates links to recent fragments when the semantic connection is independently clear — temporal proximity alone is not sufficient.

The feature uses a hybrid approach: last N fragments within a time window. `RECENT_FRAGMENTS_COUNT` (default 5) controls the maximum count, `RECENT_FRAGMENTS_WINDOW_MINUTES` (default 60) controls the time cutoff. Outside the window, the section is empty — "no recent context" is better than stale context. Set either to 0 to disable. Recent fragments that also appear in the semantic matches are deduplicated — each note appears in at most one context section.

## Linking

The agent receives the top 5 semantically related notes (with their titles and bodies) and can create typed links to them.

### Link types (capture-time)

| Type | Meaning |
|---|---|
| `contradicts` | Challenges or stands in tension with a prior note. The only capture-time type that surfaces information vector similarity alone cannot detect — similar embeddings mean similar topic, not opposing positions. |
| `related` | Any other meaningful connection: builds on, reinforces, exemplifies, parallels. The generic default when notes are connected but not in tension. |

> **History (v4 simplification, 2026-03-14):** Originally 5 capture-time types (`extends`, `contradicts`, `supports`, `is-example-of`, `duplicate-of`). Empirical analysis of 224 links showed `supports` accounted for 82.5% — a catch-all default, not a real classification. Only `contradicts` (6 links, all correct) added information beyond proximity. The rest were collapsed to `related`. See ADR "Simplify link types" in `decisions.md`.

### Link types (gardening-time)

| Type | Source | Status |
|---|---|---|
| `is-similar-to` | Auto-generated from vector similarity above `GARDENER_SIMILARITY_THRESHOLD` (see `gardener/wrangler.toml`) | ✅ Live |

`is-similar-to` links include auto-generated context from shared tags, and `confidence` = cosine similarity score. Created by the gardener's similarity linker phase (clean-slate delete + reinsert each run).

## Voice correction

The system prompt instructs the LLM to:

1. Scan for words that are likely voice transcription errors (wrong homophones, out-of-place words)
2. Cross-reference proper nouns against the related notes provided as context. If a common word in the input is phonetically similar to a domain-specific term in the related notes, and the surrounding context (entities, materials, techniques) favors the domain term, prefer it.
3. Silently apply corrections in the title and body
4. Report all corrections in the `corrections` field as `"garbled → corrected"` pairs

Corrections appear in the Telegram reply so the user can verify. This makes voice dictation a viable primary input method without requiring the user to proofread.

## The traceability rule

The capture voice (stored in the database, not in code) enforces a bright-line rule:

> Every sentence in the body must be traceable to something the user actually said.

The agent may clean up grammar, remove filler, and lightly restructure — but it must not add information, conclusions, elaborations, or descriptions that the user did not express. If the input is short, the body is short. One sentence is fine.

**Question preservation** (added PR #76): If the input contains questions, they must be preserved as questions in the body. The agent must not answer them, synthesize related notes into an answer, or reframe them as statements. Related notes are for linking context only — never fold their content into the body. This rule lives in SYSTEM_FRAME (structural correctness), not the capture voice (stylistic).

**Sentiment preservation** (added 2026-03-15 audit): The user's evaluative stance and emotional reactions must be preserved — "I liked," "I'm missing," "it felt like." The agent must not neutralize sentiment or rewrite personal reactions as neutral descriptions. Dropping "I liked how it showed" to "The film showed" violates the traceability rule by removing the user's expressed stance.

**Title register** (added 2026-03-15 audit): Titles must use the user's vocabulary, not academic equivalents or genre classifications. If the user said "ongoing series like Community," the title should not say "ensemble comedies." If the user said "agreed upon preference," the title should not say "contingent agreements." The claim in the title must be derivable from the user's words in their register.

**Commitment level** (added 2026-03-16 audit, strengthened 2026-03-25 audit): Titles must preserve the user's commitment level. If the user said "try," "maybe," "consider," "thinking about," or "I have an idea about," the title should reflect that tentativeness, not upgrade it to a definitive action or inferred purpose. The capture voice includes WRONG/RIGHT counter-examples to reinforce this — e.g., "thinking about getting a new bike" should not become "Research bikes and create moodboard."

**No expansion** (added 2026-03-25 audit): If the input is short, the body is short. A 10-word input should produce roughly a 10-word body. The LLM must not expand a brief input with detail from related notes, images, or its own knowledge. This rule lives in SYSTEM_FRAME and was added after the 2026-03-25 audit found that photo captions and other short inputs were being expanded with content from related notes — violating the traceability rule by attributing related-note content to the user.

**Preserve uncertainty** (added 2026-03-25 audit): The user's hedging and confidence markers must be preserved exactly as stated — in both the title and the body. "Maybe X would work" stays as "maybe"; "I guess" stays; "I think" stays. The LLM must not remove these markers or upgrade tentative observations to definitive statements. This rule lives in SYSTEM_FRAME alongside the question and no-expansion rules.

**Body length** (updated #108): No fixed sentence count. The body is as long as it needs to be to land the idea faithfully — typically 1–4 sentences. Shorter is better than padded, but completeness beats brevity when the idea requires it. The previous "up to 8 sentences" ceiling was removed; the principle replaces the heuristic.

This rule exists because the capture LLM (Haiku) tends to add a summarizing conclusion that restates what the user's words already showed. The traceability rule explicitly prohibits this. The user's raw input is the source of truth; the structured note is a cleaned-up presentation of it, not an interpretation.

## Input normalization

Before the raw text reaches the capture LLM, `normalizeForLLM()` replaces typographic double-quote variants (U+201C–201F, U+FF02) with ASCII `"`. This prevents the LLM from echoing them as JSON delimiters, which breaks `JSON.parse()`. The normalization only affects the LLM input — `raw_input` is stored verbatim with the original characters.

This is especially relevant for Hungarian input, which commonly uses `„"` (low-high) quotation marks, but covers all Unicode double-quote variants including full-width `＂` from CJK input.

## Parser and fallbacks

`parseCaptureResponse()` validates fields from the LLM's JSON output. When a field is missing or invalid, the parser applies a default and logs the event as structured JSON:

| Field | Invalid behavior | Default |
|---|---|---|
| `tags` | Not an array | `[]` |
| `links` | Invalid link_type, missing to_id | Filtered out |
| `corrections` | Not an array | `null` |

Every fallback produces a structured log line (`{event: "field_defaulted", field, raw_value, default}`) for prompt tuning. If the LLM returns invalid JSON entirely, the error is logged with the first 200 characters of the raw response.

The parser is covered by unit tests (`tests/parser.test.ts`) that run locally with no network dependencies.

## Tuning the capture voice

The stylistic rules live in the `capture_profiles` table, not in code. To change how titles are phrased, how the body reads, or what examples the LLM sees:

```sql
UPDATE capture_profiles
SET capture_voice = 'Your new prompt text here'
WHERE name = 'default';
```

No redeployment needed. The next capture will fetch the updated voice.

The structural contract (JSON schema, enum values, extraction rules) lives in `SYSTEM_FRAME` in `mcp/src/capture.ts`. Changing that requires a code deployment. This split is intentional — structural changes are rare and need testing; stylistic tuning should be instant.
