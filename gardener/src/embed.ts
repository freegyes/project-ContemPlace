import OpenAI from 'openai';

export interface EmbedConfig {
  openrouterApiKey: string;
  embedModel: string;
}

export function createOpenAIClient(config: EmbedConfig): OpenAI {
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
  config: EmbedConfig,
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

// Batch embed multiple texts in a single API call.
// Returns embeddings in the same order as the input texts.
export async function batchEmbedTexts(
  client: OpenAI,
  config: EmbedConfig,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await client.embeddings.create({
    model: config.embedModel,
    input: texts,
  });

  // The API returns embeddings indexed by position — sort to be safe
  const sorted = response.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => d.embedding);
}
