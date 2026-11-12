/**
 * vsl-statistic tracker — measures how long visitors actually watch a VSL.
 *
 * Install (one line, anywhere on the landing):
 *   <script src="https://<stats-host>/t.js" data-land="uroactive-es" defer></script>
 *
 * Options (data-* on the script tag):
 *   data-land          landing name in the stats (default: host + path)
 *   data-video-src     on a <video>: the stream URL to report, for players that
 *                      hide it behind a blob: URL. Rarely needed — the .m3u8 is
 *                      found among the page's own requests.
 *   data-popup-at      second the offer pops up — drawn on the retention chart
 *                      (default: the landing's global `timerPOPUP`, if any)
 *   data-count-muted   "1" to count muted playback too (default: muted
 *                      autoplay previews are ignored until the sound is on)
 *   data-buyer-param   URL param carrying the buyer (default: buyer, sub_id_1, sub1)
 *
 * From the landing you can add your own moments to the timeline:
 *   window.vslStat && vslStat.mark('form_open');
 *
 * Every <video> on the page is tracked. What gets sent is the full state of
 * this page view — a bitmap of the seconds actually played (seeking does not
 * fill it), play time, furthest position, errors, and whether a form was
 * submitted — so a lost beacon loses nothing: the next one carries it all.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script || window.__vslStat) return;
  window.__vslStat = true;

  var ENDPOINT = new URL('/api/collect', script.src).href;
  var HEARTBEAT_MS = 15000;
  var MAX_SECONDS = 4 * 60 * 60;
  var data = script.dataset || {};

  // The install snippet ships with a placeholder; pasted unedited it would lump
  // every landing together, so it counts as "not set".
  var landAttr = data.land && data.land !== 'LAND-NAME' && data.land.indexOf('{') < 0 ? data.land : '';
  var land = (landAttr || location.hostname + location.pathname.replace(/index\.(html?|php)$/, '')).slice(0, 200);
  var countMuted = data.countMuted === '1';
  var sid = randomId();
  var tracked = [];
  var marks = [];
  var submitted = false;
  var lastSent = '';
  var params = new URLSearchParams(location.search);

  var attr = {
    subid: cookie('_subid') || params.get('subid') || params.get('_subid'),
    buyer: firstParam((data.buyerParam || 'buyer,sub_id_1,sub1').split(',')),
    utm_source: params.get('utm_source'),
    utm_campaign: params.get('utm_campaign') || params.get('campaign_name'),
  };

  /* ---------------- per-video state ---------------- */

  function track(video, index) {
    if (video.__vslStat) return;
    var s = {
      el: video,
      key: (video.getAttribute('data-video-id') || video.id || 'video-' + index).slice(0, 64),
      bits: new Uint8Array(0),
      lastT: null,
      lastWall: 0,
      maxPos: 0,
      playTime: 0,
      started: false,
      ended: false,
      err: null,
    };
    video.__vslStat = s;
    tracked.push(s);

    video.addEventListener('timeupdate', function () { tick(s); });
    video.addEventListener('playing', function () { s.lastWall = Date.now(); tick(s); });
    video.addEventListener('volumechange', function () { tick(s); });
    video.addEventListener('pause', function () { s.lastT = null; send(); });
    video.addEventListener('seeking', function () { s.lastT = null; });
    video.addEventListener('ended', function () { s.ended = true; s.lastT = null; send(); });
    video.addEventListener('error', function () {
      var e = video.error;
      s.err = e ? 'media-' + e.code + (e.message ? ': ' + e.message : '') : 'error';
      send();
    });
    // The <source> children report their own errors.
    var sources = video.querySelectorAll('source');
    for (var i = 0; i < sources.length; i++) {
      sources[i].addEventListener('error', function () { s.err = s.err || 'source-error'; send(); });
    }
  }

  /** Counted = actually watched: playing, not seeking, and audible unless opted in. */
  function counting(v) {
    return !v.paused && !v.seeking && !v.ended && (countMuted || (!v.muted && v.volume > 0));
  }

  function tick(s) {
    var v = s.el;
    if (!counting(v)) { s.lastT = null; return; }

    var t = v.currentTime;
    var now = Date.now();
    if (!s.started) { s.started = true; s.lastWall = now; setTimeout(send, 0); }

    // Fill every second between two consecutive updates of normal playback;
    // a jump bigger than that is a seek and fills nothing.
    var from = s.lastT !== null && t >= s.lastT && t - s.lastT <= 2 ? s.lastT : t;
    for (var sec = Math.floor(from); sec <= Math.floor(t) && sec < MAX_SECONDS; sec++) setBit(s, sec);

    s.playTime += Math.min(Math.max(now - s.lastWall, 0), 2000) / 1000;
    s.lastWall = now;
    s.lastT = t;
    if (t > s.maxPos) s.maxPos = t;
  }

  function setBit(s, sec) {
    var byte = sec >> 3;
    if (byte >= s.bits.length) {
      var grown = new Uint8Array(Math.max(byte + 1, s.bits.length * 2, 64));
      grown.set(s.bits);
      s.bits = grown;
    }
    s.bits[byte] |= 1 << (sec & 7);
  }

  /* ---------------- sending ---------------- */

  function snapshot() {
    var videos = [];
    for (var i = 0; i < tracked.length; i++) {
      var s = tracked[i];
      var v = s.el;
      var src = streamUrl(v);
      if (!src) continue;
      videos.push({
        key: s.key,
        src: src.slice(0, 1000),
        dur: isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration * 10) / 10 : null,
        popupAt: popupAt(),
        bits: toBase64(trimBits(s.bits)),
        maxPos: Math.round(s.maxPos * 10) / 10,
        playTime: Math.round(s.playTime * 10) / 10,
        started: s.started,
        ended: s.ended,
        err: s.err,
      });
    }
    return {
      v: 1,
      sid: sid,
      land: land,
      page: (location.host + location.pathname).slice(0, 500),
      ref: document.referrer ? document.referrer.slice(0, 300) : null,
      attr: attr,
      submitted: submitted,
      videos: videos,
      marks: marks.slice(0, 50),
    };
  }

  function send() {
    var body = snapshot();
    if (!body.videos.length) return;
    var json = JSON.stringify(body);
    if (json === lastSent) return;
    lastSent = json;
    try {
      // text/plain keeps it a "simple" request — no CORS preflight.
      var blob = new Blob([json], { type: 'text/plain' });
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob)) return;
    } catch (e) { /* fall through */ }
    try {
      fetch(ENDPOINT, { method: 'POST', body: json, keepalive: true, mode: 'no-cors' });
    } catch (e) { /* nothing else to try */ }
  }

  /* ---------------- helpers ---------------- */

  function popupAt() {
    var fromAttr = parseFloat(data.popupAt);
    if (isFinite(fromAttr)) return fromAttr;
    try {
      // The landing template declares `const timerPOPUP` in a classic script:
      // a global lexical binding, reachable by name but not via `window`.
      /* global timerPOPUP */
      if (typeof timerPOPUP === 'number' && isFinite(timerPOPUP)) return timerPOPUP;
    } catch (e) { /* not declared */ }
    return null;
  }

  /**
   * The URL that identifies the video across visits. Players built on Media
   * Source Extensions (hls.js, video.js) set src to a blob: URL that is new on
   * every page load — useless as an id — so fall back to the manifest the page
   * actually requested.
   */
  function streamUrl(v) {
    var source = v.querySelector('source[src]');
    var candidates = [
      v.getAttribute('data-video-src'),
      v.getAttribute('src'),
      source && source.getAttribute('src'),
      v.currentSrc,
    ];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c && c.indexOf('blob:') !== 0) return absolute(c);
    }
    return manifestUrl() || v.currentSrc || '';
  }

  /** The HLS/DASH manifest among the page's requests — master playlist first. */
  function manifestUrl() {
    if (!window.performance || !performance.getEntriesByType) return '';
    var entries = performance.getEntriesByType('resource');
    var found = '';
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i].name;
      if (!/\.(m3u8|mpd)(\?|#|$)/i.test(name)) continue;
      if (/master/i.test(name)) return name;
      if (!found) found = name;
    }
    return found;
  }

  function absolute(url) {
    try {
      return new URL(url, location.href).href;
    } catch (e) {
      return url;
    }
  }

  function trimBits(bits) {
    var end = bits.length;
    while (end > 0 && bits[end - 1] === 0) end--;
    return bits.subarray(0, end);
  }

  function toBase64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function randomId() {
    var a = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(a);
    var out = '';
    for (var i = 0; i < a.length; i++) out += ('0' + a[i].toString(16)).slice(-2);
    return out;
  }

  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function firstParam(names) {
    for (var i = 0; i < names.length; i++) {
      var value = params.get(names[i].trim());
      if (value && value.charAt(0) !== '{') return value; // skip unfilled {macros}
    }
    return null;
  }

  function scan() {
    var videos = document.getElementsByTagName('video');
    for (var i = 0; i < videos.length; i++) track(videos[i], i);
  }

  /* ---------------- wiring ---------------- */

  window.vslStat = {
    mark: function (name) {
      var v = tracked[0] && tracked[0].el;
      marks.push([String(name).slice(0, 40), v ? Math.round(v.currentTime * 10) / 10 : 0]);
      send();
    },
    sid: sid,
  };

  document.addEventListener('submit', function () { submitted = true; send(); }, true);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') send();
  });
  window.addEventListener('pagehide', send);

  setInterval(function () {
    for (var i = 0; i < tracked.length; i++) if (counting(tracked[i].el)) { send(); return; }
  }, HEARTBEAT_MS);

  function boot() {
    scan();
    if (window.MutationObserver) {
      new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    }
    // Register the view itself even if nobody presses play.
    setTimeout(send, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
