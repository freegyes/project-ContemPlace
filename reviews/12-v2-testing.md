# Review 12 — v2 Testing Strategy

> Reviewing the smoke test plan in Task 8 of `reviews/06-implementation-plan-v2.md` against the current production tests in `tests/smoke.test.ts` and the v2 code changes across `src/`.

---

## 1. Smoke Test Coverage Gaps

### 1a. Field value validation is missing [Important]

The v2 smoke test asserts `note.intent` is not null but never checks whether the value is one of the 7 valid intents. Same for `modality` (4 values), `type` (4 values), and entity types (5 values). The database CHECK constraints will reject invalid `intent` and `modality` at insert time, so a truly invalid value would cause an insert failure (caught by the existing "note was created" assertion). But the parser's fallback logic — invalid intent defaults to `'remember'`, invalid modality defaults to `'text'` — means a misconfigured prompt could silently fall back to defaults on every note. The smoke test would pass, and the bug would be invisible.

**Recommendation:** Add assertions that validate the returned values against the allowed sets:

```typescript
const VALID_INTENTS = ['reflect', 'plan', 'create', 'remember', 'wish', 'reference', 'log'];
const VALID_MODALITIES = ['text', 'link', 'list', 'mixed'];

expect(VALID_INTENTS).toContain(note.intent);
expect(VALID_MODALITIES).toContain(note.modality);
```

For the test input "Constraints make creative work stronger.", the expected intent is `'remember'` and modality is `'text'`. Consider asserting these exact values to catch prompt regression (the LLM classifying a plain text statement as `'list'` or `'plan'` would indicate a prompt problem).

### 1b. No enrichment_log assertions [Important]

The completion criteria (Task 9e, item 4) requires two `enrichment_log` entries per note — one for `capture`, one for `embedding`. The smoke test does not check this. It is listed as a manual verification step, but it is trivially automatable.

**Recommendation:** After fetching the test note, query `enrichment_log` by `note_id`:

```typescript
const { data: logs } = await db
  .from('enrichment_log')
  .select('enrichment_type, model_used')
  .eq('note_id', note.id);

expect(logs).toHaveLength(2);
expect(logs!.map(l => l.enrichment_type).sort()).toEqual(['capture', 'embedding']);
expect(logs!.every(l => l.model_used !== null)).toBe(true);
```

### 1c. No corrections test [Advisory]

The test input "Constraints make creative work stronger." contains no voice dictation errors, so `corrections` will be null. There is no test that sends garbled input to verify the corrections pipeline works end-to-end.

**Recommendation:** Add a test input with a deliberate voice-dictation-style error, e.g. `'The cattle stitch is the strongest bookbinding technique.'` (assuming related bookbinding notes exist) or a simpler garble. Assert that the returned note has a non-null `corrections` array. This is lower priority because the corrections pipeline is unchanged from v1, but it remains untested in both versions.

### 1d. No metadata-augmented embedding verification [Advisory]

The plan's key architectural change is two-pass embedding. The smoke test cannot easily verify that the stored embedding differs from a raw-text embedding (that would require calling the embedding API from the test). But the `embedded_at` timestamp assertion partially covers this — if the second embedding call fails, `embedded_at` would still be set because it is set before the call in the code.

Wait — looking more carefully at the v2 `insertNote` in Task 6, `embedded_at` is set to `new Date().toISOString()` at insert time, unconditionally. It does not depend on the second embedding call succeeding. If the augmented re-embed call throws, the entire `processCapture` function enters the catch block, and no note is inserted at all. So `embedded_at` being non-null does confirm the second embedding call succeeded.

**Recommendation:** The current assertion is sufficient for smoke testing. If you want a regression signal for the augmentation specifically, add a comment in the test explaining why `embedded_at` non-null implies the two-pass embedding completed.

---

## 2. Cleanup Strategy

### 2a. CASCADE handles child tables [Advisory]

The v2 schema defines `ON DELETE CASCADE` on all foreign keys referencing `notes(id)`: `links.from_id`, `links.to_id`, `note_concepts.note_id`, `note_chunks.note_id`, and `enrichment_log.note_id`. Deleting a note from the `notes` table will automatically cascade to all related rows in these tables.

