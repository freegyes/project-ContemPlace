# Security Review — Implementation Plan v2

**Scope:** Schema evolution (JSONB columns, SKOS concepts, enrichment log, two-pass embedding), updated capture agent, expanded Telegram reply format. Reviewed against the deployed Phase 1 codebase and the Phase 1 security review (`reviews/02-security.md`).

**Threat model assumption:** Single-user personal system. The attacker surface is (1) anyone who discovers the Worker URL, (2) the LLM producing unexpected output, (3) accidental secret exposure. There is no multi-tenant access control to evaluate.

---

## 1. New Attack Surfaces

### 1.1 [Important] LLM output in `entities` rendered as Telegram HTML

**Problem.** The v2 plan adds entity names to the Telegram reply:

```typescript
const entityNames = capture.entities.map(e => esc(e.name)).join(', ');
lines.push(`Entities: ${entityNames}`);
```

The `esc()` function handles `&`, `<`, `>`. This is correct for preventing HTML tag injection. However, the entity `name` field is free-form text returned by the LLM. A prompt injection attack — where the user's raw input contains instructions like `"My friend <b>HACKED</b> told me..."` — would be escaped correctly by `esc()`. The risk here is not HTML injection (which `esc()` handles) but that the LLM could hallucinate entity names that were never in the input. See issue 4.1 below.

No code fix needed for HTML injection specifically — the existing `esc()` call on `e.name` is sufficient. But see 1.2 and 4.1.

### 1.2 [Important] Entity `type` field not escaped or validated before display

**Problem.** The v2 Telegram reply displays entities but only shows names, not types. However, the `entities` JSONB is stored directly from the LLM output. The parser in `capture.ts` validates that each entity has a `name` (string) and `type` (string from the allowed set), which is correct. But neither `name` nor `type` has a **length limit**. A pathological LLM response could return an entity name that is thousands of characters long, which would:
- Produce a Telegram message that exceeds the 4096-character limit, causing the `sendMessage` call to fail silently.
- Store an arbitrarily large JSONB value in Postgres.

**Fix.** Truncate entity names in the parser:

```typescript
// In parseCaptureResponse, when filtering entities:
typeof ent['name'] === 'string' &&
ent['name'].length <= 200 &&  // add this
```

And in `index.ts`, guard the Telegram message length before sending:

```typescript
const reply = lines.join('\n');
await sendTelegramMessage(config, chatId, reply.slice(0, 4096), 'HTML');
```

### 1.3 [Advisory] JSONB injection via `entities` and `metadata` columns

**Problem.** The `entities` column is `jsonb default '[]'` and `metadata` is `jsonb default '{}'`. The LLM output is parsed by `JSON.parse()` and validated (entity objects must have `name: string` and `type: string` from the allowed set). Supabase's PostgREST layer parameterizes all values, so there is no SQL injection risk from JSONB content — the value is bound as a parameter, not interpolated into a query string.

The `metadata` column is not populated at capture time (it is for gardening-time enrichment), so there is no attack surface on it yet.

**Residual risk.** If a future MCP server or gardening pipeline reads `entities` JSONB and interpolates values into a query string or template without parameterization, injection becomes possible. This is a design-time concern, not a current vulnerability.

**Fix.** No immediate fix needed. Add a comment in `db.ts` or the migration noting that JSONB columns contain LLM-generated content and must never be interpolated into raw SQL.

### 1.4 [Advisory] Enrichment log exposes model identifiers

**Problem.** The `enrichment_log` table stores `model_used` (e.g., `anthropic/claude-haiku-4-5`, `openai/text-embedding-3-small`). This is inserted via:

```typescript
await logEnrichment(db, noteId, 'capture', config.captureModel);
await logEnrichment(db, noteId, 'embedding', config.embedModel);
```

These model strings are not secrets — they are publicly documented model names. The enrichment log is protected by RLS (`using(false)`) and only accessible via the service role key. No API keys, token counts, or cost data are stored.

**Residual risk.** If an MCP server in Phase 2 exposes the enrichment log without filtering, a connected AI agent could see which models are in use. This is low-value intelligence for an attacker but worth noting for completeness.

**Fix.** None required for Phase 1.5. When the MCP server is built, do not expose `enrichment_log` as a queryable resource unless there is a specific use case.

### 1.5 [Advisory] Two-pass embedding doubles the API call surface

**Problem.** The v2 flow calls the embedding API twice per capture: once for the raw text (to find related notes) and once for the metadata-augmented text (for storage). This doubles the embedding cost and the number of outbound API calls.

