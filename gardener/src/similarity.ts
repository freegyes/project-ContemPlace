// Build the context string for an is-similar-to link.
// Derives from shared tags — no LLM call required.
// Format: "Similarity: 0.73; shared tags: cooking, kitchen"
// Falls back to "Similarity: 0.73" when there is no overlap.
export function buildContext(
  noteA: { tags: string[] },
  noteB: { tags: string[] },
  similarity: number,
): string {
  const score = `Similarity: ${similarity.toFixed(2)}`;

  const tagsA = new Set(noteA.tags);
  const sharedTags = noteB.tags.filter(t => tagsA.has(t));

  const parts: string[] = [score];

  if (sharedTags.length > 0) {
    parts.push(`shared tags: ${sharedTags.join(', ')}`);
  }

  return parts.join('; ');
}
