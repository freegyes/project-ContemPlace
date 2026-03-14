import OpenAI from 'openai';
import type { Config } from './config';
import type { CaptureResult } from './types';

export function createOpenAIClient(config: Config): OpenAI {
  return new OpenAI({
    apiKey: config.openrouterApiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/freegyes/project-ContemPlace',
      'X-Title': 'ContemPlace',
    },
  });
}

export async function embedText(
  client: OpenAI,
  config: Config,
  text: string,
): Promise<number[]> {
  const response = await client.embeddings.create({
    model: config.embedModel,
    input: text,
  });
  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new Error('Embedding API returned no data');
  }
  return embedding;
}

/**
 * Build a metadata-augmented string for embedding.
 * Prepending structured metadata bakes organizational context into the vector space.
 * The capture param is required — use embedText directly for raw (pre-LLM) embeddings.
 */
export function buildEmbeddingInput(text: string, capture: CaptureResult): string {
  if (capture.tags.length > 0) {
    return `[Tags: ${capture.tags.join(', ')}] ${text}`;
  }
  return text;
}
