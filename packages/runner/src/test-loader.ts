import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import type { TestDefinition } from './types.js';

const TESTS_DIR = path.resolve(import.meta.dirname, '..', 'tests');

function findYamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findYamlFiles(fullPath));
    } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
      results.push(fullPath);
    }
  }
  return results;
}

export function loadAllTests(): TestDefinition[] {
  return findYamlFiles(TESTS_DIR)
    .map(f => loadTest(f))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function loadTestById(testId: string): TestDefinition | null {
  const tests = loadAllTests();
  return tests.find(t => t.id === testId) ?? null;
}

function loadTest(filePath: string): TestDefinition {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw);
  const id = path.basename(filePath, path.extname(filePath));

  // Derive page group from parent folder name (e.g., "homepage", "connect")
  const parentDir = path.basename(path.dirname(filePath));
  const page = parentDir !== 'tests' ? parentDir : undefined;

  return {
    id,
    name: parsed.name ?? id,
    url: parsed.url ?? '',
    instructions: parsed.instructions ?? '',
    timeout: parsed.timeout ?? 120_000,
    expected_outcome: parsed.expected_outcome ?? '',
    viewport: parsed.viewport ?? undefined,
    tags: parsed.tags ?? [],
    category: parsed.category ?? 'sanity',
    max_turns: parsed.max_turns ?? undefined,
    requires_auth: parsed.requires_auth ?? false,
    page,
  };
}