The current cleanup strategy — `db.from('notes').delete().in('raw_input', TEST_RAW_INPUTS)` — will therefore clean up `links`, `enrichment_log`, `note_concepts`, and `note_chunks` automatically via CASCADE. No changes needed.

**One caveat:** The `processed_updates` table has no foreign key to `notes`. Test `update_id` values (based on `Date.now()`) accumulate in `processed_updates` forever. They are harmless (tiny rows, no index bloat at test scale), but if you want a pristine cleanup, delete the test update IDs explicitly:

```typescript
await db
  .from('processed_updates')
  .delete()
  .gte('update_id', UPDATE_ID_BASE)
  .lte('update_id', UPDATE_ID_BASE + 10);
```

**Recommendation:** Keep the current cleanup as-is. CASCADE covers everything meaningful. Add `processed_updates` cleanup only if the accumulated rows become a concern.

---

## 3. Test Data Isolation

### 3a. `Date.now()` collision risk is low but not zero [Advisory]

`UPDATE_ID_BASE = Date.now()` produces a millisecond-precision timestamp. Two parallel test runs would need to start within the same millisecond to collide. In practice, this is unlikely for manual runs. But CI pipelines with parallel jobs, or a developer hitting "run" twice quickly, could produce collisions. A collision would cause the second run's dedup test to silently pass (the update_id is already claimed), but the happy-path note capture would be skipped because the update_id is deduplicated.

**Recommendation:** If parallel test runs ever become possible (CI matrix, multiple developers), switch to a more unique base:

```typescript
const UPDATE_ID_BASE = Date.now() * 1000 + Math.floor(Math.random() * 1000);
```

This is not urgent. The current approach works for a single-developer project with manual test runs.

### 3b. `TEST_RAW_INPUTS` collides with real notes [Advisory]

If the user ever sends "Constraints make creative work stronger." as a real note, the test cleanup will delete it. This is an existing v1 issue, unchanged by v2.

**Recommendation:** Prefix test inputs with a marker string unlikely to appear in real usage:

```typescript
const TEST_RAW_INPUTS = [
  '[SMOKE-TEST] Constraints make creative work stronger.',
  '[SMOKE-TEST] Dedup test note.',
];
```

---

## 4. Parser Unit Tests

### 4a. `parseCaptureResponse` needs unit tests [Critical]

The v2 parser validates 10 fields with 5 distinct fallback behaviors:

1. Missing `title`, `body`, `type`, or `tags` throws an error.
2. Invalid `type` silently defaults to `'idea'`.
3. Invalid `intent` silently defaults to `'remember'`.
4. Invalid `modality` silently defaults to `'text'`.
5. Entities with invalid `type` are silently filtered out (not defaulted, dropped).
6. Links with invalid `link_type` are silently filtered out.
7. `corrections` that is not an array becomes `null`; an empty array also becomes `null`.

Each of these is a branching decision that produces correct output or silent data loss. Today they are only exercised by sending a message to the live Worker and hoping the LLM returns something that hits the fallback. That is not a test; it is a prayer.

The function is pure — no network calls, no dependencies. It takes a string and returns a `CaptureResult`. It is the ideal candidate for a focused unit test file.

**Recommendation:** Create `tests/parser.test.ts` with cases covering:

```
- Valid complete JSON → all fields populated correctly
- Missing intent field → defaults to 'remember'
- Invalid intent value ("bogus") → defaults to 'remember'
- Missing modality field → defaults to 'text'
- Invalid modality value → defaults to 'text'
- Invalid type value → defaults to 'idea'
- Empty entities array → entities is []
- Entities with invalid type → filtered out, valid ones kept
- Entity missing name field → filtered out
- Corrections as empty array → corrections is null
- Corrections as null → corrections is null
- Corrections as non-array → corrections is null
- Links with invalid link_type → filtered out
- JSON wrapped in markdown code fences → parsed correctly
- Non-JSON string → throws with descriptive message
- Missing required fields → throws with specific field name
```

To make this work, export `parseCaptureResponse` from `capture.ts` (currently it is a private function). This is a minor refactor with high payoff.