**Security implication.** If the OpenRouter API key is compromised or if the Worker is being hammered by an attacker who has the webhook secret, the cost doubles. The existing rate-limiting advice (set a spending limit on OpenRouter) still applies and is still the primary mitigation.

**Fix.** No code change. Ensure the OpenRouter spending limit accounts for the doubled embedding cost per capture.

---

## 2. RLS Coverage

### 2.1 [Important] RLS coverage is complete — verify deployment matches the migration

**Problem.** The v2 migration enables RLS on all 7 tables and creates `using(false)` policies:

| Table | RLS enabled | Policy |
|---|---|---|
| `notes` | Yes | `using(false)` |
| `links` | Yes | `using(false)` |
| `concepts` | Yes | `using(false)` |
| `note_concepts` | Yes | `using(false)` |
| `note_chunks` | Yes | `using(false)` |
| `enrichment_log` | Yes | `using(false)` |
| `processed_updates` | Yes | `using(false)` |

This is the correct pattern from the Phase 1 security review. The `using(false)` approach is cleaner than the original `auth.role() = 'service_role'` pattern and was explicitly recommended in `02-security.md`. All service-role access bypasses RLS entirely; all anon/authenticated access is denied.

**Potential gap.** The two RPC functions (`match_notes` and `match_chunks`) are declared as `language sql stable` with no `security definer`. This means they run with the caller's privileges and respect RLS — correct. However, the functions access `public.notes` and `public.note_chunks` directly. Since the service role key bypasses RLS, these function calls will work. If anyone ever calls them with the anon key, they will return zero rows (because the `using(false)` policy denies all reads). This is the correct behavior.

**Fix.** No code fix. After deploying the migration, verify in the Supabase dashboard:
1. All 7 tables show "RLS Enabled" in the Authentication tab.
2. Each table has exactly one policy named "deny all".
3. Neither RPC function has `security definer`.

### 2.2 [Advisory] `concepts` table seed data is accessible only via service role

The `seed_concepts.sql` inserts rows into `concepts`, which has RLS `using(false)`. This means the SKOS vocabulary is inaccessible via the anon key — correct for a single-user system where all access goes through the Worker or a future MCP server.

No issue here. Noted for completeness.

---

## 3. Telegram HTML Injection

### 3.1 [Important] The `esc()` function is sufficient for Telegram HTML mode, with one caveat

**Problem.** Telegram's HTML parse mode supports a limited set of tags: `<b>`, `<i>`, `<u>`, `<s>`, `<a>`, `<code>`, `<pre>`, `<tg-spoiler>`, `<blockquote>`. Telegram rejects messages that contain unrecognized tags or malformed HTML. The `esc()` function escapes `&`, `<`, `>`, which prevents any LLM output from being interpreted as HTML tags. This is correct.

**The caveat.** The `esc()` function does not escape `"` (double quote). This matters only inside HTML attribute values. In the v2 reply format, no LLM-generated content appears inside an HTML attribute (there are no `<a href="...">` tags using LLM output). If a future version adds hyperlinks using LLM-provided URLs, the `esc()` function must also escape `"` to `&quot;`. For now, no change is needed.

**The `capture.type` and `capture.intent` values are not escaped.** In line:

```typescript
`<i>${capture.type} · ${capture.intent} · ${capture.tags.join(', ')}</i>`,
```

`capture.type` is validated against a fixed set (`idea|reflection|source|lookup`), and `capture.intent` is validated against a fixed set (`reflect|plan|create|remember|wish|reference|log`). Neither can contain HTML-special characters. This is safe.

`capture.tags` are not escaped but are filtered to strings only. A tag like `<script>` would break Telegram's HTML parsing and cause the message send to fail. The LLM is unlikely to produce such tags, but defensive escaping would be cheap insurance.

**Fix.** Escape tags in the metadata line:

```typescript
`<i>${capture.type} · ${capture.intent} · ${capture.tags.map(esc).join(', ')}</i>`,
```

### 3.2 [Advisory] Telegram message failure on malformed HTML is a silent error

**Problem.** If `esc()` fails to catch something and Telegram rejects the message (HTTP 400 with "Bad Request: can't parse entities"), the error is logged but the user sees nothing — the note is already stored in the database, but no confirmation is received.

This is the same behavior as v1 and is acceptable for a single-user system where the user can check the database directly. The `telegram_send_error` log event captures the failure.

