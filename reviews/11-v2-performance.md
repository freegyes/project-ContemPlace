# Performance Review — Implementation Plan v2

> Reviewer role: Performance engineering specialist
> Reviewing: `reviews/06-implementation-plan-v2.md`
> Baseline: Phase 1 deployed Worker + Supabase schema

---

## 1. End-to-End Latency [Important]

The v1 critical path runs five sequential stages inside `ctx.waitUntil()`. The v2 plan inserts a second embedding call and two enrichment log writes. Here is the revised waterfall with realistic latency estimates.

| Step | v1 | v2 | Notes |
|---|---|---|---|
| Embed #1 + typing action (parallel) | ~500ms | ~500ms | OpenRouter embedding via `text-embedding-3-small`. Typing action is fire-and-forget, masked by the embedding call. |
| match_notes RPC | ~200ms | ~250ms | Slightly heavier in v2: the function now evaluates an optional `content_tsv @@ plainto_tsquery` clause even when `search_text` is null. At <1000 rows the planner short-circuits this, so the difference is negligible. |
| LLM call (Haiku) | 2000–4000ms | 2000–4500ms | The v2 system prompt is ~60% longer (intent/modality/entities instructions). The output JSON adds three fields. Expect ~200ms more output tokens at the margin. |
| Embed #2 (metadata-augmented) | — | ~500ms | New. Sequential because the augmented string depends on the LLM output. |
| insertNote + insertLinks | ~150ms | ~180ms | v2 inserts more columns (intent, modality, entities JSONB, corrections, embedded_at). The generated `content_tsv` column and GIN index add ~10-20ms to the insert. |
| 2x logEnrichment | — | ~100ms | Two sequential inserts into enrichment_log. Each is a simple row with no indexes beyond the B-tree on `note_id`. |
| sendTelegramMessage | ~200ms | ~200ms | Unchanged. |

**v1 total:** ~3050–5050ms (P50 ~4s, P99 ~6s)
**v2 total:** ~3730–6230ms (P50 ~5s, P99 ~7.5s)

The 8-second target is still achievable at P95 but becomes tight at P99. The second embedding call is the largest single addition (~500ms). Two factors that could push P99 past 8 seconds:

- **OpenRouter cold starts or rate limiting.** Two embedding calls per capture doubles your exposure to transient latency spikes. A single OpenRouter hiccup on the second call adds directly to the critical path.
- **Haiku output length variance.** The entities array is unbounded — a message mentioning 8 named entities produces more output tokens.

**Recommendation:** The two `logEnrichment` calls are independent of each other and independent of the Telegram reply. Fire them in parallel with `Promise.all`, and consider firing them in parallel with `sendTelegramMessage` as well. This shaves ~100ms and, more importantly, removes them from the user-visible latency path. The user gets their Telegram reply before the enrichment log writes complete.

```typescript
// Instead of:
await logEnrichment(db, noteId, 'capture', config.captureModel);
await logEnrichment(db, noteId, 'embedding', config.embedModel);
await sendTelegramMessage(config, chatId, lines.join('\n'), 'HTML');

// Do:
await Promise.all([
  logEnrichment(db, noteId, 'capture', config.captureModel),
  logEnrichment(db, noteId, 'embedding', config.embedModel),
  sendTelegramMessage(config, chatId, lines.join('\n'), 'HTML'),
]);
```

This alone drops the P50 from ~5s to ~4.8s. Not transformative, but free.

---

## 2. Index Overhead on Write Path [Advisory]

**v1 index count:** 5 on notes, 1 on links = 6 total
**v2 index count:** 7 on notes, 3 on links, 1 on note_chunks, 1 on enrichment_log = 12 total

Each index must be updated on every insert to its table. The write amplification for a single note capture in v2:

| Table | Indexes updated | Estimated overhead |
|---|---|---|
| notes | 7 (HNSW, GIN tsv, GIN tags, GIN entities, B-tree created_at, partial B-tree active, partial B-tree null_embedding, B-tree intent) | ~15-25ms total |
| links | 3 (B-tree to_id, B-tree from_id, B-tree link_type) + unique constraint | ~5ms per link |
| enrichment_log | 1 (B-tree note_id) | ~2ms per row |