---

## 5. Edge Case Coverage

### 5a. Empty entities array [Advisory]

**Handled.** The parser defaults to `[]` when `entities` is an empty array or missing entirely. The database column has `default '[]'` and no NOT NULL constraint. This path works.

### 5b. Entities with invalid types [Important]

**Handled at the parser level, but silently.** An entity with `"type": "organization"` (not in the valid set) is filtered out by the parser. The note is stored without it. There is no log or signal that an entity was dropped.

**Recommendation:** Log dropped entities so you can tune the prompt if the LLM consistently returns entity types outside the valid set:

```typescript
const dropped = (obj['entities'] as unknown[]).filter(e => !isValidEntity(e));
if (dropped.length > 0) {
  console.log(JSON.stringify({ event: 'dropped_entities', dropped }));
}
```

### 5c. LLM omits intent or modality entirely [Important]

**Handled.** If `obj['intent']` is undefined, `VALID_INTENTS.includes(undefined as Intent)` is false, and the fallback assigns `'remember'`. Same for modality defaulting to `'text'`. The code works but produces no signal that the fallback fired.

**Risk:** If the LLM prompt regresses and stops returning `intent` entirely, every note gets `intent: 'remember'` and `modality: 'text'`. The smoke test (which only checks non-null) would pass. The data would be silently wrong.

**Recommendation:** Two mitigations:

1. In the parser, log when a fallback fires:
   ```typescript
   if (!VALID_INTENTS.includes(obj['intent'] as Intent)) {
     console.log(JSON.stringify({ event: 'intent_fallback', raw: obj['intent'] }));
   }
   ```

2. In the smoke test, assert specific expected values for the known test input (see 1a above).

### 5d. Metadata-augmented embedding call fails [Critical]

The v2 `processCapture` flow is: raw embed → find related → LLM → augmented embed → insert. If the augmented embedding call (step 4) throws, the entire function enters the catch block. The note is never inserted. The user gets an error message in Telegram. The raw input is lost (not stored anywhere).

This is worse than v1 behavior. In v1, there is only one embedding call, and it happens first. If it fails, nothing else runs — the user's message is not processed but it is still in Telegram's history. In v2, the LLM call has already succeeded (burning tokens and latency), but the note is discarded because a second embedding call failed.

**Recommendation:** Use the raw embedding as a fallback if the augmented embedding fails:

```typescript
let storedEmbedding: number[];
try {
  const augmentedInput = buildEmbeddingInput(text, capture);
  storedEmbedding = await embedText(openai, config, augmentedInput);
} catch (err) {
  console.warn(JSON.stringify({
    event: 'augmented_embed_fallback',
    error: err instanceof Error ? err.message : String(err),
  }));
  storedEmbedding = rawEmbedding; // fall back to raw embedding
}
```

This preserves the note with a slightly worse embedding rather than losing it entirely. The `enrichment_log` can record whether the stored embedding is `'embedding'` or `'embedding_raw_fallback'` for later re-embedding.

---

## 6. Test Timing

### 6a. 12-second wait may be tight for two-pass embedding [Important]

The v1 flow makes 3 external calls in the background: embed, LLM, Telegram reply. The v2 flow makes 4: embed, LLM, augmented embed, Telegram reply. Plus two `enrichment_log` inserts (fast, but still network calls to Supabase).

The extra embedding call adds ~200ms per the plan's estimate, but that is best-case. OpenRouter routing variability, cold starts, and rate limiting can push individual calls to 2-5 seconds. The LLM call alone can take 3-8 seconds for Haiku via OpenRouter. Total v2 background time could reach 12-15 seconds under load.

**Recommendation:** Increase the wait to 15 seconds. The test already has a 30-second timeout on the test case (`}, 30000`), so there is room. Better to wait 3 extra seconds than to have flaky tests:

```typescript
await new Promise(r => setTimeout(r, 15000));
```

Alternatively, poll the database in a loop with a 1-second interval and a 20-second timeout. This is faster on good days and more resilient on bad ones:

```typescript
let note = null;
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const { data } = await db
    .from('notes')
    .select('id, title, embedding, intent, modality, entities, embedded_at')
    .eq('raw_input', 'Constraints make creative work stronger.')
    .limit(1);
  if (data && data.length > 0) { note = data[0]; break; }
}
expect(note).not.toBeNull();
```

---

## 7. Manual Verification Steps

### 7a. Most manual checks are automatable [Important]

Task 9e lists 4 manual verification items:

| Manual check | Automatable? | How |
|---|---|---|
| Telegram reply shows `type . intent . tags` | No | Would require reading Telegram messages via Bot API — possible but fragile |
| Telegram reply shows `Entities:` line | No | Same |
| Notes row has non-null `intent`, `modality`, `entities`, `embedded_at` | Yes | Already in the v2 smoke test (issue 1a improves it) |
| `enrichment_log` has two rows | Yes | See issue 1b |

**Recommendation:** Automate items 3 and 4 into the smoke test (as described in 1a and 1b). Keep items 1 and 2 as manual verification — the cost of automating Telegram message reading is not worth it for a single-developer project.

---

## 8. Regression Risks

### 8a. `match_notes` function signature change breaks `findRelatedNotes` [Critical]

The v2 `match_notes` function adds two new parameters (`filter_intent` and `search_text`) and is moved to the `extensions` schema. The v2 `findRelatedNotes` code passes these new parameters. But the migration must be applied before deploying the Worker code. If the Worker deploys first — or if the migration partially fails — the Worker will call `match_notes` with parameters the function does not accept, or call `extensions.match_notes` when the function is still in `public`.

The current v1 `findRelatedNotes` calls `match_notes` (no schema prefix). The v2 code calls `match_notes` with the new params. The Supabase client's `.rpc()` method uses the function name without schema prefix by default.

**Specific risk:** The v2 migration creates `extensions.match_notes` but the Supabase JS client `.rpc('match_notes')` looks in `public` by default. If the function is in `extensions` and not `public`, the RPC call fails.

**Recommendation:** Verify the Supabase RPC call resolves `match_notes` correctly when the function is in the `extensions` schema. If not, either create the function in `public` or configure the Supabase client's schema. Add a smoke test that explicitly calls `match_notes` via the Supabase client (it is already implicitly tested by the happy-path capture, but a direct test would catch this failure mode faster).

Also: coordinate the deploy sequence. Schema migration first, verify in dashboard, then `wrangler deploy`. Document this in the plan.

### 8b. v1 notes table has no `corrections` column [Important]

The v1 schema does not have a `corrections` column on the `notes` table. The v1 `insertNote` does not write corrections. But the v1 capture agent does return corrections (the field exists on `CaptureResult`), and `processCapture` logs them and shows them in the Telegram reply. They are just not stored in the database.

The v2 schema adds `corrections text[]` to the notes table, and the v2 `insertNote` writes `capture.corrections` to it. This is a clean addition — no regression risk here. But if the migration fails to apply the `corrections` column, the v2 Worker's `insertNote` will fail on every note that has corrections (Supabase would reject the unknown column). Notes without corrections would have `corrections: null` which maps to no column write.

Actually — the Supabase JS client sends all fields in the insert object, including `corrections: null`. If the column does not exist, the insert fails. So this is a hard dependency on the migration succeeding.

**Recommendation:** The smoke test implicitly catches this (the note insert would fail, and no note would appear in the DB). No additional action needed beyond ensuring migration-before-deploy ordering.

### 8c. Telegram reply format change [Advisory]

The v1 reply metadata line is `<i>${capture.type} . ${capture.tags.join(', ')}</i>`. The v2 line is `<i>${capture.type} . ${capture.intent} . ${capture.tags.join(', ')}</i>`. Additionally, v2 adds an `Entities:` line.

This is a visible change to the user. Not a regression, but worth noting: if the user has any automation parsing the Telegram reply (unlikely), it would break.

**Recommendation:** No action needed. The format change is intentional and well-documented.

### 8d. `buildEmbeddingInput` with undefined capture [Advisory]

The `buildEmbeddingInput` function accepts an optional `capture` parameter. If called without it (or with `undefined`), it returns the raw text unchanged. This is correct for the v2 flow (first embed uses raw text, no capture passed). But if someone accidentally passes `undefined` when they meant to pass the capture result, the augmentation silently does not happen.

