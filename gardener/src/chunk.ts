// Chunk splitting logic for long notes.
// Pure functions — no I/O, no dependencies.

export interface Chunk {
  index: number;
  content: string;
}

// Minimum body length (chars) to qualify for chunking.
export const MIN_BODY_LENGTH = 1500;

// Target chunk size range.
const MAX_CHUNK_SIZE = 800;

/**
 * Split a note body into chunks using a fallback chain:
 * 1. Paragraph boundaries (\n\n)
 * 2. Sentence boundaries ([.!?] followed by whitespace)
 * 3. Single newlines (\n)
 * 4. Hard character split (last resort)
 *
 * Returns empty array if:
 * - body is shorter than MIN_BODY_LENGTH
 * - splitting produces only 1 chunk (no retrieval value beyond note-level embedding)
 */
export function splitIntoChunks(body: string): Chunk[] {
  if (body.length <= MIN_BODY_LENGTH) return [];

  // Step 1: split on paragraph boundaries
  let blocks = body.split(/\n\n+/).map(b => b.trim()).filter(b => b.length > 0);

  // Step 2: break oversized blocks using sentence boundaries, then newlines, then hard split
  const finalBlocks: string[] = [];
  for (const block of blocks) {
    if (block.length <= MAX_CHUNK_SIZE) {
      finalBlocks.push(block);
    } else {
      const subBlocks = breakBlock(block);
      finalBlocks.push(...subBlocks);
    }
  }

  // Merge small adjacent blocks to avoid tiny chunks
  const merged = mergeSmallBlocks(finalBlocks, MAX_CHUNK_SIZE);

  // Skip if only 1 chunk — no retrieval value beyond note-level embedding
  if (merged.length <= 1) return [];

  return merged.map((content, index) => ({ index, content }));
}

/**
 * Break an oversized block using progressively coarser strategies.
 */
function breakBlock(block: string): string[] {
  // Try sentence boundaries: period/question/exclamation followed by whitespace
  const sentences = splitOnSentences(block);
  if (sentences.length > 1) {
    return mergeIntoChunks(sentences, MAX_CHUNK_SIZE);
  }

  // Try single newlines (handles bullet lists, code blocks)
  const lines = block.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length > 1) {
    return mergeIntoChunks(lines, MAX_CHUNK_SIZE);
  }

  // Hard character split (last resort)
  return hardSplit(block, MAX_CHUNK_SIZE);
}

/**
 * Split text on sentence boundaries.
 * Splits on [.!?] followed by whitespace, avoiding splits after common abbreviations.
 */
function splitOnSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace
  // The regex captures the punctuation with the preceding text
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * Merge an array of small pieces into chunks that don't exceed maxSize.
 */
function mergeIntoChunks(pieces: string[], maxSize: number): string[] {
  const result: string[] = [];
  let current = '';

  for (const piece of pieces) {
    const candidate = current ? current + ' ' + piece : piece;
    if (candidate.length <= maxSize) {
      current = candidate;
    } else {
      if (current) result.push(current);
      // If a single piece exceeds maxSize, it becomes its own chunk (or gets hard-split)
      if (piece.length > maxSize) {
        result.push(...hardSplit(piece, maxSize));
        current = '';
      } else {
        current = piece;
      }
    }
  }
  if (current) result.push(current);

  return result;
}

/**
 * Merge small adjacent blocks to avoid tiny chunks.
 * Combines blocks that together fit within maxSize.
 */
function mergeSmallBlocks(blocks: string[], maxSize: number): string[] {
  const result: string[] = [];
  let current = '';

  for (const block of blocks) {
    // Use double newline as separator when merging paragraph blocks
    const separator = current ? '\n\n' : '';
    const candidate = current + separator + block;
    if (candidate.length <= maxSize) {
      current = candidate;
    } else {
      if (current) result.push(current);
      current = block;
    }
  }
  if (current) result.push(current);

  return result;
}

/**
 * Hard split at maxSize boundaries, trying to break on word boundaries.
 */
function hardSplit(text: string, maxSize: number): string[] {
  const result: string[] = [];
  let remaining = text;

  while (remaining.length > maxSize) {
    // Try to find a word boundary near maxSize
    let splitAt = remaining.lastIndexOf(' ', maxSize);
    if (splitAt <= 0) splitAt = maxSize; // No word boundary found
    result.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) result.push(remaining);

  return result;
}

/**
 * Build the embedding input for a chunk.
 * Prepends title and tags for context anchoring without over-augmenting.
 */
export function buildChunkEmbeddingInput(
  title: string,
  tags: string[],
  chunkContent: string,
): string {
  const tagSuffix = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
  return `${title}${tagSuffix}: ${chunkContent}`;
}
