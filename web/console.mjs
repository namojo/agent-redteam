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

  /** Sleep that returns early when the run is stopped (runSuite accepts an injected sleep). */
  const abortableSleep = (signal) => (ms) => new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

  /**
   * runSuite has no cancel signal, so Stop makes every further transport call fail immediately
   * (and in-flight fetches abort). The run then finishes quickly and its report is discarded.
   */
  function stoppable(transport, signal) {
    return async (req) => {
      if (signal.aborted) throw new TransportError('NETWORK', '사용자가 실행을 중지했습니다');
      return transport(req);
    };
  }

  function mockTransport(signal) {
    const base = createMockTransport();
    // yield to the event loop so the progress bar can paint between mock requests
    return stoppable(async (req) => { await new Promise((r) => setTimeout(r, 0)); return base(req); }, signal);
  }

  function fetchTransport(signal) {
    const fetchImpl = (url, init = {}) => {
      const inner = init.signal;
      const ctrl = new AbortController();
      const relay = () => ctrl.abort();
      if (inner) { if (inner.aborted) ctrl.abort(); else inner.addEventListener('abort', relay, { once: true }); }
      if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', relay, { once: true });
      return fetch(url, { ...init, signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    };
    return stoppable(createFetchTransport({ fetchImpl }), signal);
  }

  const transportFor = (url, signal) => (isMockUrl(url) ? mockTransport(signal) : fetchTransport(signal));

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
      $('progress-label').textContent = '중지하는 중…';
      announce('실행을 중지하는 중입니다.');
    }
  });

  /** Run one suite through core. Returns the report, or null if the user stopped it. */
  async function execute(config, warnings, label) {
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
        transport: transportFor(config.target.url, controller.signal),
        judgeTransport: judgeUrl ? transportFor(judgeUrl, controller.signal) : undefined,
        sleep: abortableSleep(controller.signal),
        extraWarnings: warnings,
        onProgress: (ev) => {
          if (ev.type === 'trial-done') doneTrials += 1;
          bar.value = Math.min(doneTrials, totalTrials);
          const v = ev.verdict ? ` · ${VERDICT_LABELS[ev.verdict] || ev.verdict}` : '';
          $('progress-text').textContent = `케이스 ${ev.caseIndex + 1}/${ev.caseCount} · ${ev.caseId}${v} · 시도 ${doneTrials}/${totalTrials}`;
        },
      });
      if (controller.signal.aborted) {
        announce('실행을 중지했습니다. 중지된 실행의 결과는 표시하지 않습니다.');
        return null;
      }
      return report;
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

  function demoRaw(defend) {
    const mode = document.querySelector('input[name="demo-mode"]:checked').value;
    const repeats = Number($('demo-repeats').value);
    const raw = {
      version: 2,
      authorized: true,
      target: { provider: 'openai', url: `mock://${mode}/v1/chat/completions`, model: 'mock-agent' },
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

  function estimateText(config) {
    const plan = buildPlan(config);
    const er = plan.estimatedRequests;
    const judge = er.judgeMax ? ` · judge 최대 ${er.judgeMax}회 · 합계 최대 ${er.total}회` : '';
    const skipped = plan.skipped.length ? ` · 건너뛸 프로브 ${plan.skipped.length}개` : '';
    return `케이스 ${plan.cases.length}개 · 대상 요청 최대 ${er.target}회${judge}${skipped}`;
  }

  function updateDemoEstimate() {
    const el = $('demo-estimate');
    el.classList.remove('bad');
    try {
      const { config } = normalizeConfig(demoRaw(false), { env: {} });
      el.textContent = '예상: ' + estimateText(config) + ' (네트워크 사용 안 함)';
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
      const report = await execute(n.config, n.warnings, '공격 실행 (방어 OFF)');
      if (!report) return;
      state.demoRaw = raw;
      state.reports = { before: report };
      state.comparison = null;
      state.current = 'before';
      renderResults();
      $('demo-defend').disabled = false;
      announce(`공격 실행 완료 — 게이트 ${report.gate.status}: ${report.gate.summaryText}`);
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
      const after = await execute(n.config, n.warnings, '방어 적용 후 재시험 (방어 ON)');
      if (!after) return;
      const before = state.reports.before;
      state.reports = { before, after };
      state.comparison = compareReports(before, after);
      state.current = 'after';
      renderResults();
      const br = state.comparison.blockRate;
      announce(`재시험 완료 — 게이트 ${after.gate.status}. 차단률 ${br === null ? '계산 불가' : pct(br)}.`);
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
      const report = await execute(result.config, result.warnings, '실제 대상 점검');
      if (!report) return;
      state.reports = { live: report };
      state.comparison = null;
      state.current = 'live';
      renderResults();
      announce(`점검 완료 — 게이트 ${report.gate.status}: ${report.gate.summaryText}`);
    } catch (err) {
      reportError(err, $('live-estimate'));
    }
  });

  // ---------------------------------------------------------------------------
  // results rendering (reads only report fields listed in spec 9.5 + plain metadata)

  const REPORT_TITLES = { before: '방어 전 (defend OFF)', after: '방어 후 (defend ON)', live: '점검 결과' };

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

  function renderCompare() {
    const cmp = state.comparison;
    const box = $('compare');
    if (!cmp) { box.replaceChildren(); return; }
    const br = cmp.blockRate;
    const rows = Object.entries(cmp.byCategory).map(([cat, c]) => h('tr', {},
      h('td', { class: 'nowrap' }, cat),
      h('td', {}, c.title || (CATEGORY_INFO[cat] && CATEGORY_INFO[cat].title) || ''),
      h('td', { class: 'num' }, `${c.before.vulnerableCases}/${c.before.cases}`),
      h('td', { class: 'num' }, `${c.after.vulnerableCases}/${c.after.cases}`),
      h('td', { class: 'num' }, wilsonText(c.before.asr)),
      h('td', { class: 'num' }, wilsonText(c.after.asr)),
      h('td', { class: 'num' }, c.blockRate === null ? '—' : pct(c.blockRate)),
      h('td', {}, c.ciOverlap ? '차이를 단정할 수 없음 (95% 구간 겹침)' : ''),
    ));
    const idList = (title, ids) => h('details', {},
      h('summary', {}, `${title} ${ids.length}건`),
      ids.length ? h('p', { class: 'idlist' }, ids.join(', ')) : h('p', {}, '없음'));
    box.replaceChildren(h('section', { class: 'compare', 'aria-labelledby': 'cmp-title' },
      h('h3', { id: 'cmp-title' }, '폐루프 비교 — 방어 OFF → ON'),
      h('p', {},
        h('span', { class: 'big' }, br === null ? '차단률 —' : `차단률 ${pct(br)}`), ' ',
        br === null ? '(방어 전 취약 케이스가 없어 계산할 수 없습니다)' : `· 취약 케이스 ${cmp.before.vulnerableCases}/${cmp.before.cases} → ${cmp.after.vulnerableCases}/${cmp.after.cases}`),
      h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '카테고리별 전후 비교 표' },
        h('table', {},
          h('thead', {}, h('tr', {},
            h('th', { scope: 'col' }, 'OWASP'), h('th', { scope: 'col' }, '항목'),
            h('th', { scope: 'col', class: 'num' }, '전 취약/케이스'), h('th', { scope: 'col', class: 'num' }, '후 취약/케이스'),
            h('th', { scope: 'col', class: 'num' }, '전 ASR (95% CI)'), h('th', { scope: 'col', class: 'num' }, '후 ASR (95% CI)'),
            h('th', { scope: 'col', class: 'num' }, '차단률'), h('th', { scope: 'col' }, '비고'))),
          h('tbody', {}, rows))),
      idList('고쳐진 케이스', cmp.fixed),
      idList('새로 뚫린 케이스', cmp.regressed),
      cmp.warnings && cmp.warnings.length ? h('ul', { class: 'plain' }, cmp.warnings.map((w) => h('li', {}, `[${w.code}] ${w.message}`))) : null,
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

    frag.append(h('h3', {}, REPORT_TITLES[key] || '점검 결과'));

    // gate
    const pass = r.gate.status === 'PASS';
    frag.append(h('section', { class: `gate ${pass ? 'gate-pass' : 'gate-fail'}`, 'aria-label': '배포 게이트' },
      h('p', { class: 'gate-title' }, h('span', {}, '배포 게이트'), h('span', { class: 'gate-badge' }, r.gate.status)),
      h('p', {}, r.gate.summaryText),
      // summaryText already is reasons[0] (+ "외 n건"); list the reasons only when there is more to say
      r.gate.reasons.length > 1 || (r.gate.reasons.length === 1 && r.gate.reasons[0] !== r.gate.summaryText)
        ? h('ul', {}, r.gate.reasons.map((x) => h('li', {}, x))) : null,
      h('p', { class: 'muted' }, `임계값: 취약 허용 ${r.gate.thresholds.maxVulnerable}건 · 오류 허용 ${r.gate.thresholds.maxErrors}건 · 미결 시 FAIL ${r.gate.thresholds.failOnInconclusive ? '예' : '아니오'}`)));

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
        h('td', { class: 'evidence' }, c.evidence ? clip(c.evidence, 160) : '—'))));
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
}
