// Regenerate the standalone management document. No product bundle is changed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(path.join(root, 'docs/metadata/system-map.json'), 'utf8'));
const ids = new Set(data.nodes.map(n => n.id));
if (ids.size !== data.nodes.length) throw Error('Duplicate node id');
for (const n of data.nodes) {
  if (n.parent && !ids.has(n.parent)) throw Error('Unknown parent: ' + n.parent);
  for (const p of n.sources) if (!existsSync(path.join(root, p))) throw Error('Missing source: ' + p);
}
for (const e of data.edges) if (!ids.has(e.source) || !ids.has(e.target)) throw Error('Unknown edge endpoint');
for (const p of data.plans) {
  for (const id of p.nodes) if (!ids.has(id)) throw Error('Unknown plan node: ' + id);
  for (const id of p.depends) if (!data.plans.some(x => x.id === id)) throw Error('Unknown plan dependency: ' + id);
}
const template = readFileSync(path.join(root, 'docs/templates/management-map.html'), 'utf8');
if (template.split('{{SYSTEM_DATA}}').length !== 2) throw Error('Expected one data slot');
const html = template.replace('{{SYSTEM_DATA}}', () => JSON.stringify(data).replace(/</g, '\\u003c'));
const output = path.join(root, 'docs/architecture-mindmap.html');
writeFileSync(output, html);
console.log(`Built ${path.relative(root, output)}: ${data.nodes.length} nodes, ${data.edges.length} connections, ${data.plans.length} upgrade proposals.`);
