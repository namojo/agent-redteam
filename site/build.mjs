#!/usr/bin/env node
// Static site build for GitHub Pages.
//   node site/build.mjs            -> writes _site/
// Build-only dependencies (marked, mermaid, fonts) live in site/package.json.
// Install them with: npm ci --prefix site
//
// Output:
//   index.html            landing (site/landing.html + site/content/landing.json, numbers from data/demo.json)
//   readme.html, manual.html, ...   docs pages (site/template.html), one per row of PAGES
//   console/              web/ copied verbatim; src/core/ next to it so the console imports the engine
//   data/demo.json        the engine run against the in-process mock (site/demo.mjs)
//   assets/               system.css (fonts + tokens + base), landing.css, docs.css, site.js, fonts/, mermaid.min.js
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDemo, lookupDemo } from './demo.mjs';

const SITE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SITE_DIR, '..');
const OUT = join(ROOT, '_site');
const NM = join(SITE_DIR, 'node_modules');
const REPO_URL = 'https://github.com/namojo/agent-redteam';
const BLOB = `${REPO_URL}/blob/main`;
const TREE = `${REPO_URL}/tree/main`;
const SITE_NAME = 'agent-redteam';

// The single mapping table: repo Markdown source -> docs page. Order = nav order.
// index.html is the landing page (not a Markdown page); README is published as readme.html.
export const PAGES = [
  { src: 'README.md', out: 'readme.html', nav: '개요', title: '개요' },
  { src: 'docs/MANUAL.md', out: 'manual.html', nav: '매뉴얼', title: '사용 매뉴얼' },
  { src: 'docs/ARCHITECTURE.md', out: 'architecture.html', nav: '아키텍처', title: '아키텍처' },
  { src: 'docs/OFFLINE-INSTALL.md', out: 'offline-install.html', nav: '폐쇄망 설치', title: '폐쇄망 설치' },
  { src: 'docs/EXAMPLE-REPORT.md', out: 'example-report.html', nav: '예시 리포트', title: '예시 리포트' },
];
export const LANDING = { content: 'site/content/landing.json', fixture: 'site/content/landing.fixture.json', out: 'index.html', nav: '소개' };

// Directories copied verbatim so the console can import the engine with relative paths.
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

const stripTags = (html) => decodeEntities(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

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
// Markdown -> HTML (docs pages)

const ALERTS = {
  NOTE: { title: '참고', tone: 'info' },
  TIP: { title: '팁', tone: 'success' },
  IMPORTANT: { title: '중요', tone: 'info' },
  WARNING: { title: '주의', tone: 'warn' },
  CAUTION: { title: '경고', tone: 'danger' },
};

function codeBlockHtml(text, lang) {
  const label = lang || 'text';
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  return `<div class="term"><div class="term-bar"><span>${escapeHtml(label)}</span></div><pre><code${cls}>${escapeHtml(text)}</code></pre></div>\n`;
}

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
          return `<figure class="diagram"><pre class="mermaid">${escapeHtml(text)}</pre></figure>\n`;
        }
        return codeBlockHtml(text, info);
      },
      blockquote({ tokens }) {
        const body = this.parser.parse(tokens);
        // GitHub alerts: > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
        const m = /^\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:<br>)?\s*/i.exec(body);
        if (m) {
          const a = ALERTS[m[1].toUpperCase()];
          let rest = '<p>' + body.slice(m[0].length);
          rest = rest.replace(/^<p>\s*<\/p>\s*/, '');
          return `<aside class="callout callout-${a.tone}" role="note"><p class="callout-title">${a.title}</p>\n${rest}</aside>\n`;
        }
        return `<blockquote>\n${body}</blockquote>\n`;
      },
    },
  });
  let html = md.parse(source);
  // Tables scroll inside their own container, never the page.
  html = html.replace(/<table>/g, '<div class="table-wrap" tabindex="0" role="region" aria-label="표"><table>').replace(/<\/table>/g, '</table></div>');
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
// Shared chrome: header, footer

const ARROW = '<svg class="arrow" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2.5 8h10M8.75 4.25 12.5 8l-3.75 3.75" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/></svg>';
const EXT_ARROW = '<svg class="arrow" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5 11 11 5M6 4.75h5.25V10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/></svg>';
const BRAND = `<a class="brand" href="index.html"><span class="brand-mark" aria-hidden="true"><i></i><i></i></span><span>${SITE_NAME}</span></a>`;

function siteLinks(current, consoleAvailable, builtPages) {
  const items = [{ href: LANDING.out, label: LANDING.nav }];
  for (const p of PAGES) if (builtPages.has(p.src)) items.push({ href: p.out, label: p.nav });
  if (consoleAvailable) items.push({ href: 'console/', label: '웹 콘솔' });
  items.push({ href: REPO_URL, label: 'GitHub', ext: true });
  return items.map((i) => {
    const cur = i.href === current ? ' aria-current="page"' : '';
    const rel = i.ext ? ' rel="noopener"' : '';
    return `<li><a href="${escapeHtml(i.href)}"${cur}${rel}>${escapeHtml(i.label)}</a></li>`;
  }).join('');
}