At the expected scale (hundreds to low thousands of notes), this is not a problem. Postgres handles 12 indexes on a table with 1000 rows without breaking a sweat. The HNSW index is the most expensive to maintain on insert (~5-10ms per vector), but this cost is constant regardless of how many B-tree indexes exist alongside it.

**Verdict:** Not over-indexed for the current use case. The indexes exist to support Phase 2 MCP query patterns (filter by intent, search entities, full-text hybrid search). Building them now avoids a migration + reindex later. The total insert overhead is ~25ms — well within the latency budget.

The one index worth questioning is `links_type_idx` (B-tree on `link_type`). With only 8 distinct values and a small table, the planner will often prefer a sequential scan. But the cost of having it is near zero, so this is not worth removing.

---

## 3. HNSW Index on Empty note_chunks Table [Advisory]

The v2 migration creates an HNSW index on `note_chunks.embedding` before any chunks exist. Chunking is explicitly deferred to Phase 2.

**Cost of an empty HNSW index:**

- **Storage:** An empty HNSW index occupies one 8KB page. Negligible.
- **Insert overhead:** Zero until the first row is inserted.
- **Maintenance:** Postgres does not vacuum or analyze empty indexes in any meaningful way.
- **Schema clarity:** Having the index in the same migration as the table keeps the schema self-documenting.

**Verdict:** No performance cost. The only argument for deferring it would be if you expected the HNSW parameters (`m = 16`, `ef_construction = 128`) to change based on real chunk data distribution. Since the parameters match the notes table (same embedding model, same dimensionality), they are almost certainly correct. Leave it.

---

## 4. Two-Pass Embedding Parallelization [Important]

The v2 plan runs embed #2 sequentially after the LLM call, then inserts the note with the augmented embedding. The question: could we insert the note with the raw embedding immediately (in parallel with embed #2), then UPDATE the embedding column when the augmented vector is ready?

**Option A (current plan — sequential):**
```
LLM → embed #2 → INSERT note (with augmented embedding)
```

**Option B (parallel insert + update):**
```
LLM → [INSERT note (raw embedding) | embed #2] → UPDATE note SET embedding = augmented
```

Option B saves ~500ms on the critical path. But the tradeoffs are real:

1. **Race condition window.** Between INSERT and UPDATE, the note has the raw embedding. Any concurrent `match_notes` call during that ~500ms window returns similarity scores computed against the raw vector. For a single-user system with ~10 messages/day, the probability of a collision is near zero.

2. **Two writes instead of one.** The INSERT writes the full row + HNSW index entry. The UPDATE rewrites the row (Postgres MVCC creates a new tuple) and updates the HNSW index again. This doubles the HNSW maintenance cost for this note.

3. **Complexity.** The current code has a clean linear flow. Option B introduces a Promise.all with a dependent UPDATE, error handling for partial failures (what if the UPDATE fails but the INSERT succeeded?), and a note that temporarily has a "wrong" embedding.

4. **The `embedded_at` column.** The plan sets `embedded_at` at insert time. With Option B, you'd need to update it again after the re-embed, or accept that it refers to the raw embedding timestamp.

**Recommendation:** Keep the sequential approach. The 500ms cost is worth the simplicity. The metadata-augmented embedding is the one you want stored from the start — it is the one that determines retrieval quality for every future query against this note. Storing the raw embedding first, even briefly, means any match_notes call in that window gets degraded results. The v2 plan's instinct here is correct.

If latency becomes a real problem, the better optimization target is parallelizing the enrichment log writes (see Section 1), not the embedding.

---

## 5. Generated tsvector Column + GIN Index [Advisory]

The `content_tsv` column is defined as:

```sql
content_tsv tsvector generated always as (
  to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, '') || ' ' || raw_input)
) stored
```

**Storage overhead per note:**

A tsvector stores unique lexemes (stemmed words) with positional information. For a typical note (~200 words, ~150 unique stems after English stopword removal):

