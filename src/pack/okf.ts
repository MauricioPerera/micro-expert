/**
 * OKF (Open Knowledge Format) bundle support — an alternative, interoperable
 * memory pack format.
 *
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 *
 * A bundle is a tree of Markdown files. Each non-reserved `.md` carries a YAML
 * frontmatter with a non-empty `type` field (required); `title`, `description`,
 * `tags`, and `timestamp` are recommended. `index.md` and `log.md` are RESERVED
 * (they are not concepts) and MUST be ignored by consumers. Consumers MUST
 * tolerate unknown frontmatter fields, unknown `type` values, and broken links.
 *
 * No external dependencies: the frontmatter parser is a small hand-rolled
 * subset of YAML (scalar `key: value`, inline lists `[a, b]`, and block lists
 * with `- item` lines).
 */

import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

/** A memory/skill entry as used by the export/import pipeline. */
export interface OkfEntry {
  content: string;
  category: string;
  tags: string[];
}

/** Optional pack metadata carried into the bundle's index. */
export interface OkfPackMeta {
  name?: string;
  description?: string;
  author?: string;
  packVersion?: string;
  url?: string;
  models?: string[];
  packTags?: string[];
}

export interface OkfImportResult {
  memories: OkfEntry[];
  skills: OkfEntry[];
  errors: string[];
}

export interface OkfValidationResult {
  valid: boolean;
  errors: string[];
}

/** Reserved filenames — never treated as concepts. */
const RESERVED = new Set(['index.md', 'log.md']);

const TOOL_TAG_RE = /\[(MCP|CALC|FETCH|A2E):/;

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

interface ParsedFile {
  /** null when no frontmatter fence is present. */
  frontmatter: Record<string, unknown> | null;
  body: string;
}

/**
 * Split a Markdown file into frontmatter (if any) and body.
 * Frontmatter is delimited by opening and closing `---` lines; the opening
 * line must be the very first line of the file.
 */
function splitFrontmatter(text: string): ParsedFile {
  if (!text.startsWith('---')) return { frontmatter: null, body: text };

  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // Opening fence with no closing fence → no valid frontmatter.
    return { frontmatter: null, body: text };
  }

  const fmLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join('\n').replace(/^\r?\n/, '').replace(/\r?\n+$/, '');
  return { frontmatter: parseYamlLines(fmLines), body };
}

/** Parse a small YAML subset into a record. Never throws. */
function parseYamlLines(lines: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) {
      // Unparseable line — skip (tolerate messy frontmatter).
      i++;
      continue;
    }
    const key = m[1];
    const rawVal = m[2].trim();

    if (rawVal === '') {
      // Block list? Look ahead for indented `- item` lines.
      if (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        const items: string[] = [];
        let j = i + 1;
        while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
          items.push(stripQuotes(lines[j].replace(/^\s*-\s+/, '').trim()));
          j++;
        }
        result[key] = items;
        i = j;
        continue;
      }
      result[key] = '';
      i++;
      continue;
    }

    // Inline list: [a, b, c]
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      const inner = rawVal.slice(1, -1);
      result[key] = inner
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s.length > 0);
      i++;
      continue;
    }

    result[key] = stripQuotes(rawVal);
    i++;
  }
  return result;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value === null || value === undefined) return '';
  return String(value);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((s) => s.length > 0);
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

// ---------------------------------------------------------------------------
// Frontmatter serialization
// ---------------------------------------------------------------------------

function yamlScalar(value: string): string {
  // Quote strings so internal colons / special chars survive a round trip.
  return JSON.stringify(value);
}

