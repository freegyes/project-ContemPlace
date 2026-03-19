import type OpenAI from 'openai';
import type { EntityConfig } from './config';
import type {
  ExtractedEntity,
  RawExtraction,
  DictionaryEntry,
  NoteForEntityExtraction,
  EntityType,
} from './types';
import { VALID_ENTITY_TYPES } from './types';

// ── Extraction prompt ────────────────────────────────────────────────────────

function buildExtractionPrompt(
  existingEntities: Array<{ name: string; type: string }>,
): string {
  let prompt = `You are an entity extraction agent. Given a note's title, body, and tags, extract all proper nouns — named people, places, tools/software/hardware, and projects/initiatives.

Rules:
- Only extract entities that are explicitly named in the text
- Do not extract generic concepts, abstract ideas, or common nouns
- Use the canonical/full form of the name when you can infer it from context
- Classify each entity into exactly one type: person, place, tool, project

Type definitions:
- person: Named individuals (e.g., "Marshall Rosenberg", "Nicolas Bras")
- place: Named locations (e.g., "Budapest", "Fablab")
- tool: Named software, hardware, instruments, materials with brand names (e.g., "Shapr3D", "Daisy Seed", "cimbalom")
- project: Named initiatives or systems being built (e.g., "ContemPlace")

Return valid JSON only — an array of objects. No text outside the JSON.
[{"name": "...", "type": "person|place|tool|project"}]
Return [] if no proper nouns are present.`;

  if (existingEntities.length > 0) {
    prompt += `\n\nKnown entities from previous extractions (use for consistent naming and typing):`;
    for (const e of existingEntities) {
      prompt += `\n- ${e.name} [${e.type}]`;
    }
  }

  return prompt;
}

function buildExtractionUserMessage(note: NoteForEntityExtraction): string {
  const tagStr = note.tags.length > 0 ? `\nTags: ${note.tags.join(', ')}` : '';
  return `Title: ${note.title}\nBody: ${note.body}${tagStr}`;
}

// ── Extraction ───────────────────────────────────────────────────────────────

export async function extractEntitiesFromNote(
  client: OpenAI,
  config: EntityConfig,
  note: NoteForEntityExtraction,
  existingEntities: Array<{ name: string; type: string }>,
): Promise<ExtractedEntity[]> {
  const systemPrompt = buildExtractionPrompt(existingEntities);
  const userMessage = buildExtractionUserMessage(note);

  const completion = await client.chat.completions.create({
    model: config.entityModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.1,
    max_tokens: 512,
  });

  const rawContent = completion.choices[0]?.message?.content;
  if (!rawContent) return [];

  return parseExtractionResponse(rawContent);
}

// Exported for unit testing.
export function parseExtractionResponse(raw: string): ExtractedEntity[] {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.warn(JSON.stringify({ event: 'entity_extraction_parse_error', raw: cleaned.slice(0, 200) }));
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return (parsed as unknown[]).filter((item): item is ExtractedEntity => {
    if (typeof item !== 'object' || item === null) return false;
    const obj = item as Record<string, unknown>;
    return (
      typeof obj['name'] === 'string' &&
      obj['name'].length > 0 &&
      typeof obj['type'] === 'string' &&
      VALID_ENTITY_TYPES.includes(obj['type'] as EntityType)
    );
  });
}

// ── Resolution / deduplication ───────────────────────────────────────────────

interface MentionGroup {
  normalizedName: string;
  type: EntityType;
  originalNames: Map<string, number>; // surface form → frequency
  noteIds: Set<string>;
  createdAts: string[];
}

function normalize(name: string): string {
  return name.toLowerCase().trim();
}

/**
 * Check if shortName's words are all present as a contiguous sequence in longName.
 * Used for substring-based entity merging (e.g., "Rosenberg" → "Marshall Rosenberg").
 */
function isWordSubsequence(shortNorm: string, longNorm: string): boolean {
  if (shortNorm === longNorm) return false;
  if (shortNorm.length < 3) return false; // avoid matching initials
  // Check if the short form appears as a word-boundary substring
  const shortWords = shortNorm.split(/\s+/);
  const longWords = longNorm.split(/\s+/);
  if (shortWords.length >= longWords.length) return false;

  // Every word in shortWords must appear in longWords
  return shortWords.every(sw => longWords.includes(sw));
}

