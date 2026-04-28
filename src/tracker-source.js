// AUTO-GENERATED — edit tracker.src.js instead
export const TRACKER_SOURCE_JS = `(function() {
  'use strict';

  // Skip real tracking on localhost — log to console instead
  if (/^localhost$|^127(\\.\\d+){3}$/.test(location.hostname)) {
    window.aa = {
      track: function(e, p) { console.log('[aa-dev] track', e, p || {}); },
      identify: function(id) { console.log('[aa-dev] identify', id); },
      page: function(n) { console.log('[aa-dev] page', n || document.title); },
      experiment: function() { return null; },
      set: function(p) { console.log('[aa-dev] set', p || {}); },
      requireConsent: function() { console.log('[aa-dev] requireConsent'); },
      grantConsent: function() { console.log('[aa-dev] grantConsent'); },
      revokeConsent: function() { console.log('[aa-dev] revokeConsent'); }
    };
    return;
  }

  var script = document.currentScript;
  var ENDPOINT = script && script.src
    ? new URL(script.src).origin + '/track'
    : '/track';
  var PROJECT = (script && script.dataset.project) || 'default';
  var TOKEN = (script && script.dataset.token) || null;

  function storageScope() {
    var raw = TOKEN || PROJECT || 'default';
    raw = String(raw || 'default');
    try {
      return encodeURIComponent(raw).replace(/[!'()*]/g, function(ch) {
        return '%' + ch.charCodeAt(0).toString(16).toUpperCase();
      }) || 'default';
    } catch(_) {
      var out = '';
      for (var i = 0; i < raw.length; i++) {
        var c = raw.charAt(i);
        out += /[a-zA-Z0-9._-]/.test(c) ? c : '%' + raw.charCodeAt(i).toString(16).toUpperCase();
      }
      return out || 'default';
    }
  }

  var STORAGE_PREFIX = 'aa:' + storageScope() + ':';

  function createSafeStorage(name) {
    var nativeStorage = null;
    var memory = {};
    var removed = {};
    try { nativeStorage = window[name]; } catch(_) { nativeStorage = null; }
    function scoped(key) { return STORAGE_PREFIX + key; }
    return {
      getItem: function(key) {
        var sk = scoped(key);
        if (Object.prototype.hasOwnProperty.call(removed, sk)) return null;
        if (Object.prototype.hasOwnProperty.call(memory, sk)) return memory[sk];
        try {
          if (nativeStorage && typeof nativeStorage.getItem === 'function') {
            var value = nativeStorage.getItem(sk);
            if (value !== null && value !== undefined) return value;
          }
        } catch(_) {}
        return null;
      },
      setItem: function(key, value) {
        var sk = scoped(key);
        delete removed[sk];
        memory[sk] = String(value);
        try {
          if (nativeStorage && typeof nativeStorage.setItem === 'function') nativeStorage.setItem(sk, String(value));
        } catch(_) {}
      },
      removeItem: function(key) {
        var sk = scoped(key);
        delete memory[sk];
        removed[sk] = true;
        try {
          if (nativeStorage && typeof nativeStorage.removeItem === 'function') nativeStorage.removeItem(sk);
        } catch(_) {}
      }
    };
  }

  // --- DNT respect (opt-in) ---
  var RESPECT_DNT = script && script.getAttribute('data-do-not-track') === 'true';
  if (RESPECT_DNT && navigator.doNotTrack === '1') return;

  var localStore = createSafeStorage('localStorage');
  var sessionStore = createSafeStorage('sessionStorage');

  // --- Client-side disable flag ---
  if (localStore.getItem('disabled') === 'true') return;

  // --- Skip prerendered pages (Chrome Speculation Rules, <link rel="prerender">) ---
  if (document.visibilityState === 'prerender') return;

  var LINK_DOMAINS = (script && script.getAttribute('data-link-domains')) || null;
  var TRACK_OUTGOING = script && script.getAttribute('data-track-outgoing') === 'true';
  var HEARTBEAT = script && script.getAttribute('data-heartbeat');
  var TRACK_ERRORS = script && script.getAttribute('data-track-errors') === 'true';
  var TRACK_PERF = script && script.getAttribute('data-track-performance') === 'true';
  var REQUIRE_CONSENT = script && script.getAttribute('data-require-consent') === 'true';
  var TRACK_CLICKS = script && script.getAttribute('data-track-clicks') === 'true';
  var TRACK_VITALS = script && script.getAttribute('data-track-vitals') === 'true';
  var TRACK_DOWNLOADS = script && script.getAttribute('data-track-downloads') === 'true';
  var TRACK_FORMS = script && script.getAttribute('data-track-forms') === 'true';
  var TRACK_404 = script && script.getAttribute('data-track-404') === 'true';
  var TRACK_SCROLL = script && script.getAttribute('data-track-scroll-depth') === 'true';
  var TRACK_SPA = script && script.getAttribute('data-track-spa') === 'true';

  // --- Cross-subdomain identity ---
  var linkedDomains = null;
  if (LINK_DOMAINS) {
    linkedDomains = LINK_DOMAINS.split(',').map(function(d) { return d.trim().toLowerCase(); });
  }

  function isSiblingDomain(hostname) {
    if (!linkedDomains || hostname === location.hostname) return false;
    for (var i = 0; i < linkedDomains.length; i++) {
      var d = linkedDomains[i];
      if (hostname === d || hostname.endsWith('.' + d)) return true;
    }
    return false;
  }

  function adoptCrossSubdomainId() {
    if (!linkedDomains) return null;
    var p = new URLSearchParams(location.search);
    var id = p.get('_aa');
    if (id) {
      // Strip _aa from URL
      p.delete('_aa');
      var clean = location.pathname + (p.toString() ? '?' + p.toString() : '') + location.hash;
      history.replaceState(null, '', clean);
      return id;
    }
    return null;
  }

  // --- Anon ID ---
  function getAnonId() {
    var id = localStore.getItem('uid');
    if (!id) {
      id = 'anon_' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
      localStore.setItem('uid', id);
    }
    return id;
  }
  var linkedAnonId = adoptCrossSubdomainId();
  var anonId = getAnonId();
  var identifiedUserId = localStore.getItem('identified_uid') || null;
  function currentUserId() {
    return identifiedUserId || anonId;
  }

  // --- Cross-subdomain link decoration ---
  if (linkedDomains) {
    document.addEventListener('click', function(e) {
      var a = e.target.closest ? e.target.closest('a') : null;
      if (!a || !a.href) return;
      try {
        var url = new URL(a.href);
        if (isSiblingDomain(url.hostname)) {
          url.searchParams.set('_aa', anonId);
          a.href = url.toString();
        }
      } catch(_) {}
    });
  }

  // --- Session ID (30min inactivity timeout) ---
  var SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  // --- Visitor intelligence ---
  var sessionCount = parseInt(localStore.getItem('sc') || '0', 10);
  var firstVisit = parseInt(localStore.getItem('fv') || '0', 10);
  if (!firstVisit) {
    firstVisit = Date.now();
    localStore.setItem('fv', String(firstVisit));
  }

  function getSessionId() {
    var now = Date.now();
    var lastActivity = parseInt(sessionStore.getItem('last_activity') || '0', 10);
    var sid = sessionStore.getItem('sid');
    if (!sid || (lastActivity && (now - lastActivity) > SESSION_TIMEOUT)) {
      sid = 'sess_' + Math.random().toString(36).slice(2, 11) + now.toString(36);
      sessionStore.setItem('sid', sid);
      sessionCount++;
      localStore.setItem('sc', String(sessionCount));
    }
    sessionStore.setItem('last_activity', String(now));
    return sid;
  }

  // --- UTM params (session-persistent + first-touch) ---
  function getUtm() {
    var p = new URLSearchParams(location.search);
    var u = {}, keys = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'];
    var hasNew = false;
    for (var i = 0; i < keys.length; i++) {
      var v = p.get(keys[i]);
      if (v) { u[keys[i]] = v; hasNew = true; }
    }
    if (hasNew) {
      sessionStore.setItem('utm', JSON.stringify(u));
    } else {
      try { u = JSON.parse(sessionStore.getItem('utm') || '{}'); } catch(_) { u = {}; }
    }
    if (hasNew && !localStore.getItem('ft')) {
      localStore.setItem('ft', JSON.stringify(u));
    }
    return u;
  }
  var utm = getUtm();

  function sanitizeUrlLike(value) {
    if (!value) return '';
    try {
      var u = new URL(value, location.href);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin + u.pathname;
    } catch(_) {}
    return '';
  }

  // --- Browser & OS detection ---
  function detect(ua) {
    var b = 'Unknown', bv = '', os = 'Unknown';
    var m;
    if ((m = ua.match(/(Edge|Edg)\\/([\\d.]+)/))) { b = 'Edge'; bv = m[2]; }
    else if ((m = ua.match(/OPR\\/([\\d.]+)/))) { b = 'Opera'; bv = m[1]; }
    else if ((m = ua.match(/Chrome\\/([\\d.]+)/))) { b = 'Chrome'; bv = m[1]; }
    else if ((m = ua.match(/Safari\\/([\\d.]+)/))) {
      if ((m = ua.match(/Version\\/([\\d.]+)/))) { b = 'Safari'; bv = m[1]; }
    }
    else if ((m = ua.match(/Firefox\\/([\\d.]+)/))) { b = 'Firefox'; bv = m[1]; }

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

  // --- Timezone ---
  var tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch(_) {}

  // --- Client Hints (Chromium low-entropy, sync) ---
  if (navigator.userAgentData) {
    var uad = navigator.userAgentData;
    if (typeof uad.mobile === 'boolean' && uad.mobile) dev.device = 'mobile';
    if (uad.platform) {
      var plat = uad.platform;
      if (plat === 'macOS') dev.os = 'macOS';
      else if (plat === 'Windows') dev.os = 'Windows';
      else if (plat === 'Android') dev.os = 'Android';
      else if (plat === 'Chrome OS' || plat === 'ChromeOS') dev.os = 'ChromeOS';
      else if (plat === 'Linux') dev.os = 'Linux';
      else if (plat === 'iOS') dev.os = 'iOS';
    }
    if (uad.brands && uad.brands.length) {
      for (var bi = 0; bi < uad.brands.length; bi++) {
        var bn = uad.brands[bi].brand;
        if (bn === 'Google Chrome') { dev.browser = 'Chrome'; dev.browser_version = uad.brands[bi].version; break; }
        if (bn === 'Microsoft Edge') { dev.browser = 'Edge'; dev.browser_version = uad.brands[bi].version; break; }
        if (bn === 'Opera') { dev.browser = 'Opera'; dev.browser_version = uad.brands[bi].version; break; }
      }
    }
  }

  // --- Consent management ---
  var consentRequired = REQUIRE_CONSENT;
  var consentGranted = REQUIRE_CONSENT ? localStore.getItem('consent') === 'granted' : false;

  // --- Event queue ---
  var queue = [];
  var flushTimer = null;
  var FLUSH_INTERVAL = 5000;
  var MAX_BATCH_EVENTS = 100;

  function send(url, data) {
    if (navigator.sendBeacon) {
      if (navigator.sendBeacon(url, new Blob([data], {type: 'text/plain'}))) return;
    }
    fetch(url, {
      method: 'POST',
      body: data,
      keepalive: true,
      credentials: 'omit'
    }).catch(function() {});
  }

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function isReservedEmailKey(key) {
    return typeof key === 'string' && key.toLowerCase().indexOf('email') !== -1;
  }

  function sanitizeProps(props) {
    if (Array.isArray(props)) {
      var cleanArray = [];
      for (var ai = 0; ai < props.length; ai++) {
        var item = props[ai];
        if (item && typeof item === 'object') cleanArray.push(sanitizeProps(item));
        else if (item !== undefined) cleanArray.push(item);
      }
      return cleanArray;
    }
    var clean = {};
    if (!props || typeof props !== 'object') return clean;
    for (var key in props) {
      if (!props.hasOwnProperty(key)) continue;
      if (isReservedEmailKey(key)) continue;
      if (props[key] === undefined) continue;
      if (props[key] && typeof props[key] === 'object') {
        clean[key] = sanitizeProps(props[key]);
      } else {
        clean[key] = props[key];
      }
    }
    return clean;
  }

  function sanitizeIdentifyTraits(traits) {
    var clean = sanitizeProps(traits);
    var email = traits && traits.email ? normalizeEmail(traits.email) : '';
    if (email) clean.email = email;
    return clean;
  }

  function sendIdentify(previousId, nextId, traits) {
    if (!previousId || !nextId || !TOKEN || (consentRequired && !consentGranted)) return;

    var cleanTraits = sanitizeIdentifyTraits(traits);
    var payload = {
      token: TOKEN,
      previous_id: previousId,
      user_id: nextId
    };
    if (Object.keys(cleanTraits).length > 0) payload.traits = cleanTraits;
    if (payload.traits || previousId !== nextId) {
      send(ENDPOINT.replace('/track', '/identify'), JSON.stringify(payload));
    }
  }

  if (linkedAnonId && linkedAnonId !== anonId) {
    sendIdentify(linkedAnonId, anonId);
  }

  function flush() {
    if (!queue.length || (consentRequired && !consentGranted)) return;
    var batch = queue.splice(0);
    while (batch.length) {
      var chunk = batch.splice(0, MAX_BATCH_EVENTS);
      if (chunk.length === 1) {
        send(ENDPOINT, JSON.stringify(chunk[0]));
      } else {
        send(ENDPOINT.replace('/track', '/track/batch'), JSON.stringify({ events: chunk }));
      }
    }
  }

  function scheduleFlush() {
    if (consentRequired && !consentGranted) return;
    if (!flushTimer) flushTimer = setTimeout(function() { flushTimer = null; flush(); }, FLUSH_INTERVAL);
  }

  // Flush on visibility hidden / beforeunload
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('beforeunload', flush);

  // --- Global sticky properties ---
  var globalProps = {};

  // --- Common properties ---
  function baseProps(extra) {
    var p = {
      url: sanitizeUrlLike(location.href),
      path: location.pathname,
      hostname: location.hostname,
      referrer: sanitizeUrlLike(document.referrer),
      title: document.title,
      screen: screen.width + 'x' + screen.height,
      language: navigator.language || '',
      browser: dev.browser,
      browser_version: dev.browser_version,
      os: dev.os,
      device: dev.device,
      timezone: tz
    };
    // Visitor intelligence
    p.session_count = sessionCount;
    p.days_since_first_visit = Math.floor((Date.now() - firstVisit) / 86400000);
    // Merge UTM
    for (var k in utm) { if (utm.hasOwnProperty(k)) p[k] = utm[k]; }
    // Merge first-touch attribution
    try {
      var ft = JSON.parse(localStore.getItem('ft') || '{}');
      for (var kf in ft) { if (ft.hasOwnProperty(kf)) p['first_' + kf] = ft[kf]; }
    } catch(_) {}
    // Merge global sticky props
    var gp = sanitizeProps(globalProps);
    for (var k1 in gp) { if (gp.hasOwnProperty(k1)) p[k1] = gp[k1]; }
    // Merge extra (event-specific overrides global)
    var ep = sanitizeProps(extra);
    for (var k2 in ep) { if (ep.hasOwnProperty(k2)) p[k2] = ep[k2]; }
    return p;
  }

  // --- Experiments ---
  var experimentCache = {};
  var experimentConfig = null;

  var aa = {
    track: function(event, properties) {
      queue.push({
        project: PROJECT,
        token: TOKEN,
        event: event,
        properties: baseProps(properties),
        user_id: currentUserId(),
        session_id: getSessionId(),
        timestamp: Date.now()
      });
      scheduleFlush();
    },

    identify: function(id, traits) {
      if (!id) return;
      var previousId = currentUserId();
      identifiedUserId = id;
      localStore.setItem('identified_uid', id);
      flush();
      sendIdentify(previousId, id, traits || {});
    },

    page: function(name) {
      this.track('page_view', { page: name || document.title });
    },

    experiment: function(name, variants) {
      if (experimentCache[name] !== undefined) return experimentCache[name];

      var config = null;
      if (experimentConfig) {
        for (var i = 0; i < experimentConfig.length; i++) {
          if (experimentConfig[i].key === name) { config = experimentConfig[i]; break; }
        }
      }

      if (!config && variants) {
        var w = Math.floor(100 / variants.length);
        var remainder = 100 - (w * variants.length);
        config = { key: name, variants: variants.map(function(v, idx) { return { key: v, weight: w + (idx === 0 ? remainder : 0) }; }) };
      }

      if (!config) return null;

      // URL param override: ?aa_variant_<name>=<variant>
      var urlForced = new URLSearchParams(location.search).get('aa_variant_' + name);
      if (urlForced) {
        for (var vi = 0; vi < config.variants.length; vi++) {
          if (config.variants[vi].key === urlForced) {
            experimentCache[name] = urlForced;
            aa.track('$experiment_exposure', { experiment: name, variant: urlForced, forced: true });
            return urlForced;
          }
        }
        // Invalid variant — fall through to normal hash
      }

      var str = name + '.' + currentUserId();
      var hash = 0;
      for (var j = 0; j < str.length; j++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(j);
        hash |= 0;
      }
      var bucket = Math.abs(hash) % 100;

      var cumulative = 0;
      var assigned = config.variants[0].key;
      for (var k = 0; k < config.variants.length; k++) {
        cumulative += config.variants[k].weight;
        if (bucket < cumulative) { assigned = config.variants[k].key; break; }
      }

      experimentCache[name] = assigned;
      aa.track('$experiment_exposure', { experiment: name, variant: assigned });
      return assigned;
    },

    set: function(props) {
      if (!props) return;
      var clean = sanitizeProps(props);
      for (var k in clean) {
        if (clean.hasOwnProperty(k)) {
          if (props[k] === null) delete globalProps[k];
          else globalProps[k] = clean[k];
        }
      }
    },

    requireConsent: function() {
      consentRequired = true;
      consentGranted = localStore.getItem('consent') === 'granted';
    },

    grantConsent: function() {
      consentGranted = true;
      localStore.setItem('consent', 'granted');
      aa.track('$consent', { action: 'granted' });
      flush();
    },

    revokeConsent: function() {
      consentGranted = false;
      localStore.removeItem('consent');
      queue.length = 0;
    }
  };

  // --- Declarative experiments ---
  function applyDeclarativeExperiments() {
    var els = document.querySelectorAll('[data-aa-experiment]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var name = el.getAttribute('data-aa-experiment');
      var variant = aa.experiment(name);
      if (variant) {
        var attr = el.getAttribute('data-aa-variant-' + variant.toLowerCase());
        if (attr !== null) {
          el.innerHTML = attr;
        }
      }
    }
    document.documentElement.classList.remove('aa-loading');
  }

  (function loadExperimentConfig() {
    if (!TOKEN) { applyDeclarativeExperiments(); return; }
    var configUrl = ENDPOINT.replace('/track', '/experiments/config') + '?token=' + TOKEN;
    fetch(configUrl, { credentials: 'omit' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        experimentConfig = data.experiments || [];
        applyDeclarativeExperiments();
      })
      .catch(function() {
        applyDeclarativeExperiments();
      });
  })();

  // --- SPA route tracking ---
  // SPA route automation is opt-in so sites keep explicit control over URL-derived
  // page views and history monkey-patching. The initial page view and manual
  // aa.page() calls remain available without enabling automatic route listeners.
  var lastPath = location.pathname + location.search + location.hash;
  var _flushTimeOnPage = null; // set by heartbeat if enabled
  var _resetErrorTracking = null; // set by error tracking if enabled
  var _scanImpressions = null; // set by impression tracking
  var _flushWebVitals = null; // set by web vitals if enabled
  var _flushScrollDepth = null; // set by scroll depth if enabled
  var _check404 = null; // set by 404 tracking if enabled
  function onRoute() {
    var cur = location.pathname + location.search + location.hash;
    if (cur !== lastPath) {
      if (_flushTimeOnPage) _flushTimeOnPage();
      if (_flushWebVitals) _flushWebVitals();
      if (_flushScrollDepth) _flushScrollDepth();
      if (_resetErrorTracking) _resetErrorTracking();
      if (_scanImpressions) _scanImpressions();
      lastPath = cur;
      utm = getUtm(); // re-parse UTM on navigation
      aa.page();
      if (_check404) _check404();
    }
  }
  if (TRACK_SPA) {
    window.addEventListener('popstate', onRoute);
    window.addEventListener('hashchange', onRoute);
    // Monkey-patch pushState / replaceState only after explicit SPA opt-in.
    ['pushState', 'replaceState'].forEach(function(fn) {
      var orig = history[fn];
      history[fn] = function() {
        var r = orig.apply(this, arguments);
        onRoute();
        return r;
      };
    });

    // --- bfcache route support ---
    window.addEventListener('pageshow', function(e) {
      if (e.persisted) {
        if (_flushTimeOnPage) _flushTimeOnPage();
        if (_flushWebVitals) _flushWebVitals();
        if (_flushScrollDepth) _flushScrollDepth();
        lastPath = location.pathname + location.search + location.hash;
        utm = getUtm();
        aa.page();
        if (_check404) _check404();
        if (_scanImpressions) _scanImpressions();
      }
    });
  }

  // --- Declarative event tracking ---
  document.addEventListener('click', function(e) {
    var el = e.target.closest ? e.target.closest('[data-aa-event]') : null;
    if (!el) return;
    var event = el.getAttribute('data-aa-event');
    if (!event) return;
    var props = {};
    var attrs = el.attributes;
    for (var i = 0; i < attrs.length; i++) {
      var name = attrs[i].name;
      if (name.startsWith('data-aa-event-')) {
        props[name.slice(14)] = attrs[i].value;
      }
    }
    aa.track(event, props);
  });

  // --- Outgoing link tracking ---
  if (TRACK_OUTGOING) {
    document.addEventListener('click', function(e) {
      var a = e.target.closest ? e.target.closest('a') : null;
      if (!a || !a.href) return;
      try {
        var url = new URL(a.href);
        if (url.hostname && url.hostname !== location.hostname && url.protocol.startsWith('http')) {
          aa.track('outgoing_link', {
            href: sanitizeUrlLike(a.href),
            text: (a.textContent || '').trim().slice(0, 200),
            hostname: url.hostname
          });
        }
      } catch(_) {}
    });
  }

  // --- Click tracking ---
  if (TRACK_CLICKS) {
    document.addEventListener('click', function(e) {
      // Skip elements with declarative tracking to avoid double-tracking
      var decl = e.target.closest ? e.target.closest('[data-aa-event]') : null;
      if (decl) return;
      var el = e.target.closest ? e.target.closest('a, button') : null;
      if (!el) return;
      var tag = el.tagName.toLowerCase();
      var props = {
        tag: tag,
        text: (el.textContent || '').trim().slice(0, 200),
        id: el.id || '',
        classes: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 200)
      };
      if (tag === 'a') {
        var href = el.href || '';
        props.href = sanitizeUrlLike(href);
        try {
          var u = new URL(href);
          if (/^(mailto|tel|javascript):/.test(href)) return;
          props.is_external = u.hostname !== location.hostname;
        } catch(_) {
          props.is_external = false;
        }
      } else {
        props.type = el.type || 'submit';
      }
      aa.track('$click', props);
    });
  }

  // --- File download tracking ---
  if (TRACK_DOWNLOADS) {
    var DL_EXT = /\\.(pdf|xlsx?|docx?|txt|rtf|csv|exe|key|pps|pptx?|7z|pkg|rar|gz|zip|avi|mov|mp4|mpeg|wmv|midi|mp3|wav|wma|dmg|iso|msi)$/i;
    document.addEventListener('click', function(e) {
      var a = e.target.closest ? e.target.closest('a') : null;
      if (!a || !a.href) return;
      if (a.closest && a.closest('[data-aa-event]')) return;
      try {
        var url = new URL(a.href);
        if (!url.protocol.startsWith('http')) return;
        var path = url.pathname;
        var m = path.match(DL_EXT);
        if (m) {
          aa.track('$download', {
            href: url.origin + url.pathname,
            filename: path.split('/').pop(),
            extension: m[1].toLowerCase()
          });
        }
      } catch(_) {}
    });
  }

  // --- Form submission tracking ---
  if (TRACK_FORMS) {
    document.addEventListener('submit', function(e) {
      var form = e.target;
      if (!form || form.tagName !== 'FORM') return;
      if (form.getAttribute('data-aa-event')) return;
      if (!form.hasAttribute('novalidate') && form.checkValidity && !form.checkValidity()) return;
      aa.track('$form_submit', {
        id: form.id || '',
        name: form.getAttribute('name') || '',
        action: sanitizeUrlLike(form.action).slice(0, 500),
        method: (form.method || 'GET').toUpperCase(),
        classes: (form.className && typeof form.className === 'string' ? form.className : '').slice(0, 200)
      });
    }, true);
  }

  // --- 404 page tracking ---
  if (TRACK_404) {
    function check404() {
      var is404 = false;
      var meta = document.querySelector('meta[name="aa-status"]');
      if (meta && meta.content === '404') is404 = true;
      if (!is404) {
        try {
          var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
          if (nav && nav.responseStatus === 404) is404 = true;
        } catch(_) {}
      }
      if (is404) {
        aa.track('$404', {
          path: location.pathname,
          referrer: sanitizeUrlLike(document.referrer),
          title: document.title
        });
      }
    }
    _check404 = check404;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', check404);
    } else {
      setTimeout(check404, 0);
    }
  }

  // --- Content impression tracking ---
  (function() {
    if (!window.IntersectionObserver) return;
    var observer;
    function scan() {
      if (observer) observer.disconnect();
      var els = document.querySelectorAll('[data-aa-impression]');
      if (!els.length) return;
      observer = new IntersectionObserver(function(entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            var el = entries[i].target;
            var name = el.getAttribute('data-aa-impression');
            if (!name) continue;
            var props = { name: name };
            var attrs = el.attributes;
            for (var j = 0; j < attrs.length; j++) {
              var a = attrs[j].name;
              if (a.startsWith('data-aa-impression-')) {
                props[a.slice(19)] = attrs[j].value;
              }
            }
            aa.track('$impression', props);
            observer.unobserve(el);
          }
        }
      }, { threshold: 0.5 });
      for (var i = 0; i < els.length; i++) observer.observe(els[i]);
    }
    scan();
    _scanImpressions = scan;
  })();

  // --- JS error tracking ---
  if (TRACK_ERRORS) {
    var errSeen = {};
    var errCount = 0;
    var ERR_CAP = 5;

    _resetErrorTracking = function() { errSeen = {}; errCount = 0; };

    window.addEventListener('error', function(e) {
      if (errCount >= ERR_CAP) return;
      var key = (e.message || '') + '|' + (e.filename || '') + '|' + (e.lineno || 0);
      if (errSeen[key]) return;
      errSeen[key] = 1;
      errCount++;
      aa.track('$error', {
        message: (e.message || '').slice(0, 500),
        source: e.filename || '',
        line: e.lineno || 0,
        col: e.colno || 0
      });
    });

    window.addEventListener('unhandledrejection', function(e) {
      if (errCount >= ERR_CAP) return;
      var msg = e.reason instanceof Error ? e.reason.message : String(e.reason || '');
      var key = msg + '||0';
      if (errSeen[key]) return;
      errSeen[key] = 1;
      errCount++;
      aa.track('$error', {
        message: msg.slice(0, 500),
        source: '',
        line: 0,
        col: 0
      });
    });
  }

  // --- Performance timing ---
  if (TRACK_PERF) {
    function collectPerf() {
      var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
      if (!nav) return;
      aa.track('$performance', {
        path: location.pathname,
        perf_dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
        perf_tcp: Math.round(nav.connectEnd - nav.connectStart),
        perf_ttfb: Math.round(nav.responseStart - nav.requestStart),
        perf_dom_interactive: Math.round(nav.domInteractive),
        perf_dom_complete: Math.round(nav.domComplete),
        perf_load: Math.round(nav.loadEventEnd)
      });
    }
    if (document.readyState === 'complete') {
      setTimeout(collectPerf, 0);
    } else {
      window.addEventListener('load', function() { setTimeout(collectPerf, 0); });
    }
  }

  // --- Core Web Vitals ---
  if (TRACK_VITALS) {
    var cwvLcp = -1, cwvCls = 0, cwvInp = [];
    var cwvFlushed = false;

    function cwvFlush() {
      if (cwvFlushed) return;
      if (cwvLcp < 0 && cwvCls === 0 && cwvInp.length === 0) return;
      cwvFlushed = true;
      var props = { path: location.pathname };
      if (cwvLcp >= 0) props.cwv_lcp = Math.round(cwvLcp);
      props.cwv_cls = Math.round(cwvCls * 1000) / 1000;
      if (cwvInp.length > 0) {
        cwvInp.sort(function(a, b) { return a - b; });
        var idx = Math.min(Math.ceil(cwvInp.length * 0.98) - 1, cwvInp.length - 1);
        props.cwv_inp = cwvInp[Math.max(idx, 0)];
      }
      aa.track('$web_vitals', props);
    }

    function cwvReset() {
      cwvFlush();
      cwvLcp = -1;
      cwvCls = 0;
      cwvInp = [];
      cwvFlushed = false;
    }

    // LCP
    try {
      new PerformanceObserver(function(list) {
        var entries = list.getEntries();
        if (entries.length) cwvLcp = entries[entries.length - 1].startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch(_) {}

    // CLS
    try {
      new PerformanceObserver(function(list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].hadRecentInput) cwvCls += entries[i].value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch(_) {}

    // INP
    try {
      new PerformanceObserver(function(list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].interactionId) cwvInp.push(entries[i].duration);
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    } catch(_) {}

    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'hidden') cwvFlush();
    });
    window.addEventListener('beforeunload', cwvFlush);
    _flushWebVitals = cwvReset;
  }

  // --- Scroll depth tracking ---
  if (TRACK_SCROLL) {
    function sdDocHeight() {
      var b = document.body, e = document.documentElement;
      return Math.max(b.scrollHeight, b.offsetHeight, b.clientHeight,
        e.scrollHeight, e.offsetHeight, e.clientHeight);
    }

    var sdH = sdDocHeight();
    var sdMax = 0;
    var sdFlushed = false;

    function sdMeasure() {
      sdH = sdDocHeight();
      var vh = window.innerHeight || document.documentElement.clientHeight || 0;
      var px = sdH <= vh ? sdH : (window.scrollY || 0) + vh;
      if (px > sdMax) sdMax = px;
    }

    function sdFlush() {
      if (sdFlushed) return;
      sdMeasure();
      if (sdMax > 0 && sdH > 0) {
        sdFlushed = true;
        var pct = Math.min(Math.round((sdMax / sdH) * 100), 100);
        aa.track('$scroll_depth', { scroll_depth: pct, path: location.pathname });
      }
    }

    function sdReset() {
      sdFlush();
      sdMax = 0;
      sdFlushed = false;
      sdMeasure();
    }

    sdMeasure();
    document.addEventListener('scroll', sdMeasure, { passive: true });

    function sdAfterLoad() {
      var c = 0;
      var iv = setInterval(function() { sdMeasure(); if (++c >= 15) clearInterval(iv); }, 200);
    }
    if (document.readyState === 'complete') sdAfterLoad();
    else window.addEventListener('load', sdAfterLoad);

    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'hidden') sdFlush();
    });
    window.addEventListener('beforeunload', sdFlush);
    _flushScrollDepth = sdReset;
  }

  // --- Time-on-page engagement tracking ---
  if (HEARTBEAT) {
    var hbInterval = parseInt(HEARTBEAT, 10);
    if (hbInterval > 0) {
      hbInterval = Math.max(hbInterval, 15);
      var hbSeconds = 0;
      var hbTimer = null;

      function hbStart() {
        if (hbTimer) return;
        hbTimer = setInterval(function() { hbSeconds += hbInterval; }, hbInterval * 1000);
      }

      function hbStop() {
        if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
      }

      function hbFlush() {
        if (hbSeconds > 0) {
          aa.track('$time_on_page', { time_on_page: hbSeconds, path: location.pathname });
          hbSeconds = 0;
        }
      }

      document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') hbStart();
        else { hbStop(); hbFlush(); }
      });

      if (document.visibilityState !== 'hidden') hbStart();

      window.addEventListener('beforeunload', function() { hbStop(); hbFlush(); });
      _flushTimeOnPage = function() { hbStop(); hbFlush(); hbStart(); };
    }
  }

  // Auto track initial page view
  aa.page();

  window.aa = aa;
})();
`;