function docsHeader(current, consoleAvailable, builtPages) {
  return `  <header class="site-header">
    <div class="site-bar">
      ${BRAND}
      <nav class="site-nav" aria-label="사이트"><ul>${siteLinks(current, consoleAvailable, builtPages)}</ul></nav>
    </div>
  </header>`;
}

const COLOPHON = '<p>글꼴 Pretendard · JetBrains Mono — SIL Open Font License 1.1 (<a href="assets/fonts/pretendard/LICENSE.txt">Pretendard</a>, <a href="assets/fonts/jetbrains-mono/LICENSE.txt">JetBrains Mono</a>)</p>';

function footerHtml(version, extra = '') {
  return `  <footer class="site-footer">
    <div class="site-footer-inner">
      <p>${BRAND.replace('class="brand"', 'class="brand brand-small"')} <span class="mono">${escapeHtml(version)}</span> · MIT License</p>
      ${extra}
      ${COLOPHON}
      <p><a href="${REPO_URL}" rel="noopener">github.com/namojo/agent-redteam</a></p>
    </div>
  </footer>`;
}

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`template placeholder {{${key}}} has no value`);
    return values[key];
  });
}

// Mermaid themed from the same tokens (light/dark read from the live CSS variables).
const MERMAID_SCRIPT = `<script src="assets/mermaid.min.js"></script>
  <script>
    (function () {
      var cs = getComputedStyle(document.documentElement);
      var v = function (n) { return cs.getPropertyValue(n).trim(); };
      var dark = cs.getPropertyValue('color-scheme').indexOf('dark') >= 0;
      mermaid.initialize({
        startOnLoad: true, securityLevel: 'strict', theme: 'base',
        themeVariables: {
          darkMode: dark, fontFamily: v('--font-sans'), fontSize: '15px',
          background: v('--paper'), primaryColor: v('--surface'), primaryTextColor: v('--ink'), primaryBorderColor: v('--ink'),
          secondaryColor: v('--enamel'), secondaryTextColor: v('--ink'), secondaryBorderColor: v('--ink-2'),
          tertiaryColor: v('--paper-2'), tertiaryTextColor: v('--ink'), tertiaryBorderColor: v('--rule'),
          lineColor: v('--ink-2'), textColor: v('--ink'), mainBkg: v('--surface'), nodeBorder: v('--ink'),
          clusterBkg: v('--paper-2'), clusterBorder: v('--rule'), edgeLabelBackground: v('--paper'), titleColor: v('--ink'),
          actorBkg: v('--surface'), actorBorder: v('--ink'), actorTextColor: v('--ink'), actorLineColor: v('--ink-3'),
          signalColor: v('--ink-2'), signalTextColor: v('--ink'), labelBoxBkgColor: v('--enamel'), labelBoxBorderColor: v('--ink'),
          labelTextColor: v('--ink'), loopTextColor: v('--ink'), noteBkgColor: v('--amber-wash'), noteTextColor: v('--ink'), noteBorderColor: v('--amber'),
          activationBkgColor: v('--enamel'), activationBorderColor: v('--ink'), sequenceNumberColor: v('--paper')
        }
      });
    })();
  </script>`;

// ---------------------------------------------------------------------------
// Docs page pieces

function tocHtml(headings) {
  const items = headings.filter((h) => h.depth === 2 || h.depth === 3);
  if (items.filter((h) => h.depth === 2).length < 2) return '';
  let html = '';
  let open = false;
  for (const h of items) {
    const link = `<a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a>`;
    if (h.depth === 2) {
      if (open) html += '</ol></li>';
      else if (html) html += '</li>';
      html += `<li>${link}`;
      open = false;
    } else {
      if (!html) { html += '<li>'; }
      if (!open) { html += '<ol>'; open = true; }
      html += `<li>${link}</li>`;
    }
  }
  html += open ? '</ol></li>' : '</li>';
  return `    <aside class="doc-toc">
      <details class="toc" data-toc>
        <summary><span>이 문서의 목차</span></summary>
        <nav aria-label="이 문서의 목차"><ol>${html}</ol></nav>
      </details>
    </aside>`;
}

function pagerHtml(page, available) {
  const i = available.indexOf(page);
  const prev = available[i - 1];
  const next = available[i + 1];
  const cell = (p, dir) => p
    ? `<a class="pager-${dir}" href="${p.out}"><span class="pager-k">${dir === 'prev' ? '이전' : '다음'}</span><span class="pager-t">${escapeHtml(p.nav)}</span></a>`
    : '<span></span>';
  if (!prev && !next) return '';
  return `        <nav class="pager" aria-label="문서 이동">${cell(prev, 'prev')}${cell(next, 'next')}</nav>`;
}

// ---------------------------------------------------------------------------
// Landing page: site/content/landing.json (docs-writer) rendered with site/landing.html.
// Numbers are {{demo.<path>}} placeholders filled from demo.json; an unknown path fails the build.

const DEMO_RE = /\{\{\s*(demo(?:\.[A-Za-z0-9_]+)+)\s*\}\}/g;
const VERDICT_KO = { VULNERABLE: '취약', BLOCKED: '차단', INCONCLUSIVE: '미결', ERROR: '오류' };
const VERDICT_MARK = { VULNERABLE: '✗', BLOCKED: '✓', INCONCLUSIVE: '?', ERROR: '!' };

