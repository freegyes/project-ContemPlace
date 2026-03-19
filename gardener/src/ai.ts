import OpenAI from 'openai';
import type { EntityConfig } from './config';

export function createOpenAIClient(entityConfig: EntityConfig): OpenAI {
  return new OpenAI({
    apiKey: entityConfig.openrouterApiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/freegyes/project-ContemPlace',
      'X-Title': 'ContemPlace Gardener',
    },
  });
}
