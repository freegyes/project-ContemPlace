import OpenAI from 'openai';
import type { Config } from './config';
import type { CaptureResult, CaptureLink, MatchedNote, CaptureLinkType, Entity } from './types';

// ── System frame: structural contract between LLM and parser ──────────────────
// This part stays in code. It defines the JSON schema, field enums,
// entity/link rules — everything the parser depends on. Users don't touch it.
const SYSTEM_FRAME = `You are a knowledge capture agent. Structure the user's raw input as a single fragment and identify relationships to existing notes.

## Voice recognition correction

Input may come from voice dictation or quick typing. Before anything else:
1. Scan for misspellings and out-of-place words — phonetically plausible but wrong in context, or simply misspelled.
2. Cross-reference related notes for proper nouns, tool names, project names. If a common word in the input is phonetically similar to a domain-specific term that appears in the related notes, and the surrounding context (other entities, materials, techniques) matches the related note better than the common word, prefer the domain-specific term.
3. Silently correct in the output. Report in the \`corrections\` field (e.g., \`["cattle stitch → kettle stitch"]\`, \`["caleidoscope → kaleidoscope"]\`). Use null if nothing was corrected.

## Output fields

**Tags**: 2–7 lowercase kebab-case strings (e.g., \`laser-cutting\`, \`sound-art\`, \`experience-design\`). No \`#\` prefix, no spaces — use hyphens for multi-word tags. Include the specific subject of the fragment as a tag (e.g., \`cimbalom\`, not just \`percussion\`). Use remaining slots for broader categories.

**source_ref**: URL if the user included one, otherwise null.

**Entities**: extract named entities **explicitly mentioned in the input text** — not from related notes, not from your training data, not inferred from context. Only extract proper nouns (capitalized in standard writing) or specific named things. Generic abstract nouns like "creativity", "constraints", "productivity" are NOT entities even if they match a type below. If a name is ambiguous or only implied, do not extract it. If you corrected a name in the \`corrections\` field, use the corrected version in entities. Entity extraction is separate from the body rule — extract entities based on meaning, even though the body preserves the user's exact words.
Scan every input for proper nouns, regardless of length. A person mentioned by name must always appear in entities.
Each entity has a name and type:
- \`person\` — people (real names, nicknames, public figures)
- \`place\` — locations, cities, venues
- \`tool\` — software, apps, instruments, physical tools
- \`project\` — named projects, initiatives, creative works
- \`concept\` — named frameworks, methodologies, movements (e.g., "Zettelkasten", "GTD", "Wabi-sabi")
Return an empty array if no clear named entities appear in the input.

**Links**: for each related note provided, decide if a typed relationship applies.
Types: \`extends | contradicts | supports | is-example-of | duplicate-of\`
- \`extends\` — builds on, deepens, or expands the other note's idea
- \`contradicts\` — challenges or is in tension with it
- \`supports\` — provides evidence, reinforces, or is a parallel/sibling idea toward the same goal
- \`is-example-of\` — a concrete instance of the other note's concept
- \`duplicate-of\` — the new fragment covers substantially the same content as the related note. Test: if you would give the new fragment the same or nearly identical title as the related note, it is a duplicate. Use \`duplicate-of\`, not \`supports\`. Still create the note — deduplication is a gardening concern, not a capture concern.
Prefer more links over fewer. It is fine to link to zero notes.

If the input is very short, do your best. Do not ask for clarification.

**Body rule**: if the input contains questions, preserve them as questions in the body. Do not answer them, synthesize related notes into an answer, or reframe them as statements. The body captures what the user said, not what the system thinks the answer is. Related notes are provided for linking context only — never fold their content into the body.

Return valid JSON only. No text outside the JSON object.
{
  "title": "...",
  "body": "...",
  "tags": ["...", "..."],
  "source_ref": null,
  "corrections": ["garbled → corrected"] | null,
  "entities": [{"name": "...", "type": "person|place|tool|project|concept"}],
  "links": [
    { "to_id": "<uuid>", "link_type": "extends|contradicts|supports|is-example-of|duplicate-of" }
  ]
}`;

