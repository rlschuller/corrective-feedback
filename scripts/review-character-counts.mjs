// Recover counts locally; stdout contains only metadata and aggregates, never prose.
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.ts';
import { loadClaudeConfig } from '../src/claude-reviewer.ts';
import { prepareText } from '../src/text.ts';
import { extractText } from '../src/review.ts';

const indexes = new Map();
const output = [];
const excluded = [];
const seen = new Set();
async function jsonl(path) {
  const raw = await readFile(path, 'utf8');
  const lines = raw.split('\n');
  return lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; }
    catch (error) {
      if (index === lines.length - 1 && !raw.endsWith('\n')) {
        console.error(`Ignored an incomplete final row in ${path}`);
        return [];
      }
      // SyntaxError can include a source-text excerpt; never print that prose.
      throw new Error(`Invalid JSON row ${index + 1} in ${path}`);
    }
  });
}
const sources = [
  ['pi', process.argv[2] || (await loadConfig()).logPath],
  ['claude', process.argv[3] || (await loadClaudeConfig()).logPath],
];
for (const [host, path] of sources) {
  let records;
  try { records = await jsonl(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.error(`Feedback log not found; skipping ${host}: ${path}`);
    continue;
  }
  for (const record of records) {
    const unique = `${host}:${record.id}`;
    if (seen.has(unique)) throw new Error('Duplicate review ID');
    seen.add(unique);
    let reason;
    let prose;
    let rawCharacters;
    try {
      if (!record.sessionPath) throw new Error('no transcript path');
      if (!indexes.has(record.sessionPath)) {
        const index = new Map();
        for (const row of await jsonl(record.sessionPath)) {
          if (row.message?.role !== 'user') continue;
          const id = row.uuid ?? row.id;
          if (id) {
            if (index.has(id)) throw new Error('duplicate user-message ID');
            index.set(id, row.message);
          }
        }
        indexes.set(record.sessionPath, index);
      }
      const message = indexes.get(record.sessionPath).get(record.userMessageId);
      if (!message) throw new Error('user message not found');
      const text = extractText(message.content);
      rawCharacters = [...text].length;
      // Reuse the extension's exact prose filtering, without assuming the old
      // configuration's maximum input length. Counts are Unicode code points.
      prose = prepareText(text, Number.MAX_SAFE_INTEGER);
      if (!prose) throw new Error('reviewed prose could not be reconstructed');
      if (record.corrections.some(c => !prose.includes(c.original))) {
        throw new Error('correction excerpts do not match reconstructed prose');
      }
    } catch (error) { reason = error.code === 'ENOENT' ? 'transcript missing' : error.message; }
    const item = {
      host, timestamp: record.timestamp, model: record.model,
      errors: record.corrections.filter(c => c.kind === 'error').length,
    };
    if (reason) excluded.push({ ...item, reason });
    else output.push({ ...item, characters: [...prose].length, rawCharacters });
  }
}
console.log(JSON.stringify({ reviews: output, excluded }));
