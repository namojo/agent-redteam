#!/usr/bin/env node
// Static site build for GitHub Pages.
//   node site/build.mjs            -> writes _site/
// Build-only dependencies (marked, mermaid) live in site/package.json.
// Install them with: npm ci --prefix site
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SITE_DIR, '..');
const OUT = join(ROOT, '_site');
const REPO_URL = 'https://github.com/namojo/agent-redteam';
const BLOB = `${REPO_URL}/blob/main`;
const TREE = `${REPO_URL}/tree/main`;
const SITE_NAME = 'agent-redteam';

// The single mapping table: repo Markdown source -> site page. Order = nav order.
export const PAGES = [
  { src: 'README.md', out: 'index.html', nav: '소개', title: '소개' },
  { src: 'docs/MANUAL.md', out: 'manual.html', nav: '매뉴얼', title: '사용 매뉴얼' },
  { src: 'docs/ARCHITECTURE.md', out: 'architecture.html', nav: '아키텍처', title: '아키텍처' },
  { src: 'docs/OFFLINE-INSTALL.md', out: 'offline-install.html', nav: '폐쇄망 설치', title: '폐쇄망 설치' },
  { src: 'docs/EXAMPLE-REPORT.md', out: 'example-report.html', nav: '예시 리포트', title: '예시 리포트' },
];

// Directories copied verbatim so the console can import the engine with relative paths.
// Repo layout and site layout keep the same relative shape:
//   web/console.mjs  --import '../src/core/index.mjs'-->  src/core/index.mjs   (repo root served)
//   console/console.mjs --same specifier-->              src/core/index.mjs   (_site served)
export const COPY_TREES = [
  { src: 'web', out: 'console' },
  { src: 'src/core', out: 'src/core' },
];

const IMAGE_PREFIX = 'docs/images/';

// ---------------------------------------------------------------------------
// helpers

const toPosix = (p) => p.split(sep).join('/');
const warnings = [];
const warn = (msg) => { warnings.push(msg); console.warn(`warn: ${msg}`); };

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

// GitHub-compatible heading slug (same rule as github-slugger):
// lowercase, drop everything except letters, marks, numbers, connector punctuation,
// space and hyphen; spaces -> '-'. Korean is kept. Duplicates get -1, -2, ...
export function createSlugger() {
  const seen = new Map();
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    let slug = base;
    if (seen.has(base)) {
      let n = seen.get(base);
      do { n += 1; slug = `${base}-${n}`; } while (seen.has(slug));
      seen.set(base, n);
    }
    seen.set(slug, 0);
    return slug;
  };
}

// ---------------------------------------------------------------------------
// Mermaid lint: edge labels must not contain characters that broke rendering before.