**Fix.** No immediate fix. If this becomes a recurring issue, add a fallback: on Telegram send failure with HTML, retry without `parse_mode` (plain text).

---

## 4. Data Exposure in the Capture Agent Prompt

### 4.1 [Important] Entity extraction creates a hallucination risk for PII

**Problem.** The system prompt instructs the LLM to extract entities of type `person`, `place`, `tool`, `project`, `concept`. The prompt says "Do not invent entities from generic nouns." However, LLMs can still:

1. **Hallucinate names.** If the user says "I talked to my neighbor about gardening," the LLM might invent a name for the neighbor from its training data.
2. **Surface training-data PII.** If the user mentions a company or project name, the LLM might associate it with real people from its training data and extract those names as entities — names the user never mentioned.
3. **Confuse related-note content with current input.** Related notes are passed in the user message. If a related note mentions "John" and the current input does not, the LLM could extract "John" as an entity for the current note.

In a personal system where the only user is the system owner, the privacy risk is self-contained. The hallucinated entity would be stored in the owner's own database. The risk is not data leakage to third parties but data pollution — incorrect entity records that degrade retrieval quality.

**Fix.** Strengthen the entity extraction instruction in the system prompt:

```
**Entities**: extract named entities **explicitly mentioned in the input text** — not from related notes, not from your training data, not inferred from context. If a name is ambiguous or only implied, do not extract it. Return an empty array if no clear named entities appear in the input.
```

The current prompt says "Do not invent entities from generic nouns" — this should be expanded to explicitly prohibit sourcing entities from related notes or training data.

### 4.2 [Advisory] Related notes passed to the LLM expose the full note graph

**Problem.** This is unchanged from v1. Related notes (up to 5) are passed in the user message with their UUID, title, and body. The LLM sees this content to decide on links. In v2, the `match_notes` function also returns `raw_input`, `intent`, `modality`, and `entities` — but the `relatedSection` in `capture.ts` only uses `id`, `title`, and `body`, so the expanded return columns are not exposed to the LLM.

**Fix.** No fix needed. The code correctly limits what the LLM sees. If a future change passes `raw_input` or `entities` from related notes into the prompt, reassess.

---

## 5. Secrets and Environment

### 5.1 [Advisory] No new secrets required

The v2 plan does not introduce any new environment variables or secrets. The existing set is unchanged:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `OPENROUTER_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ALLOWED_CHAT_IDS`
- `CAPTURE_MODEL`
- `EMBED_MODEL`
- `MATCH_THRESHOLD`

The `model_used` values written to `enrichment_log` come from `config.captureModel` and `config.embedModel`, which are the model string identifiers (e.g., `anthropic/claude-haiku-4-5`), not API keys. No secret material enters the database.

### 5.2 [Advisory] `.dev.vars.example` does not need updating

No new env vars, so the example file does not change. Confirmed.

---

## 6. Phase 1 Security Posture: Retained, Regressed, or Missing

### 6.1 [Critical] Error messages in Telegram leak internal state

**Problem.** This exists in v1 and is unchanged in v2. The catch block in `processCapture` sends the raw error message to Telegram:

```typescript
`Something went wrong capturing your note.\n\nError: ${errorMessage}\n\nPlease try again.`
```

`errorMessage` can contain:
- Database error messages from Supabase (which may include table names, column names, constraint names)
- OpenRouter API error messages (which may include the model string, rate limit details, or partial request data)
- Stack traces if an unexpected error type is thrown
- The `cleaned.slice(0, 200)` from JSON parse failures, which contains raw LLM output

In a single-user system where the Telegram chat is private, this is low risk — the user is the system owner. But if the chat ID whitelist were misconfigured, or if a future channel (Slack, web) is added, these error messages could leak internal structure to unauthorized users.

**Fix.** Send a generic error to Telegram; log the details to console only:

```typescript
catch (err: unknown) {
  const errorMessage = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({
    event: 'capture_error',
    error: errorMessage,
    chatId,
    textPreview: text.slice(0, 100),
  }));
  await sendTelegramMessage(
    config,
    chatId,
    'Something went wrong capturing your note. Check the logs for details.',
  );
}
```

### 6.2 [Important] Webhook secret comparison is not timing-safe

**Problem.** Noted in `02-security.md` as "overkill" for a bearer-token scheme, but the Phase 1 review explicitly called it out. The v2 plan preserves the same direct string comparison:

```typescript
if (!incomingSecret || incomingSecret !== config.telegramWebhookSecret) {
```

