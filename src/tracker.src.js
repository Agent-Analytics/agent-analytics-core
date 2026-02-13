(function() {
  'use strict';

  var script = document.currentScript;
  var ENDPOINT = script && script.src
    ? new URL(script.src).origin + '/track'
    : '/track';
  var PROJECT = (script && script.dataset.project) || 'default';
  var TOKEN = (script && script.dataset.token) || null;

  // --- Anon ID ---
  function getAnonId() {
    var id = localStorage.getItem('aa_uid');
    if (!id) {
      id = 'anon_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
      localStorage.setItem('aa_uid', id);
    }
    return id;
  }
  var userId = getAnonId();

  // --- Session ID (30min inactivity timeout) ---
  var SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  function getSessionId() {
    var now = Date.now();
    var lastActivity = parseInt(sessionStorage.getItem('aa_last_activity') || '0', 10);
    var sid = sessionStorage.getItem('aa_sid');
    if (!sid || (lastActivity && (now - lastActivity) > SESSION_TIMEOUT)) {
      sid = 'sess_' + Math.random().toString(36).substr(2, 9) + now.toString(36);
      sessionStorage.setItem('aa_sid', sid);
    }
    sessionStorage.setItem('aa_last_activity', String(now));
    return sid;
  }

  // --- UTM params ---
  function getUtm() {
    var p = new URLSearchParams(location.search);
    var u = {}, keys = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'];
    for (var i = 0; i < keys.length; i++) {
      var v = p.get(keys[i]);
      if (v) u[keys[i]] = v;
    }
    return u;
  }
  var utm = getUtm();

  // --- Browser & OS detection ---
  function detect(ua) {
    var b = 'Unknown', bv = '', os = 'Unknown';
    var m;
    if ((m = ua.match(/(Edge|Edg)\/([\d.]+)/))) { b = 'Edge'; bv = m[2]; }
    else if ((m = ua.match(/OPR\/([\d.]+)/))) { b = 'Opera'; bv = m[1]; }
    else if ((m = ua.match(/Chrome\/([\d.]+)/))) { b = 'Chrome'; bv = m[1]; }
    else if ((m = ua.match(/Safari\/([\d.]+)/))) {
      if ((m = ua.match(/Version\/([\d.]+)/))) { b = 'Safari'; bv = m[1]; }
    }
    else if ((m = ua.match(/Firefox\/([\d.]+)/))) { b = 'Firefox'; bv = m[1]; }

    if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';

    return { browser: b, browser_version: bv.split('.')[0], os: os };
  }
  var ua = navigator.userAgent || '';
  var dev = detect(ua);

  // --- Device type ---
  function deviceType() {
    var w = screen.width;
    if (/Tablet|iPad/i.test(ua) || (w >= 768 && w < 1024 && !/Mobi/i.test(ua))) return 'tablet';
    if (/Mobi/i.test(ua) || w < 768) return 'mobile';
    return 'desktop';
  }
  dev.device = deviceType();

  // --- Event queue ---
  var queue = [];
  var flushTimer = null;

  function send(url, data) {
    if (navigator.sendBeacon) {
      if (navigator.sendBeacon(url, new Blob([data], {type: 'text/plain'}))) return;
    }
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data,
      keepalive: true,
      credentials: 'omit'
    }).catch(function() {});
  }

  function flush() {
    if (!queue.length) return;
    var batch = queue.splice(0);
    if (batch.length === 1) {
      send(ENDPOINT, JSON.stringify(batch[0]));
    } else {
      send(ENDPOINT.replace('/track', '/track/batch'), JSON.stringify({ events: batch }));
    }
  }

  function scheduleFlush() {
    if (!flushTimer) flushTimer = setTimeout(function() { flushTimer = null; flush(); }, 5000);
  }

  // Flush on visibility hidden / beforeunload
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('beforeunload', flush);

  // --- Common properties ---
  function baseProps(extra) {
    var p = {
      url: location.href,
      path: location.pathname,
      hostname: location.hostname,
      referrer: document.referrer,
      title: document.title,
      screen: screen.width + 'x' + screen.height,
      language: navigator.language || '',
      browser: dev.browser,
      browser_version: dev.browser_version,
      os: dev.os,
      device: dev.device
    };
    // Merge UTM
    for (var k in utm) p[k] = utm[k];
    // Merge extra
    if (extra) for (var k2 in extra) p[k2] = extra[k2];
    return p;
  }

  var aa = {
    track: function(event, properties) {
      queue.push({
        project: PROJECT,
        token: TOKEN,
        event: event,
        properties: baseProps(properties),
        user_id: userId,
        session_id: getSessionId(),
        timestamp: Date.now()
      });
      scheduleFlush();
    },

    identify: function(id) {
      userId = id;
      localStorage.setItem('aa_uid', id);
    },

    page: function(name) {
      this.track('page_view', { page: name || document.title });
    }
  };

  // --- SPA route tracking ---
  var lastPath = location.pathname + location.search;
  function onRoute() {
    var cur = location.pathname + location.search;
    if (cur !== lastPath) {
      lastPath = cur;
      utm = getUtm(); // re-parse UTM on navigation
      aa.page();
    }
  }
  window.addEventListener('popstate', onRoute);
  // Monkey-patch pushState / replaceState
  ['pushState', 'replaceState'].forEach(function(fn) {
    var orig = history[fn];
    history[fn] = function() {
      var r = orig.apply(this, arguments);
      onRoute();
      return r;
    };
  });

  // Auto track initial page view
  aa.page();

  window.aa = aa;
})();