- tsvector itself: ~1.5-2KB per note (150 lexemes x ~12 bytes each including positions)
- GIN index entry: ~1KB per note (lexeme references + posting lists)
- Total: ~2.5-3KB per note

At 1000 notes: ~3MB total. At 10,000 notes: ~30MB. Supabase Free tier has 500MB. This is not a concern.

**Is the GIN index justified at this scale?**

Without the index, `content_tsv @@ plainto_tsquery(...)` does a sequential scan. At 1000 rows, a sequential scan over tsvector columns takes ~2-5ms. The GIN index reduces this to ~0.5ms. The difference is negligible for the user.

However, the GIN index exists for the hybrid `match_notes` function, which combines vector similarity with full-text filtering. When `search_text` is non-null, the query planner can use the GIN index to pre-filter candidates before the HNSW vector scan. This matters more at 5000+ notes where the sequential scan would add 10-20ms to every hybrid query.

**Verdict:** Justified as a forward investment for Phase 2 MCP queries. The storage and write overhead are trivial. One concern: the generated column concatenates `title || body || raw_input`. For voice-dictated input, `raw_input` likely contains the same content as `body` (with corrections). This means the tsvector double-weights those terms. In practice this doesn't matter for boolean `@@` matching, but it's worth noting.

---

## 6. JSONB Entities Column with GIN Index [Important]

The `entities` column stores:
```json
[{"name": "Claude", "type": "tool"}, {"name": "Prague", "type": "place"}]
```

The default GIN index (`notes_entities_idx`) supports `@>` containment queries:

```sql
-- Find notes mentioning a specific entity
SELECT * FROM notes WHERE entities @> '[{"name": "Claude"}]'::jsonb;

-- Find notes mentioning any person
SELECT * FROM notes WHERE entities @> '[{"type": "person"}]'::jsonb;
```

**Problem:** The `@>` containment operator on a JSONB array of objects works, but it's not selective when filtering by a single key. The query `entities @> '[{"type": "person"}]'` matches any array element where `type = "person"` regardless of name — this is correct. But the default GIN index (`jsonb_ops`) indexes every key-value path in the document, including keys like `"name"` and `"type"` themselves, which have low selectivity.

**Better alternative:** A `jsonb_path_ops` GIN index is smaller and faster for `@>` queries because it only indexes values, not keys:

```sql
create index notes_entities_idx on notes using gin (entities jsonb_path_ops);
```

This index is ~40% smaller than the default `jsonb_ops` and faster for containment queries. The tradeoff: `jsonb_path_ops` does not support key-existence checks (`?`, `?|`, `?&`), but those aren't useful for the entities array pattern.

**Alternative pattern:** If the primary query is "find notes mentioning entity X by name," a computed expression index would be even more targeted:

```sql
-- Extract entity names as a text array for GIN indexing
create index notes_entity_names_idx on notes using gin (
  (SELECT array_agg(e->>'name') FROM jsonb_array_elements(entities) e)
);
```

However, this is more complex and Postgres may not use it via the Supabase client's query builder. The `jsonb_path_ops` change is simpler and more broadly useful.

**Recommendation:** Switch from default `jsonb_ops` to `jsonb_path_ops`. One-word change in the migration, measurable improvement in index size and query performance.

---

## 7. Enrichment Log Growth [Advisory]

At 2 rows per capture:

| Notes | enrichment_log rows | Estimated storage |
|---|---|---|
| 100 | 200 | ~25KB |
| 1,000 | 2,000 | ~250KB |
| 10,000 | 20,000 | ~2.5MB |

When the gardening pipeline arrives (Phase 2), each note may gain 2-4 additional enrichment entries (chunking, similarity links, tag normalization, maturity scoring). That pushes the ratio to 4-6x. At 10,000 notes: ~60,000 log entries, ~7.5MB.

**Is this a concern?** No. The enrichment_log table has no vector columns, no GIN indexes, no generated columns — just UUIDs, text, and timestamps with a single B-tree index on `note_id`. Postgres handles millions of such rows without issue. Supabase's 500MB Free tier limit is not threatened.

