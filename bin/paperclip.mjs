#!/usr/bin/env node
// Paperclip — minimal orchestrator for the requirement-generator workflow.
// In production this is a real service with scheduling, MCP-based source fetches,
// budget tracking, and durable approval gates. This script is a faithful local
// simulation for demos and dev loops.

import { spawn } from 'node:child_process';
import {
  readFileSync, existsSync, mkdirSync, cpSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import { resolve } from 'node:path';
import readline from 'node:readline/promises';

const PROJECT_ROOT = process.cwd();
const CONFIG_PATH = resolve(PROJECT_ROOT, 'paperclip.config.json');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const log = {
  stage: (n, total, msg) =>
    console.log(`\n${c.cyan(`[${n}/${total}]`)} ${c.bold(msg)}`),
  ok: (msg) => console.log(`      ${c.green('✓')} ${msg}`),
  fail: (msg) => console.error(`      ${c.red('✗')} ${msg}`),
  info: (msg) => console.log(`      ${c.dim(msg)}`),
};

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(c.red(`Missing ${CONFIG_PATH}`));
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function fetchInputs(cfg) {
  log.stage(1, 4, `Fetch inputs — source: ${cfg.source.path}`);
  log.info(cfg.source.note);
  const src = resolve(PROJECT_ROOT, cfg.source.path);
  if (!existsSync(src)) {
    log.fail(`Source path does not exist: ${src}`);
    process.exit(1);
  }
  const inputsDir = resolve(PROJECT_ROOT, 'inputs');
  // Clear inputs so each run is idempotent
  if (existsSync(inputsDir)) rmSync(inputsDir, { recursive: true, force: true });
  mkdirSync(inputsDir, { recursive: true });
  for (const file of readdirSync(src)) {
    const srcFile = resolve(src, file);
    const dstFile = resolve(inputsDir, file);
    cpSync(srcFile, dstFile);
    const s = statSync(dstFile);
    log.ok(`${file} ${c.dim(`(${humanSize(s.size)})`)}`);
  }
}

function runClaude(prompt, label) {
  return new Promise((resolveP, rejectP) => {
    log.info(c.dim(`(claude --print …${label ? ' — ' + label : ''})`));
    const child = spawn('claude', ['--print', prompt], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', rejectP);
    child.on('exit', (code) =>
      code === 0 ? resolveP() : rejectP(new Error(`claude exited ${code}`))
    );
  });
}

async function generate(cfg) {
  log.stage(2, 4, `Generate — skill: ${cfg.skill}`);
  // Clear outputs so each run is idempotent
  const outDir = resolve(PROJECT_ROOT, 'outputs');
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const params = Object.entries(cfg.parameters)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
  const prompt = `Use the ${cfg.skill} skill.

Read everything in ./inputs/ and ./examples/.

Use these parameters:
${params}

Generate outputs/extraction.json, outputs/product-summary.md, outputs/stories.json, outputs/stories.md, and outputs/gaps.md.

Print only a one-line summary at the end. Do not call any MCP tools.`;
  await runClaude(prompt, 'requirement-generator');

  const expected = [
    'extraction.json', 'product-summary.md',
    'stories.json', 'stories.md', 'gaps.md',
  ];
  for (const f of expected) {
    const p = resolve(outDir, f);
    if (existsSync(p)) log.ok(f);
    else log.fail(`${f} not produced`);
  }
}

async function approve() {
  log.stage(3, 4, 'Approval gate');
  log.info('Review outputs/stories.md and outputs/product-summary.md before pushing.');
  if (!process.stdin.isTTY) {
    log.info(c.yellow('Non-interactive shell — auto-approving for demo.'));
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`      ${c.bold('Approve and push to Atlassian?')} [y/N] `);
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    log.info(c.yellow('Aborted by user. Artifacts kept in outputs/. No push performed.'));
    process.exit(0);
  }
  log.ok('Approved');
}

async function push(cfg) {
  log.stage(4, 4, 'Push to Atlassian via Rovo MCP');
  const a = cfg.atlassian;
  const prompt = `Use the atlassian MCP for all calls below.

1. Read outputs/product-summary.md from this folder. Create a Confluence page in space "${a.confluence_space_key}" with title "${a.confluence_page_title}". Render the markdown body appropriately. Capture the page URL.

2. Read outputs/stories.json. For each item:
   - Set fields.parent.key to "${a.parent_epic_key}".
   - In fields.description, replace the literal string {{PRODUCT_SUMMARY_URL}} with the Confluence URL from step 1.
   - Create the Jira issue using the atlassian MCP.

3. Print a markdown table with columns: story_number | jira_key | jira_url | confluence_url. Print the Confluence URL only on the first row.

Stop after the table. Do not transition statuses. Do not attach images.`;
  await runClaude(prompt, 'atlassian push');
}

async function run() {
  const t0 = Date.now();
  const cfg = loadConfig();
  console.log(`\n${c.blue('📎 Paperclip')} ${c.dim('—')} workflow: ${c.bold(cfg.skill)}`);
  console.log(c.dim('─'.repeat(64)));
  await fetchInputs(cfg);
  await generate(cfg);
  await approve();
  await push(cfg);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${c.dim('─'.repeat(64))}`);
  console.log(`${c.green('✓')} Done in ${dt}s.`);
}

const cmd = process.argv[2];
switch (cmd) {
  case 'run':
    run().catch((e) => { console.error(c.red(`\n✗ ${e.message}`)); process.exit(1); });
    break;
  case undefined:
  case 'help':
  case '--help':
    console.log(`Usage: paperclip <command>

  run        Run the configured workflow end-to-end:
             fetch inputs → generate → approval gate → push to Atlassian

Config is read from ./paperclip.config.json.`);
    break;
  default:
    console.error(c.red(`Unknown command: ${cmd}`));
    process.exit(1);
}
