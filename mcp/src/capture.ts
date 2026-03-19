import OpenAI from 'openai';
import type { Config } from './config';
import type { CaptureResult, CaptureLink, MatchedNote, RecentFragment, CaptureLinkType } from './types';

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

**Links**: for each related note provided, decide if a typed relationship applies.
Types: \`contradicts | related\`
- \`contradicts\` — challenges or is in tension with it
- \`related\` — builds on, deepens, supports, parallels, is an example of, or otherwise connects to it
Prefer fewer links over many. It is fine to link to zero notes.

If the input is very short, do your best. Do not ask for clarification.

## Recent fragments

You may receive a list of the user's most recently captured fragments. These provide temporal context — what the user has been thinking about in this session.

Use recent fragments to:
- **Prefer consistent tag vocabulary.** If a recent fragment uses \`pen-plotting\` for a concept, use the same tag phrasing rather than inventing \`plotter-art\` or \`pen-plotter\`.
- **Improve voice correction.** Domain terms appearing in recent fragments are likely to recur.

Do NOT:
- Force links to recent fragments unless the semantic connection is independently clear.
- Assume recent fragments are about the same topic as the current input.

**Body rule**: if the input contains questions, preserve them as questions in the body. Do not answer them, synthesize related notes into an answer, or reframe them as statements. The body captures what the user said, not what the system thinks the answer is. Related notes are provided for linking context only — never fold their content into the body.

Return valid JSON only. No text outside the JSON object.
{
  "title": "...",
  "body": "...",
  "tags": ["...", "..."],
  "source_ref": null,
  "corrections": ["garbled → corrected"] | null,
  "links": [
    { "to_id": "<uuid>", "link_type": "contradicts|related" }
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

const VALID_LINK_TYPES: readonly CaptureLinkType[] = ['contradicts', 'related'];

export async function runCaptureAgent(
  client: OpenAI,
  config: Config,
  text: string,
  relatedNotes: MatchedNote[],
  captureVoice: string,
  recentFragments: RecentFragment[] = [],
): Promise<CaptureResult> {
  const today = new Date().toISOString().split('T')[0];
  const systemPrompt = buildSystemPrompt(captureVoice);

  const recentSection = recentFragments.length > 0
    ? '\n\nRecent fragments (for context, not linking targets):\n' +
      recentFragments.map(r => `- "${r.title}" [${r.tags.join(', ')}]`).join('\n')
    : '';

  const relatedSection = relatedNotes.length > 0
    ? '\n\nRelated notes for context:\n' +
      relatedNotes.map(n => `[${n.id}] "${n.title}"\n${n.body}`).join('\n\n')
    : '';

  const userMessage = `Today's date: ${today}\n\nCapture this:\n${text}${recentSection}${relatedSection}`;

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
  };
}
