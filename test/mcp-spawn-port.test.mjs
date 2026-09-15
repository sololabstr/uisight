/**
 * The MCP server has to start the panel on the port it then polls.
 *
 * `portForProject()` hashes the PROJECT's cwd into a port, and this process
 * polls that port. `server.mjs` has no such function: given no `--port` and no
 * `UISIGHT_PORT`, it falls back to its own default, 5055. So the spawned panel
 * bound 5055 while the MCP waited on, say, 5103 -- thirty seconds of polling
 * and then "panel server did not start on port 5103", about a panel that had
 * started perfectly well somewhere else.
 *
 * It leaks as well as fails. Nothing can reach that panel afterwards, so it
 * holds a browser open for the life of the machine. Found in the wild: a panel
 * on 5055 pointed at the MCP's own default URL, with a live browser under it
 * and no MCP anywhere that could see it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const mcp = strip(readFileSync(join(root, 'src', 'mcp.mjs'), 'utf8'));
const server = strip(readFileSync(join(root, 'src', 'server.mjs'), 'utf8'));

test('the two sides really do derive the port differently', () => {
  // If this stops being true the bug cannot happen and the fix is dead weight,
  // so the premise is asserted rather than assumed.
  assert.match(mcp, /function portForProject\(/, 'the MCP derives a port from the project cwd');
  assert.ok(!/function portForProject\(/.test(server), 'the panel does not know that function');
  assert.match(server, /arg\('--port', 5055\)/, 'left alone the panel binds its own default');
});

test('the spawned panel is told which port to bind', () => {
  const m = mcp.match(/child = spawn\(process\.execPath, \[[^\]]*\]/);
  assert.ok(m, 'the spawn call has to exist to be checked');
  assert.match(m[0], /'--port'/, 'without --port the panel binds 5055 and this process polls elsewhere');
  assert.match(m[0], /String\(PORT\)/, 'and it has to be the very port this process goes on to poll');
});
