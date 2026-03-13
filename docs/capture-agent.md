# Capture agent

The capture agent is an LLM that turns raw user input into a structured note. It runs once per message, produces 7 fields in a single pass, and never asks the user for clarification.

> **Note (2026-03-13):** `type`, `intent`, and `modality` were removed from the capture pipeline (#110, decision in #104). The classification complexity didn't justify the marginal retrieval value. The fields below — title, body, tags, entities, links, corrections, source_ref — are the capture output. Existing notes may still have type/intent/modality values from before the change.

## Entity extraction

The agent extracts proper nouns from the input with five type categories: `person`, `place`, `tool`, `project`, `concept`.

Strict rules:
- Only extract entities **explicitly mentioned** in the user's input
- Never infer entities from related notes or training data
- Scan every input for proper nouns, regardless of length — a person mentioned by name must always appear in entities
- If a name was corrected via the `corrections` field, use the corrected version
- Names over 200 characters are filtered out (likely parser artifacts)
- Invalid entity types are filtered out

## Linking

The agent receives the top 5 semantically related notes (with their titles and bodies) and can create typed links to them.

### Link types (capture-time)

| Type | Meaning |
|---|---|
| `extends` | Builds on, deepens, or continues a prior note |
| `contradicts` | Challenges or stands in tension with a prior note |
| `supports` | Reinforces, provides evidence for, or runs parallel toward the same goal |
| `is-example-of` | A concrete instance of a more abstract prior note |
| `duplicate-of` | Covers substantially the same content as an existing note — same topic, detail, angle. Heuristic: if the new note would get the same or nearly identical title as the related note, it's a duplicate. Use `duplicate-of`, not `supports`. The note is still created; deduplication is a gardening concern. |

`supports` was broadened after real usage showed that sibling projects (e.g., two kitchen improvement ideas) weren't being linked because none of the original four types fit cleanly. Now `supports` covers both "provides evidence for" and "is a parallel effort toward the same goal."

### Link types (gardening-time)

Four additional types are assigned by the gardener Worker, not the capture agent:

| Type | Source | Status |
|---|---|---|
| `is-similar-to` | Auto-generated from vector similarity above threshold (0.70) | ✅ Live |
| `is-part-of` | Hierarchical grouping — planned for brain dump splitting (sibling notes from same input) | Planned |
| `follows` | Temporal sequence | Planned |
| `is-derived-from` | One note produced from another | Planned |

`is-similar-to` links include auto-generated context from shared tags and entities, and `confidence` = cosine similarity score. Created by the gardener's similarity linker phase (clean-slate delete + reinsert each run).

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

**Body length scaling** (added PR #76): The capture voice no longer enforces a fixed "1-5 sentences." Short inputs get 1-3 sentences. Longer inputs can use up to 8 sentences to preserve all actionable content. Shorter is still better than padded.

This rule exists because the capture LLM (Haiku) tends to add a summarizing conclusion that restates what the user's words already showed. The traceability rule explicitly prohibits this. The user's raw input is the source of truth; the structured note is a cleaned-up presentation of it, not an interpretation.

## Parser and fallbacks

`parseCaptureResponse()` validates fields from the LLM's JSON output. When a field is missing or invalid, the parser applies a default and logs the event as structured JSON:

| Field | Invalid behavior | Default |
|---|---|---|
| `tags` | Not an array | `[]` |
| `entities` | Invalid type, missing name, name > 200 chars | Filtered out (kept entities preserved) |
| `links` | Invalid link_type, missing to_id | Filtered out |
| `corrections` | Not an array | `null` |

Every fallback produces a structured log line (`{event: "field_defaulted", field, raw_value, default}`) for prompt tuning. If the LLM returns invalid JSON entirely, the error is logged with the first 200 characters of the raw response.

The parser is covered by unit tests (`tests/parser.test.ts`) that run locally with no network dependencies.

## Tuning the capture voice

The stylistic rules live in the `capture_profiles` table, not in code. To change how titles are phrased, how bodies read, or what examples the LLM sees:

```sql
UPDATE capture_profiles
SET capture_voice = 'Your new prompt text here'
WHERE name = 'default';
```

No redeployment needed. The next capture will fetch the updated voice.

The structural contract (JSON schema, enum values, extraction rules) lives in `SYSTEM_FRAME` in `src/capture.ts`. Changing that requires a code deployment. This split is intentional — structural changes are rare and need testing; stylistic tuning should be instant.