// ── Assemble full prompt ─────────────────────────────────────────────────────
// The capture voice (title/body style rules) is fetched from the DB at runtime.
// This keeps the stylistic part user-configurable while the structural contract
// stays in code. Any capture interface — Telegram, MCP, CLI — calls the same
// function and gets the same prompt.
function buildSystemPrompt(captureVoice: string): string {
  return SYSTEM_FRAME + '\n\n' + captureVoice;
}

const VALID_LINK_TYPES: readonly CaptureLinkType[] = ['extends', 'contradicts', 'supports', 'is-example-of', 'duplicate-of'];
const VALID_ENTITY_TYPES = ['person', 'place', 'tool', 'project', 'concept'] as const;

export async function runCaptureAgent(
  client: OpenAI,
  config: Config,
  text: string,
  relatedNotes: MatchedNote[],
  captureVoice: string,
): Promise<CaptureResult> {
  const today = new Date().toISOString().split('T')[0];
  const systemPrompt = buildSystemPrompt(captureVoice);

  const relatedSection = relatedNotes.length > 0
    ? '\n\nRelated notes for context:\n' +
      relatedNotes.map(n => `[${n.id}] "${n.title}"\n${n.body}`).join('\n\n')
    : '';

  const userMessage = `Today's date: ${today}\n\nCapture this:\n${text}${relatedSection}`;

  const completion = await client.chat.completions.create({
    model: config.captureModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 1536, // bumped from 1024 for 10-field output headroom [Review fix 10-§5]
  });

  const rawContent = completion.choices[0]?.message?.content;
  if (!rawContent) {
    throw new Error('LLM returned empty content');
  }

  return parseCaptureResponse(rawContent);
}

// Exported for unit testing [Review fix 12-§4a]
export function parseCaptureResponse(raw: string): CaptureResult {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`LLM returned invalid JSON: ${cleaned.slice(0, 200)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`LLM response is not an object: ${cleaned.slice(0, 200)}`);
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['title'] !== 'string') throw new Error('LLM response missing title');
  if (typeof obj['body'] !== 'string') throw new Error('LLM response missing body');
  if (!Array.isArray(obj['tags'])) throw new Error('LLM response missing tags array');

  // Truncate entity names at 200 chars, filter invalid types [Review fix 08-§1.2]
  const entities: Entity[] = Array.isArray(obj['entities'])
    ? (obj['entities'] as unknown[]).filter((e): e is Entity => {
        if (typeof e !== 'object' || e === null) return false;
        const ent = e as Record<string, unknown>;
        return (
          typeof ent['name'] === 'string' &&
          ent['name'].length <= 200 &&
          typeof ent['type'] === 'string' &&
          (VALID_ENTITY_TYPES as readonly string[]).includes(ent['type'] as string)
        );
      })
    : [];

  // Log dropped entities for prompt tuning [Review fix 12-§5b]
  if (Array.isArray(obj['entities'])) {
    const totalCount = (obj['entities'] as unknown[]).length;
    if (totalCount > entities.length) {
      console.warn(JSON.stringify({
        event: 'entities_filtered',
        kept: entities.length,
        dropped: totalCount - entities.length,
      }));
    }
  }

  const links: CaptureLink[] = Array.isArray(obj['links'])
    ? (obj['links'] as unknown[]).filter((l): l is CaptureLink => {
        if (typeof l !== 'object' || l === null) return false;
        const link = l as Record<string, unknown>;
        return (
          typeof link['to_id'] === 'string' &&
          VALID_LINK_TYPES.includes(link['link_type'] as CaptureLinkType)
        );
      })
    : [];

  const corrections: string[] | null = Array.isArray(obj['corrections'])
    ? (obj['corrections'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : null;

  return {
    title: obj['title'] as string,
    body: obj['body'] as string,
    tags: (obj['tags'] as unknown[]).filter((t): t is string => typeof t === 'string'),
    source_ref: typeof obj['source_ref'] === 'string' ? obj['source_ref'] : null,
    links,
    corrections: corrections?.length ? corrections : null,
    entities,
  };
}
