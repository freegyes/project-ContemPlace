import type { Entity } from './types';

function toEntityArray(entities: unknown): Entity[] {
  if (!Array.isArray(entities)) return [];
  return entities.filter(
    (e): e is Entity =>
      typeof e === 'object' &&
      e !== null &&
      'name' in e &&
      typeof (e as Record<string, unknown>)['name'] === 'string' &&
      'type' in e,
  );
}

// Build the context string for an is-similar-to link.
// Derives from shared tags and shared entities — no LLM call required.
// Format: "Similarity: 0.73; shared tags: cooking, kitchen; shared entities: IKEA [tool]"
// Falls back to "Similarity: 0.73" when there is no overlap.
export function buildContext(
  noteA: { tags: string[]; entities: unknown },
  noteB: { tags: string[]; entities: unknown },
  similarity: number,
): string {
  const score = `Similarity: ${similarity.toFixed(2)}`;

  const tagsA = new Set(noteA.tags);
  const sharedTags = noteB.tags.filter(t => tagsA.has(t));

  const entitiesA = toEntityArray(noteA.entities);
  const entitiesB = toEntityArray(noteB.entities);
  const namesA = new Set(entitiesA.map(e => e.name.toLowerCase()));
  const sharedEntities = entitiesB.filter(e => namesA.has(e.name.toLowerCase()));

  const parts: string[] = [score];

  if (sharedTags.length > 0) {
    parts.push(`shared tags: ${sharedTags.join(', ')}`);
  }
  if (sharedEntities.length > 0) {
    const entityStrs = sharedEntities.map(e => `${e.name} [${e.type}]`);
    parts.push(`shared entities: ${entityStrs.join(', ')}`);
  }

  return parts.join('; ');
}