export function resolveEntities(
  extractions: RawExtraction[],
  noteCreatedAts: Map<string, string>,
): DictionaryEntry[] {
  // Step 1: Build mention groups — group by (normalizedName, type)
  const groupKey = (name: string, type: string) => `${normalize(name)}::${type}`;
  const groups = new Map<string, MentionGroup>();

  for (const extraction of extractions) {
    for (const entity of extraction.entities) {
      const key = groupKey(entity.name, entity.type);
      let group = groups.get(key);
      if (!group) {
        group = {
          normalizedName: normalize(entity.name),
          type: entity.type,
          originalNames: new Map(),
          noteIds: new Set(),
          createdAts: [],
        };
        groups.set(key, group);
      }
      group.originalNames.set(
        entity.name,
        (group.originalNames.get(entity.name) ?? 0) + 1,
      );
      group.noteIds.add(extraction.noteId);
      const createdAt = noteCreatedAts.get(extraction.noteId);
      if (createdAt) group.createdAts.push(createdAt);
    }
  }

  // Step 2: Convert groups to preliminary entries
  let entries: DictionaryEntry[] = [...groups.values()].map(group => {
    // Canonical name = most frequent surface form
    const canonicalName = [...group.originalNames.entries()]
      .sort((a, b) => b[1] - a[1])[0]![0];

    // Aliases = other surface forms (excluding canonical)
    const aliases = [...group.originalNames.keys()]
      .filter(name => name !== canonicalName);

    const noteIds = [...group.noteIds];
    const timestamps = group.createdAts.sort();

    return {
      name: canonicalName,
      type: group.type,
      aliases,
      note_count: noteIds.length,
      note_ids: noteIds,
      first_seen: timestamps[0] ?? new Date().toISOString(),
      last_seen: timestamps[timestamps.length - 1] ?? new Date().toISOString(),
    };
  });

  // Step 3: Substring containment merge — merge shorter names into longer ones
  // Sort by name length descending so we process longest first
  entries.sort((a, b) => b.name.length - a.name.length);
  const merged = new Set<number>();

  for (let i = 0; i < entries.length; i++) {
    if (merged.has(i)) continue;
    const long = entries[i]!;

    for (let j = i + 1; j < entries.length; j++) {
      if (merged.has(j)) continue;
      const short = entries[j]!;

      // Only merge if same type and short is a word subsequence of long
      if (short.type !== long.type) continue;
      if (!isWordSubsequence(normalize(short.name), normalize(long.name))) continue;

      // Merge short into long
      long.aliases.push(short.name, ...short.aliases);
      for (const noteId of short.note_ids) {
        if (!long.note_ids.includes(noteId)) {
          long.note_ids.push(noteId);
        }
      }
      long.note_count = long.note_ids.length;
      if (short.first_seen < long.first_seen) long.first_seen = short.first_seen;
      if (short.last_seen > long.last_seen) long.last_seen = short.last_seen;
      merged.add(j);
    }
  }

  // Deduplicate aliases
  const result = entries
    .filter((_, i) => !merged.has(i))
    .map(entry => ({
      ...entry,
      aliases: [...new Set(entry.aliases)],
    }));

  // Sort by note_count descending for stable output
  result.sort((a, b) => b.note_count - a.note_count);

  return result;
}

// ── Per-note entity mapping ──────────────────────────────────────────────────

/**
 * For each note, map its raw extracted entities to canonical dictionary forms.
 * Returns a map of noteId → canonical entities for that note.
 */
export function mapNotesToCanonicalEntities(
  extractions: RawExtraction[],
  dictionary: DictionaryEntry[],
): Map<string, ExtractedEntity[]> {
  // Build a lookup: normalized name → dictionary entry
  const lookup = new Map<string, DictionaryEntry>();
  for (const entry of dictionary) {
    lookup.set(normalize(entry.name), entry);
    for (const alias of entry.aliases) {
      lookup.set(normalize(alias), entry);
    }
  }

  const result = new Map<string, ExtractedEntity[]>();

  for (const extraction of extractions) {
    const canonicalEntities: ExtractedEntity[] = [];
    const seen = new Set<string>(); // avoid duplicates per note

    for (const entity of extraction.entities) {
      const dictEntry = lookup.get(normalize(entity.name));
      if (dictEntry && !seen.has(dictEntry.name)) {
        canonicalEntities.push({ name: dictEntry.name, type: dictEntry.type });
        seen.add(dictEntry.name);
      }
    }

    result.set(extraction.noteId, canonicalEntities);
  }

  return result;
}