**Recommendation:** Consider making the `capture` parameter required and having the caller explicitly pass `undefined` or use `embedText(openai, config, text)` directly for raw embedding. This is a minor code-clarity issue, not a test issue.

### 8e. Dedup test creates a note that may not be cleaned up [Important]

The dedup test sends the same update twice. The first send triggers a note capture in the background. The test asserts both return 200 but does not wait for the background processing of the first send to complete. At cleanup time, the `afterAll` deletes notes by `raw_input`. If the background processing has not finished by the time `afterAll` runs (unlikely but possible if tests complete very fast), the note could be inserted after cleanup ran.

More practically: the dedup test's note (`'Dedup test note.'`) is in `TEST_RAW_INPUTS` and will be cleaned up. But the test does not verify the dedup actually prevented double-insertion. It only checks that both HTTP responses are 200.

**Recommendation:** Add a post-wait assertion to the dedup test verifying only one note exists with that `raw_input`:

```typescript
it('deduplicates identical update_id', async () => {
  const update = makeUpdate(UPDATE_ID_BASE + 4, 'Dedup test note.');
  const first = await post(update);
  const second = await post(update);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);

  await new Promise(r => setTimeout(r, 15000));

  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data } = await db
    .from('notes')
    .select('id')
    .eq('raw_input', 'Dedup test note.');
  expect(data).toHaveLength(1);
}, 30000);
```

This is a stronger assertion than "both return 200." It proves the dedup mechanism actually prevented the duplicate.

### 8f. `findRelatedNotes` new parameters [Important]

The v2 `findRelatedNotes` passes `filter_intent: null` and `search_text: null` to `match_notes`. The v1 `findRelatedNotes` only passes `filter_type`, `filter_source`, and `filter_tags`. If the v2 code deploys against the v1 function signature, the RPC call will fail because the function does not accept those parameters. Postgres does not silently ignore extra named parameters.

This is the same underlying issue as 8a but worth restating: the deploy order is migration-then-Worker, and there is no safe intermediate state where the v2 Worker works against the v1 schema.

**Recommendation:** Make the smoke test the gate. Run the smoke test after deploying both schema and Worker. If it passes, the system is consistent. If it fails, roll back the Worker (redeploy v1 code) and investigate.

---

## Summary

| # | Issue | Severity | Action |
|---|---|---|---|
| 4a | Parser has no unit tests | Critical | Create `tests/parser.test.ts`, export `parseCaptureResponse` |
| 5d | Augmented embed failure loses the note | Critical | Fall back to raw embedding on second embed failure |
| 8a | `match_notes` schema/signature mismatch risk | Critical | Verify RPC schema resolution, enforce migration-before-deploy |
| 1a | Field values not validated against allowed sets | Important | Assert specific values, not just non-null |
| 1b | No `enrichment_log` assertions | Important | Query and assert 2 log entries per note |
| 5b | Dropped entities produce no signal | Important | Log filtered entities |
| 5c | Intent/modality fallback produces no signal | Important | Log when fallbacks fire |
| 6a | 12-second wait may be tight | Important | Increase to 15s or use polling |
| 7a | Automatable manual checks not automated | Important | Move DB checks into smoke test |
| 8e | Dedup test does not verify single-insertion | Important | Assert note count after wait |
| 8f | v2 Worker against v1 schema is a hard failure | Important | Gate deploy on migration success, smoke test after both |
| 1c | No corrections test | Advisory | Add garbled-input test case |
| 1d | No augmented-embedding verification | Advisory | Current assertions are sufficient |
| 2a | Cleanup does not touch `processed_updates` | Advisory | Optional; CASCADE handles everything else |
| 3a | `Date.now()` collision in parallel runs | Advisory | Low risk; randomize if CI is added |
| 3b | Test inputs could collide with real notes | Advisory | Prefix with `[SMOKE-TEST]` |
| 8c | Telegram reply format change | Advisory | Intentional; no action needed |
| 8d | `buildEmbeddingInput` optional param | Advisory | Consider making required |
