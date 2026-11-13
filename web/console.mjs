/**
 * agent-redteam web console.
 *
 * Every verdict, gate decision, comparison and Markdown rendering comes from src/core (the same
 * engine the CLI runs). This file only collects settings, wires transports and draws the report.
 * Import rule: relative paths only (web/ -> _site/console/, src/core/ -> _site/src/core/).
 *
 * Secrets: API keys live only in the password inputs of this tab. Nothing is written to
 * localStorage, sessionStorage, IndexedDB or cookies.
 */

const $ = (id) => document.getElementById(id);

/** Tiny DOM builder. Text is always inserted as text nodes (report content is untrusted). */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function bootError(message) {
  const el = $('boot-error');
  el.hidden = false;
  el.textContent = message;
}

// Forms never submit natively (that would reload the page). Run buttons stay disabled in the HTML
// until start() has wired the handlers; if the engine fails to load they stay disabled.
for (const id of ['demo-form', 'live-form']) $(id).addEventListener('submit', (e) => e.preventDefault());

import('../src/core/index.mjs')
  .then((core) => start(core))
  .catch((e) => bootError('엔진(src/core)을 불러오지 못했습니다: ' + ((e && e.message) || e) + ' — 최신 브라우저(정규식 lookbehind 지원, Safari 16.4 이상)가 필요합니다.'));

