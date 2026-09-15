/**
 * Getting a browser onto the machine, the first time.
 *
 * Playwright's npm package carries no install hook, so a fresh `npx uisight`
 * arrives with the driver and nothing to drive. Telling people to run one
 * command works, but it is a wall in front of the first thing they ever try.
 *
 * So: ask, then fetch. Only where asking makes sense — a real terminal, not
 * CI, not a server a host started for an agent. Nobody's build should pull
 * hundreds of megabytes because a config file mentioned this tool.
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

/** Which of these engines are not on disk. */
export function missingEngines(engines, playwright) {
  const eksik = [];
  for (const ad of new Set(engines)) {
    try {
      const yol = playwright[ad]?.executablePath?.();
      if (!yol || !existsSync(yol)) eksik.push(ad);
    } catch { eksik.push(ad); }
  }
  return eksik;
}

/**
 * What a download costs on disk, measured rather than remembered.
 *
 * `playwright install chromium` fetches Chromium AND its headless shell. On
 * Windows with Playwright 1.62 they took 428 + 272 MB; WebKit took 170 MB. The
 * "~150 MB" this tool used to quote was off by more than four times, and this
 * number is shown exactly where someone decides whether to agree to it.
 */
const DISK_MB = { chromium: 700, webkit: 170 };
export function diskSize(engines) {
  const mb = [...new Set(engines)].reduce((t, ad) => t + (DISK_MB[ad] || 300), 0);
  return `about ${mb} MB on disk`;
}

/**
 * Is there a person here to ask?
 *
 * `CI` covers the usual runners. The panel and the MCP server are usually
 * started by an editor or an agent host with no terminal attached, and that is
 * exactly where a large download with a question nobody sees would hang.
 */
export function canAsk(env = process.env, stdin = process.stdin, stdout = process.stdout) {
  if (env.CI || env.UISIGHT_NO_INSTALL) return false;
  return Boolean(stdin?.isTTY && stdout?.isTTY);
}

/** The `playwright install` command, resolved rather than guessed. */
export function installCommand(engines, require_ = createRequire(import.meta.url)) {
  const pkgYolu = require_.resolve('playwright/package.json');
  const pkg = require_(pkgYolu);
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.playwright;
  return { cmd: process.execPath, args: [join(dirname(pkgYolu), bin), 'install', ...engines], version: pkg.version };
}

/**
 * Was the download agreed to ahead of time, by a host that cannot ask?
 *
 * Claude Desktop installs uisight as an MCPB bundle. There is no terminal, so
 * offerInstall can never ask, and a bundle cannot carry a browser of several
 * hundred megabytes. Without this, a new user's first tool call ends in an
 * error telling them to open a terminal, which is the one thing a one-click
 * install exists to avoid. So the bundle's install screen asks instead, once,
 * with the size stated, and passes the answer in as UISIGHT_AUTO_INSTALL. CI
 * and an explicit UISIGHT_NO_INSTALL still win, and an unfilled template is
 * not a yes.
 */
export function autoInstall(env = process.env) {
  if (env.CI || env.UISIGHT_NO_INSTALL) return false;
  return /^(1|true|yes|on)$/i.test(String(env.UISIGHT_AUTO_INSTALL || '').trim());
}

async function sor(soru) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const cevap = await new Promise((c) => rl.question(soru, c));
    return !/^n/i.test(cevap.trim());
  } finally { rl.close(); }
}

function runInstall(komut, stdio) {
  return new Promise((c) => {
    const p = spawn(komut.cmd, komut.args, { stdio, windowsHide: true });
    p.on('error', () => c(1));
    p.on('close', c);
  });
}

/**
 * Offer to download what is missing. Returns true if the engines are there
 * afterwards; false means the caller should fall back to explaining.
 *
 * In a terminal it asks, and Playwright's own output is inherited rather than
 * captured: a download this long must show its own progress, or the first run
 * looks like a hang. Without a terminal it only proceeds if the download was
 * agreed to in advance (autoInstall), and then there is nowhere to show
 * progress -- `onStart(engines, size)` lets the caller publish that a download
 * is under way.
 */
export async function offerInstall(engines, playwright, {
  ask = sor, auto = autoInstall(), onStart = () => {}, run = runInstall,
} = {}) {
  const eksik = missingEngines(engines, playwright);
  if (!eksik.length) return true;
  const sorulabilir = canAsk();
  if (!sorulabilir && !auto) return false;

  let komut;
  try { komut = installCommand(eksik); } catch { return false; }

  if (sorulabilir) {
    const evet = await ask(`  ${eksik.join(' and ')} ${eksik.length > 1 ? 'are' : 'is'} not downloaded yet (${diskSize(eksik)}, once). Fetch now? [Y/n] `);
    if (!evet) return false;
    process.stderr.write(`\n  playwright ${komut.version} install ${eksik.join(' ')}\n\n`);
  }

  onStart(eksik, diskSize(eksik));
  const kod = await run(komut, sorulabilir ? ['ignore', 'inherit', 'inherit'] : 'ignore');
  if (kod !== 0) return false;
  return missingEngines(eksik, playwright).length === 0;
}
