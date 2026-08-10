import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const INFERENCE_DIR = join(import.meta.dirname, '..', 'src', 'inference');
const EXEMPT_FILE = 'referenceProfile.ts';
const FORBIDDEN_PATTERN = /from\s+['"]@prisma\/client['"]/;

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function main(): void {
  const violations: string[] = [];

  for (const filePath of collectTsFiles(INFERENCE_DIR)) {
    if (basename(filePath) === EXEMPT_FILE) continue;
    const content = readFileSync(filePath, 'utf-8');
    if (FORBIDDEN_PATTERN.test(content) && content.includes('PlantProfile')) {
      violations.push(filePath);
    }
  }

  if (violations.length > 0) {
    console.error('Species-blindness boundary violated — these files import PlantProfile from @prisma/client:');
    for (const file of violations) console.error(`  ${file}`);
    console.error(`\nOnly ${EXEMPT_FILE} is allowed to do this (spec: "Species-blindness — the one botanical boundary").`);
    process.exit(1);
  }

  console.log('Species-blindness boundary check passed.');
}

main();
