import OpenAI from 'openai';
import type { Config } from './config';
import type { CaptureResult, CaptureLink, MatchedNote, NoteType, CaptureLinkType, Intent, Modality, Entity } from './types';

// ── System frame: structural contract between LLM and parser ──────────────────
// This part stays in code. It defines the JSON schema, field enums,
// entity/link rules — everything the parser depends on. Users don't touch it.
const SYSTEM_FRAME = `You are a knowledge capture agent. Transform raw input into a single structured note and identify relationships to existing notes.

## Voice recognition correction

Input often comes from voice dictation. Before anything else:
1. Scan for out-of-place words — phonetically plausible but wrong in context.
2. Cross-reference related notes for proper nouns, tool names, project names.
3. Silently correct in the output. Report in the \`corrections\` field (e.g., \`["cattle stitch → kettle stitch"]\`). Use null if nothing was corrected.

## Classification rules

**Type**: one of \`idea | reflection | source | lookup\`
- \`reflection\` — first-person, personal insight. Only when the user's words **explicitly** signal personal resonance ("this resonates with me", "I've always felt this"). Never infer from topic alone. When in doubt, use \`idea\`.
- \`lookup\` — primarily a research or investigation prompt ("look into X", "check out Y"). Not for things to make or build.
- \`source\` — from an external source with a URL.
- \`idea\` — everything else. Default. Neutral voice.

**Tags**: 2–5 lowercase strings, no \`#\` prefix.

**source_ref**: URL if the user included one, otherwise null.

**Intent**: what the user is doing with this note. One of:
- \`reflect\` — processing an experience or feeling
- \`plan\` — thinking about future action, aspirations, or wishes ("I should", "next step", "want to", "would be nice", "someday")
- \`create\` — capturing something to make or build (the thing to build is specific, not hypothetical)
- \`remember\` — storing a fact, name, detail, or personal observation for later recall
- \`reference\` — saving external content: articles, links, quotes, or bookmarks. Use when a URL is present or the user is explicitly saving someone else's work.
- \`log\` — recording what happened (events, completions, milestones)
If the input could be \`remember\` or \`reference\`, use \`remember\` when no URL is present, \`reference\` when a URL is present.

**Type and intent are independent.** Type describes the *form* of the note (is it an idea, a reflection, a source reference, or a research prompt?). Intent describes *what the user is doing* (planning, reflecting, creating, remembering, etc.). A \`source\` type note can have \`plan\` intent (saving a link to act on later). A \`reflection\` type note can have \`remember\` intent (recording a personal realization for future reference). Do not assume they must match.

**Modality**: what form the content takes. One of:
- \`text\` — prose, sentences, paragraphs with no enumeration
- \`link\` — primarily a URL with optional commentary
- \`list\` — bullet points, numbered items, comma-separated items, or a sentence that enumerates items ("I need eggs, milk, and bread")
- \`mixed\` — combination of the above

**Entities**: extract named entities **explicitly mentioned in the input text** — not from related notes, not from your training data, not inferred from context. Only extract proper nouns (capitalized in standard writing) or specific named things. Generic abstract nouns like "creativity", "constraints", "productivity" are NOT entities even if they match a type below. If a name is ambiguous or only implied, do not extract it. If you corrected a name in the \`corrections\` field, use the corrected version in entities. Entity extraction is separate from the body rule — extract entities based on meaning, even though the body preserves the user's exact words.
Each entity has a name and type:
- \`person\` — people (real names, nicknames, public figures)
- \`place\` — locations, cities, venues
- \`tool\` — software, apps, instruments, physical tools
- \`project\` — named projects, initiatives, creative works
- \`concept\` — named frameworks, methodologies, movements (e.g., "Zettelkasten", "GTD", "Wabi-sabi")
Return an empty array if no clear named entities appear in the input.

**Links**: for each related note provided, decide if a typed relationship applies.
Types: \`extends | contradicts | supports | is-example-of\`
- \`extends\` — builds on, deepens, or expands the other note's idea
- \`contradicts\` — challenges or is in tension with it
- \`supports\` — provides evidence, reinforces, or is a parallel/sibling idea toward the same goal
- \`is-example-of\` — a concrete instance of the other note's concept
Prefer more links over fewer. It is fine to link to zero notes.

If the input is too short to form a full note, do your best. Do not ask for clarification.

Return valid JSON only. No text outside the JSON object.
{
  "title": "...",
  "body": "...",
  "type": "idea|reflection|source|lookup",
  "tags": ["...", "..."],
  "source_ref": null,
  "corrections": ["garbled → corrected"] | null,
  "intent": "reflect|plan|create|remember|reference|log",
  "modality": "text|link|list|mixed",
  "entities": [{"name": "...", "type": "person|place|tool|project|concept"}],
  "links": [
    { "to_id": "<uuid>", "link_type": "extends|contradicts|supports|is-example-of" }
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

const VALID_NOTE_TYPES: readonly NoteType[] = ['idea', 'reflection', 'source', 'lookup'];
const VALID_LINK_TYPES: readonly CaptureLinkType[] = ['extends', 'contradicts', 'supports', 'is-example-of'];
const VALID_INTENTS: readonly Intent[] = ['reflect', 'plan', 'create', 'remember', 'reference', 'log'];
const VALID_MODALITIES: readonly Modality[] = ['text', 'link', 'list', 'mixed'];
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

  // Include type/intent metadata in related notes for better linking decisions [Review fix 10-§7]
  const relatedSection = relatedNotes.length > 0
    ? '\n\nRelated notes for context:\n' +
      relatedNotes.map(n => {
        const meta = [n.type, n.intent].filter(Boolean).join(' · ');
        const metaSuffix = meta ? ` (${meta})` : '';
        return `[${n.id}] "${n.title}"${metaSuffix}\n${n.body}`;
      }).join('\n\n')
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
  if (typeof obj['type'] !== 'string') throw new Error('LLM response missing type');
  if (!Array.isArray(obj['tags'])) throw new Error('LLM response missing tags array');

  const noteType: NoteType = VALID_NOTE_TYPES.includes(obj['type'] as NoteType)
    ? (obj['type'] as NoteType)
    : (() => {
        console.warn(JSON.stringify({ event: 'field_defaulted', field: 'type', raw_value: obj['type'], default: 'idea' }));
        return 'idea' as NoteType;
      })();

  // Log when fallback defaults are applied [Review fix 10-§3]
  const intent: Intent = VALID_INTENTS.includes(obj['intent'] as Intent)
    ? (obj['intent'] as Intent)
    : (() => {
        console.warn(JSON.stringify({ event: 'field_defaulted', field: 'intent', raw_value: obj['intent'], default: 'remember' }));
        return 'remember' as Intent;
      })();

  const modality: Modality = VALID_MODALITIES.includes(obj['modality'] as Modality)
    ? (obj['modality'] as Modality)
    : (() => {
        console.warn(JSON.stringify({ event: 'field_defaulted', field: 'modality', raw_value: obj['modality'], default: 'text' }));
        return 'text' as Modality;
      })();

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
    type: noteType,
    tags: (obj['tags'] as unknown[]).filter((t): t is string => typeof t === 'string'),
    source_ref: typeof obj['source_ref'] === 'string' ? obj['source_ref'] : null,
    links,
    corrections: corrections?.length ? corrections : null,
    intent,
    modality,
    entities,
  };
}