The Phase 1 review's assessment that this is acceptable for Telegram's scheme is still valid. A timing attack against a 64-character hex string over the network is not practical. No regression.

### 6.3 [Important] `match_notes` function: `search_path` pinned correctly

**Problem.** The v1 codebase fixed the `match_notes` function to include `set search_path = ''` after the Phase 1 security review identified a search-path vulnerability. The v2 migration preserves this:

```sql
language sql stable
set search_path = ''
```

Both `match_notes` and the new `match_chunks` function have this set. No regression.

### 6.4 [Important] `update_updated_at()` trigger function lacks `search_path` pinning

**Problem.** The trigger function `update_updated_at()` is declared as:

```sql
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
```

This function does not set `search_path`. It uses only `now()`, which is a system function and cannot be hijacked via search path. However, for consistency with the security posture applied to `match_notes` and `match_chunks`, and to prevent future modifications from introducing a search-path vulnerability, it should be pinned.

**Fix.** Add `set search_path = ''` to the function:

```sql
create or replace function update_updated_at()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
```

### 6.5 [Advisory] Phase 1 pre-commit hook recommendations not yet implemented

**Problem.** The Phase 1 security review (`02-security.md`, R1) recommended installing `gitleaks` as a pre-commit hook via a committed `.gitleaks.toml` and `scripts/install-hooks.sh`. The current repository does not have these files. This is not a regression (they were recommended, not required), but the recommendation still applies.

**Fix.** Implement when convenient. Not blocking for v2.

### 6.6 [Advisory] OpenRouter spending limit reminder

**Problem.** The Phase 1 review (R6) recommended setting a spending limit on the OpenRouter dashboard. With the two-pass embedding in v2, the cost per capture increases. The recommendation is unchanged and still applies.

**Fix.** Verify the spending limit accounts for doubled embedding calls. If the limit was set at $5/month for v1 usage patterns, it may need a small increase.

### 6.7 [Advisory] `to_id` in links not validated as an existing note UUID

**Problem.** This exists in v1 and persists in v2. The `insertLinks` function inserts link rows where `to_id` comes from the LLM output. The LLM is supposed to reference UUIDs from the related notes passed in the prompt, but could hallucinate a UUID. The `links` table has a foreign key constraint (`references notes(id) on delete cascade`), so a non-existent UUID would cause the insert to fail with a FK violation error. This error is caught and logged:

```typescript
if (error) {
  console.error(JSON.stringify({ event: 'links_insert_error', ... }));
}
```

The note itself is already stored by this point, so a link insert failure does not lose the note. The behavior is correct — the FK constraint is the validation. No fix needed.

---

## Summary of Issues by Severity

| # | Severity | Issue | Action Required |
|---|---|---|---|
| 6.1 | Critical | Error messages leak internal state to Telegram | Send generic error to user, log details to console |
| 1.2 | Important | No length limit on entity names | Truncate in parser and cap Telegram message at 4096 chars |
| 3.1 | Important | Tags not escaped in Telegram HTML metadata line | Apply `esc()` to each tag |
| 4.1 | Important | Entity extraction can hallucinate from training data or related notes | Strengthen prompt to prohibit non-input-sourced entities |
| 6.4 | Important | `update_updated_at()` trigger lacks `search_path` pinning | Add `set search_path = ''` |
| 1.1 | Important | Entity names in Telegram reply (covered by `esc()`) | No fix needed — escaping is present |
| 2.1 | Important | RLS coverage complete — verify after deployment | Manual verification step |
| 6.2 | Important | Webhook secret comparison not timing-safe (accepted risk) | No fix needed |
| 6.3 | Important | `search_path` pinned on RPC functions | No regression — confirmed correct |
| 1.3 | Advisory | JSONB injection via entities/metadata | No fix now; document for future consumers |
| 1.4 | Advisory | Enrichment log exposes model identifiers | No fix now; filter in MCP server |
| 1.5 | Advisory | Two-pass embedding doubles API cost | Adjust OpenRouter spending limit |
| 3.2 | Advisory | HTML parse failure causes silent confirmation loss | Consider plaintext fallback |
| 4.2 | Advisory | Related notes exposed to LLM (unchanged from v1) | No fix needed |
| 5.1 | Advisory | No new secrets required | Confirmed |
| 6.5 | Advisory | Pre-commit hook not yet installed | Implement when convenient |
| 6.6 | Advisory | OpenRouter spending limit needs re-check | Verify limit covers doubled embedding |
| 6.7 | Advisory | Hallucinated link UUIDs caught by FK constraint | No fix needed |
