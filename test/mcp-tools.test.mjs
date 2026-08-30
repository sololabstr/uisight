/**
 * The MCP tool surface, in both languages.
 *
 * These exist because a rename swept through the bilingual tool table and quietly
 * turned the Turkish names into English ones. Every syntax check passed, every
 * inspection test passed, and `UISIGHT_LANG=tr` shipped tools called `inspect`
 * and `goto`. The tool NAMES are the contract an agent binds to — renaming one is
 * a breaking change, and nothing in the test suite could see it.
 *
 * tools/list needs no panel, so these run in about a second.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp.mjs');

/** Spawns the MCP server over stdio and returns its advertised tools. */
function listTools(env = {}) {
  const p = spawn(process.execPath, [MCP], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { p.kill(); reject(new Error('MCP server did not answer tools/list')); }, 25000);
    const done = (fn, v) => { clearTimeout(timer); p.kill(); fn(v); };
    p.on('error', (e) => done(reject, e));
    p.stdout.on('data', (d) => {
      buffer += d.toString();
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m.id === 2) return done(resolve, m.result.tools);
        } catch { /* not our frame */ }
      }
    });
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

// A port nothing else is on: these tests never start a panel, but the server
// reads the value at import time.
const PORT = { UISIGHT_PORT: '5199' };

const EN = ['see_screen', 'inspect', 'goto', 'tap', 'type_text', 'scroll', 'set_device', 'status', 'marks'];
const TR = ['ekrani_gor', 'denetle', 'git', 'tikla', 'yaz', 'kaydir', 'cihaz_degistir', 'durum', 'isaretler'];

test('the English tool names are exactly the nine an agent binds to', async () => {
  const tools = await listTools(PORT);
  assert.deepEqual(tools.map((t) => t.name).sort(), [...EN].sort());
});

test('UISIGHT_LANG=tr renames every tool, not some of them', async () => {
  const tools = await listTools({ ...PORT, UISIGHT_LANG: 'tr' });
  const names = tools.map((t) => t.name);
  assert.deepEqual([...names].sort(), [...TR].sort());
  // The specific failure that prompted this file: a half-translated surface.
  for (const leftover of EN) {
    assert.equal(names.includes(leftover), false, `${leftover} is still English in tr mode`);
  }
});

test('both languages expose the same parameters for the same tool', async () => {
  const [en, tr] = await Promise.all([listTools(PORT), listTools({ ...PORT, UISIGHT_LANG: 'tr' })]);
  const params = (tools, name) => Object.keys(tools.find((t) => t.name === name).inputSchema?.properties || {}).sort();
  // Language changes the name and the prose, never the argument keys — an agent
  // that learned `session` must not have to relearn it per locale.
  for (let i = 0; i < EN.length; i++) {
    assert.deepEqual(params(tr, TR[i]), params(en, EN[i]), `${EN[i]} / ${TR[i]} take different parameters`);
  }
});

test('every tool describes itself and its arguments', async () => {
  const tools = await listTools(PORT);
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 20, `${t.name} has no usable description`);
    for (const [k, v] of Object.entries(t.inputSchema?.properties || {})) {
      assert.ok(v.description, `${t.name}.${k} has no description — the agent has to guess`);
    }
  }
});