const EDGE_LABEL_FORBIDDEN = /[<>≤≥"'“”‘’()（）]/u;

export function findMermaidBlocks(source) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  let open = null;
  lines.forEach((line, i) => {
    if (!open) {
      const m = /^(\s*)(`{3,}|~{3,})\s*mermaid\b.*$/.exec(line);
      if (m) open = { fence: m[2], startLine: i + 1, lines: [] };
      return;
    }
    const close = new RegExp(`^\\s*${open.fence[0] === '`' ? '`' : '~'}{${open.fence.length},}\\s*$`);
    if (close.test(line)) { blocks.push(open); open = null; return; }
    open.lines.push({ no: i + 1, text: line });
  });
  return blocks;
}

export function lintMermaid(source, file) {
  const problems = [];
  for (const block of findMermaidBlocks(source)) {
    for (const { no, text } of block.lines) {
      // Blank out quoted node labels (["..."], ("..."), {"..."}, >"...") so pipes/quotes inside them are ignored.
      const line = text.replace(/([\[({>])"[^"]*"/g, '$1""');
      const labels = [];
      // Pipe form: A -->|label| B, A ---|label| B, A -.->|label| B, A ==>|label| B
      for (const m of line.matchAll(/(?:<?(?:-{2,}|={2,}|-\.+-)[>xo]?)\s*\|([^|]*)\|/g)) labels.push(m[1]);
      // Text form: A -- label --> B, A == label ==> B, A -. label .-> B
      for (const m of line.matchAll(/(?:^|[\s\])}])(?:--|==|-\.)\s+(.+?)\s+(?:-{2,}>|={2,}>|\.-+>|-{3,}|={3,})/g)) labels.push(m[1]);
      for (const label of labels) {
        const bad = label.match(new RegExp(EDGE_LABEL_FORBIDDEN, 'gu'));
        if (bad) {
          problems.push(`${file}:${no}: Mermaid edge label "${label.trim()}" contains forbidden character(s) ${[...new Set(bad)].join(' ')} — remove < > ≤ ≥ quotes and parentheses from |edge labels|`);
        }
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Link rewriting.
//   - absolute URLs (scheme: or //) and pure #anchors: unchanged
//   - a mapped Markdown page that is built: <out>.html[#anchor]
//   - an image under docs/images/: copied to _site/docs/images/, same repo path
//   - any other repo file/dir: GitHub blob/tree URL on main

function makeRewriter({ srcFile, builtPages, usedAssets }) {
  return (href, kind) => {
    if (!href) return href;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return href;
    const hashAt = href.indexOf('#');
    const pathPart = hashAt >= 0 ? href.slice(0, hashAt) : href;
    const fragment = hashAt >= 0 ? href.slice(hashAt) : '';
    const clean = pathPart.split('?')[0];
    let decoded;
    try { decoded = decodeURI(clean); } catch { decoded = clean; }
    const repoPath = decoded.startsWith('/')
      ? posix.normalize(decoded.slice(1))
      : posix.normalize(posix.join(posix.dirname(srcFile), decoded));
    if (repoPath.startsWith('..')) { warn(`${srcFile}: link "${href}" points outside the repository; left unchanged`); return href; }
    const target = repoPath === '.' ? '' : repoPath.replace(/\/$/, '');

    const page = PAGES.find((p) => p.src === target);
    if (page) {
      if (builtPages.has(page.src)) return page.out + fragment;
      warn(`${srcFile}: link to ${target} — page not built (source missing); using GitHub URL`);
      return `${BLOB}/${encodeURI(target)}${fragment}`;
    }
    if (target.startsWith(IMAGE_PREFIX) && existsSync(join(ROOT, target)) && statSync(join(ROOT, target)).isFile()) {
      usedAssets.add(target);
      return encodeURI(target) + fragment;
    }
    if (!target) return REPO_URL;
    const abs = join(ROOT, target);
    if (!existsSync(abs)) warn(`${srcFile}: ${kind} "${href}" -> ${target} does not exist in the repository`);
    const isDir = existsSync(abs) && statSync(abs).isDirectory();
    return `${isDir ? TREE : BLOB}/${encodeURI(target)}${fragment}`;
  };
}

// ---------------------------------------------------------------------------
// Markdown -> HTML

function renderMarkdown(Marked, source, ctx) {
  const slug = createSlugger();
  const rewrite = makeRewriter(ctx);
  const headings = [];
  let hasMermaid = false;
  const md = new Marked({ gfm: true });
  md.use({
    walkTokens(token) {
      if (token.type === 'link') token.href = rewrite(token.href, 'link');
      if (token.type === 'image') token.href = rewrite(token.href, 'image');
      // Raw HTML inside Markdown (<img src>, <a href>) follows the same rules.
      if (token.type === 'html') {
        token.text = token.text.replace(/\b(src|href)=(["'])([^"']*)\2/gi, (_, attr, q, url) =>
          `${attr}=${q}${escapeHtml(rewrite(decodeEntities(url), attr === 'src' ? 'image' : 'link'))}${q}`);
      }
    },
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const text = decodeEntities(inner.replace(/<[^>]*>/g, '')).trim();
        const id = slug(text);
        headings.push({ depth, text, id });
        return `<h${depth} id="${escapeHtml(id)}"><a class="anchor" href="#${escapeHtml(id)}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`;
      },
      code({ text, lang }) {
        const info = (lang || '').trim().split(/\s+/)[0];
        if (info === 'mermaid') {
          hasMermaid = true;
          return `<pre class="mermaid">${escapeHtml(text)}</pre>\n`;
        }
        return false; // default renderer
      },
    },
  });
  let html = md.parse(source);
  // Tables scroll inside their own container, never the page.
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  return { html, headings, hasMermaid };
}

