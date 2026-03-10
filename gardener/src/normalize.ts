import type OpenAI from 'openai';
import type { EmbedConfig } from './embed';
import type { Concept, NoteForTagNorm, TagMatch } from './types';

// Build the embedding input for a concept: "{pref_label}: {definition}"
// No scheme prefix (tags never contain scheme info), no alt_labels (handled lexically).
export function buildConceptEmbeddingInput(concept: Concept): string {
  if (concept.definition) {
    return `${concept.pref_label}: ${concept.definition}`;
  }
  return concept.pref_label;
}

// Case-insensitive lexical match of a tag against all concepts.
// Returns the matched concept or null.
export function lexicalMatch(tag: string, concepts: Concept[]): Concept | null {
  const lower = tag.toLowerCase();
  for (const concept of concepts) {
    if (concept.pref_label.toLowerCase() === lower) return concept;
    for (const alt of concept.alt_labels) {
      if (alt.toLowerCase() === lower) return concept;
    }
  }
  return null;
}

// Cosine similarity between two vectors.
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) * (a[i] ?? 0);
    normB += (b[i] ?? 0) * (b[i] ?? 0);
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// Semantic match: find the best-matching concept above threshold.
// Requires pre-computed tag and concept embeddings.
export function semanticMatch(
  tagEmbedding: number[],
  concepts: Array<{ concept: Concept; embedding: number[] }>,
  threshold: number,
): Concept | null {
  let bestScore = -1;
  let bestConcept: Concept | null = null;

  for (const { concept, embedding } of concepts) {
    const score = cosineSimilarity(tagEmbedding, embedding);
    if (score > bestScore && score >= threshold) {
      bestScore = score;
      bestConcept = concept;
    }
  }

  return bestConcept;
}

// Resolve all tags for a single note.
// Returns arrays of matched and unmatched tags.
export function resolveNoteTags(
  note: NoteForTagNorm,
  concepts: Concept[],
  conceptsWithEmbeddings: Array<{ concept: Concept; embedding: number[] }>,
  tagEmbeddings: Map<string, number[]>,
  threshold: number,
): { matched: TagMatch[]; unmatched: string[] } {
  const matched: TagMatch[] = [];
  const unmatched: string[] = [];
  const seenPrefLabels = new Set<string>();

  for (const tag of note.tags) {
    // 1. Lexical match
    const lexHit = lexicalMatch(tag, concepts);
    if (lexHit) {
      if (!seenPrefLabels.has(lexHit.id)) {
        seenPrefLabels.add(lexHit.id);
        matched.push({ conceptId: lexHit.id, prefLabel: lexHit.pref_label });
      }
      continue;
    }

    // 2. Semantic fallback (only if embeddings are available)
    const tagEmb = tagEmbeddings.get(tag.toLowerCase());
    if (tagEmb && conceptsWithEmbeddings.length > 0) {
      const semHit = semanticMatch(tagEmb, conceptsWithEmbeddings, threshold);
      if (semHit) {
        if (!seenPrefLabels.has(semHit.id)) {
          seenPrefLabels.add(semHit.id);
          matched.push({ conceptId: semHit.id, prefLabel: semHit.pref_label });
        }
        continue;
      }
    }

    // 3. Unmatched
    unmatched.push(tag);
  }

  return { matched, unmatched };
}