**Should old entries be pruned?** Not yet. The log's value is debugging and idempotency (knowing whether a particular enrichment already ran on a note). Pruning removes that information. If storage ever matters, a retention policy that drops entries older than 90 days would be trivial:

```sql
DELETE FROM enrichment_log WHERE completed_at < now() - interval '90 days';
```

But there is no reason to build this now.

---

## 8. Supabase Connection Pooling from Workers [Important]

The v2 flow makes these DB calls per capture:

1. `tryClaimUpdate` (sync, before 200)
2. `findRelatedNotes` (RPC call)
3. `insertNote`
4. `insertLinks`
5. `logEnrichment` x2

That's 5-6 round-trips to Supabase per message. The v1 flow had 3-4.

**How Supabase handles this:** The `@supabase/supabase-js` client uses PostgREST (HTTP API), not a raw Postgres connection. Each call is an independent HTTPS request to the PostgREST endpoint. There is no persistent connection and no connection pooling concern in the traditional Postgres sense — Supabase's PostgREST server manages its own connection pool to Postgres.

From Cloudflare Workers, this means:

- **No connection leak risk.** Each HTTP request is stateless.
- **No pool exhaustion.** PostgREST handles concurrency internally. Supabase Free tier allows up to 60 concurrent connections; PostgREST typically uses 10-20.
- **Latency per call:** Each PostgREST call incurs HTTP overhead (~20-40ms for TLS + request/response). Six calls at 30ms each = ~180ms of pure HTTP overhead. This is already included in the per-step estimates above.

**Potential issue:** If you ever switch to the Supabase Postgres connection string directly (e.g., for a migration to `postgres.js` or `drizzle`), Cloudflare Workers' connection model becomes relevant. Workers cannot hold persistent TCP connections between requests. You would need Supabase's connection pooler (PgBouncer on port 6543) in transaction mode. But this is not the current architecture.

**Recommendation:** The current PostgREST-over-HTTP approach scales fine for the expected load. The only optimization worth considering is batching the two `logEnrichment` calls into a single PostgREST request using `.insert([row1, row2])` instead of two separate calls:

```typescript
export async function logEnrichments(
  db: SupabaseClient,
  noteId: string,
  entries: Array<{ enrichment_type: string; model_used: string | null }>,
): Promise<void> {
  const rows = entries.map(e => ({
    note_id: noteId,
    enrichment_type: e.enrichment_type,
    model_used: e.model_used,
  }));
  const { error } = await db.from('enrichment_log').insert(rows);
  // error handling...
}
```

This reduces DB round-trips from 6 to 5 and saves ~30ms. Small win, but it also simplifies the calling code.

---

## Summary

| # | Issue | Severity | Action |
|---|---|---|---|
| 1 | P99 latency approaches 8s limit | [Important] | Parallelize enrichment log writes with Telegram reply. Monitor P99 after deploy. |
| 2 | 12 indexes across 4 tables | [Advisory] | Acceptable at current scale. No action needed. |
| 3 | HNSW index on empty note_chunks | [Advisory] | No cost. Leave it. |
| 4 | Two-pass embedding is sequential | [Important] | Keep sequential. Augmented embedding from the start is the right call. |
| 5 | Generated tsvector + GIN index | [Advisory] | Justified as Phase 2 investment. ~3KB/note overhead is negligible. |
| 6 | JSONB entities GIN index type | [Important] | Switch to `jsonb_path_ops` for smaller index and faster `@>` queries. |
| 7 | Enrichment log growth at 2x notes | [Advisory] | Not a concern below 100K notes. No pruning needed yet. |
| 8 | Supabase connection pooling | [Important] | PostgREST HTTP model avoids pool issues. Batch the two logEnrichment calls into one insert. |

The plan is sound. The 8-second latency target survives the v2 additions at P95 with room to spare. The two concrete changes worth making before implementation: switch `entities` to `jsonb_path_ops`, and batch/parallelize the enrichment log writes. Everything else is either correct as designed or deferred appropriately.
