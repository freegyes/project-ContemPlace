import { describe, it, expect } from 'vitest';
import { embedText as gardenerEmbedText, batchEmbedTexts as gardenerBatchEmbedTexts } from '../gardener/src/embed';
import { embedText as mcpEmbedText } from '../mcp/src/embed';

// ── Parity test ──────────────────────────────────────────────────────────────
// The gardener and mcp embedText functions must have compatible signatures.
// This test verifies structural parity, not network behavior.

describe('embedText parity', () => {
  it('gardener embedText has the same parameter structure as mcp/src/embed.ts', () => {
    expect(typeof gardenerEmbedText).toBe('function');
    expect(typeof mcpEmbedText).toBe('function');
    expect(gardenerEmbedText.length).toBe(3);
    expect(mcpEmbedText.length).toBe(3);
  });
});

describe('batchEmbedTexts', () => {
  it('is exported from gardener/src/embed.ts', () => {
    expect(typeof gardenerBatchEmbedTexts).toBe('function');
    // Accepts (client, config, texts) — 3 params
    expect(gardenerBatchEmbedTexts.length).toBe(3);
  });
});