function collectIds(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => decodeEntities(m[1])));
}

// ---------------------------------------------------------------------------
// Console / core import rule check (only runs when web/ exists).
// Rule: every import in web/** and src/core/** must be a relative specifier that resolves
// to a file inside the copied trees (web/ or src/core/). Bare specifiers (no bundler),
// root-absolute paths ('/x' breaks under the /agent-redteam/ Pages subpath) and imports
// into src/node/ are errors.

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

export function checkImports(root = ROOT) {
  const problems = [];
  const trees = COPY_TREES.filter((t) => existsSync(join(root, t.src)));
  const inTree = (repoPath) => trees.some((t) => repoPath === t.src || repoPath.startsWith(`${t.src}/`));
  for (const t of trees) {
    for (const abs of listFiles(join(root, t.src))) {
      if (!/\.(mjs|js)$/.test(abs)) continue;
      const file = toPosix(relative(root, abs));
      const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const specs = [
          ...line.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g),
          ...line.matchAll(/^\s*import\s*['"]([^'"]+)['"]/g),
          ...line.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
        ].map((m) => m[1]);
        for (const spec of specs) {
          const where = `${file}:${i + 1}`;
          if (spec.startsWith('/')) { problems.push(`${where}: import "${spec}" is root-absolute; use a relative path (site is served under /agent-redteam/)`); continue; }
          if (!spec.startsWith('.')) { problems.push(`${where}: import "${spec}" is a bare/scheme specifier; the console has no bundler — import core via a relative path`); continue; }
          const target = posix.normalize(posix.join(posix.dirname(file), spec));
          if (!inTree(target)) { problems.push(`${where}: import "${spec}" resolves to ${target}, which is not published (only ${COPY_TREES.map((x) => x.src + '/').join(', ')} are copied)`); continue; }
          if (!existsSync(join(root, target))) problems.push(`${where}: import "${spec}" resolves to ${target}, which does not exist`);
        }
      });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------

function navHtml(current, consoleAvailable, builtPages) {
  const items = PAGES.filter((p) => builtPages.has(p.src)).map((p) => {
    const cur = p.out === current ? ' aria-current="page"' : '';
    return `<li><a href="${p.out}"${cur}>${escapeHtml(p.nav)}</a></li>`;
  });
  if (consoleAvailable) items.push('<li><a href="console/">웹 콘솔</a></li>');
  items.push(`<li><a href="${REPO_URL}" rel="noopener">GitHub</a></li>`);
  return items.join('\n          ');
}

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`template placeholder {{${key}}} has no value`);
    return values[key];
  });
}

const MERMAID_SCRIPT = `<script src="assets/mermaid.min.js"></script>
  <script>
    (function () {
      var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      mermaid.initialize({ startOnLoad: true, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
    })();
  </script>`;