function createLandingRenderer({ Marked, demo, detail, builtPages, usedAssets, consoleAvailable }) {
  const errors = [];
  const rewrite = makeRewriter({ srcFile: 'README.md', builtPages, usedAssets });
  const known = new Set([LANDING.out, ...PAGES.filter((p) => builtPages.has(p.src)).map((p) => p.out), 'data/demo.json']);
  // the copy is "inline Markdown only": raw HTML is escaped (below) and links may only be
  // http(s)/mailto, site-relative or #anchors — javascript:, data:, vbscript: etc. fail the build.
  let where = 'landing';
  const SAFE_SCHEME = /^(?:https?|mailto):/i;
  const linkHref = (href, at = where) => {
    const probe = String(href ?? '').replace(/[\s\u0000-\u001f\u007f]/g, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(probe) && !SAFE_SCHEME.test(probe)) {
      errors.push(`${at}: link "${href}" uses a disallowed scheme (only http, https, mailto, relative paths and #anchors)`);
      return '#';
    }
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return href;
    const path = href.split('#')[0];
    if (known.has(path)) return href;
    if (path === 'console' || path === 'console/' || path.startsWith('console/')) {
      if (!consoleAvailable) warn(`landing: link "${href}" — web/ is missing, console is not built`);
      return path === 'console' ? 'console/' + href.slice(path.length) : href;
    }
    return rewrite(href, 'link');
  };
  const md = new Marked({ gfm: true });
  md.use({
    walkTokens(t) { if (t.type === 'link' || t.type === 'image') t.href = linkHref(t.href); },
    renderer: { html(t) { return escapeHtml(t.text ?? t.raw ?? ''); } },
  });

  const sub = (s, where) => String(s ?? '').replace(DEMO_RE, (all, path) => {
    const v = lookupDemo(demo, path);
    if (v === undefined) { errors.push(`${where}: unknown placeholder {{${path}}} (known keys: the demo.json object built in site/demo.mjs)`); return all; }
    return String(v);
  });
  const inline = (s, at) => { where = at; return md.parseInline(sub(s, at)); };
  const paras = (s, at) => (where = at, sub(s, at)).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${md.parseInline(p)}</p>`).join('');
  const need = (obj, key, where, type = 'string') => {
    const v = obj ? obj[key] : undefined;
    const ok = type === 'array' ? Array.isArray(v) : type === 'object' ? v && typeof v === 'object' && !Array.isArray(v) : typeof v === 'string' && v.trim() !== '';
    if (!ok) errors.push(`${where}.${key}: required ${type}`);
    return ok ? v : (type === 'array' ? [] : type === 'object' ? {} : '');
  };

  // signal-lamp helpers (page-only detail from the same engine run)
  const lampsFor = (cases, side) => cases.map((c) =>
    `<span class="lamp" data-v="${c[side]}" data-before="${c.before}" data-after="${c.after}" title="${escapeHtml(`${c.caseId} · ${VERDICT_KO[c[side]]}`)}"></span>`).join('');
  const byCat = (cat) => detail.cases.filter((c) => c.category === cat);
  const count = (list, side, v) => list.filter((c) => c[side] === v).length;

  function termLines(sideKey) {
    const r = detail[sideKey].report;
    const g = detail[sideKey].gate;
    const cmd = sideKey === 'before' ? 'node src/cli.mjs run --mock vulnerable' : 'node src/cli.mjs run --mock vulnerable --defend';
    const picks = [];
    for (const cat of detail.categories.map((c) => c.id)) {
      const c = r.cases.find((x) => x.category === cat);
      if (c && picks.length < 3) picks.push(c);
    }
    const row = (c) => `<span class="tl tl-case v-${c.verdict}"><span class="tl-v">${VERDICT_MARK[c.verdict]} ${VERDICT_KO[c.verdict]}</span><span class="tl-cat">${c.category}</span><span class="tl-id">${escapeHtml(c.caseId)}</span><span class="tl-t">${escapeHtml(c.title)}</span></span>`;
    const s = r.summary;
    const gateCls = g.pass ? 'v-BLOCKED' : 'v-VULNERABLE';
    return [
      `<span class="tl tl-cmd"><span class="tl-ps" aria-hidden="true">$</span> ${escapeHtml(cmd)}</span>`,
      ...picks.map(row),
      `<span class="tl tl-dim">  … ${r.cases.length - picks.length}건 더</span>`,
      `<span class="tl tl-dim">  케이스 ${s.cases} · 취약 ${s.vulnerable} · 차단 ${s.blocked} · 미결 ${s.inconclusive} · 오류 ${s.errors}</span>`,
      `<span class="tl tl-gate ${gateCls}"><span class="tl-v">${g.pass ? '✓ PASS' : '✗ FAIL'}</span> ${escapeHtml(g.summaryText)}</span>`,
      `<span class="tl tl-cmd"><span class="tl-ps" aria-hidden="true">$</span> echo $?</span>`,
      `<span class="tl tl-exit ${gateCls}">${g.pass ? 0 : 1}</span>`,
    ].join('\n');
  }

  function signalPanel(eyebrow) {
    const bg = detail.before.gate;
    const ag = detail.after.gate;
    const groups = detail.categories.map((cat) => {
      const list = byCat(cat.id);
      if (!list.length) return '';
      return `<div class="sp-grp">
            <span class="plate plate-id">${cat.id}</span>
            <span class="sp-grp-t">${escapeHtml(cat.title)}</span>
            <span class="sp-lamps">${lampsFor(list, 'before')}</span>
            <span class="sp-grp-n mono"><span data-show="before">취약 ${count(list, 'before', 'VULNERABLE')}/${list.length}</span><span data-show="after">취약 ${count(list, 'after', 'VULNERABLE')}/${list.length}</span></span>
          </div>`;
    }).join('\n          ');
    const n = detail.cases.length;
    const station = (label, extra = '') => `<li class="sp-st${extra}"><span class="sp-node" aria-hidden="true"></span><span class="sp-st-t">${label}</span></li>`;
    return `<figure class="sigpanel" data-state="before" data-gate-before="${bg.status}" data-gate-after="${ag.status}" aria-labelledby="sp-cap">
        <div class="sp-head">
          ${eyebrow ? `<span class="plate">${eyebrow}</span>` : ''}
          <span class="sp-target mono">mock://vulnerable · ${n} cases</span>
        </div>
        <div class="sp-board">
          <div class="sp-cases">
          ${groups}
          </div>
          <div class="sp-signal" aria-hidden="true">
            <span class="sp-head-housing"><span class="lamp sp-red"></span><span class="lamp sp-green"></span></span>
            <span class="sp-post"></span>
          </div>
        </div>
        <ol class="sp-route" aria-label="점검 경로">
          ${station('에이전트')}
          ${station(`공격 <span class="mono">${n}</span>`)}
          ${station('판정')}
          ${station('게이트', ' sp-st-gate')}
          ${station('배포', ' sp-st-deploy')}
        </ol>
        <div class="sp-readout" aria-live="polite">
          <span class="sp-aspect" data-show="before"><span class="lamp is-${bg.pass ? 'green' : 'red'}"></span><span class="mono">${bg.status}</span><span class="sp-exit mono">exit ${bg.pass ? 0 : 1}</span><span class="sr-only">방어 끄고 실행: 게이트 ${bg.status}</span></span>
          <span class="sp-aspect" data-show="after"><span class="lamp is-${ag.pass ? 'green' : 'red'}"></span><span class="mono">${ag.status}</span><span class="sp-exit mono">exit ${ag.pass ? 0 : 1}</span><span class="sr-only">방어 켜고 실행: 게이트 ${ag.status}</span></span>
          <div class="sp-switch" role="group" aria-label="방어 가드 프롬프트">
            <button type="button" data-set="before" aria-pressed="true">방어 OFF</button>
            <button type="button" data-set="after" aria-pressed="false">방어 ON <span class="mono">--defend</span></button>
          </div>
        </div>
        <div class="term sp-term">
          <div class="term-bar"><span>terminal · mock 실행 결과</span></div>
          <div class="sp-lines" data-show="before">${termLines('before')}</div>
          <div class="sp-lines" data-show="after">${termLines('after')}</div>
        </div>
        <figcaption id="sp-cap" class="sp-cap">사이트 빌드 때 엔진(<span class="mono">src/core</span> ${escapeHtml(detail.version)})이 내장 mock 에이전트를 실제로 실행한 결과입니다. 원자료: <a href="data/demo.json">data/demo.json</a></figcaption>
      </figure>`;
  }

  const TONE_RULES = [
    [/demo\.(?:vulnerable|defended)\.vulnerable$/, (v) => (Number(v) > 0 ? 'red' : 'green')],
    [/demo\.(?:vulnerable|defended)\.errors$/, (v) => (Number(v) > 0 ? 'red' : '')],
    [/demo\.(?:vulnerable|defended)\.inconclusive$/, (v) => (Number(v) > 0 ? 'amber' : '')],
    [/demo\.(?:vulnerable|defended)\.blocked$/, (v) => (Number(v) > 0 ? 'green' : '')],
    [/demo\.(?:vulnerable|defended)\.gate$/, (v) => (v === 'PASS' ? 'green' : 'red')],
    [/demo\.compare\.(?:blockedRate|fixed)$/, () => 'green'],
  ];
  const toneOf = (raw) => {
    const keys = [...String(raw).matchAll(DEMO_RE)].map((m) => m[1]);
    if (keys.length !== 1) return '';
    const v = lookupDemo(demo, keys[0]);
    for (const [re, fn] of TONE_RULES) if (re.test(keys[0])) return fn(v);
    return '';
  };

  const BLOCKS = {
    paragraph: (b, w) => `<div class="b b-prose prose">${paras(need(b, 'text', w), w)}</div>`,
    cards: (b, w) => {
      const items = need(b, 'items', w, 'array');
      return `<ul class="b b-cards" data-n="${items.length}">${items.map((it, i) => {
        const iw = `${w}.items[${i}]`;
        const tag = it.tag ? `<span class="plate plate-id">${inline(it.tag, iw)}</span>` : '';
        const ex = it.example ? `<figure class="b-example"><figcaption>예시 프롬프트</figcaption><code>${escapeHtml(sub(it.example, iw))}</code></figure>` : '';
        return `<li class="b-card">${tag}<h3>${inline(need(it, 'title', iw), iw)}</h3><div class="b-card-text">${paras(need(it, 'text', iw), iw)}</div>${ex}</li>`;
      }).join('')}</ul>`;
    },
    steps: (b, w) => {
      const items = need(b, 'items', w, 'array');
      return `<ol class="b b-steps" data-n="${items.length}">${items.map((it, i) => {
        const iw = `${w}.items[${i}]`;
        return `<li class="b-step"><span class="b-step-node" aria-hidden="true"><span class="mono">${i + 1}</span></span><h3>${inline(need(it, 'title', iw), iw)}</h3><div class="b-step-text">${paras(need(it, 'text', iw), iw)}</div></li>`;
      }).join('')}</ol>`;
    },
    compare: (b, w) => {
      const side = (key, label) => {
        const s = need(b, key, w, 'object');
        const sw = `${w}.${key}`;
        const g = detail[label].gate;
        return `<div class="cmp-side cmp-${label}">
            <div class="cmp-head"><h3>${inline(need(s, 'title', sw), sw)}</h3><span class="cmp-aspect"><span class="lamp is-${g.pass ? 'green' : 'red'}"></span><span class="mono">${g.status}</span></span></div>
            <div class="cmp-lamps" aria-hidden="true">${lampsFor(detail.cases, label)}</div>
            <div class="cmp-text">${paras(need(s, 'text', sw), sw)}</div>
          </div>`;
      };
      return `<div class="b b-compare">${side('before', 'before')}<div class="cmp-arrow" aria-hidden="true"><span class="mono">--defend</span>${ARROW}</div>${side('after', 'after')}</div>`;
    },
    stats: (b, w) => {
      const items = need(b, 'items', w, 'array');
      return `<dl class="b b-stats" data-n="${items.length}">${items.map((it, i) => {
        const iw = `${w}.items[${i}]`;
        const tone = toneOf(it.value);
        return `<div class="stat"${tone ? ` data-tone="${tone}"` : ''}><dt>${inline(need(it, 'label', iw), iw)}</dt><dd class="mono">${inline(String(it.value ?? need(it, 'value', iw)), iw)}</dd></div>`;
      }).join('')}</dl>`;
    },
    table: (b, w) => {
      const cols = need(b, 'columns', w, 'array');
      const rows = need(b, 'rows', w, 'array');
      const cap = b.caption ? `<caption>${inline(b.caption, w)}</caption>` : '';
      const label = b.caption ? escapeHtml(stripTags(inline(b.caption, w))) : '표';
      return `<div class="b table-wrap" tabindex="0" role="region" aria-label="${label}"><table>${cap}<thead><tr>${cols.map((c) => `<th scope="col">${inline(c, w)}</th>`).join('')}</tr></thead><tbody>${rows.map((r, i) => {
        if (!Array.isArray(r)) { errors.push(`${w}.rows[${i}]: must be an array`); return ''; }
        if (r.length !== cols.length) warn(`${w}.rows[${i}]: ${r.length} cells for ${cols.length} columns`);
        return `<tr>${r.map((c, j) => (j === 0 ? `<th scope="row">${inline(c, w)}</th>` : `<td>${inline(c, w)}</td>`)).join('')}</tr>`;
      }).join('')}</tbody></table></div>`;
    },
    list: (b, w) => `<ul class="b b-list">${need(b, 'items', w, 'array').map((it, i) => `<li>${inline(it, `${w}.items[${i}]`)}</li>`).join('')}</ul>`,
    callout: (b, w) => {
      const tone = ['info', 'warn', 'success'].includes(b.tone) ? b.tone : (errors.push(`${w}.tone: must be info|warn|success`), 'info');
      return `<aside class="b callout callout-${tone}" role="note">${b.title ? `<p class="callout-title">${inline(b.title, w)}</p>` : ''}${paras(need(b, 'text', w), w)}</aside>`;
    },
    code: (b, w) => `<div class="b">${codeBlockHtml(sub(need(b, 'code', w), w), b.lang || '')}</div>`,
    flow: (b, w) => {
      const items = need(b, 'items', w, 'array');
      return `<ol class="b b-flow" data-n="${items.length}">${items.map((it, i) => {
        const text = typeof it === 'string' ? it : (it && (it.title || it.label)) || '';
        const isGate = /게이트|gate/i.test(text);
        return `<li class="b-flow-st${isGate ? ' is-gate' : ''}"><span class="b-flow-node" aria-hidden="true">${isGate ? '<span class="lamp is-red"></span><span class="lamp is-green"></span>' : ''}</span><span class="b-flow-t">${inline(text, `${w}.items[${i}]`)}</span></li>`;
      }).join('')}</ol>`;
    },
    faq: (b, w) => `<div class="b b-faq">${need(b, 'items', w, 'array').map((it, i) => {
      const iw = `${w}.items[${i}]`;
      return `<details class="faq"><summary><span>${inline(need(it, 'q', iw), iw)}</span><span class="faq-x" aria-hidden="true"></span></summary><div class="faq-a">${paras(need(it, 'a', iw), iw)}</div></details>`;
    }).join('')}</div>`,
    links: (b, w) => `<ul class="b b-links">${need(b, 'items', w, 'array').map((it, i) => {
      const iw = `${w}.items[${i}]`;
      const href = linkHref(sub(need(it, 'href', iw), iw), iw);
      const ext = /^https?:/i.test(href);
      return `<li><a href="${escapeHtml(href)}"${ext ? ' rel="noopener"' : ''}><span>${inline(need(it, 'label', iw), iw)}</span>${ext ? EXT_ARROW : ARROW}</a></li>`;
    }).join('')}</ul>`,
  };

  function render(content, template, version) {
    const meta = need(content, 'meta', 'meta', 'object');
    const hero = need(content, 'hero', 'hero', 'object');
    const sections = need(content, 'sections', 'sections', 'array');
    const ids = new Set();

    const ctas = (Array.isArray(hero.ctas) ? hero.ctas : []).map((c, i) => {
      const cw = `hero.ctas[${i}]`;
      const kind = ['primary', 'secondary', 'ghost'].includes(c.kind) ? c.kind : 'secondary';
      const href = linkHref(sub(need(c, 'href', cw), cw), cw);
      const ext = /^https?:/i.test(href);
      return `<a class="btn btn-${kind === 'secondary' ? 'line' : kind}" href="${escapeHtml(href)}"${ext ? ' rel="noopener"' : ''}>${inline(need(c, 'label', cw), cw)}${kind === 'primary' ? ARROW : ''}</a>`;
    }).join('\n          ');
    const heroHtml = `    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-inner">
        <div class="hero-copy">
          <h1 id="hero-title">${inline(need(hero, 'title', 'hero'), 'hero.title')}</h1>
          ${hero.lead ? `<p class="hero-lead">${inline(hero.lead, 'hero.lead')}</p>` : ''}
          <div class="hero-ctas">
          ${ctas}
          </div>
          ${hero.note ? `<p class="hero-note">${inline(hero.note, 'hero.note')}</p>` : ''}
        </div>
        <div class="hero-panel">
      ${signalPanel(hero.eyebrow ? inline(hero.eyebrow, 'hero.eyebrow') : '')}
        </div>
      </div>
    </section>`;

    const secHtml = sections.map((s, si) => {
      const w = `sections[${si}]`;
      const id = need(s, 'id', w);
      if (!/^[a-z][a-z0-9-]*$/.test(id)) errors.push(`${w}.id: "${id}" must be lowercase letters, digits and -`);
      if (ids.has(id)) errors.push(`${w}.id: duplicate "${id}"`);
      ids.add(id);
      const blocks = (Array.isArray(s.blocks) ? s.blocks : []).map((b, bi) => {
        const bw = `${w}(${id}).blocks[${bi}]`;
        const fn = BLOCKS[b && b.type];
        if (!fn) { errors.push(`${bw}.type: unknown block type "${b && b.type}" (known: ${Object.keys(BLOCKS).join(', ')})`); return ''; }
        return fn(b, bw);
      }).join('\n        ');
      return `    <section id="${escapeHtml(id)}" class="sec" aria-labelledby="${escapeHtml(id)}-title">
      <div class="sec-inner">
        <header class="sec-head">
          <div class="sec-title">
            ${s.eyebrow ? `<span class="plate sec-plate">${inline(s.eyebrow, `${w}.eyebrow`)}</span>` : ''}
            <h2 id="${escapeHtml(id)}-title">${inline(need(s, 'title', w), `${w}.title`)}</h2>
          </div>
          ${s.lead ? `<p class="sec-lead">${inline(s.lead, `${w}.lead`)}</p>` : ''}
        </header>
        <div class="sec-body">
        ${blocks}
        </div>
      </div>
    </section>`;
    }).join('\n');

    const sectionNav = sections.filter((s) => s.nav && s.id)
      .map((s, i) => `<li><a href="#${escapeHtml(s.id)}" data-spy="${escapeHtml(s.id)}">${inline(s.nav, `sections[${i}].nav`)}</a></li>`).join('');
    const header = `  <header class="site-header site-header-landing">
    <div class="site-bar">
      ${BRAND}
      <nav class="section-nav" aria-label="이 페이지의 섹션"><ul>${sectionNav}</ul></nav>
      <nav class="site-nav site-nav-compact" aria-label="사이트"><ul>${[
        ...PAGES.filter((p) => builtPages.has(p.src)).slice(0, 1).map((p) => `<li><a href="${p.out}">문서</a></li>`),
        consoleAvailable ? '<li><a href="console/" class="nav-cta">웹 콘솔</a></li>' : '',
        `<li><a href="${REPO_URL}" rel="noopener">GitHub</a></li>`,
      ].join('')}</ul></nav>
    </div>
  </header>`;

    const html = fill(template, {
      title: escapeHtml(stripTags(sub(need(meta, 'title', 'meta'), 'meta.title'))),
      description: escapeHtml(stripTags(sub(meta.description || '', 'meta.description'))),
      header,
      hero: heroHtml,
      sections: secHtml,
      footer: footerHtml(version, '<p>이 페이지의 숫자는 빌드 때 엔진을 mock 대상으로 실행해 만든 <a href="data/demo.json">data/demo.json</a>에서 옵니다.</p>'),
    });
    return html;
  }

  return { render, errors };
}

// ---------------------------------------------------------------------------
// Published output carries no authoring comments: HTML comments are dropped, CSS keeps only
// /*! license */ comments, the client script keeps none. Source files keep theirs.

export const stripHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->\s*/g, '');
export const stripCssComments = (css) => css.replace(/\/\*(?!!)[\s\S]*?\*\//g, '').replace(/\n{3,}/g, '\n\n');
export const stripJsComments = (js) => js
  .replace(/^\s*\/\*[\s\S]*?\*\/[ \t]*\r?\n/gm, '')
  .replace(/^[ \t]*\/\/.*\r?\n/gm, '')
  .replace(/[ \t]+\/\/ [^'"\n]*$/gm, '');

// ---------------------------------------------------------------------------
// Fonts: self-hosted woff2 (no CDN), copied from site/node_modules at build time.

function buildFonts() {
  const out = join(OUT, 'assets', 'fonts');
  // Pretendard Variable, dynamic subsets (unicode-range): browsers fetch only the slices a page uses.
  const pDir = join(NM, 'pretendard', 'dist', 'web', 'variable');
  const pCss = readFileSync(join(pDir, 'pretendardvariable-dynamic-subset.css'), 'utf8')
    .replace(/url\(\.\/woff2-dynamic-subset\//g, 'url(fonts/pretendard/');
  mkdirSync(join(out, 'pretendard'), { recursive: true });
  let files = 0;
  for (const f of readdirSync(join(pDir, 'woff2-dynamic-subset'))) {
    if (!f.endsWith('.woff2')) continue;
    cpSync(join(pDir, 'woff2-dynamic-subset', f), join(out, 'pretendard', f));
    files += 1;
  }
  // JetBrains Mono Variable: latin + latin-ext, upright only (code, IDs, numbers).
  const jDir = join(NM, '@fontsource-variable', 'jetbrains-mono');
  const jCssAll = readFileSync(join(jDir, 'wght.css'), 'utf8');
  const keep = ['latin-ext', 'latin'];
  const jBlocks = [...jCssAll.matchAll(/\/\* jetbrains-mono-([a-z-]+)-wght-normal \*\/\s*@font-face\s*\{[^}]*\}/g)]
    .filter((m) => keep.includes(m[1])).map((m) => m[0].replace(/url\(\.\/files\//g, 'url(fonts/jetbrains-mono/'));
  mkdirSync(join(out, 'jetbrains-mono'), { recursive: true });
  for (const k of keep) {
    cpSync(join(jDir, 'files', `jetbrains-mono-${k}-wght-normal.woff2`), join(out, 'jetbrains-mono', `jetbrains-mono-${k}-wght-normal.woff2`));
    files += 1;
  }
  // SIL OFL 1.1 requires the license to travel with redistributed font files
  cpSync(join(jDir, 'LICENSE'), join(out, 'jetbrains-mono', 'LICENSE.txt'));
  cpSync(join(NM, 'pretendard', 'dist', 'LICENSE.txt'), join(out, 'pretendard', 'LICENSE.txt'));
  const css = `/*! Pretendard Variable — SIL OFL 1.1 — assets/fonts/pretendard/LICENSE.txt */\n${pCss.replace(/^\/\*[\s\S]*?\*\/\s*/, '')}\n/*! JetBrains Mono — SIL OFL 1.1 — assets/fonts/jetbrains-mono/LICENSE.txt */\n${jBlocks.join('\n')}\n`;
  return { css, files };
}

// ---------------------------------------------------------------------------

async function main() {
  let Marked;
  try {
    ({ Marked } = await import('marked'));
    for (const p of [['mermaid', 'dist', 'mermaid.min.js'], ['pretendard', 'dist', 'web', 'variable', 'pretendardvariable-dynamic-subset.css'], ['@fontsource-variable', 'jetbrains-mono', 'wght.css']]) {
      if (!existsSync(join(NM, ...p))) throw new Error(`${p[0]} missing`);
    }
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
  const fail = (problems) => {
    for (const p of problems) console.error(`error: ${p}`);
    console.error(`site build failed: ${problems.length} problem(s)`);
    process.exit(1);
  };
  if (lint.length) fail(lint);

  // 2. engine run against the in-process mock -> demo.json + landing detail
  let demo;
  try {
    demo = await buildDemo(ROOT);
  } catch (err) {
    fail([`demo run against the mock failed: ${err && err.stack ? err.stack : err}`]);
  }

  // 3. landing content (docs-writer's landing.json, or the layout fixture)
  // The fixture is for local layout work only and needs an explicit --fixture flag; a missing
  // landing.json must never put the fixture on Pages.
  let landingFile = LANDING.content;
  if (process.argv.includes('--fixture')) {
    warn(`--fixture: building the landing page from ${LANDING.fixture} (layout fixture, not real copy - do not deploy)`);
    landingFile = LANDING.fixture;
  } else if (!existsSync(join(ROOT, landingFile))) {
    fail([`${LANDING.content} not found - the landing page has no copy. For local layout work only: node site/build.mjs --fixture`]);
  }
  let landingContent;
  try {
    landingContent = JSON.parse(readFileSync(join(ROOT, landingFile), 'utf8'));
  } catch (err) {
    fail([`${landingFile}: ${err.message}`]);
  }
  const usedAssets = new Set();
  const landing = createLandingRenderer({ Marked, demo: demo.data, detail: demo.detail, builtPages, usedAssets, consoleAvailable });
  const landingHtml = landing.render(landingContent, readFileSync(join(SITE_DIR, 'landing.html'), 'utf8'), demo.detail.version);
  if (landing.errors.length) fail(landing.errors.map((e) => `${landingFile}: ${e}`));

  // 4. fresh output dir
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'assets'), { recursive: true });
  mkdirSync(join(OUT, 'data'), { recursive: true });

  writeFileSync(join(OUT, LANDING.out), stripHtmlComments(landingHtml));
  writeFileSync(join(OUT, 'data', 'demo.json'), JSON.stringify(demo.data, null, 2) + '\n');
  const rendered = [{ page: { src: landingFile, out: LANDING.out }, html: landingHtml }];

  const template = readFileSync(join(SITE_DIR, 'template.html'), 'utf8');
  let mermaidBlocks = 0;
  for (const page of available) {
    const source = sources.get(page.src);
    const { html, headings, hasMermaid } = renderMarkdown(Marked, source, { srcFile: page.src, builtPages, usedAssets });
    mermaidBlocks += findMermaidBlocks(source).length;
    const h1 = headings.find((h) => h.depth === 1);
    const docTitle = h1 ? h1.text.replace(/^[^\p{L}\p{N}]+/u, '') : page.title;
    const title = page.out === 'readme.html' ? `${page.title} · ${SITE_NAME}` : `${docTitle} · ${SITE_NAME}`;
    const firstP = /<p>([\s\S]*?)<\/p>/.exec(html);
    const description = firstP ? stripTags(firstP[1]).slice(0, 160) : `${SITE_NAME} ${page.title}`;
    const out = fill(template, {
      title: escapeHtml(title),
      description: escapeHtml(description),
      header: docsHeader(page.out, consoleAvailable, builtPages),
      toc: tocHtml(headings),
      content: html,
      pager: pagerHtml(page, available),
      source: `${BLOB}/${page.src}`,
      sourceName: escapeHtml(page.src),
      footer: footerHtml(demo.detail.version),
      mermaid: hasMermaid ? MERMAID_SCRIPT : '',
    });
    if (/\{\{\s*demo\./.test(source)) warn(`${page.src}: contains {{demo.*}} — placeholders are only filled on the landing page`);
    writeFileSync(join(OUT, page.out), stripHtmlComments(out));
    rendered.push({ page, html: out });
  }

  // 5. anchor check (warning only): #id and page.html#id must exist
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

  // 6. assets: one system.css (fonts + tokens + base), page CSS, client JS, Mermaid, fonts
  const fonts = buildFonts();
  const system = [
    `/* agent-redteam design system — generated by site/build.mjs from site/styles/{tokens,base}.css. Do not edit. */`,
    fonts.css,
    readFileSync(join(SITE_DIR, 'styles', 'tokens.css'), 'utf8'),
    readFileSync(join(SITE_DIR, 'styles', 'base.css'), 'utf8'),
  ].join('\n');
  writeFileSync(join(OUT, 'assets', 'system.css'), stripCssComments(system));
  for (const name of ['landing.css', 'docs.css']) writeFileSync(join(OUT, 'assets', name), stripCssComments(readFileSync(join(SITE_DIR, 'styles', name), 'utf8')));
  writeFileSync(join(OUT, 'assets', 'site.js'), stripJsComments(readFileSync(join(SITE_DIR, 'client', 'site.js'), 'utf8')));
  cpSync(join(NM, 'mermaid', 'dist', 'mermaid.min.js'), join(OUT, 'assets', 'mermaid.min.js'));
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
  // console page and stylesheet follow the same rule (engine modules are copied as-is)
  if (consoleAvailable) {
    for (const file of listFiles(join(OUT, 'console'))) {
      if (file.endsWith('.css')) writeFileSync(file, stripCssComments(readFileSync(file, 'utf8')));
      if (file.endsWith('.html')) writeFileSync(file, stripHtmlComments(readFileSync(file, 'utf8')));
    }
  }
  writeFileSync(join(OUT, '.nojekyll'), '');

  console.log(`built ${rendered.length} page(s): ${rendered.map((r) => r.page.out).join(', ')}`);
  console.log(`landing: ${landingFile}; demo: vulnerable ${demo.data.vulnerable.gate} ${demo.data.vulnerable.vulnerable}/${demo.data.vulnerable.cases}, defended ${demo.data.defended.gate}, block rate ${demo.data.compare.blockedRate}`);
  console.log(`mermaid blocks: ${mermaidBlocks} (lint passed); images copied: ${usedAssets.size}; font files: ${fonts.files}; trees: ${copied.length ? copied.join(', ') : 'none'}`);
  if (warnings.length) console.log(`${warnings.length} warning(s)`);
  console.log(`output: ${toPosix(relative(process.cwd(), OUT)) || '.'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