function serializeFrontmatter(fields: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`);
    } else {
      lines.push(`${key}: ${yamlScalar(String(value))}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function slugify(text: string, fallback: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || fallback;
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base.endsWith('.md') ? base : `${base}.md`;
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let n = 2;
  const stem = name.replace(/\.md$/, '');
  while (used.has(`${stem}-${n}.md`)) n++;
  const finalName = `${stem}-${n}.md`;
  used.add(finalName);
  return finalName;
}

function titleFromContent(content: string, fallback: string): string {
  const firstLine = content.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!firstLine) return fallback;
  const t = firstLine.replace(/[#>*`_]/g, '').trim();
  return t.length > 0 ? t.slice(0, 80) : fallback;
}

function descriptionFromContent(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Write an OKF bundle to `dir`: an `index.md` listing every node, one `.md`
 * per memory (`type: Memory`) and per skill (`type: Skill`), each with
 * frontmatter (title/description/tags/timestamp) and the content in the body.
 */
export function exportOkfBundle(
  memories: OkfEntry[],
  skills: OkfEntry[],
  dir: string,
  packMeta?: OkfPackMeta,
): void {
  mkdirSync(dir, { recursive: true });
  const used = new Set<string>();
  const timestamp = new Date().toISOString();
  const links: string[] = [];

  const writeNode = (entry: OkfEntry, type: 'Memory' | 'Skill', prefix: string, fallback: string): string => {
    const title = titleFromContent(entry.content, fallback);
    const base = `${prefix}-${slugify(title, fallback)}`;
    const fileName = uniqueName(base, used);
    const fm = serializeFrontmatter({
      title,
      description: descriptionFromContent(entry.content),
      type,
      category: entry.category || (type === 'Skill' ? 'skill' : 'fact'),
      tags: entry.tags || [],
      timestamp,
    });
    const body = entry.content;
    writeFileSync(join(dir, fileName), `${fm}\n\n${body}\n`, 'utf-8');
    links.push(`- [${title}](${fileName})`);
    return fileName;
  };

  memories.forEach((m, i) => writeNode(m, 'Memory', 'memory', `memory-${i + 1}`));
  skills.forEach((s, i) => writeNode(s, 'Skill', 'skill', `skill-${i + 1}`));

  // index.md is reserved — it is a directory of nodes, not a concept.
  const packName = packMeta?.name ?? 'MicroExpert OKF Bundle';
  const indexLines: string[] = [
    '---',
    `title: ${yamlScalar(packName)}`,
    `description: ${yamlScalar(packMeta?.description ?? 'OKF knowledge bundle')}`,
    `timestamp: ${yamlScalar(timestamp)}`,
    '---',
    '',
    `# ${packName}`,
    '',
    packMeta?.description ? `${packMeta.description}\n` : '',
    '## Nodes',
    '',
    ...links,
    '',
  ];
  writeFileSync(join(dir, 'index.md'), indexLines.join('\n'), 'utf-8');
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Recursively collect `.md` file paths under `dir`. */
function collectMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Read an OKF bundle and convert every non-reserved `.md` with parseable
 * frontmatter and a non-empty `type` into a memory or skill entry. Files
 * without frontmatter or without a `type` are reported in `errors` (by
 * filename). Unknown `type` values are accepted as memories (the spec
 * forbids rejecting them).
 */
export function importOkfBundle(dir: string): OkfImportResult {
  const memories: OkfEntry[] = [];
  const skills: OkfEntry[] = [];
  const errors: string[] = [];

  let files: string[];
  try {
    files = collectMarkdownFiles(dir);
  } catch (e) {
    return { memories, skills, errors: [`Cannot read bundle directory: ${(e as Error).message}`] };
  }

  for (const path of files) {
    const name = basename(path);
    if (RESERVED.has(name)) continue; // reserved — not a concept

    const text = readFileSync(path, 'utf-8');
    const { frontmatter, body } = splitFrontmatter(text);

    if (frontmatter === null) {
      errors.push(`${name}: missing frontmatter.`);
      continue;
    }

    const type = asString(frontmatter.type).trim();
    if (type === '') {
      errors.push(`${name}: frontmatter has no "type" field.`);
      continue;
    }

    const content = body;
    const category = asString(frontmatter.category).trim();
    const tags = asStringArray(frontmatter.tags);

    const isSkill = type === 'Skill' || TOOL_TAG_RE.test(content);
    const entry: OkfEntry = {
      content,
      category: category || (isSkill ? 'skill' : 'fact'),
      tags,
    };

    if (isSkill) skills.push(entry);
    else memories.push(entry);
  }

  return { memories, skills, errors };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate spec conformance of an OKF bundle: every non-reserved `.md` must
 * carry parseable frontmatter with a non-empty `type`. Broken links are NOT
 * reported (the spec mandates tolerance). Reserved files are ignored.
 */
export function validateOkfBundle(dir: string): OkfValidationResult {
  const errors: string[] = [];

  let files: string[];
  try {
    files = collectMarkdownFiles(dir);
  } catch (e) {
    return { valid: false, errors: [`Cannot read bundle directory: ${(e as Error).message}`] };
  }

  for (const path of files) {
    const name = basename(path);
    if (RESERVED.has(name)) continue;

    const text = readFileSync(path, 'utf-8');
    const { frontmatter } = splitFrontmatter(text);

    if (frontmatter === null) {
      errors.push(`${name}: missing frontmatter.`);
      continue;
    }
    const type = asString(frontmatter.type).trim();
    if (type === '') {
      errors.push(`${name}: frontmatter has no "type" field.`);
    }
    // Unknown fields and unknown types are tolerated per spec.
  }

  return { valid: errors.length === 0, errors };
}