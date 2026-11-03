/** npm installation and guided onboarding in the user's existing Chrome. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { CHROME_WEB_STORE_URL } from './dassi-shared.mjs';
import { resolveChromePath } from './launch.mjs';

const exec = promisify(execFile);
const sourceDir = path.dirname(fileURLToPath(import.meta.url));

async function globalPackageDir(install) {
  const { stdout } = await install('npm', ['root', '--global'], { encoding: 'utf8', timeout: 30000 });
  const root = stdout.trim();
  if (!path.isAbsolute(root)) throw new Error('npm did not return its global installation location. Check npm, then rerun setup.');
  return path.join(root, '@dassi_ai', 'cli');
}

export async function installCli({ source = sourceDir, install = exec } = {}) {
  source = fs.realpathSync(source);
  const packageDir = await globalPackageDir(install);
  const cliPath = path.join(packageDir, 'dassi.mjs');
  const alreadyInstalled = fs.existsSync(packageDir) && fs.realpathSync(packageDir) === source;
  if (!alreadyInstalled) {
    try {
      await install('npm', ['install', '--global', '--install-links', '--omit=dev',
        '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', source],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      if (/EACCES|EPERM/.test(`${error.code} ${error.stderr}`)) throw new Error(
        'npm cannot write to its global installation location. Configure a user-writable npm prefix, then rerun setup.\n' +
        'https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/',
      );
      throw error;
    }
  }
  if (!fs.existsSync(cliPath) || fs.lstatSync(packageDir).isSymbolicLink())
    throw new Error('Global CLI installation failed. Update npm, then run setup again.');
  return { packageDir, cliPath, skillDir: path.join(packageDir, 'skills', 'dassi') };
}

function skillLinks({ home = os.homedir(), claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude') } = {}) {
  return [...new Set([path.join(home, '.agents', 'skills', 'dassi'), path.join(claudeDir, 'skills', 'dassi')])];
}

export function registerSkills(skillDir, options = {}) {
  return skillLinks(options).map(link => {
    try {
      fs.lstatSync(link);
      return { path: link, status: fs.realpathSync(link) === fs.realpathSync(skillDir) ? 'registered' : 'conflict' };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling user link is still a user-owned installation.
      try { fs.lstatSync(link); return { path: link, status: 'conflict' }; } catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(skillDir, link, 'dir');
      return { path: link, status: 'registered' };
    }
  });
}

export async function unregisterSkills({ install = exec, ...options } = {}) {
  const skillDir = path.join(await globalPackageDir(install), 'skills', 'dassi');
  return skillLinks(options).map(link => {
    try {
      if (!fs.lstatSync(link).isSymbolicLink() || path.resolve(path.dirname(link), fs.readlinkSync(link)) !== skillDir)
        return { path: link, status: 'preserved' };
      fs.unlinkSync(link);
      return { path: link, status: 'removed' };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { path: link, status: 'not_registered' };
    }
  });
}

async function openChrome(url) {
  const chrome = resolveChromePath();
  if (!chrome) throw new Error('Chrome was not found. Install Google Chrome, then run setup again.');
  if (process.platform === 'darwin') await exec('open', ['-a', 'Google Chrome', url]);
  else {
    const { spawn } = await import('node:child_process');
    const child = spawn(chrome, [url], { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  }
}

async function chooseProfile(profiles) {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    profiles.forEach((profile, index) => process.stderr.write(`${index + 1}. ${profile.label} (${profile.id})\n`));
    while (true) {
      const answer = await terminal.question('Which Chrome profile should Dassi use? Enter its number: ');
      if (/^\d+$/.test(answer.trim()) && profiles[Number(answer) - 1]) return profiles[Number(answer) - 1].id;
    }
  } finally { terminal.close(); }
}

export async function connectSetup({ profile = null, waitMs = 300000, noOpen = false, interactive = false } = {}, {
  send, open = openChrome, choose = chooseProfile, pause = sleep, now = Date.now, log = console.error,
} = {}) {
  const deadline = now() + waitMs;
  const announced = new Set();
  const announce = message => { if (!announced.has(message)) { announced.add(message); log(message); } };
  const opened = new Set();
  const openOnce = async (key, fn) => {
    if (noOpen || opened.has(key)) return;
    opened.add(key);
    try { await fn(); } catch (error) { announce(`Could not open Chrome: ${error.message}`); }
  };
  let selected = profile;
  let pending;
  while (true) {
    const response = await send({ action: 'list_profiles' });
    if (!response.success) throw new Error(response.error);
    const profiles = response.data.map(({ id, label, authenticated, error }) => ({ id, label, authenticated, ...(error ? { error } : {}) }));
    const exact = profiles.find(p => p.id === selected);
    const matches = selected ? (exact ? [exact] : profiles.filter(p => p.label === selected)) : profiles;
    if (matches.length > 1) {
      if (!interactive) return { ready: false, reason: 'choose_profile', profiles,
        next: 'Run setup --profile <id> using the intended Chrome profile ID.' };
      selected = await choose(matches);
      continue;
    }
    if (!matches.length) {
      pending = { ready: false, reason: 'connect_chrome', profiles, installUrl: CHROME_WEB_STORE_URL,
        next: selected ? `Open Dassi in profile "${selected}". Setup will resume when it connects.`
          : 'In Chrome, click Add to Chrome and confirm Add extension in the profile you want to use.' };
      announce(pending.next);
      announce(CHROME_WEB_STORE_URL);
      if (!selected) await openOnce('install', () => open(CHROME_WEB_STORE_URL));
    } else {
      const current = matches[0];
      selected = current.id;
      let verification;
      try {
        verification = await send({ action: 'list_tools', target: selected });
        if (verification.success && Array.isArray(verification.data)) {
          const tabs = await send({ action: 'list_tabs', target: selected, all: true });
          const tabError = tabs.error ?? tabs.profiles?.find(p => p.error)?.error;
          if (tabs.success && !tabError) {
            const latest = tabs.profiles?.find(p => p.id === selected);
            const delegationError = latest ? latest.authError : current.error;
            const authenticated = (latest ?? current).authenticated === true && !delegationError;
            return { ready: true, profile: { id: current.id, label: current.label }, browserTools: true,
              delegation: authenticated, ...(delegationError ? { delegationError } : {}), tabCount: tabs.data.length };
          }
          verification = { success: false, error: tabError };
        }
      } catch (error) { verification = { success: false, error: error.message }; }
      const outdated = /Unknown method: list_tools/.test(verification.error ?? '');
      pending = { ready: false, reason: outdated ? 'update_extension' : 'verify_connection', profile: { id: current.id, label: current.label },
        next: outdated ? `Update Dassi in Chrome profile "${current.label}", then reopen Dassi.` : `Reopen Dassi in Chrome profile "${current.label}" to verify its browser tools.`,
        error: verification.error };
      announce(pending.next);
      if (outdated) await openOnce(`update:${selected}`, () => send({ action: 'open_tab', target: selected, url: CHROME_WEB_STORE_URL, active: true }).then(r => { if (!r.success) throw new Error(r.error); }));
    }
    if (now() >= deadline) break;
    await pause(Math.min(1000, deadline - now()));
  }
  return pending;
}

export async function setup(options = {}, deps = {}) {
  if ((deps.platform ?? process.platform) === 'win32') throw new Error('Dassi CLI setup currently supports macOS and Linux.');
  const log = deps.log ?? console.error;
  log('Welcome to Dassi\n\nInstalling Dassi…');
  const installed = await (deps.installCli ?? installCli)(deps);
  log('✓ Dassi installed');
  const skills = registerSkills(installed.skillDir, deps);
  const conflicts = skills.filter(skill => skill.status === 'conflict');
  if (conflicts.length) return { ...installed, skills, ready: false, reason: 'skill_conflict',
    next: `Existing skills were preserved. Move or rename these entries, then rerun setup: ${conflicts.map(s => s.path).join(', ')}` };
  log('✓ Agent skill installed\n\nConnecting Chrome…');
  let send = deps.send;
  if (!send) {
    const transport = await import(pathToFileURL(path.join(installed.packageDir, 'daemon-client.mjs')).href);
    const socket = await transport.ensureDaemonReady(options.session ?? 'default');
    send = command => transport.sendCommand(socket, { id: `setup_${randomUUID()}`, ...command });
  }
  return { ...installed, skills, ...await connectSetup(options, { ...deps, send, log }) };
}

export function formatSetup(data) {
  if (!data.ready) return `${data.next}\n\nRun dassi setup to resume.`;
  return [
    `✓ Chrome connected: ${data.profile.label}`,
    '✓ Browser tools verified',
    '', "You're ready.", '',
    'Open your agent and ask:',
    '“Use Dassi to show my open browser tabs.”',
    '', 'If your agent is already running, restart it to load the skill.',
  ].join('\n');
}