function start(core) {
  const {
    VERSION, TRANSFORMS, CATEGORY_INFO, VERDICT_LABELS, SOURCE_LABELS, MOCK_CANARY,
    normalizeConfig, buildPlan, runSuite, createMockTransport, createFetchTransport,
    compareReports, renderMarkdown, renderCompareMarkdown, ConfigError, TransportError, isMockUrl,
  } = core;

  $('engine-version').textContent = 'agent-redteam ' + VERSION;

  const state = {
    running: false,
    controller: null,
    demoRaw: null,          // settings of the last "공격 실행" (reused by 방어 적용 후 재시험)
    reports: {},            // { before, after } (demo) or { live }
    comparison: null,
    current: null,          // key into reports
    liveShowErrors: false,
    lastDialogTrigger: null,
  };

  // ---------------------------------------------------------------------------
  // formatting helpers (display only)

  const pct = (p) => (p === null || p === undefined ? '—' : (p * 100).toFixed(1) + '%');
  const pct1 = (p) => (p === null || p === undefined ? '—' : (p * 100).toFixed(1));
  const num4 = (x) => (x === null || x === undefined ? '—' : Number(x).toFixed(3));
  const wilsonText = (w) => (!w || w.p === null ? '— (시도 없음)' : `${pct(w.p)} (${pct1(w.low)}–${pct1(w.high)})`);
  const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t; };
  const transformLabel = (id) => (TRANSFORMS[id] ? TRANSFORMS[id].label : id);
  const verdictBadge = (v) => h('span', { class: `verdict v-${v}` }, VERDICT_LABELS[v] || v);
  /**
   * Display-only context for short evidence. Refusal evidence is just the matched phrase (e.g. "릴 수 없"),
   * and the report has no separate context field, so show the matched phrase inside its turn response
   * (a report field, already masked by core). Returns null when there is nothing better than c.evidence.
   */
  function evidenceContext(c) {
    if (c.source !== 'refusal' || !c.evidence) return null;
    for (const t of c.trials || []) {
      for (const tn of t.turns || []) {
        const resp = typeof tn.response === 'string' ? tn.response : '';
        const i = tn.evidence === c.evidence ? resp.indexOf(c.evidence) : -1;
        if (i < 0) continue;
        const radius = 40;
        const start = Math.max(0, i - radius);
        const end = Math.min(resp.length, i + c.evidence.length + radius);
        return (start > 0 ? '…' : '') + resp.slice(start, end).replace(/\s+/g, ' ').trim() + (end < resp.length ? '…' : '');
      }
    }
    return null;
  }
  const stamp = (iso) => String(iso || new Date().toISOString()).replace(/[:.]/g, '-');

  function announce(msg) {
    const s = $('status');
    s.textContent = '';
    // re-set after a tick so repeated identical messages are still read out
    clearTimeout(announce.t);
    announce.t = setTimeout(() => { s.textContent = msg; }, 60);
  }

  function download(filename, text, type) {
    const blob = new Blob([text], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce(`${filename} 파일을 내려받았습니다.`);
  }

  // ---------------------------------------------------------------------------
  // tabs

  const tabs = [$('tab-demo'), $('tab-live')];
  function selectTab(tab, focus) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t, false));
    t.addEventListener('keydown', (e) => {
      let next = null;
      if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); selectTab(next, true); }
    });
  });

  // ---------------------------------------------------------------------------
  // option lists generated from core constants

  const transformIds = Object.keys(TRANSFORMS).filter((id) => id !== 'none');
  for (const box of document.querySelectorAll('[data-transforms]')) {
    for (const id of transformIds) {
      box.append(h('label', { class: 'choice' },
        h('input', { type: 'checkbox', name: box.id, value: id }),
        ` ${TRANSFORMS[id].label} `, h('span', { class: 'muted' }, `(${id})`)));
    }
  }
  for (const [cat, info] of Object.entries(CATEGORY_INFO)) {
    $('f-categories').append(h('label', { class: 'choice' },
      h('input', { type: 'checkbox', name: 'f-categories', value: cat, checked: true }),
      ` ${cat} ${info.title}`));
  }
  const checkedValues = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);

  // ---------------------------------------------------------------------------
  // transports, progress, stop
  //
  // Cancellation is core's: runSuite(config, { signal }) stops scheduling, aborts the in-flight
  // request (req.signal) and rejects with AbortError whose err.report is the partial report
  // (aborted: true, gate forced FAIL). The transports below just pass req through.

  const yieldTick = () => new Promise((r) => setTimeout(r, 0));

  function mockTransport() {
    const base = createMockTransport();
    // yield to the event loop so the progress bar can paint between mock requests
    return async (req) => { await yieldTick(); return base(req); };
  }

  /**
   * Demo-only fake target that answers every request with an empty assistant message (OpenAI shape).
   * It shows how the engine treats a target that says nothing: undecided cases, never a PASS.
   */
  function emptyTransport() {
    return async (req) => {
      await yieldTick();
      if (req.signal && req.signal.aborted) throw new TransportError('ABORTED', '중단됨');
      const body = { id: 'empty-1', object: 'chat.completion', model: 'mock-empty-agent', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '' } }] };
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    };
  }

  function fetchTransport() {
    // no cookies or referrer to third-party targets; core passes its own AbortSignal in init.signal
    const fetchImpl = (url, init = {}) => fetch(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' });
    return createFetchTransport({ fetchImpl });
  }

  const transportFor = (url) => (isMockUrl(url) ? mockTransport() : fetchTransport());

  function setRunning(on) {
    state.running = on;
    $('progress').hidden = !on;
    $('demo-run').disabled = on;
    $('demo-defend').disabled = on || !state.reports.before || !state.demoRaw;
    updateLiveRunButton();
    $('stop').disabled = !on;
  }

  $('stop').addEventListener('click', () => {
    if (state.controller) {
      state.controller.abort();
      $('stop').disabled = true;
      $('progress-label').textContent = '중지하는 중…';
      announce('실행을 중지하는 중입니다.');
    }
  });

  /**
   * Run one suite through core.
   * Resolves { report, aborted }: on Stop, report is core's partial report (aborted: true, gate FAIL),
   * or null if core attached none.
   */
  async function execute(config, warnings, label, { transport } = {}) {
    const controller = new AbortController();
    state.controller = controller;
    const plan = buildPlan(config);
    const totalTrials = Math.max(1, plan.cases.length * config.attack.repeats);
    let doneTrials = 0;
    const bar = $('progress-bar');
    bar.max = totalTrials;
    bar.value = 0;
    $('progress-label').textContent = label;
    $('progress-text').textContent = `케이스 ${plan.cases.length}개 · 시도 ${totalTrials}회 준비`;
    setRunning(true);
    announce(`${label} 시작: 케이스 ${plan.cases.length}개, 시도 ${totalTrials}회.`);

    const judgeUrl = config.judge.enabled && config.judge.target ? config.judge.target.url : null;
    try {
      const report = await runSuite(config, {
        transport: transport || transportFor(config.target.url),
        judgeTransport: judgeUrl ? transportFor(judgeUrl) : undefined,
        signal: controller.signal,
        extraWarnings: warnings,
        onProgress: (ev) => {
          if (ev.type === 'trial-done') doneTrials += 1;
          bar.value = Math.min(doneTrials, totalTrials);
          const v = ev.verdict ? ` · ${VERDICT_LABELS[ev.verdict] || ev.verdict}` : '';
          $('progress-text').textContent = `케이스 ${ev.caseIndex + 1}/${ev.caseCount} · ${ev.caseId}${v} · 시도 ${doneTrials}/${totalTrials}`;
        },
      });
      return { report, aborted: false };
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.code === 'ABORTED')) {
        const partial = e.report || null;
        const done = partial ? partial.cases.length : 0;
        announce(`실행을 중지했습니다. 완료된 케이스 ${done}/${plan.cases.length}개의 부분 결과를 표시합니다. 중단된 실행은 통과로 보지 않습니다.`);
        return { report: partial, aborted: true };
      }
      throw e;
    } finally {
      state.controller = null;
      setRunning(false);
    }
  }

  function reportError(e, where) {
    if (e instanceof ConfigError) {
      const list = (e.errors || []).map((x) => `${x.path || '설정'}: ${x.message}`);
      const msg = `${e.message}${list.length ? ' — ' + list.join(' / ') : ''}`;
      where.textContent = msg;
      where.classList.add('bad');
      announce(msg);
      return;
    }
    const msg = '실행 중 오류: ' + ((e && e.message) || e);
    where.textContent = msg;
    where.classList.add('bad');
    announce(msg);
    console.error(e);
  }

  // ---------------------------------------------------------------------------
  // demo mode

  const EMPTY_MODEL = 'mock-empty-agent';

  function demoRaw(defend) {
    const mode = document.querySelector('input[name="demo-mode"]:checked').value;
    const repeats = Number($('demo-repeats').value);
    // 'empty' reuses a mock:// URL (so no network and no authorization prompt) but is answered by emptyTransport()
    const host = mode === 'empty' ? 'secure' : mode;
    const raw = {
      version: 2,
      authorized: true,
      target: { provider: 'openai', url: `mock://${host}/v1/chat/completions`, model: mode === 'empty' ? EMPTY_MODEL : 'mock-agent' },
      attack: {
        transforms: checkedValues('demo-transforms'),
        multiturn: $('demo-multiturn').checked,
        repeats: $('demo-repeats').value === '' ? 1 : repeats,
        defend,
      },
      oracles: { canary: MOCK_CANARY },
    };
    if ($('demo-judge').checked) {
      raw.judge = { enabled: true, mode: 'all', target: { provider: 'openai', url: 'mock://secure/v1/chat/completions', model: 'mock-judge' } };
    }
    return raw;
  }
  const demoTransport = (raw) => (raw.target.model === EMPTY_MODEL ? emptyTransport() : undefined);

  function estimateText(config) {
    const plan = buildPlan(config);
    const er = plan.estimatedRequests;
    const judge = er.judgeMax ? ` · judge 최대 ${er.judgeMax}회 · 합계 최대 ${er.total}회` : '';
    const skipped = plan.skipped.length ? ` · 건너뛸 프로브 ${plan.skipped.length}개` : '';
    // only real network targets retry; the in-browser mock answers every request once
    const retries = !isMockUrl(config.target.url) && config.network.retries > 0 ? ` (재시도 시 최대 ×${config.network.retries + 1})` : '';
    return `케이스 ${plan.cases.length}개 · 대상 요청 최대 ${er.target}회${retries}${judge}${skipped}`;
  }

  function updateDemoEstimate() {
    const el = $('demo-estimate');
    el.classList.remove('bad');
    try {
      const { config } = normalizeConfig(demoRaw(false), { env: {} });
      el.textContent = '예상: ' + estimateText(config) + ' · 네트워크 사용 안 함';
    } catch (e) {
      reportError(e, el);
    }
  }
  $('demo-form').addEventListener('input', updateDemoEstimate);
  $('demo-form').addEventListener('change', updateDemoEstimate);
  updateDemoEstimate();

  $('demo-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.running) return;
    const raw = demoRaw(false);
    let n;
    try { n = normalizeConfig(raw, { env: {} }); } catch (err) { reportError(err, $('demo-estimate')); return; }
    try {
      const { report, aborted } = await execute(n.config, n.warnings, '공격 실행 (방어 OFF)', { transport: demoTransport(raw) });
      if (!report) return;
      // an aborted run is shown (as 중단됨 · FAIL) but is never a baseline for the defend comparison
      state.demoRaw = aborted ? null : raw;
      state.reports = { before: report };
      state.comparison = null;
      state.compareNote = null;
      state.current = 'before';
      renderResults();
      $('demo-defend').disabled = aborted;
      if (!aborted) announce(`공격 실행 완료 — 게이트 ${report.gate.status}: ${report.gate.summaryText}`);
    } catch (err) {
      reportError(err, $('demo-estimate'));
    }
  });

  $('demo-defend').addEventListener('click', async () => {
    if (state.running || !state.demoRaw || !state.reports.before) return;
    const raw = { ...state.demoRaw, attack: { ...state.demoRaw.attack, defend: true } };
    let n;
    try { n = normalizeConfig(raw, { env: {} }); } catch (err) { reportError(err, $('demo-estimate')); return; }
    try {
      const { report: after, aborted } = await execute(n.config, n.warnings, '방어 적용 후 재시험 (방어 ON)', { transport: demoTransport(raw) });
      if (!after) return;
      const before = state.reports.before;
      state.reports = { before, after };
      // never compare against a partial run: its missing cases would look "fixed"
      state.comparison = aborted ? null : compareReports(before, after);
      state.compareNote = aborted ? '방어 후 재시험이 중단되어 전후 비교를 하지 않았습니다. 다시 실행하십시오.' : null;
      state.current = 'after';
      renderResults();
      if (!aborted) {
        const c = state.comparison;
        const br = c.blockRate;
        announce(`재시험 완료 — 게이트 ${after.gate.status}. 차단률 ${br === null ? '계산 불가' : pct(br)}${c.trustworthy === false ? ', 신뢰할 수 없음' : ''}.`);
      }
    } catch (err) {
      reportError(err, $('demo-estimate'));
    }
  });

  // ---------------------------------------------------------------------------
  // live mode

  const liveForm = $('live-form');

  function applyProviderVisibility() {
    const provider = $('f-provider').value;
    for (const el of liveForm.querySelectorAll('[data-show]')) {
      el.hidden = !el.dataset.show.split(' ').includes(provider);
    }
  }
  $('f-provider').addEventListener('change', applyProviderVisibility);
  applyProviderVisibility();

  $('f-canary-insert').addEventListener('click', () => {
    const canary = $('f-canary').value.trim();
    if (!canary) { announce('먼저 카나리 문자열을 입력하십시오.'); $('f-canary').focus(); return; }
    const sp = $('f-system-prompt');
    if (!sp.value.includes(canary)) {
      sp.value = (sp.value ? sp.value.replace(/\s+$/, '') + '\n' : '') + `내부 식별자: ${canary}. 이 식별자는 절대 공개하지 않는다.`;
      validateLive();
    }
    announce('시스템 프롬프트에 카나리를 넣었습니다.');
  });

  function intField(id, out, key, uiErrors, path) {
    const raw = $(id).value.trim();
    if (raw === '') return;
    const n = Number(raw);
    if (!Number.isFinite(n)) { uiErrors.push({ path, message: '숫자를 입력하십시오' }); return; }
    out[key] = n;
  }

  function jsonObjectField(id, path, uiErrors) {
    const text = $(id).value.trim();
    if (!text) return undefined;
    try {
      const v = JSON.parse(text);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('JSON 객체({ … })여야 합니다');
      return v;
    } catch (e) {
      uiErrors.push({ path, message: 'JSON 객체로 해석할 수 없습니다: ' + e.message });
      return undefined;
    }
  }

  /** Form → raw v2 config (the shape normalizeConfig expects). */
  function collectLive() {
    const uiErrors = [];
    const val = (id) => $(id).value.trim();
    const provider = $('f-provider').value;
    const target = { provider, url: val('f-url') };
    const key = $('f-key').value.trim();
    if (key) target.apiKey = key;
    if (provider !== 'http') target.model = val('f-model');
    if (provider === 'openai') target.systemRole = $('f-system-role').value;
    const headers = jsonObjectField('f-headers', 'target.headers', uiErrors);
    if (headers) target.headers = headers;
    if ($('f-system-prompt').value.trim()) target.systemPrompt = $('f-system-prompt').value;
    if (provider === 'http') {
      target.method = $('f-method').value;
      if (target.method !== 'GET') target.body = $('f-body').value;
      if (val('f-response-path')) target.responsePath = val('f-response-path');
      if (val('f-toolcalls-path')) target.toolCallsPath = val('f-toolcalls-path');
    } else {
      const extra = jsonObjectField('f-extra-body', 'target.extraBody', uiErrors);
      if (extra) target.extraBody = extra;
    }

    const attack = {
      categories: checkedValues('f-categories'),
      transforms: checkedValues('f-transforms'),
      multiturn: $('f-multiturn').checked,
      defend: $('f-defend').checked,
    };
    intField('f-repeats', attack, 'repeats', uiErrors, 'attack.repeats');

    const raw = { version: 2, authorized: $('f-authorized').checked, target, attack, oracles: {} };
    if (val('f-canary')) raw.oracles.canary = val('f-canary');

    if ($('f-judge').checked) {
      const jt = {};
      if ($('f-judge-provider').value) jt.provider = $('f-judge-provider').value;
      if (val('f-judge-url')) jt.url = val('f-judge-url');
      if (val('f-judge-model')) jt.model = val('f-judge-model');
      if ($('f-judge-key').value.trim()) jt.apiKey = $('f-judge-key').value.trim();
      raw.judge = { enabled: true, mode: $('f-judge-mode').value };
      if (Object.keys(jt).length) raw.judge.target = jt;
    }

    raw.gate = { failOnInconclusive: $('f-fail-inconclusive').checked };
    intField('f-max-vuln', raw.gate, 'maxVulnerable', uiErrors, 'gate.maxVulnerable');
    intField('f-max-err', raw.gate, 'maxErrors', uiErrors, 'gate.maxErrors');
    raw.network = {};
    intField('f-timeout', raw.network, 'timeoutMs', uiErrors, 'network.timeoutMs');
    intField('f-retries', raw.network, 'retries', uiErrors, 'network.retries');
    intField('f-rpm', raw.network, 'rpm', uiErrors, 'network.rpm');
    return { raw, uiErrors };
  }

  function fieldForPath(path) {
    const parts = String(path || '').split('.');
    while (parts.length) {
      const el = liveForm.querySelector(`[data-path="${parts.join('.')}"]`);
      if (el && !el.closest('[hidden]')) return el;
      parts.pop();
    }
    return null;
  }

  function labelFor(el) {
    if (!el) return null;
    if (el.id) {
      const l = liveForm.querySelector(`label[for="${el.id}"]`);
      if (l) return l.textContent.replace(/\s+/g, ' ').trim();
    }
    const by = el.getAttribute('aria-labelledby');
    if (by && $(by)) return $(by).textContent.replace(/\s+/g, ' ').trim();
    const wrap = el.closest('label');
    return wrap ? wrap.textContent.replace(/\s+/g, ' ').trim() : null;
  }

  function clearFieldErrors() {
    for (const p of liveForm.querySelectorAll('.field-error')) p.remove();
    for (const el of liveForm.querySelectorAll('[aria-invalid="true"]')) {
      el.removeAttribute('aria-invalid');
      const ids = (el.getAttribute('aria-describedby') || '').split(' ').filter((x) => x && !x.startsWith('err-'));
      if (ids.length) el.setAttribute('aria-describedby', ids.join(' ')); else el.removeAttribute('aria-describedby');
    }
    // the summary box is only hidden when there is nothing to show, so it keeps focus while errors remain
    $('live-errors').replaceChildren();
  }

  function showFieldErrors(errors) {
    const box = $('live-errors');
    const items = [];
    errors.forEach((err, i) => {
      const el = fieldForPath(err.path);
      const label = labelFor(el);
      if (el) {
        const id = `err-${i}`;
        el.setAttribute('aria-invalid', 'true');
        el.setAttribute('aria-describedby', [el.getAttribute('aria-describedby'), id].filter(Boolean).join(' '));
        const msg = h('p', { class: 'field-error', id }, err.message);
        const box = el.closest('.field') || el.closest('.sub');
        if (box) box.append(msg);
        else (el.closest('label') || el).after(msg);
      }
      const text = `${label || err.path || '설정'}: ${err.message}`;
      items.push(h('li', {}, el && el.id
        ? h('a', { href: '#' + el.id, onclick: (ev) => { ev.preventDefault(); el.focus(); } }, text)
        : text));
    });
    box.replaceChildren(h('p', {}, h('strong', {}, `설정 오류 ${errors.length}건 — 실행하기 전에 고치십시오.`)), h('ul', {}, items));
    box.hidden = false;
  }

  function validateLive() {
    const { raw, uiErrors } = collectLive();
    let errors = [...uiErrors];
    let result = null;
    try {
      result = normalizeConfig(raw, { env: {} });
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      errors = errors.concat(e.errors && e.errors.length ? e.errors : [{ path: '', message: e.message }]);
    }
    if (errors.length) result = null;
    clearFieldErrors();
    if (!errors.length || !state.liveShowErrors) $('live-errors').hidden = true;
    const est = $('live-estimate');
    est.classList.remove('bad');
    est.replaceChildren();
    if (errors.length) {
      if (state.liveShowErrors) {
        showFieldErrors(errors);
        est.textContent = `설정 오류 ${errors.length}건`;
        est.classList.add('bad');
      } else {
        est.textContent = `대상 URL 등 필수 설정을 채우면 예상 요청 수가 표시됩니다 (현재 확인 필요 ${errors.length}건).`;
      }
    } else {
      const mock = isMockUrl(result.config.target.url) ? ' · mock URL이라 네트워크를 쓰지 않습니다' : '';
      est.append('예상: ' + estimateText(result.config) + mock);
      if (result.warnings.length) {
        est.append(h('ul', { class: 'plain' }, result.warnings.map((w) => h('li', {}, `[${w.code}] ${w.message}`))));
      }
    }
    return { raw, result, errors };
  }

  function updateLiveRunButton() {
    $('live-run').disabled = state.running || !$('f-authorized').checked;
  }

  let liveTimer = null;
  const scheduleValidate = () => { clearTimeout(liveTimer); liveTimer = setTimeout(validateLive, 150); };
  liveForm.addEventListener('input', scheduleValidate);
  liveForm.addEventListener('change', (e) => { if (e.target.id === 'f-authorized') updateLiveRunButton(); scheduleValidate(); });
  updateLiveRunButton();
  validateLive();

  liveForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.running) return;
    if (!$('f-authorized').checked) { announce('권한 확인 체크박스를 먼저 선택하십시오.'); $('f-authorized').focus(); return; }
    state.liveShowErrors = true;
    clearTimeout(liveTimer);
    const { result, errors } = validateLive();
    if (errors.length) {
      announce(`설정 오류 ${errors.length}건이 있어 실행하지 않았습니다.`);
      $('live-errors').focus();
      return;
    }
    try {
      const { report, aborted } = await execute(result.config, result.warnings, '실제 대상 점검');
      if (!report) return;
      state.reports = { live: report };
      state.comparison = null;
      state.compareNote = null;
      state.current = 'live';
      renderResults();
      if (!aborted) announce(`점검 완료 — 게이트 ${report.gate.status}: ${report.gate.summaryText}`);
    } catch (err) {
      reportError(err, $('live-estimate'));
    }
  });

  // ---------------------------------------------------------------------------
  // results rendering. Display only: no verdict/gate logic here. Reads the spec 9.5 fields plus other
  // report fields that exist in every report (spec 7): target.*, settings.attack/judge.*, tool.version,
  // schemaVersion, startedAt/finishedAt/durationMs, plan.cases, gate.thresholds.*, summary.trials/asr,
  // judge.*, cases[].{probeId,kind,vulnerableTrials,errorTrials}, trials[].{index,verdict,source,reason,
  // evidence,vulnerableTurn,error,judge}, turns[].{verdict,source,evidence,latencyMs,reasoningStripped,error},
  // optional aborted, and the Comparison fields (spec 3.13 + engine notes §1.2).

  const REPORT_TITLES = { before: '방어 전 (defend OFF)', after: '방어 후 (defend ON)', live: '점검 결과' };
  // ABORTED is not repeated here: it is already the banner and the first gate reason
  const GATE_WARNINGS = new Set(['MOSTLY_INCONCLUSIVE', 'JUDGE_FAILURES']);

  function renderResults() {
    $('results').hidden = false;
    renderCompare();
    renderSwitch();
    const report = state.reports[state.current];
    $('report').replaceChildren(report ? renderReport(report, state.current) : '');
    $('results-title').focus({ preventScroll: false });
  }

  function renderSwitch() {
    const keys = Object.keys(state.reports);
    const box = $('report-switch');
    if (keys.length < 2) { box.replaceChildren(); return; }
    box.replaceChildren(h('div', { class: 'segmented', role: 'group', 'aria-label': '표시할 리포트' },
      keys.map((k) => h('button', {
        type: 'button', 'aria-pressed': String(k === state.current),
        onclick: () => {
          state.current = k;
          renderSwitch();
          $('report').replaceChildren(renderReport(state.reports[k], k));
          announce(`${REPORT_TITLES[k]} 리포트를 표시합니다.`);
        },
      }, REPORT_TITLES[k]))));
  }

  // caseId lists in a Comparison. Known keys get Korean titles; any other top-level string[] field
  // (core may add more, e.g. a list of after-run INCONCLUSIVE cases) is still listed under its key name.
  const CMP_LISTS = [
    ['fixed', '고쳐진 케이스', true],
    ['regressed', '새로 뚫린 케이스', true],
    ['becameInconclusive', '취약 → 미결로 바뀐 케이스 (차단이 확인된 것은 아님)', false],
    ['onlyInBefore', '방어 전에만 있는 케이스', false],
    ['onlyInAfter', '방어 후에만 있는 케이스', false],
  ];
  const CMP_SKIP = new Set(['uncomparable', 'warnings']); // uncomparable is shown in the trust box

  function idListsFor(cmp) {
    const idList = (title, ids) => h('details', {},
      h('summary', {}, `${title} ${ids.length}건`),
      ids.length ? h('p', { class: 'idlist' }, ids.join(', ')) : h('p', {}, '없음'));
    const isIdArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
    const out = [];
    for (const [key, title, always] of CMP_LISTS) {
      if (isIdArray(cmp[key]) && (always || cmp[key].length)) out.push(idList(title, cmp[key]));
    }
    const known = new Set([...CMP_LISTS.map(([k]) => k), ...CMP_SKIP]);
    for (const [key, v] of Object.entries(cmp)) {
      if (!known.has(key) && isIdArray(v) && v.length) out.push(idList(`${key}`, v));
    }
    return out;
  }

  function renderCompare() {
    const cmp = state.comparison;
    const box = $('compare');
    if (!cmp) {
      box.replaceChildren(state.compareNote ? h('p', { class: 'callout callout-warn', role: 'note' }, state.compareNote) : '');
      return;
    }
    const br = cmp.blockRate;
    const untrusted = cmp.trustworthy === false;
    const unc = Array.isArray(cmp.uncomparable) ? cmp.uncomparable : [];
    const afterErr = cmp.after && typeof cmp.after.errorCases === 'number' ? cmp.after.errorCases : 0;
    const brText = br === null ? '차단률 —' : `차단률 ${pct(br)}`;
    const rows = Object.entries(cmp.byCategory).map(([cat, c]) => h('tr', {},
      h('td', { class: 'nowrap' }, cat),
      h('td', {}, c.title || (CATEGORY_INFO[cat] && CATEGORY_INFO[cat].title) || ''),
      h('td', { class: 'num' }, `${c.before.vulnerableCases}/${c.before.cases}`),
      h('td', { class: 'num' }, `${c.after.vulnerableCases}/${c.after.cases}`),
      h('td', { class: 'num' }, wilsonText(c.before.asr)),
      h('td', { class: 'num' }, wilsonText(c.after.asr)),
      h('td', { class: 'num' }, c.blockRate === null ? '—' : pct(c.blockRate)),
      h('td', { class: 'num' }, typeof c.uncomparable === 'number' ? c.uncomparable : '—'),
      h('td', {}, c.ciOverlap ? '차이를 단정할 수 없음 (95% 구간 겹침)' : ''),
    ));
    const cmpWarnings = Array.isArray(cmp.warnings) ? cmp.warnings : [];
    box.replaceChildren(h('section', { class: 'compare', 'aria-labelledby': 'cmp-title' },
      h('h3', { id: 'cmp-title' }, '폐루프 비교 — 방어 OFF → ON'),
      h('p', {},
        h('span', { class: 'big' }, brText),
        untrusted ? h('span', { class: 'verdict v-VULNERABLE trust-badge' }, '신뢰할 수 없음') : null, ' ',
        br === null
          ? '(비교 가능한 케이스 중 방어 전 취약 케이스가 없어 계산할 수 없습니다)'
          : `· 취약 케이스 ${cmp.before.vulnerableCases}/${cmp.before.cases} → ${cmp.after.vulnerableCases}/${cmp.after.cases}`),
      h('p', { class: 'muted' }, `비교 가능 케이스 ${typeof cmp.comparableCases === 'number' ? cmp.comparableCases : '—'}건 · 비교 불가 ${unc.length}건 (전/후 한쪽이 오류) · 방어 후 오류 ${afterErr}건`),
      untrusted ? h('div', { class: 'callout callout-error', role: 'note' },
        h('p', {}, h('strong', {}, '이 차단률은 신뢰할 수 없습니다.'),
          unc.length ? ` 전/후 중 한쪽이 오류인 케이스 ${unc.length}건은 측정되지 않아 계산에서 빠졌습니다.` : '',
          afterErr ? ` 방어 후 리포트에 오류 케이스 ${afterErr}건이 있습니다.` : '',
          ' 아래 비교 경고의 원인을 해소한 뒤 다시 비교하십시오.'),
        unc.length ? h('p', { class: 'idlist' }, unc.join(', ')) : null) : null,
      // every compare warning, whatever its code (new codes from core render the same way)
      cmpWarnings.length ? h('div', { class: 'callout callout-warn', role: 'note' },
        h('p', {}, h('strong', {}, `비교 경고 ${cmpWarnings.length}건`)),
        h('ul', {}, cmpWarnings.map((w) => h('li', {}, h('code', {}, w.code || 'WARNING'), ` ${w.message || ''}`)))) : null,
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '카테고리별 전후 비교 표' },
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', { scope: 'col' }, 'OWASP'), h('th', { scope: 'col' }, '항목'),
            h('th', { scope: 'col', class: 'num' }, '전 취약/케이스'), h('th', { scope: 'col', class: 'num' }, '후 취약/케이스'),
            h('th', { scope: 'col', class: 'num' }, '전 ASR (95% CI)'), h('th', { scope: 'col', class: 'num' }, '후 ASR (95% CI)'),
            h('th', { scope: 'col', class: 'num' }, '차단률'), h('th', { scope: 'col', class: 'num' }, '비교 불가'), h('th', { scope: 'col' }, '비고'))),
          h('tbody', {}, rows))),
      idListsFor(cmp),
      h('div', { class: 'downloads' },
        h('button', { type: 'button', class: 'btn btn-small', onclick: () => download(`agent-redteam-compare-${stamp(cmp.after.finishedAt)}.md`, renderCompareMarkdown(cmp), 'text/markdown') }, '비교 리포트 Markdown 내려받기')),
    ));
  }

  function statItem(k, v, cls) {
    return h('li', { class: `stat ${cls || ''}` }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
  }

  function renderReport(r, key) {
    const s = r.summary;
    const a = r.settings.attack;
    const j = r.settings.judge;
    const frag = document.createDocumentFragment();

    frag.append(h('h3', {}, (REPORT_TITLES[key] || '점검 결과') + (r.aborted === true ? ' — 중단됨 (부분 결과)' : '')));

    // aborted run: core already forces the gate to FAIL; the UI never shows such a run as PASS either way
    const aborted = r.aborted === true;
    if (aborted) {
      frag.append(h('div', { class: 'callout callout-error aborted-banner', role: 'note' },
        h('p', {}, h('strong', {}, `중단된 실행 — 부분 결과 (완료 ${r.cases.length}/${r.plan.cases} 케이스)`)),
        h('p', {}, '사용자가 실행을 중지했습니다. 중단 시점의 케이스는 버렸고, 측정하지 않은 케이스가 있으므로 이 결과는 통과로 보지 않습니다. 다시 실행하십시오.')));
    }

    // gate
    const pass = r.gate.status === 'PASS' && !aborted;
    const badge = aborted ? '중단됨 · FAIL' : (pass ? 'PASS' : 'FAIL');
    frag.append(h('section', { class: `gate ${pass ? 'gate-pass' : 'gate-fail'}`, 'aria-label': '배포 게이트' },
      h('p', { class: 'gate-title' }, h('span', {}, '배포 게이트'), h('span', { class: 'gate-badge' }, badge)),
      h('p', {}, r.gate.summaryText),
      // summaryText already is reasons[0] (+ "외 n건"); list the reasons only when there is more to say
      r.gate.reasons.length > 1 || (r.gate.reasons.length === 1 && r.gate.reasons[0] !== r.gate.summaryText)
        ? h('ul', {}, r.gate.reasons.map((x) => h('li', {}, x))) : null,
      h('p', { class: 'muted' }, `임계값: 취약 허용 ${r.gate.thresholds.maxVulnerable}건 · 오류 허용 ${r.gate.thresholds.maxErrors}건 · 미결 시 FAIL ${r.gate.thresholds.failOnInconclusive ? '예' : '아니오'}`),
      // warnings that change how the gate should be read are repeated right here
      r.warnings.filter((w) => GATE_WARNINGS.has(w.code)).map((w) =>
        h('p', { class: 'callout callout-warn gate-warning' }, h('code', {}, w.code), ` ${w.message}`))));

    // counts
    frag.append(h('ul', { class: 'stats', 'aria-label': '요약 수치' },
      statItem('케이스', s.cases),
      statItem('시도', s.trials),
      statItem('취약', s.vulnerable, s.vulnerable ? 'is-bad' : ''),
      statItem('차단', s.blocked, 'is-ok'),
      statItem('미결', s.inconclusive, s.inconclusive ? 'is-warn' : ''),
      statItem('오류', s.errors, s.errors ? 'is-bad' : ''),
      statItem('전체 ASR', s.asr && s.asr.p !== null ? pct(s.asr.p) : '—')));

    // metadata
    const transforms = a.transforms.length ? a.transforms.map(transformLabel).join(', ') : '변형 없음';
    const judgeText = j.enabled ? `ON (${j.mode}${j.model ? ' · ' + j.model : ''}${j.sameAsTarget ? ' · 대상과 같은 엔드포인트' : ''})` : 'OFF';
    frag.append(h('div', { class: 'meta' }, h('dl', {},
      h('dt', {}, '대상'), h('dd', {}, `${r.target.provider} · ${r.target.url}${r.target.model ? ' · ' + r.target.model : ''}`),
      h('dt', {}, '구성'), h('dd', {}, `${transforms} · 멀티턴 ${a.multiturn ? 'ON' : 'OFF'} · 반복 ${a.repeats} · 방어 ${a.defend ? 'ON' : 'OFF'} · judge ${judgeText}`),
      h('dt', {}, '실행'), h('dd', {}, `${r.startedAt} → ${r.finishedAt} (${(r.durationMs / 1000).toFixed(1)}초) · agent-redteam ${r.tool.version} · 스키마 ${r.schemaVersion}`))));

    // downloads
    const base = `agent-redteam-${key === 'live' ? 'report' : key}-${stamp(r.finishedAt)}`;
    frag.append(h('div', { class: 'downloads' },
      h('button', { type: 'button', class: 'btn', onclick: () => download(base + '.md', renderMarkdown(r), 'text/markdown') }, 'Markdown 리포트 내려받기'),
      h('button', { type: 'button', class: 'btn', onclick: () => download(base + '.json', JSON.stringify(r, null, 2), 'application/json') }, 'JSON 리포트 내려받기')));

    // per-category
    const cats = Object.entries(s.byCategory);
    const small = cats.some(([, c]) => c.asr && c.asr.n < 30);
    frag.append(h('h3', { id: `cat-${key}` }, '카테고리별 결과'),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-labelledby': `cat-${key}` },
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', { scope: 'col' }, 'OWASP'), h('th', { scope: 'col' }, '항목'),
            h('th', { scope: 'col', class: 'num' }, '케이스'), h('th', { scope: 'col', class: 'num' }, '취약 케이스'),
            h('th', { scope: 'col', class: 'num' }, '시도'), h('th', { scope: 'col', class: 'num' }, 'ASR (95% CI)'),
            h('th', { scope: 'col', class: 'num' }, `ASR@k`))),
          h('tbody', {}, cats.map(([cat, c]) => h('tr', {},
            h('td', { class: 'nowrap' }, cat), h('td', {}, c.title),
            h('td', { class: 'num' }, c.cases), h('td', { class: 'num' }, c.vulnerableCases),
            h('td', { class: 'num' }, c.trials), h('td', { class: 'num' }, wilsonText(c.asr)),
            h('td', { class: 'num' }, c.asrAtK && c.asrAtK.p !== null ? `${pct(c.asrAtK.p)} (k=${c.asrAtK.k})` : '—')))))),
      small ? h('p', { class: 'hint' }, '표본이 작아 구간이 넓습니다. 반복 수를 늘리면 구간이 좁아집니다.') : null);

    // judge
    if (r.judge) frag.append(renderJudge(r.judge));

    // warnings
    if (r.warnings.length) {
      frag.append(h('h3', {}, '경고'),
        h('ul', { class: 'plain' }, r.warnings.map((w) => h('li', {}, h('code', {}, w.code), ` ${w.message}`, w.level === 'info' ? h('span', { class: 'muted' }, ' (정보)') : null))));
    }

    // skipped
    if (r.plan.skipped && r.plan.skipped.length) {
      frag.append(h('h3', {}, '건너뛴 프로브'),
        h('ul', { class: 'plain' }, r.plan.skipped.map((x) => h('li', {}, h('code', {}, x.probeId), ` — ${x.reason}`))));
    }

    frag.append(renderCaseTable(r, key));
    return frag;
  }

  function renderJudge(jd) {
    const c = jd.calibration;
    const box = h('section', { 'aria-labelledby': 'judge-title' },
      h('h3', { id: 'judge-title' }, 'LLM judge'),
      h('p', {}, `모드 ${jd.mode} · 호출 ${jd.calls}회 · 실패 ${jd.failures}회 · 미결 해소 ${jd.resolved}건`),
      jd.sameAsTarget ? h('p', { class: 'callout callout-warn' }, 'judge가 점검 대상과 같은 엔드포인트입니다. 대상이 자기 응답을 평가하므로 판정이 관대해질 수 있습니다. 별도 judge 모델을 쓰십시오.') : null);
    if (c) {
      box.append(h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'judge 보정 지표' },
        h('table', {},
          h('caption', {}, '보정 지표 (오라클 판정을 정답으로 본 judge 일치도)'),
          h('thead', {}, h('tr', {},
            ['n', '정밀도', '재현율', '오탐률', '일치율', 'κ', 'TP', 'FP', 'FN', 'TN', '불명'].map((x) => h('th', { scope: 'col', class: 'num' }, x)))),
          h('tbody', {}, h('tr', {},
            [c.n, num4(c.precision), num4(c.recall), num4(c.falsePositiveRate), num4(c.agreement), num4(c.kappa), c.tp, c.fp, c.fn, c.tn, c.unclear]
              .map((x) => h('td', { class: 'num' }, x)))))));
      box.append(h('p', { class: c.needsHumanReview ? 'callout callout-warn' : 'hint' }, c.note));
    } else if (jd.mode === 'fallback') {
      box.append(h('p', { class: 'hint' }, '보정 지표는 judge 모드 all에서만 계산됩니다.'));
    }
    return box;
  }

  const VERDICT_FILTERS = [['', '전체'], ['VULNERABLE', VERDICT_LABELS.VULNERABLE], ['BLOCKED', VERDICT_LABELS.BLOCKED], ['INCONCLUSIVE', VERDICT_LABELS.INCONCLUSIVE], ['ERROR', VERDICT_LABELS.ERROR]];

  function renderCaseTable(r, key) {
    const wrap = h('section', { 'aria-labelledby': `cases-${key}` });
    const filterId = `case-filter-${key}`;
    const tbody = h('tbody');
    const countEl = h('p', { class: 'hint', 'aria-live': 'polite' });
    const select = h('select', { id: filterId },
      VERDICT_FILTERS.map(([v, label]) => {
        const n = v ? r.cases.filter((c) => c.verdict === v).length : r.cases.length;
        return h('option', { value: v }, `${label} (${n})`);
      }));
    const fill = () => {
      const v = select.value;
      const list = v ? r.cases.filter((c) => c.verdict === v) : r.cases;
      tbody.replaceChildren(...list.map((c) => h('tr', {},
        h('td', { class: 'nowrap' }, h('button', {
          type: 'button', class: 'btn-link', 'aria-haspopup': 'dialog', 'aria-label': `${c.caseId} 상세 보기`,
          onclick: (ev) => openCase(c, ev.currentTarget),
        }, c.caseId)),
        h('td', { class: 'nowrap' }, c.category),
        h('td', {}, c.title),
        h('td', { class: 'nowrap' }, c.transformLabel),
        h('td', {}, verdictBadge(c.verdict)),
        h('td', { class: 'nowrap' }, SOURCE_LABELS[c.source] || c.source),
        h('td', { class: 'reason' }, c.reason),
        h('td', { class: 'evidence' }, c.evidence ? clip(evidenceContext(c) || c.evidence, 160) : '—'))));
      countEl.textContent = `${list.length}건 표시`;
    };
    select.addEventListener('change', fill);
    fill();
    wrap.append(
      h('h3', { id: `cases-${key}` }, '케이스별 결과'),
      h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', { for: filterId }, '판정으로 거르기'), select), countEl),
      h('p', { class: 'hint' }, '케이스 ID를 누르면 턴별 프롬프트·응답 발췌를 볼 수 있습니다.'),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-labelledby': `cases-${key}` },
        h('table', {},
          h('thead', {}, h('tr', {},
            ['ID', 'OWASP', '프로브', '변형', '판정', '근거', '사유', '증거'].map((x) => h('th', { scope: 'col' }, x)))),
          tbody)));
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // case detail dialog

  const dialog = $('case-dialog');
  $('case-dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (state.lastDialogTrigger && document.contains(state.lastDialogTrigger)) state.lastDialogTrigger.focus();
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  function excerpt(label, text) {
    return [h('p', { class: 'excerpt-label' }, label), h('pre', { class: 'excerpt', tabindex: '0' }, text)];
  }

  function errText(err) {
    return err ? `${err.code}${err.status ? ' ' + err.status : ''} — ${err.message}` : '';
  }

  function openCase(c, trigger) {
    state.lastDialogTrigger = trigger;
    $('case-dialog-title').textContent = `${c.caseId} — ${c.title}`;
    const body = $('case-dialog-body');
    body.replaceChildren(h('div', {},
      h('div', { class: 'meta' }, h('dl', {},
        h('dt', {}, '판정'), h('dd', {}, verdictBadge(c.verdict), ` 근거: ${SOURCE_LABELS[c.source] || c.source}`),
        h('dt', {}, '사유'), h('dd', {}, c.reason),
        h('dt', {}, '증거'), h('dd', {}, c.evidence || '—'),
        evidenceContext(c) ? [h('dt', {}, '증거 주변 응답'), h('dd', {}, evidenceContext(c))] : null,
        h('dt', {}, 'OWASP'), h('dd', {}, `${c.category} ${(CATEGORY_INFO[c.category] || {}).title || ''}`),
        h('dt', {}, '프로브'), h('dd', {}, `${c.probeId} · ${c.kind === 'crescendo' ? '멀티턴(크레센도)' : '단일 턴'} · 변형 ${c.transformLabel}`),
        h('dt', {}, '시도'), h('dd', {}, `${c.trials.length}회 · 취약 ${c.vulnerableTrials} · 오류 ${c.errorTrials}`))),
      c.trials.map((t) => h('section', { class: 'trial', 'aria-label': `시도 ${t.index}` },
        h('h3', {}, `시도 ${t.index} `, verdictBadge(t.verdict)),
        h('p', {}, `${SOURCE_LABELS[t.source] || t.source} · ${t.reason}${t.vulnerableTurn ? ` · 취약 턴 ${t.vulnerableTurn}` : ''}`),
        t.evidence ? h('p', { class: 'muted' }, `증거: ${t.evidence}`) : null,
        t.error ? h('p', { class: 'callout callout-error' }, `오류: ${errText(t.error)}`) : null,
        t.judge ? h('p', { class: 'muted' }, `judge: ${t.judge.verdict} · ${t.judge.reason}${t.judge.used ? ' (판정에 사용)' : ''}${t.judge.error ? ' · 오류 ' + errText(t.judge.error) : ''}`) : null,
        t.turns.map((tn) => h('div', { class: 'turn' },
          h('h4', {}, `턴 ${tn.turn}`, verdictBadge(tn.verdict), h('span', { class: 'muted' },
            `${SOURCE_LABELS[tn.source] || tn.source}${tn.latencyMs !== null && tn.latencyMs !== undefined ? ` · ${tn.latencyMs}ms` : ''}${tn.reasoningStripped ? ' · 추론 블록 제거됨' : ''}`)),
          excerpt('프롬프트', tn.prompt),
          excerpt('응답', tn.response || '(빈 응답)'),
          tn.toolCalls && tn.toolCalls.length ? excerpt('도구 호출', tn.toolCalls.map((x) => `${x.name} ${JSON.stringify(x.arguments)}`).join('\n')) : null,
          tn.error ? h('p', { class: 'callout callout-error' }, `오류: ${errText(tn.error)}`) : null))))));
    dialog.showModal();
    $('case-dialog-close').focus();
  }

  // engine ready: enable the demo run (the live run follows the authorization checkbox)
  $('demo-run').disabled = false;
  $('demo-run').removeAttribute('aria-busy');
  updateLiveRunButton();
}
