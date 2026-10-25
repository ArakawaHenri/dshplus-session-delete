import { readFile, writeFile } from 'node:fs/promises';
import { remoteContribution } from '../remote.js';

const templateUrl = new URL('../src/client.template.js', import.meta.url);
const outputUrl = new URL('../client.js', import.meta.url);
const enUrl = new URL('../locale/en.json', import.meta.url);
const zhUrl = new URL('../locale/zh.json', import.meta.url);

const [template, enRaw, zhRaw] = await Promise.all([
  readFile(templateUrl, 'utf8'),
  readFile(enUrl, 'utf8'),
  readFile(zhUrl, 'utf8'),
]);

const { meta: _enMeta, ...en } = JSON.parse(enRaw);
const { meta: _zhMeta, ...zh } = JSON.parse(zhRaw);
if (JSON.stringify(Object.keys(en).sort()) !== JSON.stringify(Object.keys(zh).sort())) {
  throw new Error('Client locale keys must match');
}

const indent = (text, spaces = 4) =>
  text
    .split('\n')
    .map((line, index) => (index === 0 || !line ? line : `${' '.repeat(spaces)}${line}`))
    .join('\n');

const source = template
  .replace('/* REMOTE_CONTRIBUTION */', `const remoteContribution = ${indent(remoteContribution.toString())};`)
  .replace('/* DICTIONARIES */', `const dictionaries = ${indent(JSON.stringify({ en, zh }, null, 2))};`);

if (process.argv.includes('--check')) {
  if (await readFile(outputUrl, 'utf8') !== source) {
    throw new Error('client.js is stale; run npm run build');
  }
} else {
  await writeFile(outputUrl, source);
}
