/* agent-redteam site client — progressive enhancement only; every page reads fine without it.
   1. copy buttons on terminal code blocks
   2. landing: section-nav scroll spy, hero signal-panel defend switch (one chase sweep)
   3. docs: table of contents open on wide screens + scroll spy */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 1. copy buttons ------------------------------------------------------------
  if (navigator.clipboard && window.isSecureContext !== false) {
    document.querySelectorAll('.term').forEach(function (term) {
      var bar = term.querySelector('.term-bar');
      var code = term.querySelector('pre code');
      if (!bar || !code) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy-btn';
      btn.textContent = '복사';
      btn.setAttribute('aria-label', '코드 복사');
      btn.addEventListener('click', function () {
        navigator.clipboard.writeText(code.textContent).then(function () {
          btn.textContent = '복사됨';
          btn.setAttribute('data-done', '');
          setTimeout(function () { btn.textContent = '복사'; btn.removeAttribute('data-done'); }, 1600);
        }, function () { btn.textContent = '복사 실패'; });
      });
      bar.appendChild(btn);
    });
  }

  // shared scroll spy: marks the link whose target section is nearest the top
  function spy(links, onChange) {
    if (!('IntersectionObserver' in window) || !links.length) return;
    var targets = links.map(function (a) {
      var id = decodeURIComponent(a.getAttribute('href').slice(1));
      return document.getElementById(id);
    });
    var visible = new Map();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { visible.set(e.target, e.isIntersecting); });
      var idx = -1;
      for (var i = 0; i < targets.length; i++) {
        if (!targets[i]) continue;
        var r = targets[i].getBoundingClientRect();
        if (r.top - 140 <= 0) idx = i;
      }
      if (idx < 0) { for (var j = 0; j < targets.length; j++) if (visible.get(targets[j])) { idx = j; break; } }
      links.forEach(function (a, k) {
        var on = k === idx;
        a.classList.toggle('is-active', on);
        if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
      });
      if (onChange && idx >= 0) onChange(links[idx]);
    }, { rootMargin: '-120px 0px -55% 0px', threshold: [0, 1] });
    targets.forEach(function (t) { if (t) io.observe(t); });
  }

  // 2. landing -----------------------------------------------------------------
  var sectionLinks = Array.prototype.slice.call(document.querySelectorAll('.section-nav a[href^="#"]'));
  spy(sectionLinks, function (a) {
    var nav = a.closest('.section-nav');
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    var left = a.offsetLeft - nav.clientWidth / 2 + a.offsetWidth / 2;
    nav.scrollTo({ left: left, behavior: reduce ? 'auto' : 'smooth' });
  });

  var panel = document.querySelector('.sigpanel');
  if (panel) {
    var lamps = Array.prototype.slice.call(panel.querySelectorAll('.sp-lamps .lamp'));
    var buttons = Array.prototype.slice.call(panel.querySelectorAll('.sp-switch button'));
    var timers = [];
    var sweep = function (state) {
      timers.forEach(clearTimeout);
      timers = [];
      var step = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chase-step')) || 42;
      lamps.forEach(function (lamp, i) {
        var v = lamp.getAttribute('data-' + state);
        if (reduce) { lamp.setAttribute('data-v', v); return; }
        lamp.setAttribute('data-v', 'off');
        timers.push(setTimeout(function () { lamp.setAttribute('data-v', v); }, 160 + i * step));
      });
      // the signal and readout change once the sweep has reached the gate
      var delay = reduce ? 0 : 160 + lamps.length * step;
      panel.setAttribute('data-sweeping', '');
      timers.push(setTimeout(function () {
        panel.setAttribute('data-state', state);
        panel.removeAttribute('data-sweeping');
      }, delay));
    };
    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        var state = b.getAttribute('data-set');
        buttons.forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        sweep(state);
      });
    });
    // first view: one sweep into the "before" state, the run the hero describes
    if (!reduce && 'IntersectionObserver' in window) {
      var once = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) { once.disconnect(); sweep('before'); }
      }, { threshold: 0.35 });
      once.observe(panel);
    }
  }

  // 3. docs ----------------------------------------------------------------------
  var toc = document.querySelector('details[data-toc]');
  if (toc) {
    var wide = window.matchMedia('(min-width: 1100px)');
    var sync = function () { if (wide.matches) toc.open = true; };
    sync();
    if (wide.addEventListener) wide.addEventListener('change', sync);
    var tocLinks = Array.prototype.slice.call(toc.querySelectorAll('a[href^="#"]'));
    tocLinks.forEach(function (a) {
      a.addEventListener('click', function () { if (!wide.matches) toc.open = false; });
    });
    spy(tocLinks);
  }
})();