async function main() {
  let Marked;
  try {
    ({ Marked } = await import('marked'));
    if (!existsSync(join(SITE_DIR, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'))) throw new Error('mermaid missing');
  } catch {
    console.error('site build dependencies are not installed. Run: npm ci --prefix site');
    process.exit(2);
  }

  const available = PAGES.filter((p) => {
    if (existsSync(join(ROOT, p.src))) return true;
    warn(`${p.src} not found — skipping ${p.out} (and its nav entry)`);
    return false;
  });
  const builtPages = new Set(available.map((p) => p.src));
  const sources = new Map(available.map((p) => [p.src, readFileSync(join(ROOT, p.src), 'utf8')]));

  // 1. lint first, fail before writing anything
  const lint = available.flatMap((p) => lintMermaid(sources.get(p.src), p.src));
  const consoleAvailable = existsSync(join(ROOT, 'web'));
  if (consoleAvailable && !existsSync(join(ROOT, 'src', 'core'))) lint.push('web/ exists but src/core/ does not — the console cannot import the engine');
  if (consoleAvailable) lint.push(...checkImports());
  if (lint.length) {
    for (const p of lint) console.error(`error: ${p}`);
    console.error(`site build failed: ${lint.length} problem(s)`);
    process.exit(1);
  }

  // 2. fresh output dir
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'assets'), { recursive: true });

  const template = readFileSync(join(SITE_DIR, 'template.html'), 'utf8');
  const usedAssets = new Set();
  const rendered = [];
  let mermaidBlocks = 0;

  for (const page of available) {
    const source = sources.get(page.src);
    const { html, headings, hasMermaid } = renderMarkdown(Marked, source, { srcFile: page.src, builtPages, usedAssets });
    mermaidBlocks += findMermaidBlocks(source).length;
    const h1 = headings.find((h) => h.depth === 1);
    const docTitle = h1 ? h1.text.replace(/^[^\p{L}\p{N}]+/u, '') : page.title;
    const title = page.out === 'index.html' ? `${SITE_NAME} — ${page.title}` : `${docTitle} · ${SITE_NAME}`;
    const out = fill(template, {
      title: escapeHtml(title),
      nav: navHtml(page.out, consoleAvailable, builtPages),
      content: html,
      source: `${BLOB}/${page.src}`,
      sourceName: escapeHtml(page.src),
      mermaid: hasMermaid ? MERMAID_SCRIPT : '',
    });
    writeFileSync(join(OUT, page.out), out);
    rendered.push({ page, html: out });
  }

  // 3. anchor check (warning only): #id and page.html#id must exist
  const idsByPage = new Map(rendered.map((r) => [r.page.out, collectIds(r.html)]));
  for (const r of rendered) {
    for (const m of r.html.matchAll(/href="([^"]*#[^"]*)"/g)) {
      const href = decodeEntities(m[1]);
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      const [file, frag] = href.split('#');
      const targetPage = file || r.page.out;
      const ids = idsByPage.get(targetPage);
      let id;
      try { id = decodeURIComponent(frag); } catch { id = frag; }
      if (ids && id && !ids.has(id)) warn(`${r.page.src}: anchor "${href}" has no matching heading id in ${targetPage}`);
    }
  }

  // 4. assets
  cpSync(join(SITE_DIR, 'style.css'), join(OUT, 'assets', 'style.css'));
  cpSync(join(SITE_DIR, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'), join(OUT, 'assets', 'mermaid.min.js'));
  for (const asset of usedAssets) {
    mkdirSync(dirname(join(OUT, asset)), { recursive: true });
    cpSync(join(ROOT, asset), join(OUT, asset));
  }
  const copied = [];
  for (const t of COPY_TREES) {
    if (!existsSync(join(ROOT, t.src))) continue;
    cpSync(join(ROOT, t.src), join(OUT, t.out), { recursive: true });
    copied.push(`${t.src}/ -> ${t.out}/`);
  }
  writeFileSync(join(OUT, '.nojekyll'), '');

  console.log(`built ${rendered.length} page(s): ${rendered.map((r) => r.page.out).join(', ')}`);
  console.log(`mermaid blocks: ${mermaidBlocks} (lint passed); images copied: ${usedAssets.size}; trees: ${copied.length ? copied.join(', ') : 'none'}`);
  if (warnings.length) console.log(`${warnings.length} warning(s)`);
  console.log(`output: ${toPosix(relative(process.cwd(), OUT)) || '.'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
