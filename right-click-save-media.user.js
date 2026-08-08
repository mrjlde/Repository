// ==UserScript==
// @name         (Jay.D) V1.0.2 - (Right-Click) Save Media
// @namespace    local.tools
// @version      1.0.2
// @description  Right-click media/link to copy/open/download URL + optional MP3/MP4 conversion for direct file URLs.
// @match        *://*/*
// @match        https://www.facebook.com/*
// @match        https://m.facebook.com/*
// @match        https://web.facebook.com/*
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_NAME = '(Jay.D) V1.0.2 - (Right-Click) Save Media';
  const MENU_ID = 'tm-save-media-menu';
  const TOAST_ID = 'tm-save-media-toast';
  const UI_FONT = "'Poppins', 'Nunito Sans', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";
  const TITLE_FONT = "'Sora', 'Poppins', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";
  const DOUBLE_RCLICK_MS = 450;
  const DOUBLE_RCLICK_PX = 24;

  const FFMPEG_VER = '0.12.15';
  const CORE_VER = '0.12.10';
  const FFMPEG_CLASSES_SRC = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/esm/classes.js`;
  const FFMPEG_WORKER_SRC = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/esm/worker.js`;
  const FFMPEG_CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VER}/dist/umd`;

  let lastHandledAt = 0;
  let lastContext = { t: 0, x: 0, y: 0, url: '' };
  let toastTimer = null;

  let _ffmpeg = null;
  let _ffmpegLoadPromise = null;
  let _ffmpegAssets = null;

  function removeMenu() {
    const old = document.getElementById(MENU_ID);
    if (old) old.remove();
  }

  function showToast(text) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      toast.style.cssText = [
        'position:fixed',
        'left:50%',
        'bottom:20px',
        'transform:translateX(-50%)',
        'z-index:2147483647',
        'padding:8px 12px',
        'border-radius:8px',
        'background:linear-gradient(135deg, rgba(42,19,64,.95), rgba(12,12,12,.95))',
        'border:1px solid #5a2d86',
        'color:#d8ff9e',
        `font:13px/1.28 ${UI_FONT}`,
        'box-shadow:0 0 0 1px rgba(120,255,90,.2), 0 0 14px rgba(120,255,90,.2), 0 0 30px rgba(120,255,90,.12), 0 10px 24px rgba(0,0,0,.4)',
        'text-shadow:0 0 8px rgba(120,255,90,.65)',
        'opacity:0',
        'transition:opacity .15s ease',
        'pointer-events:none'
      ].join(';');
      document.documentElement.appendChild(toast);
    }
    toast.textContent = `${SCRIPT_NAME} • ${text}`;
    toast.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.style.opacity = '0';
    }, 1300);
  }

  function stripWrappingQuotes(s) {
    const t = String(s || '').trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
    return t;
  }

  function safeURL(raw) {
    if (!raw) return null;
    const cleaned = stripWrappingQuotes(raw).replace(/\\([()'"])/g, '$1').trim();
    if (!cleaned) return null;
    try {
      const u = new URL(cleaned, location.href);
      const p = u.protocol.toLowerCase();
      if (p === 'javascript:' || p === 'file:' || p === 'about:') return null;
      if (p === 'http:' || p === 'https:' || p === 'blob:' || p === 'data:') return u.toString();
      return null;
    } catch {
      return null;
    }
  }

  function isUsableUrl(u) {
    return !!u && (u.startsWith('https://') || u.startsWith('http://'));
  }

  function normalizePreferredLink(raw) {
    const s = safeURL(raw);
    if (!s) return null;

    try {
      const u = new URL(s);
      const host = u.hostname.toLowerCase();

      if (host.includes('youtube.com')) {
        if (u.pathname === '/watch' && u.searchParams.get('v')) return `${u.origin}/watch?v=${u.searchParams.get('v')}`;
        if (u.pathname.startsWith('/shorts/')) return `${u.origin}${u.pathname}`;
        if (u.pathname.startsWith('/live/')) return `${u.origin}${u.pathname}`;
      }

      if (host === 'youtu.be') {
        const id = u.pathname.replace(/^\/+/, '').split('/')[0];
        if (id) return `https://www.youtube.com/watch?v=${id}`;
      }

      return u.toString();
    } catch {
      return null;
    }
  }

  function isBadPreviewUrl(url) {
    try {
      const h = new URL(url).hostname.toLowerCase();
      return h === 'i.ytimg.com' || h.endsWith('.ytimg.com');
    } catch {
      return false;
    }
  }

  function parseBackgroundImage(bg) {
    if (!bg || bg === 'none') return [];
    const out = [];
    const re = /url\((['"]?)(.*?)\1\)/ig;
    let m;
    while ((m = re.exec(bg))) if (m[2]) out.push(m[2]);
    return out;
  }

  function parseSrcset(srcset) {
    if (!srcset) return [];
    return srcset.split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean);
  }

  function getCandidatesFromElement(el) {
    if (!(el instanceof Element)) return [];
    const c = [];

    const pushAttr = (name) => {
      const v = el.getAttribute(name);
      if (v) c.push(v);
    };

    if (el instanceof HTMLImageElement) {
      if (el.currentSrc) c.push(el.currentSrc);
      if (el.src) c.push(el.src);
      c.push(...parseSrcset(el.srcset));
      pushAttr('data-src');
      pushAttr('data-original');
      pushAttr('data-url');
    }

    if (el instanceof HTMLVideoElement) {
      if (el.currentSrc) c.push(el.currentSrc);
      if (el.src) c.push(el.src);
      if (el.poster) c.push(el.poster);
      el.querySelectorAll('source[src]').forEach((s) => {
        const v = s.getAttribute('src');
        if (v) c.push(v);
      });
    }

    if (el instanceof HTMLAudioElement) {
      if (el.currentSrc) c.push(el.currentSrc);
      if (el.src) c.push(el.src);
      el.querySelectorAll('source[src]').forEach((s) => {
        const v = s.getAttribute('src');
        if (v) c.push(v);
      });
    }

    if (el instanceof HTMLSourceElement) {
      if (el.src) c.push(el.src);
      pushAttr('src');
    }

    const styleList = [
      getComputedStyle(el).backgroundImage,
      getComputedStyle(el, '::before').backgroundImage,
      getComputedStyle(el, '::after').backgroundImage
    ];
    styleList.forEach((bg) => c.push(...parseBackgroundImage(bg)));

    pushAttr('data-image');
    pushAttr('data-thumb');
    pushAttr('data-href');
    pushAttr('href');

    return c;
  }

  function pickBestUrl(urls) {
    const normalized = [];
    for (const raw of urls) {
      const u = safeURL(raw);
      if (u && isUsableUrl(u)) normalized.push(u);
    }
    if (!normalized.length) return null;

    const uniq = [...new Set(normalized)];
    const nonPreview = uniq.find((u) => !isBadPreviewUrl(u));
    return nonPreview || uniq[0];
  }

  function isYouTubePlayerClick(event) {
    const host = location.hostname.toLowerCase();
    if (!(host.includes('youtube.com') || host === 'youtu.be')) return false;

    const path = event.composedPath ? event.composedPath() : [];
    for (const n of path) {
      if (n instanceof HTMLVideoElement) return true;
      if (n instanceof Element) {
        if (n.id === 'movie_player' || n.id === 'ytd-player') return true;
        if (n.classList && (n.classList.contains('html5-video-player') || n.classList.contains('video-stream'))) return true;
        if (n.matches && n.matches('.ytp-cued-thumbnail-overlay, .ytp-chrome-bottom, .ytp-progress-bar-container, .ytp-gradient-bottom')) return true;
        if (n.closest && n.closest('#movie_player, #ytd-player, .html5-video-player')) return true;
      }
    }
    return false;
  }

  function findTargetUrlFromEvent(event) {
    if (event.target instanceof Element) {
      const a = event.target.closest('a[href]');
      if (a) {
        const preferred = normalizePreferredLink(a.href);
        if (preferred && isUsableUrl(preferred)) return preferred;
      }
    }

    const candidates = [];
    const path = event.composedPath ? event.composedPath() : [];

    for (const n of path) {
      if (n instanceof Element) candidates.push(...getCandidatesFromElement(n));
    }

    let el = event.target instanceof Element ? event.target : null;
    let hops = 0;
    while (el && hops < 10) {
      candidates.push(...getCandidatesFromElement(el));
      el = el.parentElement;
      hops += 1;
    }

    return pickBestUrl(candidates) || null;
  }

  function copyToClipboard(text) {
    if (!text) return false;
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, 'text');
        return true;
      }
    } catch {
      // noop
    }
    return false;
  }

  function openInNewTab(rawUrl) {
    const url = safeURL(rawUrl);
    if (!url) return false;

    try {
      if (typeof GM_openInTab === 'function') {
        GM_openInTab(url, { active: true, insert: true, setParent: true });
        return true;
      }
    } catch {
      // noop
    }

    const w = window.open(url, '_blank', 'noopener,noreferrer');
    return !!w;
  }

  function guessExt(url, fallback = 'bin') {
    try {
      const u = new URL(url, location.href);
      const name = u.pathname.split('/').pop() || '';
      const dot = name.lastIndexOf('.');
      if (dot > -1 && dot < name.length - 1) {
        const ext = name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
        return ext || fallback;
      }
      return fallback;
    } catch {
      return fallback;
    }
  }

  function makeFileName(url, prefix = 'media') {
    return `${prefix}-${Date.now()}.${guessExt(url, 'bin')}`;
  }

  function downloadMedia(targetUrl) {
    const finalUrl = targetUrl && isUsableUrl(targetUrl) ? targetUrl : null;
    if (!finalUrl) {
      showToast('No direct downloadable URL');
      return;
    }

    const name = makeFileName(finalUrl, 'media');
    if (typeof GM_download === 'function') {
      GM_download({ url: finalUrl, name, saveAs: true });
      showToast('Download started');
      return;
    }

    const a = document.createElement('a');
    a.href = finalUrl;
    a.download = name;
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Download started');
  }

  function downloadWithExt(targetUrl, ext, prefix = 'media') {
    const finalUrl = targetUrl && isUsableUrl(targetUrl) ? targetUrl : null;
    if (!finalUrl) {
      showToast('No URL to save');
      return;
    }

    const cleanExt = String(ext || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
    const name = `${prefix}-${Date.now()}.${cleanExt}`;

    if (typeof GM_download === 'function') {
      GM_download({ url: finalUrl, name, saveAs: true });
      showToast(`Saved as .${cleanExt}`);
      return;
    }

    const a = document.createElement('a');
    a.href = finalUrl;
    a.download = name;
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast(`Saved as .${cleanExt}`);
  }

  function downloadTextFile(filename, content, mime = 'text/plain;charset=utf-8') {
    try {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      return true;
    } catch {
      return false;
    }
  }

  function urlToColorHex(text) {
    let h = 0;
    const s = String(text || '');
    for (let i = 0; i < s.length; i += 1) {
      h = (h << 5) - h + s.charCodeAt(i);
      h |= 0;
    }
    const c = (h >>> 0).toString(16).padStart(6, '0').slice(0, 6);
    return `#${c}`;
  }

  function saveUrlFile(targetUrl) {
    const finalUrl = targetUrl && isUsableUrl(targetUrl) ? targetUrl : location.href;
    const body = `[InternetShortcut]\r\nURL=${finalUrl}\r\n`;
    const ok = downloadTextFile(`link-${Date.now()}.url`, body, 'application/internet-shortcut');
    showToast(ok ? 'Saved .url shortcut' : 'Could not save .url');
  }

  function saveStructured(targetUrl, kind) {
    const finalUrl = targetUrl && isUsableUrl(targetUrl) ? targetUrl : location.href;
    const ts = new Date().toISOString();
    let filename = `media-${Date.now()}.${kind}`;
    let content = finalUrl;
    let mime = 'text/plain;charset=utf-8';

    if (kind === 'xml') {
      content = `<media>\n  <url>${finalUrl}</url>\n  <savedAt>${ts}</savedAt>\n</media>\n`;
      mime = 'application/xml;charset=utf-8';
    } else if (kind === 'ytf') {
      content = `YTF_LINK=${finalUrl}\nSAVED_AT=${ts}\n`;
    } else if (kind === 'obx') {
      content = `OBX_URL=${finalUrl}\nOBX_TIME=${ts}\n`;
    } else if (kind === 'hex') {
      const hex = urlToColorHex(finalUrl);
      content = `${hex}\n`;
      filename = `hex-${Date.now()}.txt`;
      copyToClipboard(hex);
      showToast(`Hex copied: ${hex}`);
    }

    const ok = downloadTextFile(filename, content, mime);
    if (ok && kind !== 'hex') showToast(`Saved .${kind}`);
    if (!ok) showToast(`Could not save .${kind}`);
  }

  function openViaCustomProtocol(protocolUrl) {
    try {
      const frame = document.createElement('iframe');
      frame.style.display = 'none';
      frame.src = protocolUrl;
      document.documentElement.appendChild(frame);
      setTimeout(() => frame.remove(), 1200);
      return true;
    } catch {
      return false;
    }
  }

  function launchDiscordApp() {
    const tried = openViaCustomProtocol('discord://-/channels/@me');
    showToast(tried ? 'Tried opening Discord app' : 'Discord app protocol not available');
  }

  function launchFLStudio() {
    const tried = openViaCustomProtocol('flstudio://');
    showToast(tried ? 'Tried opening FL Studio' : 'FL Studio app protocol not available');
  }

  function getShareConfig(service, encUrl, encText) {
    const map = {
      discord: { app: 'discord://-/channels/@me', web: 'https://discord.com/channels/@me', copyFirst: true },
      facebook: { app: `fb://facewebmodal/f?href=${encUrl}`, web: `https://www.facebook.com/sharer/sharer.php?u=${encUrl}` },
      google: { app: `googlechrome://www.google.com/search?q=${encUrl}`, web: `https://www.google.com/search?q=${encUrl}` },
      x: { app: `twitter://post?message=${encText}%20${encUrl}`, web: `https://x.com/intent/tweet?url=${encUrl}&text=${encText}` },
      whatsapp: { app: `whatsapp://send?text=${encUrl}`, web: `https://wa.me/?text=${encUrl}` },
      telegram: { app: `tg://msg_url?url=${encUrl}&text=${encText}`, web: `https://t.me/share/url?url=${encUrl}&text=${encText}` },
      reddit: { app: `reddit://submit?url=${encUrl}`, web: `https://www.reddit.com/submit?url=${encUrl}&title=${encText}` },
      gmail: { app: `mailto:?subject=${encodeURIComponent('Shared link')}&body=${encUrl}`, web: `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent('Shared link')}&body=${encUrl}` }
    };
    return map[service] || null;
  }

  function openShareTarget(service, mode, targetUrl) {
    const u = targetUrl && isUsableUrl(targetUrl) ? targetUrl : location.href;
    const enc = encodeURIComponent(u);
    const text = encodeURIComponent('Check this out');
    const cfg = getShareConfig(service, enc, text);

    if (!cfg) {
      showToast('Unknown share target');
      return;
    }

    const copied = copyToClipboard(u);

    if (mode === 'app') {
      const opened = openViaCustomProtocol(cfg.app);
      if (opened && copied) showToast('URL copied + app launch sent');
      else if (opened) showToast('App launch sent');
      else if (copied) showToast('URL copied (app not opened)');
      else showToast('Could not open app');
      return;
    }

    const opened = openInNewTab(cfg.web);
    if (opened && copied) showToast('URL copied + opened in browser');
    else if (opened) showToast('Opened in browser');
    else if (copied) showToast('URL copied (browser blocked)');
    else showToast('Open failed');
  }

  function copyAndOpen(targetUrl) {
    const finalUrl = targetUrl && isUsableUrl(targetUrl) ? targetUrl : location.href;
    const copied = copyToClipboard(finalUrl);
    const opened = openInNewTab(finalUrl);

    if (copied && opened) showToast('Copied + opened in new tab');
    else if (copied) showToast('URL copied (tab blocked)');
    else if (opened) showToast('Opened in new tab');
    else showToast('Could not open URL');
  }

  function parseResponseHeaders(raw) {
    const out = {};
    String(raw || '').split(/\r?\n/).forEach((line) => {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    });
    return out;
  }

  function gmGetArrayBuffer(url) {
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'arraybuffer',
          onload: (r) => {
            const headers = parseResponseHeaders(r.responseHeaders);
            resolve({
              ok: r.status >= 200 && r.status < 300,
              status: r.status,
              arrayBuffer: r.response,
              headers,
              finalUrl: r.finalUrl || url
            });
          },
          onerror: () => reject(new Error('GM_xmlhttpRequest failed')),
          ontimeout: () => reject(new Error('GM_xmlhttpRequest timeout'))
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async function fetchArrayBufferAny(url) {
    const u = new URL(url, location.href);
    if (u.protocol === 'blob:' || u.protocol === 'data:') {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      return {
        ok: res.ok,
        status: res.status,
        arrayBuffer: buf,
        headers: { 'content-type': res.headers.get('content-type') || '' },
        finalUrl: url
      };
    }
    return gmGetArrayBuffer(url);
  }

  function isStreamPlaylistUrl(url) {
    return /\.(m3u8|mpd)(\?|#|$)/i.test(url) || /\/manifest(\?|#|$)/i.test(url);
  }

  function looksLikeHtml(contentType) {
    const ct = String(contentType || '').toLowerCase();
    return ct.includes('text/html') || ct.includes('application/xhtml');
  }

  function baseNameFromUrl(url, fallback = 'media') {
    try {
      const u = new URL(url, location.href);
      const last = (u.pathname.split('/').pop() || '').trim();
      const clean = last.replace(/[^\w.\-()+\[\] ]+/g, '').trim();
      if (!clean) return fallback;
      const dot = clean.lastIndexOf('.');
      return (dot > 0 ? clean.slice(0, dot) : clean) || fallback;
    } catch {
      return fallback;
    }
  }

  function downloadBlobFile(filename, blob) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = filename;
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
  }

  async function toBlobURL(srcUrl, mime) {
    const r = await gmGetArrayBuffer(srcUrl);
    if (!r.ok) throw new Error(`Fetch failed (${r.status})`);
    const blob = new Blob([r.arrayBuffer], { type: mime });
    return URL.createObjectURL(blob);
  }

  async function ensureFFmpegLoaded() {
    if (_ffmpeg) return _ffmpeg;
    if (_ffmpegLoadPromise) return _ffmpegLoadPromise;

    _ffmpegLoadPromise = (async () => {
      showToast('Loading converter (first run may take time)…');

      if (!_ffmpegAssets) {
        const classesURL = await toBlobURL(FFMPEG_CLASSES_SRC, 'text/javascript');
        const workerURL = await toBlobURL(FFMPEG_WORKER_SRC, 'text/javascript');
        const coreURL = await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, 'text/javascript');
        const wasmURL = await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm');
        _ffmpegAssets = { classesURL, workerURL, coreURL, wasmURL };
      }

      const mod = await import(_ffmpegAssets.classesURL);
      const FFmpeg = mod.FFmpeg;
      const ff = new FFmpeg();

      await ff.load({
        coreURL: _ffmpegAssets.coreURL,
        wasmURL: _ffmpegAssets.wasmURL,
        workerURL: _ffmpegAssets.workerURL
      });

      _ffmpeg = ff;
      showToast('Converter ready');
      return _ffmpeg;
    })().finally(() => {
      _ffmpegLoadPromise = null;
    });

    return _ffmpegLoadPromise;
  }

  async function convertUrlTo(kind, targetUrl) {
    const url = safeURL(targetUrl);
    if (!url) {
      showToast('No URL to convert');
      return;
    }

    if (isStreamPlaylistUrl(url)) {
      showToast('Playlists (.m3u8/.mpd) are not supported');
      return;
    }

    showToast('Fetching media bytes…');
    const r = await fetchArrayBufferAny(url);
    const ct = (r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || '';

    if (!r.ok) {
      showToast(`Fetch failed (HTTP ${r.status})`);
      return;
    }

    if (looksLikeHtml(ct)) {
      showToast('Target is a page URL, not a direct media file');
      return;
    }

    const ff = await ensureFFmpegLoaded();
    const inExt = guessExt(url, 'bin');
    const inName = `input.${inExt}`;
    const outName = kind === 'mp3' ? 'output.mp3' : 'output.mp4';

    await ff.writeFile(inName, new Uint8Array(r.arrayBuffer));

    try {
      if (kind === 'mp3') {
        showToast('Converting to MP3…');
        await ff.exec(['-i', inName, '-vn', '-codec:a', 'libmp3lame', '-q:a', '2', outName]);
      } else {
        showToast('Converting to MP4…');
        await ff.exec(['-i', inName, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', outName]);
      }

      const out = await ff.readFile(outName);
      const mime = kind === 'mp3' ? 'audio/mpeg' : 'video/mp4';
      const base = baseNameFromUrl(url, 'media');
      const filename = `${base}-${Date.now()}.${kind}`;
      downloadBlobFile(filename, new Blob([out.buffer], { type: mime }));
      showToast(`${kind.toUpperCase()} saved`);
    } catch (e) {
      showToast(`Convert failed: ${String(e && e.message ? e.message : e).slice(0, 140)}`);
    } finally {
      try { await ff.deleteFile(inName); } catch {}
      try { await ff.deleteFile(outName); } catch {}
    }
  }

  function makeMenuItem(text, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.style.cssText = [
      'display:block',
      'width:100%',
      'padding:8px 10px',
      'border:none',
      'background:linear-gradient(90deg, rgba(116,55,180,.14) 0%, rgba(111,255,143,.11) 100%)',
      'color:#eaffb5',
      'text-align:left',
      'cursor:pointer',
      `font:13px/1.28 ${UI_FONT}`,
      'border-radius:8px',
      'margin:2px 0'
    ].join(';');

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
      removeMenu();
    });

    return btn;
  }

  function makeSectionHeader(text) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = [
      'padding:5px 10px 6px',
      'margin:6px 4px 4px',
      'border-radius:8px',
      'border:1px solid rgba(120,255,90,.35)',
      'background:linear-gradient(90deg, rgba(34,90,34,.22), rgba(34,90,34,.06))',
      'color:#d5ff9a',
      `font:12px/1.25 ${TITLE_FONT}`
    ].join(';');
    return el;
  }

  function showMenu(x, y, targetUrl) {
    removeMenu();

    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.style.cssText = [
      'position:fixed',
      `left:${x}px`,
      `top:${y}px`,
      'z-index:2147483647',
      'min-width:260px',
      'max-width:380px',
      'max-height:65vh',
      'overflow-y:auto',
      'background:rgba(22,16,34,.92)',
      'border:1px solid rgba(173,110,255,.55)',
      'border-radius:8px',
      'padding:6px',
      'backdrop-filter:blur(8px) saturate(120%)',
      'box-shadow:0 10px 30px rgba(0,0,0,.45)'
    ].join(';');

    const title = document.createElement('div');
    title.textContent = `${SCRIPT_NAME} • Media actions`;
    title.style.cssText = `padding:6px 10px 8px;font:12px/1.25 ${TITLE_FONT};border-bottom:1px solid rgba(137,207,240,.35);margin-bottom:4px;color:#d5ff9a;`;
    menu.appendChild(title);

    menu.appendChild(makeSectionHeader('Media Tools'));
    menu.appendChild(makeMenuItem('Copy URL + Open tab', () => copyAndOpen(targetUrl)));
    menu.appendChild(makeMenuItem('Open in new tab', () => {
      const u = targetUrl && isUsableUrl(targetUrl) ? targetUrl : location.href;
      showToast(openInNewTab(u) ? 'Opened in new tab' : 'Open failed');
    }));
    menu.appendChild(makeMenuItem('Copy URL', () => {
      const u = targetUrl && isUsableUrl(targetUrl) ? targetUrl : location.href;
      showToast(copyToClipboard(u) ? 'URL copied' : 'Copy failed');
    }));
    menu.appendChild(makeMenuItem('Save Media (original)', () => downloadMedia(targetUrl)));
    menu.appendChild(makeMenuItem('Save as PNG', () => downloadWithExt(targetUrl, 'png', 'image')));
    menu.appendChild(makeMenuItem('Save as VIDEO (mp4)', () => downloadWithExt(targetUrl, 'mp4', 'video')));
    menu.appendChild(makeMenuItem('Save as .URL file', () => saveUrlFile(targetUrl)));
    menu.appendChild(makeMenuItem('Save as TXT', () => saveStructured(targetUrl, 'txt')));
    menu.appendChild(makeMenuItem('Save as XML', () => saveStructured(targetUrl, 'xml')));
    menu.appendChild(makeMenuItem('Save as YTF', () => saveStructured(targetUrl, 'ytf')));
    menu.appendChild(makeMenuItem('Save as OBX', () => saveStructured(targetUrl, 'obx')));
    menu.appendChild(makeMenuItem('Save #HEX code', () => saveStructured(targetUrl, 'hex')));

    menu.appendChild(makeSectionHeader('Convert (Direct file URLs only)'));
    menu.appendChild(makeMenuItem('Convert → MP3 (FFmpeg.wasm)', async () => convertUrlTo('mp3', targetUrl)));
    menu.appendChild(makeMenuItem('Convert → MP4 (FFmpeg.wasm)', async () => convertUrlTo('mp4', targetUrl)));

    menu.appendChild(makeSectionHeader('Quick Actions'));
    menu.appendChild(makeMenuItem('Open Discord App', launchDiscordApp));
    menu.appendChild(makeMenuItem('Open FL Studio', launchFLStudio));

    menu.appendChild(makeSectionHeader('Quick Share (App / Web)'));
    menu.appendChild(makeMenuItem('Copy + Discord App', () => openShareTarget('discord', 'app', targetUrl)));
    menu.appendChild(makeMenuItem('Copy + Discord Web', () => openShareTarget('discord', 'web', targetUrl)));
    menu.appendChild(makeMenuItem('Copy + Facebook App', () => openShareTarget('facebook', 'app', targetUrl)));
    menu.appendChild(makeMenuItem('Copy + Facebook Web', () => openShareTarget('facebook', 'web', targetUrl)));
    menu.appendChild(makeMenuItem('Copy + Google App', () => openShareTarget('google', 'app', targetUrl)));
    menu.appendChild(makeMenuItem('Copy + Google Web', () => openShareTarget('google', 'web', targetUrl)));
    menu.appendChild(makeMenuItem('Copy + X App', () => openShareTarget('x', 'app', targetUrl)));
    menu.appendChild(makeMenuItem('Copy + X Web', () => openShareTarget('x', 'web', targetUrl)));
    menu.appendChild(makeMenuItem('Copy + WhatsApp App', () => openShareTarget('whatsapp', 'app', targetUrl)));
    menu.appendChild(makeMenuItem('Copy + WhatsApp Web', () => openShareTarget('whatsapp', 'web', targetUrl)));
    menu.appendChild(makeMenuItem('Copy + Telegram App', () => openShareTarget('telegram', 'app', targetUrl)));
    menu.appendChild(makeMenuItem('Copy + Telegram Web', () => openShareTarget('telegram', 'web', targetUrl)));
    menu.appendChild(makeMenuItem('Copy + Reddit App', () => openShareTarget('reddit', 'app', targetUrl)));
    menu.appendChild(makeMenuItem('Copy + Reddit Web', () => openShareTarget('reddit', 'web', targetUrl)));
    menu.appendChild(makeMenuItem('Copy + Mail App', () => openShareTarget('gmail', 'app', targetUrl)));
    menu.appendChild(makeMenuItem('Copy + Gmail Web', () => openShareTarget('gmail', 'web', targetUrl)));

    document.documentElement.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    const pad = 6;
    let nx = x;
    let ny = y;
    if (rect.right > innerWidth - pad) nx = Math.max(pad, innerWidth - rect.width - pad);
    if (rect.bottom > innerHeight - pad) ny = Math.max(pad, innerHeight - rect.height - pad);
    menu.style.left = `${nx}px`;
    menu.style.top = `${ny}px`;
  }

  function onGlobalClose(e) {
    const menu = document.getElementById(MENU_ID);
    if (!menu) return;
    if (e && e.target instanceof Node && menu.contains(e.target)) return;
    removeMenu();
  }

  function isDoubleRightClick(e, url) {
    const now = Date.now();
    const dt = now - lastContext.t;
    const dx = Math.abs(e.clientX - lastContext.x);
    const dy = Math.abs(e.clientY - lastContext.y);
    const sameSpot = dx <= DOUBLE_RCLICK_PX && dy <= DOUBLE_RCLICK_PX;
    const sameUrl = url === lastContext.url;

    const isDouble = dt > 0 && dt <= DOUBLE_RCLICK_MS && sameSpot && sameUrl;
    lastContext = { t: now, x: e.clientX, y: e.clientY, url };
    return isDouble;
  }

  document.addEventListener('click', onGlobalClose, true);
  document.addEventListener('scroll', onGlobalClose, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') removeMenu(); }, true);

  if (document.readyState === 'complete') {
    setTimeout(() => showToast('Loaded'), 250);
  } else {
    window.addEventListener('load', () => {
      setTimeout(() => showToast('Loaded'), 250);
    }, { once: true });
  }

  document.addEventListener('contextmenu', (e) => {
    if (e.shiftKey) return;

    const now = Date.now();
    if (now - lastHandledAt < 60) return;
    lastHandledAt = now;

    let targetUrl = findTargetUrlFromEvent(e);
    if (!targetUrl && isYouTubePlayerClick(e)) {
      targetUrl = normalizePreferredLink(location.href) || location.href;
    }

    if (!targetUrl) {
      removeMenu();
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (isDoubleRightClick(e, targetUrl)) {
      removeMenu();
      copyAndOpen(targetUrl);
      return;
    }

    showMenu(e.clientX, e.clientY, targetUrl);
  }, true);
})();
