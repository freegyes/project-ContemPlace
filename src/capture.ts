import OpenAI from 'openai';
import type { Config } from './config';
import type { CaptureResult, CaptureLink, MatchedNote, NoteType, LinkType } from './types';

const SYSTEM_PROMPT = `You are a knowledge capture agent following the Evergreen Notes methodology.
Transform raw input into a single, well-formed note and identify its typed relationships to existing notes.

## Voice recognition correction

Input can come from voice dictation and will NOT be pre-corrected. Before doing anything else:
1. Scan for out-of-place words — words that seem irrelevant, oddly generic, or phonetically plausible but wrong in context (homophones, near-homophones, garbled proper nouns).
2. Cross-reference related notes for proper nouns, tool names, and project names — if a garbled word sounds like something that appears in the related notes, that's almost certainly what was meant.
3. Silently correct — fix in the output, never preserve the garbled version. Report corrections in the \`corrections\` field (e.g., \`["cattle stitch → kettle stitch", "black data → PlugData"]\`). Omit the field (or use null) if nothing was corrected.

## Note rules

**Title**: A claim or insight, not a topic label.
- Good: "Constraints make creative work stronger"
- Bad: "Creativity" or "Note about constraints"

**Body**: 2–5 sentences. Atomic — one idea, standing alone. Your job is transcription, not interpretation. Use the user's own words and phrasing wherever possible — rewrite only enough to fix grammar and remove filler. Do not paraphrase their metaphors into neutral descriptions. Do not add a concluding sentence that synthesizes or names what their words already showed. Do not add benefits, follow-ons, or observations the user did not make. If the input is one idea, the body is one idea. Shorter is better than padded.

**Type**: one of \`idea | reflection | source | lookup\`
- \`reflection\` — first-person, personal insight about creativity or inner life. Only use this when the user's words **explicitly** signal personal resonance ("this resonates with me", "I've always felt this"). Never infer it from topic alone. When in doubt, use \`idea\`.
- \`lookup\` — primarily a research or investigation prompt ("look into X", "check out Y"). Not for things to make or build, even if research is involved.
- \`source\` — from an external source with a URL.
- \`idea\` — everything else. Default. Use neutral voice — describe concepts without claiming them as the user's own.

**Tags**: 2–5 lowercase strings, no \`#\` prefix.

**source_ref**: URL if the user included one, otherwise null.

**Links**: For each related note provided, decide whether a typed relationship applies.
Types: \`extends | contradicts | supports | is-example-of\`
- \`extends\` — builds on, deepens, or expands the other note's idea
- \`contradicts\` — challenges or is in tension with it
- \`supports\` — provides evidence, reinforces, or is a parallel/sibling idea working toward the same larger goal
- \`is-example-of\` — a concrete instance of the other note's concept
Prefer more links over fewer; connections are valuable. When two notes are parallel projects or instances of the same broader pattern, link with \`supports\`. It is fine to link to zero notes.

If the input is too short to form a full note, do your best. Do not ask for clarification — just capture what is there.

Return valid JSON only. No text outside the JSON object.
{
  "title": "...",
  "body": "...",
  "type": "idea|reflection|source|lookup",
  "tags": ["...", "..."],
  "source_ref": null,
  "corrections": ["garbled word → corrected word"] | null,
  "links": [
    { "to_id": "<uuid>", "link_type": "extends|contradicts|supports|is-example-of" }
  ]
}`;

const VALID_NOTE_TYPES: readonly NoteType[] = ['idea', 'reflection', 'source', 'lookup'];
const VALID_LINK_TYPES: readonly LinkType[] = ['extends', 'contradicts', 'supports', 'is-example-of'];

export async function runCaptureAgent(
  client: OpenAI,
  config: Config,
  text: string,
  relatedNotes: MatchedNote[],
): Promise<CaptureResult> {
  const today = new Date().toISOString().split('T')[0];

  const relatedSection = relatedNotes.length > 0
    ? '\n\nRelated notes for context:\n' +
      relatedNotes.map(n => `[${n.id}] "${n.title}"\n${n.body}`).join('\n\n')
    : '';

  const userMessage = `Today's date: ${today}\n\nCapture this:\n${text}${relatedSection}`;

  const completion = await client.chat.completions.create({
    model: config.captureModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 1024,
  });

  const rawContent = completion.choices[0]?.message?.content;
  if (!rawContent) {
    throw new Error('LLM returned empty content');
  }

  return parseCaptureResponse(rawContent);
}

function parseCaptureResponse(raw: string): CaptureResult {
  // Strip markdown code fences if the model wraps JSON in them
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
    : 'idea';

  const links: CaptureLink[] = Array.isArray(obj['links'])
    ? (obj['links'] as unknown[]).filter((l): l is CaptureLink => {
        if (typeof l !== 'object' || l === null) return false;
        const link = l as Record<string, unknown>;
        return (
          typeof link['to_id'] === 'string' &&
          VALID_LINK_TYPES.includes(link['link_type'] as LinkType)
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
  };
}
