import { defineConfig } from 'vitest/config';
import { readFileSync, existsSync } from 'fs';

function loadDevVars(): Record<string, string> {
  const path = '.dev.vars';
  if (!existsSync(path)) return {};
  const content = readFileSync(path, 'utf-8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    vars[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
  }
  return vars;
}

export default defineConfig({
  test: {
    env: loadDevVars(),
  },
});
