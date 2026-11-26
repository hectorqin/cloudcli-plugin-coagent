#!/usr/bin/env node
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const source = fs.readFileSync('src/shared/version.ts', 'utf8');
const skill = fs.readFileSync('skills/coagent/SKILL.md', 'utf8');
const match = source.match(/export const VERSION = ['"]([^'"]+)['"]/);
if (!match) throw new Error('src/shared/version.ts does not export a literal VERSION');
if (!/^---\r?\nname: coagent\r?\ndescription: [^\r\n]+\r?\ndisable-model-invocation: true\r?\n---\r?\n/.test(skill)) {
  throw new Error('skills/coagent/SKILL.md must have coagent name and description frontmatter');
}

const versions = { package: pkg.version, manifest: manifest.version, source: match[1] };
if (new Set(Object.values(versions)).size !== 1) {
  throw new Error(`release versions do not match: ${JSON.stringify(versions)}`);
}

const required = {
  name: 'coagent',
  displayName: 'string',
  entry: 'dist/index.js',
  server: 'dist/server.js',
  type: 'module',
  slot: 'tab',
};
for (const [field, expected] of Object.entries(required)) {
  const value = manifest[field];
  if (expected === 'string' ? typeof value !== 'string' || value.length === 0 : value !== expected) {
    throw new Error(`manifest.json ${field} must be ${JSON.stringify(expected)}`);
  }
}
if (manifest.toolRenderers !== undefined && (!Array.isArray(manifest.toolRenderers)
  || manifest.toolRenderers.some((value) => typeof value !== 'string'))) {
  throw new Error('manifest.json toolRenderers must be an array of strings when present');
}

console.log(`release metadata valid (${pkg.version})`);
