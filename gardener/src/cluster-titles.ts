import type OpenAI from 'openai';
import type { EntityConfig } from './config';
import type { ClusterRow } from './clustering';
import type { NoteForSimilarity } from './types';

// ── Prompt ───────────────────────────────────────────────────────────────────

export function buildClusterTitlePrompt(
  rows: ClusterRow[],
  noteMap: Map<string, NoteForSimilarity>,
): string {
  const clusterSections = rows.map((row, idx) => {
    const titles = row.note_ids
      .map(id => noteMap.get(id)?.title)
      .filter((t): t is string => !!t);
    const tagStr = row.top_tags.length > 0 ? `, tags: ${row.top_tags.join(', ')}` : '';
    return `Cluster ${idx} (${row.note_ids.length} notes${tagStr}):\n${titles.map(t => `- ${t}`).join('\n')}`;
  });

  return `You are labeling thematic clusters in a personal knowledge graph. Each cluster contains notes grouped by semantic similarity.

For each cluster, generate a short descriptive title that captures what the cluster is about.

Rules:
- Each title should be a descriptive phrase, 5-15 words, not a sentence
- Be specific to the cluster's actual content — avoid generic labels
- Use the top tags as additional context for the cluster's theme
- For small clusters (2-3 notes), a simple description is fine

${clusterSections.join('\n\n')}

Return valid JSON only — an object mapping cluster numbers to title strings.
${JSON.stringify(Object.fromEntries(rows.map((_, i) => [i, '...'])))}
Return exactly one title per cluster. No text outside the JSON.`;
}

// ── Response parser ──────────────────────────────────────────────────────────

export function parseClusterTitleResponse(
  raw: string,
  clusterCount: number,
): Map<number, string> {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.warn(JSON.stringify({ event: 'cluster_title_parse_error', raw: cleaned.slice(0, 200) }));
    return new Map();
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn(JSON.stringify({ event: 'cluster_title_unexpected_format', type: typeof parsed }));
    return new Map();
  }

  const result = new Map<number, string>();
  const obj = parsed as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    const idx = parseInt(key, 10);
    if (isNaN(idx) || idx < 0 || idx >= clusterCount) continue;
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    result.set(idx, value.trim());
  }

  return result;
}

// ── Generator ────────────────────────────────────────────────────────────────

export async function generateClusterTitles(
  client: OpenAI,
  config: EntityConfig,
  rows: ClusterRow[],
  noteMap: Map<string, NoteForSimilarity>,
): Promise<ClusterRow[]> {
  if (rows.length === 0) return rows;

  const prompt = buildClusterTitlePrompt(rows, noteMap);

  const completion = await client.chat.completions.create({
    model: config.entityModel,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 2000,
  });

  const rawContent = completion.choices[0]?.message?.content;
  if (!rawContent) {
    console.warn(JSON.stringify({ event: 'cluster_title_empty_response' }));
    return rows;
  }

  const titles = parseClusterTitleResponse(rawContent, rows.length);

  return rows.map((row, idx) => {
    const llmTitle = titles.get(idx);
    return llmTitle ? { ...row, label: llmTitle } : row;
  });
}
