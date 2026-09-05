import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function parseStaticAllowlist(): Promise<Array<{ route: string; file: string; type: string }>> {
  const source = await readFile("src/server.ts", "utf8");
  const marker = "const staticFiles: Record<string, [string, string]> = {";
  const start = source.indexOf(marker);
  assert.ok(start >= 0, "the staticFiles allowlist must exist in src/server.ts");
  const entries: Array<{ route: string; file: string; type: string }> = [];
  const entryPattern = /^\s*("\/[^"]*"):\s*\[("[^"]*"),\s*("[^"]*")\]/gm;
  for (const match of source.slice(start).matchAll(entryPattern)) {
    entries.push({ route: JSON.parse(match[1]!), file: JSON.parse(match[2]!), type: JSON.parse(match[3]!) });
  }
  assert.ok(entries.length >= 10, `the allowlist must contain entries (found ${entries.length})`);
  return entries;
}

test("every allowlisted static asset exists on disk under public/", async () => {
  const entries = await parseStaticAllowlist();
  for (const entry of entries) {
    const fullPath = path.join("public", entry.file);
    const info = await stat(fullPath);
    assert.ok(info.isFile(), `${entry.file} (served at ${entry.route}) must be a file on disk`);
  }
});

test("allowlist routes are unique", async () => {
  const entries = await parseStaticAllowlist();
  assert.equal(new Set(entries.map((entry) => entry.route)).size, entries.length, "route keys must be unique");
});

test("allowlisted files serve content-types compatible with their extension", async () => {
  const entries = await parseStaticAllowlist();
  for (const entry of entries) {
    const bytes = await readFile(path.join("public", entry.file));
    assert.ok(bytes.length > 0, `${entry.file} must not be empty`);
    if (entry.file.endsWith(".js")) assert.match(entry.type, /^text\/javascript/);
    if (entry.file.endsWith(".css")) assert.match(entry.type, /^text\/css/);
    if (entry.file.endsWith(".html")) assert.match(entry.type, /^text\/html/);
  }
});
