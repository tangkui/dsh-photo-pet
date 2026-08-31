/**
 * dsh-photo-pet browser half — mounts the photo pet as a global floating
 * surface and drives it through the host's same-origin '/api/photo-pet/*'
 * JSON endpoints: fetch the state once, upload/delete photos, persist the
 * drag position through the 'photo-pet' settings scope. The pet is
 * host-global (no session dimension), so it mounts directly onto
 * 'document.body' via a single React root — on the new-conversation screen
 * no session exists, and a session-scoped slot would vanish there. When the
 * pet is hidden the entry becomes a fixed-position summon button.
 *
 * The bundle is a factory-form client module (window.__ModuleLoader__.load):
 * every import is a seeded external (react, react-dom/client), and the only
 * exported face is { apply, inject }.
 * @module dsh-photo-pet/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-photo-pet',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { createPortal } = require('react-dom');
    const { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useSyncExternalStore } = React;

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    const API_STATE = '/api/photo-pet/state';
    const API_PHOTO = '/api/photo-pet/photo';
    const API_ACTIVITY = '/api/photo-pet/activity';

    /** AI cutout (browser matting): the module graph comes from esm.sh while
     * the segmentation model + onnxruntime wasm are served same-origin by the
     * host proxy ('/api/photo-pet/ai/*', mirrored from npmmirror + cached).
     * Model 'small' = isnet_quint8 (~44MB) — good quality for portraits. */
    const AI_MODULE_URL = 'https://esm.sh/@imgly/background-removal@1.5.5';
    const AI_PUBLIC_PATH = '/api/photo-pet/ai/';
    const AI_MODEL = 'small';
    const AI_EDIT_MAX = 1024;

    /** Room (px) needed below the pet for the menu to open downward; when the
     * pet sits closer to the bottom edge the menu flips above instead. */
    const MENU_FLIP_AT = 240;

    /** Longest allowed pet name. */
    const NAME_MAX = 12;

    const DEFAULT_SETTINGS = Object.freeze({
      enabled: true,
      visible: true,
      size: 140,
      right: 40,
      bottom: 40,
      name: '小宠',
      smartTrim: true,
      aiCutout: true,
      workLines: '努力工作中…\n正在思考…\n灵感加载中…\n脑内风暴进行中…\n等一个回音…\n忙着呢,先不闹～',
      workInterval: 4.8,
      clickLines: '摸摸我～\n主人好呀！\n我在呢～\n今天也要加油哦！\n喵～\n汪！\n嘿嘿，被你发现了\n最喜欢你啦\n要一直陪着我哦\n累了吗？歇会儿吧\n啾～\n呼噜呼噜…',
      fanMenuItems: 'hide,shrink,rename,photo,cutout,enlarge,reset',
    });

    /** Split the stored work-lines string into a list; empty → built-ins. */
    function parseWorkLines(raw) {
      if (typeof raw !== 'string') return WORK_LINES;
      const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
      return lines.length > 0 ? lines : WORK_LINES;
    }

    /** Split the stored click-lines string into a list; empty → built-ins. */
    function parseClickLines(raw) {
      if (typeof raw !== 'string') return PET_LINES;
      const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
      return lines.length > 0 ? lines : PET_LINES;
    }

    /** All hover fan-menu items, in fixed order. */
    const FAN_MENU_ITEMS = [
      { id: 'hide', icon: '🙈', title: '先藏起来' },
      { id: 'shrink', icon: '➖', title: '缩小' },
      { id: 'rename', icon: '🏷️', title: '取名字' },
      { id: 'photo', icon: '📷', title: '上传照片' },
      { id: 'cutout', icon: '🪄', title: '智能抠图' },
      { id: 'enlarge', icon: '➕', title: '放大' },
      { id: 'reset', icon: '♻️', title: '恢复默认形象' },
    ];

    /** Parse the enabled fan-item ids; unknown ids are ignored. */
    function parseFanMenuItems(raw) {
      if (typeof raw !== 'string') return new Set(FAN_MENU_ITEMS.map((item) => item.id));
      const ids = new Set(raw.split(',').map((id) => id.trim()).filter((id) => id.length > 0));
      return new Set(FAN_MENU_ITEMS.map((item) => item.id).filter((id) => ids.has(id)));
    }

    /** Cross-tree event bus: the settings page drives pet actions (upload,
     * open cutout, reset photo) that live in the pet's own component tree. */
    const petBus = {
      listeners: new Set(),
      on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
      emit(message) {
        for (const fn of Array.from(this.listeners)) {
          try { fn(message); } catch { /* one bad listener must not break the rest */ }
        }
      },
    };

    /** Plugin management (settings card 更新 / 卸载 buttons): the version
     * check and the update/uninstall triggers run through the host API — the
     * host performs the real `dsh plugin` / pnpm commands and restarts the
     * GUI. Exposed for the settings card and the smoke tests. */
    const pluginManage = {
      check: async () => {
        try {
          const response = await fetch('/api/photo-pet/update/check');
          if (!response.ok) return null;
          return await response.json();
        } catch {
          return null;
        }
      },
      update: async () => {
        try {
          const response = await fetch('/api/photo-pet/update', { method: 'POST' });
          if (!response.ok) return { ok: false };
          return await response.json();
        } catch {
          // The host dies mid-restart: a dropped connection means it worked.
          return { ok: true, restarting: true };
        }
      },
      uninstall: async () => {
        try {
          const response = await fetch('/api/photo-pet/uninstall', { method: 'POST' });
          if (!response.ok) return { ok: false };
          return await response.json();
        } catch {
          return { ok: true, restarting: true };
        }
      },
    };

    const STYLE_ID = 'dsh-photo-pet-style';
    const ROOT_ATTR = 'data-photo-pet-root';

    /** Pet speech pool on click/pet. */
    const PET_LINES = [
      '摸摸我～',
      '主人好呀！',
      '我在呢～',
      '今天也要加油哦！',
      '喵～',
      '汪！',
      '嘿嘿，被你发现了',
      '最喜欢你啦',
      '要一直陪着我哦',
      '累了吗？歇会儿吧',
      '啾～',
      '呼噜呼噜…',
    ];

    /** Occasional idle lines. */
    const IDLE_LINES = [
      '发呆中…',
      '等你回来～',
      '今天想做什么呀？',
      '好安静呀…',
      '困了，打个盹…',
      '肚子有点饿了…',
    ];

    /** Lines shown while the model is working. */
    const WORK_LINES = [
      '努力工作中…',
      '正在思考…',
      '灵感加载中…',
      '脑内风暴进行中…',
      '等一个回音…',
      '忙着呢，先不闹～',
    ];

    /** Default pet face: a cute round kitten, embedded as an SVG data URL. */
    const DEFAULT_PET_SVG = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">',
      '<defs>',
      '<linearGradient id="ppbg" x1="0" y1="0" x2="0" y2="1">',
      '<stop offset="0" stop-color="#ffdfc2"/><stop offset="1" stop-color="#f2b98e"/>',
      '</linearGradient>',
      '<clipPath id="ppclip"><circle cx="100" cy="112" r="68"/></clipPath>',
      '</defs>',
      '<circle cx="100" cy="112" r="68" fill="url(#ppbg)"/>',
      '<ellipse cx="78" cy="78" rx="26" ry="13" fill="#fff" opacity="0.25" transform="rotate(-18 78 78)"/>',
      '<path d="M58 92 Q74 84 92 92" stroke="#4a3020" stroke-width="7" fill="none" stroke-linecap="round"/>',
      '<path d="M142 92 Q126 84 108 92" stroke="#4a3020" stroke-width="7" fill="none" stroke-linecap="round"/>',
      '<circle cx="76" cy="104" r="4.5" fill="#3a2418"/>',
      '<circle cx="124" cy="104" r="4.5" fill="#3a2418"/>',
      '<path d="M100 108 Q112 112 108 126 Q100 132 92 126 Q88 112 100 108 Z" fill="#e8a878" stroke="#c98a66" stroke-width="2"/>',
      '<g clip-path="url(#ppclip)"><circle cx="100" cy="158" r="42" fill="rgba(110,80,55,.22)"/></g>',
      '<path d="M88 146 Q100 154 112 146" stroke="#5b3a29" stroke-width="4" fill="none" stroke-linecap="round"/>',
      '</svg>',
    ].join('');
    const DEFAULT_PET_URL = 'data:image/svg+xml;utf8,' + encodeURIComponent(DEFAULT_PET_SVG);

    // ---------------------------------------------------------------------
    // Styles (injected once per bundle instance; refcounted on dispose)
    // ---------------------------------------------------------------------

    const CSS = `
.pp-shell{position:fixed;z-index:9990;user-select:none;-webkit-user-select:none;touch-action:none}
.pp-pet{position:absolute;inset:0;cursor:grab;display:flex;align-items:center;justify-content:center;outline:none}
.pp-pet:active{cursor:grabbing}
.pp-anim{position:absolute;inset:0;filter:drop-shadow(0 6px 14px rgba(90,60,40,.35))}
.pp-menu-backdrop{position:fixed;inset:0;z-index:9989;background:transparent}
.pp-avatar{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:100%;line-height:0;overflow:visible}
.pp-avatar img,.pp-avatar .pp-fallback{display:block;width:100%;height:auto}
.pp-avatar .pp-fallback img{position:static}
.pp-bob{animation:pp-bob 3s ease-in-out infinite}
.pp-bounce{animation:pp-bounce .55s cubic-bezier(.34,1.56,.64,1)}
.pp-wiggle{animation:pp-wiggle .5s ease-in-out}
@keyframes pp-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
@keyframes pp-bounce{0%{transform:scale(1)}35%{transform:scale(1.14) translateY(-10px)}70%{transform:scale(.96)}100%{transform:scale(1)}}
@keyframes pp-wiggle{0%,100%{transform:rotate(0)}25%{transform:rotate(-7deg)}75%{transform:rotate(7deg)}}
.pp-bubble{position:absolute;bottom:calc(100% + 12px);left:50%;transform:translateX(-50%);background:#fff;color:#5b3a29;font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:7px 12px;border-radius:14px;box-shadow:0 4px 14px rgba(90,60,40,.22);white-space:nowrap;pointer-events:none;animation:pp-pop .18s ease-out;z-index:2;border:1px solid rgba(90,60,40,.08)}
.pp-bubble::after{content:"";position:absolute;top:100%;left:50%;transform:translateX(-50%);border:6px solid transparent;border-top-color:#fff}
@keyframes pp-pop{0%{opacity:0;transform:translateX(-50%) translateY(6px) scale(.9)}100%{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
.pp-menu{position:absolute;left:50%;top:50%;width:0;height:0;z-index:3}
.pp-fan-btn{position:absolute;width:24px;height:24px;border-radius:50%;border:2px solid #fff;background:linear-gradient(160deg,#fff,#fff3e8);color:#8a5a3a;font-size:12px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 3px 10px rgba(90,60,40,.28);transform:translate(-50%,-50%);transition:transform .12s,background .12s;padding:0}
.pp-fan-btn:hover{transform:translate(-50%,-50%) scale(1.18);background:linear-gradient(160deg,#ffe9d6,#ffd0b3)}
.pp-fan-btn:disabled{opacity:.4;cursor:not-allowed}
.pp-fan-label{position:absolute;transform:translate(-50%,-50%);background:rgba(91,58,41,.85);color:#fff;font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:3px 9px;border-radius:9px;white-space:nowrap;pointer-events:none;z-index:4;box-shadow:0 2px 8px rgba(90,60,40,.25);animation:pp-label-in .12s ease-out}
@keyframes pp-label-in{0%{opacity:0;transform:translate(-50%,-50%) scale(.85)}100%{opacity:1;transform:translate(-50%,-50%) scale(1)}}
.pp-nameplate{position:absolute;bottom:calc(100% + 10px);left:50%;transform:translateX(-50%);background:rgba(255,255,255,.92);color:#8a5a3a;font:11px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:2px 10px;border-radius:9px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(90,60,40,.22);border:1px solid rgba(90,60,40,.08);z-index:5}
.pp-nameplate-below{top:calc(100% + 10px);bottom:auto}
.pp-name-panel{position:absolute;bottom:-50px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:4px;background:#fff;border-radius:10px;box-shadow:0 6px 18px rgba(90,60,40,.26);padding:5px;border:1px solid rgba(90,60,40,.08);z-index:3}
.pp-name-panel input{width:96px;border:1px solid #f0d9c4;border-radius:7px;background:#fffdf9;color:#5b3a29;font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:4px 7px;outline:none}
.pp-name-panel input:focus{border-color:#ffc9a8}
.pp-name-panel button{width:24px;height:24px;border:none;border-radius:7px;background:#fdf3ea;color:#8a5a3a;font-size:13px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
.pp-name-panel button:hover{background:#fbe7d3}
.pp-editor{position:fixed;inset:0;z-index:10000;background:rgba(60,40,20,.35);display:flex;align-items:center;justify-content:center}
.pp-editor-card{background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(60,35,15,.35);padding:12px;width:min(560px,calc(100vw - 40px));max-height:calc(100vh - 60px);display:flex;flex-direction:column;gap:10px}
.pp-editor-head{display:flex;align-items:center;justify-content:space-between;font:14px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#5b3a29;font-weight:600}
.pp-editor-close{border:none;background:#fdf3ea;color:#8a5a3a;border-radius:8px;width:26px;height:26px;cursor:pointer;font-size:13px}
.pp-editor-wrap{flex:1;min-height:200px;overflow:auto;display:flex;align-items:center;justify-content:center;background:conic-gradient(#e9e2d6 25%,#fff 0 50%,#e9e2d6 0 75%,#fff 0) 0 0/18px 18px;border-radius:10px;border:1px solid #f0e2d0}
.pp-editor-canvas{max-width:100%;max-height:56vh;cursor:crosshair;touch-action:none;box-shadow:0 2px 10px rgba(90,60,40,.18)}
.pp-editor-msg{padding:24px;color:#a07a55;font:13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.pp-editor-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pp-editor-tools button,.pp-editor-actions button{border:1px solid #f0d9c4;background:#fffdf9;color:#5b3a29;font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;border-radius:8px;padding:5px 10px;cursor:pointer}
.pp-editor-tools button.on{background:#fbe7d3;border-color:#e8b98c}
.pp-editor-tools .pp-editor-ai{background:linear-gradient(160deg,#c9e4ff,#8fb9f5);border:none;color:#fff;font-weight:600}
.pp-editor-label{color:#a07a55;font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;margin:0 2px}
.pp-editor-actions{display:flex;justify-content:flex-end;gap:8px}
.pp-editor-actions .pp-editor-apply{background:linear-gradient(160deg,#ffd9b8,#f5b988);border:none;color:#fff;font-weight:600;padding:6px 18px}
.pp-editor-actions button:disabled{opacity:.5;cursor:not-allowed}
.pp-summon{position:fixed;z-index:9990;width:46px;height:46px;border-radius:50%;border:none;background:linear-gradient(160deg,#ffe9d6,#ffd0b3);box-shadow:0 4px 14px rgba(90,60,40,.3);cursor:pointer;font-size:20px;display:flex;align-items:center;justify-content:center;transition:transform .15s}
.pp-summon:hover{transform:scale(1.1)}
.pp-working .pp-anim{animation:pp-work-sway 1.2s ease-in-out infinite}
@keyframes pp-work-sway{0%,100%{transform:rotate(-7deg) scale(1)}50%{transform:rotate(7deg) scale(1.06)}}
.pp-smoke{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:3}
.pp-smoke-puff{position:absolute;left:49.5%;top:48%;width:26px;height:20px;margin-left:-13px;margin-top:-10px;border-radius:50%;background:radial-gradient(ellipse 60% 55% at 30% 45%,rgba(240,242,246,.95) 0%,rgba(225,228,235,.6) 55%,rgba(215,218,228,0) 80%),radial-gradient(ellipse 55% 50% at 68% 60%,rgba(235,238,244,.9) 0%,rgba(220,223,232,.55) 55%,rgba(210,213,224,0) 78%),radial-gradient(ellipse 45% 40% at 50% 25%,rgba(245,247,250,.85) 0%,rgba(230,233,240,.45) 60%,rgba(220,223,232,0) 80%);filter:blur(1.5px);opacity:0;animation:pp-smoke-rise 3s ease-in infinite}
.pp-smoke-puff:nth-child(2n){width:30px;height:23px;margin-left:-15px;margin-top:-11.5px}
.pp-smoke-puff:nth-child(3){width:22px;height:17px;margin-left:-11px;margin-top:-8.5px}
@keyframes pp-smoke-rise{0%{transform:translate(0,0) scale(.55) rotate(0deg);opacity:0}12%{opacity:.9}55%{transform:translate(-6px,-38px) scale(1.35) rotate(8deg);opacity:.65}100%{transform:translate(-16px,-86px) scale(2.7) rotate(-6deg);opacity:0}}
`;

    let styleRefCount = 0;
    function injectStyles() {
      styleRefCount += 1;
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute('data-plugin', 'photo-pet');
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    function releaseStyles() {
      styleRefCount -= 1;
      if (styleRefCount > 0) return;
      const el = document.getElementById(STYLE_ID);
      if (el !== null) el.remove();
    }

    // ---------------------------------------------------------------------
    // Host API
    // ---------------------------------------------------------------------

    async function fetchState() {
      const response = await fetch(API_STATE);
      if (!response.ok) throw new Error('photo-pet state ' + response.status);
      return response.json();
    }

    async function uploadPhoto(dataUrl) {
      const response = await fetch(API_PHOTO, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      });
      if (!response.ok) throw new Error('photo-pet upload ' + response.status);
      return response.json();
    }

    async function deletePhoto() {
      const response = await fetch(API_PHOTO, { method: 'DELETE' });
      if (!response.ok) throw new Error('photo-pet delete ' + response.status);
      return response.json();
    }

    // ---------------------------------------------------------------------
    // Settings stores: official settings scope, or a localStorage fallback
    // ---------------------------------------------------------------------

    function createScopeStore(scope) {
      let snapshot = scope.getSnapshot();
      const listeners = new Set();
      const emit = () => { for (const fn of Array.from(listeners)) fn(); };
      const unsubscribe = scope.subscribe(() => {
        snapshot = scope.getSnapshot();
        emit();
      });
      return {
        getSnapshot: () => snapshot,
        subscribe: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        set: (field, value) => scope.set(field, value),
        dispose: () => {
          try { unsubscribe(); } catch { /* already disposed */ }
        },
      };
    }

    function loadLocalSettings() {
      try {
        const raw = window.localStorage.getItem('dsh-photo-pet.settings');
        if (raw !== null) return JSON.parse(raw);
      } catch { /* ignore */ }
      return {};
    }

    function createLocalStore() {
      let value = loadLocalSettings();
      let snapshotObj = { status: 'ready', value: { ...DEFAULT_SETTINGS, ...value } };
      const listeners = new Set();
      const emit = () => { for (const fn of Array.from(listeners)) fn(); };
      return {
        getSnapshot: () => snapshotObj,
        subscribe: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        set: (field, v) => {
          value = { ...value, [field]: v };
          snapshotObj = { status: 'ready', value: { ...DEFAULT_SETTINGS, ...value } };
          try { window.localStorage.setItem('dsh-photo-pet.settings', JSON.stringify(value)); } catch { /* ignore */ }
          emit();
          return Promise.resolve();
        },
        dispose: () => {},
      };
    }

    function useSettings(store) {
      const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
      if (snapshot.status === 'ready' && snapshot.value !== undefined && snapshot.value !== null) {
        return snapshot.value;
      }
      return DEFAULT_SETTINGS;
    }

    // ---------------------------------------------------------------------
    // Image helpers
    // ---------------------------------------------------------------------

    /** Read a File and (for still images) downscale to ≤1024px before upload. */
    /** Smart trim: remove the surrounding background/border from a photo,
     * keeping the main subject. Flood-fills from the edges with a color
     * tolerance, makes the connected background transparent, then crops to
     * the subject's bounding box. Returns true when a trim was applied.
     * Degrades gracefully: on any failure, or when the background is not
     * clearly separable, the photo is left untouched. */
    function trimBackground(canvas, ctx) {
      try {
        const w = canvas.width;
        const h = canvas.height;
        if (w < 8 || h < 8) return false;
        const imageData = ctx.getImageData(0, 0, w, h);
        const px = imageData.data;
        const total = w * h;

        // Background color: per-channel median of the border ring.
        const channels = [[], [], []];
        const step = Math.max(1, Math.floor(Math.max(w, h) / 32));
        const sample = (x, y) => {
          const i = (y * w + x) * 4;
          channels[0].push(px[i]);
          channels[1].push(px[i + 1]);
          channels[2].push(px[i + 2]);
        };
        for (let x = 0; x < w; x += step) { sample(x, 0); sample(x, h - 1); }
        for (let y = 0; y < h; y += step) { sample(0, y); sample(w - 1, y); }
        const median = (arr) => {
          const sorted = Array.from(arr).sort((a, b) => a - b);
          return sorted[Math.floor(sorted.length / 2)];
        };
        const bg = [median(channels[0]), median(channels[1]), median(channels[2])];

        // Flood fill from every border pixel within a color tolerance.
        const tol = 60; // sum of per-channel absolute differences
        const isBg = new Uint8Array(total);
        const stack = [];
        const probe = (x, y) => {
          if (x < 0 || y < 0 || x >= w || y >= h) return;
          const k = y * w + x;
          if (isBg[k] === 1) return;
          const i = k * 4;
          if (px[i + 3] < 12) { isBg[k] = 1; return; } // already-transparent counts as background
          const d = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]);
          if (d <= tol) { isBg[k] = 1; stack.push(k); }
        };
        for (let x = 0; x < w; x++) { probe(x, 0); probe(x, h - 1); }
        for (let y = 0; y < h; y++) { probe(0, y); probe(w - 1, y); }
        while (stack.length > 0) {
          const k = stack.pop();
          const x = k % w;
          const y = (k / w) | 0;
          probe(x - 1, y);
          probe(x + 1, y);
          probe(x, y - 1);
          probe(x, y + 1);
        }

        // Foreground bounding box + background share.
        let bgCount = 0;
        let minX = w, minY = h, maxX = -1, maxY = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (isBg[y * w + x] === 1) { bgCount++; continue; }
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }

        // Only trim when the background is clearly separable: a meaningful
        // share is connected background AND the subject spans a sane area
        // (not a corner speck, not nearly the whole frame).
        const fgW = maxX - minX + 1;
        const fgH = maxY - minY + 1;
        const bgFrac = bgCount / total;
        if (bgFrac < 0.2) return false;
        if (fgW < w * 0.25 || fgH < h * 0.25) return false;
        if (fgW > w * 0.98 && fgH > h * 0.98 && bgFrac < 0.35) return false;

        // Make the connected background transparent.
        for (let k = 0; k < total; k++) {
          if (isBg[k] === 1) px[k * 4 + 3] = 0;
        }
        imageData.data.set(px);

        // Crop to the subject with a small margin.
        const margin = Math.max(2, Math.round(Math.min(w, h) * 0.02));
        const cx = Math.max(0, minX - margin);
        const cy = Math.max(0, minY - margin);
        const cw = Math.min(w - cx, maxX - minX + 1 + margin * 2);
        const ch = Math.min(h - cy, maxY - minY + 1 + margin * 2);
        const cropped = document.createElement('canvas');
        cropped.width = cw;
        cropped.height = ch;
        cropped.getContext('2d').putImageData(imageData, -cx, -cy);
        canvas.width = cw;
        canvas.height = ch;
        ctx.drawImage(cropped, 0, 0);
        return true;
      } catch (error) {
        console.error('[photo-pet] smart trim failed:', error);
        return false;
      }
    }

    // ------------------------------------------------------------------
    // AI cutout pipeline: matting model → smart cleanup → auto-crop.
    // ------------------------------------------------------------------

    /** Remove tiny foreground specks and fill tiny background holes (each
     * connected region below a pixel-area threshold), so the cutout has no
     * floating noise and no pinholes inside the subject. */
    function cleanMatte(ctx) {
      const w = ctx.canvas.width;
      const h = ctx.canvas.height;
      const n = w * h;
      if (n < 16) return;
      const imageData = ctx.getImageData(0, 0, w, h);
      const px = imageData.data;
      const isFg = (k) => px[k * 4 + 3] >= 128;
      const minBlob = Math.max(8, Math.round(n * 0.0005));
      const visited = new Uint8Array(n);
      const stack = [];
      const blob = [];
      for (let k = 0; k < n; k++) {
        if (visited[k] === 1) continue;
        const fg = isFg(k);
        visited[k] = 1;
        stack.length = 0;
        blob.length = 0;
        stack.push(k);
        while (stack.length > 0) {
          const cur = stack.pop();
          blob.push(cur);
          const x = cur % w;
          const y = (cur / w) | 0;
          if (x > 0) { const nb = cur - 1; if (visited[nb] === 0 && isFg(nb) === fg) { visited[nb] = 1; stack.push(nb); } }
          if (x < w - 1) { const nb = cur + 1; if (visited[nb] === 0 && isFg(nb) === fg) { visited[nb] = 1; stack.push(nb); } }
          if (y > 0) { const nb = cur - w; if (visited[nb] === 0 && isFg(nb) === fg) { visited[nb] = 1; stack.push(nb); } }
          if (y < h - 1) { const nb = cur + w; if (visited[nb] === 0 && isFg(nb) === fg) { visited[nb] = 1; stack.push(nb); } }
        }
        if (blob.length < minBlob) {
          const to = fg ? 0 : 255;
          for (let i = 0; i < blob.length; i++) px[blob[i] * 4 + 3] = to;
        }
      }
      ctx.putImageData(imageData, 0, 0);
    }

    /** Kill the colored fringe the original background leaves on the subject's
     * edge: for every semi-transparent pixel, pull its RGB toward the average
     * of nearby fully-opaque pixels (one pass, 5×5 neighborhood). */
    function decontaminateEdges(ctx) {
      const w = ctx.canvas.width;
      const h = ctx.canvas.height;
      const n = w * h;
      if (n < 16) return;
      const imageData = ctx.getImageData(0, 0, w, h);
      const px = imageData.data;
      const rgb = new Uint8ClampedArray(n * 3);
      for (let k = 0; k < n; k++) {
        rgb[k * 3] = px[k * 4];
        rgb[k * 3 + 1] = px[k * 4 + 1];
        rgb[k * 3 + 2] = px[k * 4 + 2];
      }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const k = y * w + x;
          const a = px[k * 4 + 3];
          if (a === 0 || a >= 255) continue;
          let rs = 0, gs = 0, bs = 0, count = 0;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const x2 = x + dx;
              const y2 = y + dy;
              if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
              const k2 = y2 * w + x2;
              if (px[k2 * 4 + 3] < 200) continue;
              rs += rgb[k2 * 3];
              gs += rgb[k2 * 3 + 1];
              bs += rgb[k2 * 3 + 2];
              count++;
            }
          }
          if (count >= 2) {
            px[k * 4] = Math.round(rs / count);
            px[k * 4 + 1] = Math.round(gs / count);
            px[k * 4 + 2] = Math.round(bs / count);
          }
        }
      }
      ctx.putImageData(imageData, 0, 0);
    }

    /** Crop the canvas to the visible subject (alpha ≥ 8) plus a small
     * margin, dropping transparent borders so the pet hugs the subject. */
    function cropToSubject(canvas, ctx) {
      const w = canvas.width;
      const h = canvas.height;
      if (w < 8 || h < 8) return;
      const imageData = ctx.getImageData(0, 0, w, h);
      const px = imageData.data;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (px[(y * w + x) * 4 + 3] < 8) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (maxX < 0) return; // fully transparent — leave as-is
      const margin = Math.max(2, Math.round(Math.min(w, h) * 0.02));
      const cx = Math.max(0, minX - margin);
      const cy = Math.max(0, minY - margin);
      const cw = Math.min(w - cx, maxX - minX + 1 + margin * 2);
      const ch = Math.min(h - cy, maxY - minY + 1 + margin * 2);
      const cropped = document.createElement('canvas');
      cropped.width = cw;
      cropped.height = ch;
      cropped.getContext('2d').putImageData(imageData, -cx, -cy);
      canvas.width = cw;
      canvas.height = ch;
      ctx.drawImage(cropped, 0, 0);
    }

    /** Load the browser matting module (esm.sh) and run it on a photo blob.
     * Model + wasm come same-origin through the host proxy and are cached. */
    async function aiCutoutBlob(photoBlob, onProgress) {
      const mod = await import(AI_MODULE_URL);
      const removeBackground = mod?.removeBackground;
      if (typeof removeBackground !== 'function') throw new Error('bad-ai-module');
      return removeBackground(photoBlob, {
        model: AI_MODEL,
        publicPath: AI_PUBLIC_PATH,
        output: { format: 'image/png' },
        progress: onProgress,
      });
    }

    /** Decode a Blob (AI result) into a canvas sized ≤ maxSize. */
    async function blobToCanvas(blob, maxSize) {
      const bitmap = await createImageBitmap(blob);
      let width = bitmap.width || 1;
      let height = bitmap.height || 1;
      if (width > maxSize || height > maxSize) {
        const scale = maxSize / Math.max(width, height);
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
      return canvas;
    }

    function fileToDataUrl(file, options) {
      const trim = options?.trim === true;
      return new Promise((resolve, reject) => {
        const reader = new window.FileReader();
        reader.onload = () => {
          const original = reader.result;
          if (file.type === 'image/gif') {
            resolve(original);
            return;
          }
          const img = new window.Image();
          img.onload = () => {
            const MAX = 1024;
            let width = img.naturalWidth || 1;
            let height = img.naturalHeight || 1;
            if (width > MAX || height > MAX) {
              const scale = MAX / Math.max(width, height);
              width = Math.max(1, Math.round(width * scale));
              height = Math.max(1, Math.round(height * scale));
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (ctx === null) {
              reject(new Error('no-canvas'));
              return;
            }
            ctx.drawImage(img, 0, 0, width, height);
            const trimmed = trim ? trimBackground(canvas, ctx) : false;
            const mime = trimmed || file.type === 'image/png' || file.type === 'image/webp' ? 'image/png' : 'image/jpeg';
            resolve(canvas.toDataURL(mime, 0.85));
          };
          img.onerror = () => reject(new Error('bad-image'));
          img.src = original;
        };
        reader.onerror = () => reject(new Error('read-failed'));
        reader.readAsDataURL(file);
      });
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function randomOf(list) {
      return list[Math.floor(Math.random() * list.length)];
    }

    // ---------------------------------------------------------------------
    // The pet UI
    // ---------------------------------------------------------------------

    function PhotoPetApp(props) {
      const { store } = props;
      const settings = useSettings(store);

      const [photoUrl, setPhotoUrl] = useState(null);
      const [busy, setBusy] = useState(false);
      const [bubble, setBubble] = useState(null);
      const [bounce, setBounce] = useState(0);
      const [menuOpen, setMenuOpen] = useState(false);
      const [dragging, setDragging] = useState(false);
      const [working, setWorking] = useState(false);
      const [hovered, setHovered] = useState(null);
      const [hovering, setHovering] = useState(false);
      const [naming, setNaming] = useState(false);
      const [editing, setEditing] = useState(false);
      const [editError, setEditError] = useState(null);
      const [brushMode, setBrushMode] = useState('erase');
      const [brushSize, setBrushSize] = useState('medium');
      const [pos, setPos] = useState({ right: settings.right, bottom: settings.bottom });

      const dragRef = useRef(null);
      const clickLineIdxRef = useRef(0);
      const commitAtRef = useRef(0);
      const bubbleTimerRef = useRef(null);
      const fileRef = useRef(null);
      const hoverTimerRef = useRef(null);
      const labelTimerRef = useRef(null);
      const nameInputRef = useRef(null);
      const namingRef = useRef(false);
      const editCanvasRef = useRef(null);
      const editCtxRef = useRef(null);
      const editOriginalRef = useRef(null); // untouched photo (for 重来)
      const editBaseRef = useRef(null);     // restore-brush reference (original or auto-trimmed)
      const editUndoRef = useRef([]);
      const editStrokeRef = useRef(null);
      namingRef.current = naming;

      // Load the photo state once, then keep it fresh: a photo uploaded from
      // another tab/browser (or the settings page) appears without a reload.
      useEffect(() => {
        let alive = true;
        const refresh = () => {
          fetchState().then((state) => {
            if (!alive) return;
            if (state.photoUrl !== undefined && state.photoUrl !== null) {
              setPhotoUrl((current) => {
                const base = (current ?? '').split('?')[0];
                if (base === state.photoUrl) return current; // unchanged: keep the cached image
                return state.photoUrl + '?t=' + Date.now();
              });
            } else {
              setPhotoUrl(null);
            }
          }, () => { /* host API unavailable; stay on the current face */ });
        };
        refresh();
        const timer = window.setInterval(refresh, 20000);
        return () => { alive = false; window.clearInterval(timer); };
      }, []);

      // Sync displayed position from settings when not dragging and not
      // right after our own commit (the settings write lands async).
      useEffect(() => {
        if (dragging) return;
        if (Date.now() - commitAtRef.current < 600) return;
        setPos({ right: settings.right, bottom: settings.bottom });
      }, [settings.right, settings.bottom, dragging]);

      // Auto-hide the speech bubble (work bubbles rotate on their own timer).
      useEffect(() => {
        if (bubble === null || bubble.kind === 'work') return;
        bubbleTimerRef.current = window.setTimeout(() => {
          setBubble(null);
        }, 2600);
        return () => {
          if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current);
        };
      }, [bubble]);

      // Occasional idle lines while visible (not while working).
      useEffect(() => {
        if (!settings.enabled || !settings.visible || working) return;
        let timer = null;
        const schedule = () => {
          timer = window.setTimeout(() => {
            if (document.visibilityState === 'visible' && !busy && !working) {
              setBubble({ text: randomOf(IDLE_LINES), kind: 'idle' });
            }
            schedule();
          }, 18000 + Math.random() * 14000);
        };
        schedule();
        return () => { if (timer !== null) window.clearTimeout(timer); };
      }, [settings.enabled, settings.visible, busy, working]);

      // Poll the host for model activity; the pet reacts while any session
      // is generating. Poll only while visible: hidden pets stay calm.
      useEffect(() => {
        if (!settings.enabled || !settings.visible) return;
        let alive = true;
        const tick = () => {
          fetch(API_ACTIVITY).then((response) => {
            if (!response.ok) throw new Error('activity ' + response.status);
            return response.json();
          }).then((data) => {
            if (alive) setWorking(Boolean(data.working));
          }, () => { /* host API unavailable; stay calm */ });
        };
        tick();
        const timer = window.setInterval(tick, 2000);
        return () => { alive = false; window.clearInterval(timer); };
      }, [settings.enabled, settings.visible]);

      // Working mood: rotating bubble while the model is busy. The lines are
      // user-configurable (settings.workLines, one per line) and the swap
      // interval too (settings.workInterval, seconds). workLines must be
      // memoized — parseWorkLines returns a fresh array each render, and an
      // unstable dep would re-run the effect (and swap the bubble) every render.
      const workLines = useMemo(() => parseWorkLines(settings.workLines), [settings.workLines]);
      const workIntervalMs = Math.max(1000, (Number.isFinite(settings.workInterval) ? settings.workInterval : 4.8) * 1000);
      // Click-state lines rotate on every click; memoized for the same reason.
      const clickLines = useMemo(() => parseClickLines(settings.clickLines), [settings.clickLines]);
      useEffect(() => {
        if (!working) {
          setBubble((current) => (current !== null && current.kind === 'work' ? null : current));
          return;
        }
        setBubble({ text: randomOf(workLines), kind: 'work' });
        const timer = window.setInterval(() => {
          setBubble({ text: randomOf(workLines), kind: 'work' });
        }, workIntervalMs);
        return () => window.clearInterval(timer);
      }, [working, workLines, workIntervalMs]);

      const say = useCallback((text) => {
        setBubble({ text, kind: 'talk' });
      }, []);

      const handleFile = useCallback(async (file) => {
        if (file === undefined || file === null) return;
        if (!file.type.startsWith('image/')) {
          say('这好像不是图片哦～');
          return;
        }
        const useAi = settings.aiCutout !== false;
        setBusy(true);
        say('换装中…');
        try {
          const dataUrl = await fileToDataUrl(file, { trim: settings.smartTrim !== false && !useAi });
          await uploadPhoto(dataUrl);
          setPhotoUrl(API_PHOTO + '?t=' + Date.now());
          if (!useAi) {
            say('新形象真好看！');
            return;
          }
          // Smart auto-cutout: AI matting + cleanup + auto-crop, then save.
          say('正在 AI 抠图…');
          let lastPct = 0;
          const photoBlob = await (await fetch(API_PHOTO + '?t=' + Date.now())).blob();
          const result = await aiCutoutBlob(photoBlob, (key, current, total) => {
            if (typeof current === 'number' && typeof total === 'number' && total > 0) {
              const pct = Math.round((current / total) * 100);
              if (pct - lastPct >= 10) {
                lastPct = pct;
                say(`AI 抠图中… ${pct}%`);
              }
            }
          });
          const canvas = await blobToCanvas(result, AI_EDIT_MAX);
          const ctx = canvas.getContext('2d');
          if (ctx === null) throw new Error('no-canvas');
          cleanMatte(ctx);
          decontaminateEdges(ctx);
          cropToSubject(canvas, ctx);
          await uploadPhoto(canvas.toDataURL('image/png'));
          setPhotoUrl(API_PHOTO + '?t=' + Date.now());
          say('AI 抠好啦，干净多了！');
        } catch (error) {
          console.error('[photo-pet] upload/AI failed:', error);
          if (useAi) say('AI 抠图没成功，已保留原图');
          else say('上传失败了，再试试？');
        } finally {
          setBusy(false);
        }
      }, [say, settings.smartTrim, settings.aiCutout]);

      // ------------------------------------------------------------------
      // 抠图 (cutout) editor: open the current photo on a checkerboard,
      // paint with an eraser/restore brush, run the auto background-removal
      // pass, then apply the transparent result.
      // ------------------------------------------------------------------
      const openEditor = useCallback(() => {
        setEditing(true);
        setEditError(null);
      }, []);

      // Load the current photo into the edit canvas when the editor opens.
      useEffect(() => {
        if (!editing) return;
        let alive = true;
        (async () => {
          try {
            const img = new window.Image();
            await new Promise((resolve, reject) => {
              img.onload = resolve;
              img.onerror = reject;
              img.src = photoUrl;
            });
            const canvas = editCanvasRef.current;
            const ctx = canvas === null ? null : canvas.getContext('2d');
            if (!canvas || ctx === null) throw new Error('no-canvas');
            const MAX = 1024;
            let width = img.naturalWidth || 1;
            let height = img.naturalHeight || 1;
            if (width > MAX || height > MAX) {
              const scale = MAX / Math.max(width, height);
              width = Math.max(1, Math.round(width * scale));
              height = Math.max(1, Math.round(height * scale));
            }
            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(img, 0, 0, width, height);
            const snapshot = ctx.getImageData(0, 0, width, height);
            editCtxRef.current = ctx;
            editOriginalRef.current = snapshot;
            editBaseRef.current = snapshot;
            editUndoRef.current = [];
            if (alive) setEditError(null);
          } catch (error) {
            console.error('[photo-pet] editor init failed:', error);
            if (alive) setEditError('图片加载失败，重试一下？');
          }
        })();
        return () => { alive = false; };
      }, [editing, photoUrl]);

      const brushPx = brushSize === 'small' ? 8 : brushSize === 'large' ? 34 : 18;

      // Stamp a soft brush circle on the working canvas.
      const paintAt = useCallback((ctx, x, y, radius, mode) => {
        const base = editBaseRef.current;
        const w = ctx.canvas.width;
        const h = ctx.canvas.height;
        const imageData = ctx.getImageData(0, 0, w, h);
        const px = imageData.data;
        const r2 = radius * radius;
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const d2 = dx * dx + dy * dy;
            if (d2 > r2) continue;
            const x2 = x0 + dx;
            const y2 = y0 + dy;
            if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
            const k = (y2 * w + x2) * 4;
            const f = 1 - Math.sqrt(d2) / radius; // soft edge 1 → 0
            if (mode === 'erase') {
              px[k + 3] = Math.round(px[k + 3] * (1 - f));
            } else {
              const origA = base === null ? 0 : base.data[k + 3];
              px[k + 3] = Math.min(255, Math.round(px[k + 3] + (origA - px[k + 3]) * f));
            }
          }
        }
        ctx.putImageData(imageData, 0, 0);
      }, []);

      const canvasPos = useCallback((event) => {
        const canvas = editCanvasRef.current;
        const rect = canvas.getBoundingClientRect();
        return {
          x: (event.clientX - rect.left) * (canvas.width / Math.max(1, rect.width)),
          y: (event.clientY - rect.top) * (canvas.height / Math.max(1, rect.height)),
        };
      }, []);

      const onEditPointerDown = useCallback((event) => {
        const ctx = editCtxRef.current;
        if (ctx === null) return;
        event.preventDefault();
        try { ctx.canvas.setPointerCapture(event.pointerId); } catch { /* pointer capture optional */ }
        editUndoRef.current.push(ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height));
        if (editUndoRef.current.length > 12) editUndoRef.current.shift();
        const pos = canvasPos(event);
        editStrokeRef.current = pos;
        paintAt(ctx, pos.x, pos.y, brushPx, brushMode);
      }, [canvasPos, paintAt, brushPx, brushMode]);

      const onEditPointerMove = useCallback((event) => {
        const ctx = editCtxRef.current;
        const last = editStrokeRef.current;
        if (ctx === null || last === null) return;
        const pos = canvasPos(event);
        const steps = Math.max(1, Math.ceil(Math.hypot(pos.x - last.x, pos.y - last.y) / (brushPx / 2)));
        for (let i = 1; i <= steps; i++) {
          paintAt(ctx, last.x + ((pos.x - last.x) * i) / steps, last.y + ((pos.y - last.y) * i) / steps, brushPx, brushMode);
        }
        editStrokeRef.current = pos;
      }, [canvasPos, paintAt, brushPx, brushMode]);

      const undoEdit = useCallback(() => {
        const ctx = editCtxRef.current;
        const snapshot = editUndoRef.current.pop();
        if (ctx !== null && snapshot !== undefined) ctx.putImageData(snapshot, 0, 0);
      }, []);

      const resetEdit = useCallback(() => {
        const ctx = editCtxRef.current;
        const original = editOriginalRef.current;
        if (ctx === null || original === null) return;
        ctx.putImageData(original, 0, 0);
        editBaseRef.current = original;
        editUndoRef.current = [];
      }, []);

      const runAutoCut = useCallback(() => {
        const ctx = editCtxRef.current;
        if (ctx === null) return;
        const before = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
        editUndoRef.current.push(before);
        if (trimBackground(ctx.canvas, ctx)) {
          // The photo may have been cropped: treat the trimmed state as the
          // new reference for the restore brush and start a fresh undo list.
          editBaseRef.current = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
          editUndoRef.current = [];
          say('自动抠图完成，可再手动修边');
        } else {
          say('背景不够干净，试试手动擦除');
        }
      }, [say]);

      // AI one-click cutout: run the browser matting model on the current
      // photo, then clean up (specks/holes/fringe) and auto-crop into the
      // editor canvas. First use streams the model (~44MB) through the host
      // proxy, then it is disk-cached.
      const runAiCut = useCallback(async () => {
        if (editCtxRef.current === null) return;
        setBusy(true);
        let lastPct = 0;
        try {
          say('正在加载 AI 模型(首次约 40MB)…');
          const photoBlob = await (await fetch(photoUrl)).blob();
          const result = await aiCutoutBlob(photoBlob, (key, current, total) => {
            if (typeof current === 'number' && typeof total === 'number' && total > 0) {
              const pct = Math.round((current / total) * 100);
              if (pct - lastPct >= 10) {
                lastPct = pct;
                say(`AI 抠图中… ${pct}%`);
              }
            }
          });
          const canvas = await blobToCanvas(result, AI_EDIT_MAX);
          const ctx = canvas.getContext('2d');
          if (ctx === null) throw new Error('no-canvas');
          cleanMatte(ctx);
          decontaminateEdges(ctx);
          cropToSubject(canvas, ctx);
          const editCanvas = editCanvasRef.current;
          const editCtx = editCtxRef.current;
          if (editCanvas === null || editCtx === null) throw new Error('no-canvas');
          editCanvas.width = canvas.width;
          editCanvas.height = canvas.height;
          editCtx.drawImage(canvas, 0, 0);
          const snapshot = editCtx.getImageData(0, 0, editCanvas.width, editCanvas.height);
          editOriginalRef.current = snapshot;
          editBaseRef.current = snapshot;
          editUndoRef.current = [];
          setEditError(null);
          say('AI 抠图完成，可再手动修边');
        } catch (error) {
          console.error('[photo-pet] AI cutout failed:', error);
          say('AI 抠图失败(网络或浏览器不支持)，可用手动擦除');
        } finally {
          setBusy(false);
        }
      }, [say, photoUrl]);

      const applyEdit = useCallback(async () => {
        const canvas = editCanvasRef.current;
        if (canvas === null) return;
        setBusy(true);
        say('正在保存…');
        try {
          const dataUrl = canvas.toDataURL('image/png');
          await uploadPhoto(dataUrl);
          setPhotoUrl(API_PHOTO + '?t=' + Date.now());
          setEditing(false);
          say('抠好啦，干净多了！');
        } catch (error) {
          console.error('[photo-pet] edit save failed:', error);
          say('保存失败了，再试试？');
        } finally {
          setBusy(false);
        }
      }, [say]);

      const handleResetPhoto = useCallback(async () => {
        try {
          await deletePhoto();
          setPhotoUrl(null);
          say('变回原来的样子啦');
        } catch {
          say('恢复失败了…');
        }
      }, [say]);

      // The settings page ("我的宠物") drives pet actions through the bus:
      // upload a photo, open the cutout editor, reset the photo. useLayoutEffect
      // (not useEffect) so the listener is registered at commit time — a
      // passive effect can lag behind a same-turn bus emit.
      useLayoutEffect(() => {
        return petBus.on((message) => {
          if (message.type === 'upload' && message.file !== undefined && message.file !== null) {
            handleFile(message.file);
          } else if (message.type === 'openCutout') {
            if (photoUrl === null) say('先上传照片才能抠图哦～');
            else openEditor();
          } else if (message.type === 'resetPhoto') {
            handleResetPhoto();
          }
        });
      }, [handleFile, openEditor, handleResetPhoto, say, photoUrl]);

      // Save the pet's name: empty input is refused, length is capped.
      const saveName = useCallback(() => {
        const value = (nameInputRef.current?.value ?? '').trim().slice(0, NAME_MAX);
        if (value === '') {
          say('名字不能是空的哦～');
          return;
        }
        store.set('name', value);
        setNaming(false);
        say(`好呀,以后叫我${value}!`);
      }, [store, say]);

      // Focus the name input as soon as the naming panel opens.
      useEffect(() => {
        if (naming) nameInputRef.current?.focus();
      }, [naming]);

      const commitPos = useCallback((right, bottom) => {
        commitAtRef.current = Date.now();
        setPos({ right, bottom });
        setDragging(false);
        store.set('right', Math.round(right));
        store.set('bottom', Math.round(bottom));
      }, [store]);

      const onPointerDown = useCallback((event) => {
        if (event.button !== 0 || event.target.closest('.pp-menu') !== null) return;
        event.preventDefault();
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        dragRef.current = {
          startX: event.clientX,
          startY: event.clientY,
          startRight: settings.right,
          startBottom: settings.bottom,
          moved: false,
        };
        setDragging(true);
      }, [settings.right, settings.bottom]);

      const onPointerMove = useCallback((event) => {
        const drag = dragRef.current;
        if (drag === null) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        const size = settings.size;
        const maxRight = Math.max(0, window.innerWidth - size);
        const maxBottom = Math.max(0, window.innerHeight - size);
        setPos({
          right: clamp(drag.startRight - dx, 0, maxRight),
          bottom: clamp(drag.startBottom - dy, 0, maxBottom),
        });
      }, [settings.size]);

      const onPointerUp = useCallback((event) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (drag === null) return;
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
        if (!drag.moved) {
          setDragging(false);
          if (event.pointerType === 'touch') {
            // No hover on touch screens: a tap opens the menu.
            if (naming) setNaming(false);
            else setMenuOpen((v) => !v);
            return;
          }
          setBounce((n) => n + 1);
          // Clicking rotates through the configured click lines, one per click.
          const clickLines_ = clickLines.length > 0 ? clickLines : PET_LINES;
          const line = clickLines_[clickLineIdxRef.current % clickLines_.length];
          clickLineIdxRef.current = (clickLineIdxRef.current + 1) % clickLines_.length;
          say(line);
          return;
        }
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        const size = settings.size;
        const maxRight = Math.max(0, window.innerWidth - size);
        const maxBottom = Math.max(0, window.innerHeight - size);
        const right = clamp(drag.startRight - dx, 0, maxRight);
        const bottom = clamp(drag.startBottom - dy, 0, maxBottom);
        commitPos(right, bottom);
      }, [settings.size, naming, commitPos, say, clickLines]);

      const onDrop = useCallback((event) => {
        event.preventDefault();
        const file = event.dataTransfer?.files?.[0];
        if (file !== undefined) handleFile(file);
      }, [handleFile]);

      // Hover reveals the menu, leaving hides it. A document-level mouseover
      // tracker keeps it open while the pointer is over the pet OR its menu
      // (moving between the two never flickers), and closes it a moment after
      // the pointer leaves both.
      const scheduleClose = useCallback(() => {
        if (hoverTimerRef.current !== null) { window.clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
        hoverTimerRef.current = window.setTimeout(() => {
          setMenuOpen(false);
          setHovered(null);
          setHovering(false);
        }, 250);
      }, []);
      const cancelHoverTimer = useCallback(() => {
        if (hoverTimerRef.current !== null) { window.clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
      }, []);
      // Hovering a fan button shows its function label; a short grace avoids
      // flicker while the pointer crosses from one button to the next.
      const showLabel = useCallback((index) => {
        if (labelTimerRef.current !== null) { window.clearTimeout(labelTimerRef.current); labelTimerRef.current = null; }
        setHovered(index);
      }, []);
      const hideLabelSoon = useCallback(() => {
        if (labelTimerRef.current !== null) { window.clearTimeout(labelTimerRef.current); labelTimerRef.current = null; }
        labelTimerRef.current = window.setTimeout(() => setHovered(null), 100);
      }, []);
      useEffect(() => () => {
        if (labelTimerRef.current !== null) window.clearTimeout(labelTimerRef.current);
      }, []);
      useEffect(() => {
        const onOver = (event) => {
          const target = event.target;
          if (target === null || typeof target.closest !== 'function') return;
          if (dragRef.current !== null) return; // no menu while dragging
          if (namingRef.current) return; // naming mode: ignore hover entirely
          if (target.closest('.pp-shell') !== null) {
            cancelHoverTimer();
            setHovering(true);
            setMenuOpen(true);
          } else {
            scheduleClose();
          }
        };
        document.addEventListener('mouseover', onOver);
        return () => {
          document.removeEventListener('mouseover', onOver);
          cancelHoverTimer();
        };
      }, [scheduleClose, cancelHoverTimer]);

      if (!settings.enabled) return null;

      const size = settings.size;
      const rootStyle = {
        width: size,
        // Slightly taller than wide: the photo (portrait) plus breathing room.
        height: Math.round(size * 1.15),
        right: pos.right,
        bottom: pos.bottom,
      };

      if (!settings.visible) {
        return React.createElement('button', {
          className: 'pp-summon',
          style: { right: pos.right, bottom: pos.bottom },
          title: '召唤宠物',
          onClick: () => store.set('visible', true),
        }, '🐾');
      }

      const petClass = 'pp-pet' + (dragging ? '' : ' pp-bob');
      const animClass = (bounce > 0 ? ' pp-bounce' : '').trim();
      const shellClass = 'pp-shell' + (working ? ' pp-working' : '');
      // Semi-circular fan menu around the pet: opens downward when there is
      // room, flips upward when the pet hugs the bottom edge of the viewport.
      // Upload sits at the bottom-center (the focal point), size controls
      // flank it symmetrically. Never overlaps the bubble above the pet.
      const fanSign = pos.bottom > MENU_FLIP_AT ? 1 : -1;
      const menuClass = 'pp-menu' + (fanSign < 0 ? ' pp-menu-above' : '');
      // Which fan items show is user-configurable (settings.fanMenuItems).
      const enabledFanIds = parseFanMenuItems(settings.fanMenuItems);
      const menuItems = [
        { id: 'hide', icon: '🙈', title: '先藏起来', onClick: () => { setMenuOpen(false); store.set('visible', false); } },
        { id: 'shrink', icon: '➖', title: '缩小', onClick: () => { setMenuOpen(false); store.set('size', clamp(settings.size - 20, 80, 320)); } },
        { id: 'rename', icon: '🏷️', title: '取名字', onClick: () => { setMenuOpen(false); setNaming(true); } },
        { id: 'photo', icon: '📷', title: '上传照片', disabled: busy, onClick: () => { setMenuOpen(false); fileRef.current?.click(); } },
        { id: 'cutout', icon: '🪄', title: '智能抠图', disabled: busy, onClick: () => {
          setMenuOpen(false);
          if (photoUrl === null) { say('先上传照片才能抠图哦～'); return; }
          openEditor();
        } },
        { id: 'enlarge', icon: '➕', title: '放大', onClick: () => { setMenuOpen(false); store.set('size', clamp(settings.size + 20, 80, 320)); } },
      ].filter((item) => enabledFanIds.has(item.id));
      if (photoUrl !== null && enabledFanIds.has('reset')) {
        menuItems.push({ id: 'reset', icon: '♻️', title: '恢复默认形象', disabled: busy, onClick: () => { setMenuOpen(false); handleResetPhoto(); } });
      }
      const fanRadius = size / 2 + 18;
      const fanAngles = menuItems.map((_, index) => {
        const span = Math.max(1, menuItems.length - 1);
        return fanSign * (180 - (index * 180) / span);
      });

      return React.createElement('div', {
        className: shellClass,
        style: rootStyle,
        onDragOver: (e) => e.preventDefault(),
        onDrop,
      },
        bubble !== null && React.createElement('div', { className: 'pp-bubble', key: 'bubble-' + bubble.at }, bubble.text),
        // The file input lives OUTSIDE the menu (always mounted): the menu
        // closes the moment "上传照片" is clicked, and a change event fired
        // on an unmounted input would never reach handleFile.
        React.createElement('input', {
          ref: fileRef,
          type: 'file',
          accept: 'image/*',
          style: { display: 'none' },
          onChange: (e) => {
            const file = e.target.files?.[0];
            if (file !== undefined) handleFile(file);
            e.target.value = '';
          },
        }),
        // No menu at all when every item is disabled by the settings.
        menuOpen && menuItems.length > 0 && createPortal(React.createElement('div', {
          className: 'pp-menu-backdrop',
          key: 'backdrop',
          onClick: () => setMenuOpen(false),
        }), document.body),
        menuOpen && menuItems.length > 0 && React.createElement('div', {
          className: menuClass,
          key: 'menu',
        },
          menuItems.map((item, index) => {
            const rad = (fanAngles[index] * Math.PI) / 180;
            return React.createElement('button', {
              key: item.title,
              className: 'pp-fan-btn',
              title: item.title,
              disabled: item.disabled === true,
              style: {
                left: (fanRadius * Math.cos(rad)).toFixed(1) + 'px',
                top: (fanRadius * Math.sin(rad)).toFixed(1) + 'px',
              },
              onMouseEnter: () => showLabel(index),
              onMouseLeave: hideLabelSoon,
              onClick: item.onClick,
            }, item.icon);
          }),
          hovered !== null && hovered < menuItems.length && React.createElement('div', {
            className: 'pp-fan-label',
            key: 'fan-label',
            style: (() => {
              const rad = (fanAngles[hovered] * Math.PI) / 180;
              const labelRadius = fanRadius + 16;
              return {
                left: (labelRadius * Math.cos(rad)).toFixed(1) + 'px',
                top: (labelRadius * Math.sin(rad)).toFixed(1) + 'px',
              };
            })(),
          }, menuItems[hovered].title),
        ),
        // Nameplate: hidden by default, appears while hovering the pet (on
        // the side opposite the fan menu so they never overlap), and hides
        // again once the pointer leaves. A speech bubble takes precedence.
        hovering && !naming && bubble === null && React.createElement('div', {
          className: 'pp-nameplate' + (fanSign < 0 ? ' pp-nameplate-below' : ''),
          key: 'nameplate',
        }, settings.name || '小宠'),
        naming && React.createElement('div', {
          className: 'pp-name-panel',
          key: 'name-panel',
        },
          React.createElement('input', {
            ref: nameInputRef,
            type: 'text',
            maxLength: NAME_MAX,
            defaultValue: settings.name || '',
            placeholder: '取个名字',
            onKeyDown: (e) => { if (e.key === 'Enter') saveName(); },
          }),
          React.createElement('button', { title: '保存', onClick: saveName }, '✓'),
          React.createElement('button', { title: '取消', onClick: () => setNaming(false) }, '✕'),
        ),
        editing && createPortal(React.createElement('div', {
          className: 'pp-editor',
          key: 'editor',
          onClick: (e) => { if (e.target === e.currentTarget) setEditing(false); },
        },
          React.createElement('div', { className: 'pp-editor-card' },
            React.createElement('div', { className: 'pp-editor-head' },
              React.createElement('span', null, '✂️ 抠图工具'),
              React.createElement('button', {
                className: 'pp-editor-close',
                title: '关闭',
                onClick: () => setEditing(false),
              }, '✕'),
            ),
            React.createElement('div', { className: 'pp-editor-wrap' },
              editError !== null
                ? React.createElement('div', { className: 'pp-editor-msg' }, editError)
                : React.createElement('canvas', {
                    ref: editCanvasRef,
                    className: 'pp-editor-canvas',
                    onPointerDown: onEditPointerDown,
                    onPointerMove: onEditPointerMove,
                    onPointerUp: () => { editStrokeRef.current = null; },
                    onPointerCancel: () => { editStrokeRef.current = null; },
                  }),
            ),
            React.createElement('div', { className: 'pp-editor-tools' },
              React.createElement('button', {
                className: 'pp-editor-ai',
                disabled: busy,
                onClick: runAiCut,
              }, '🤖 AI 一键抠图'),
              React.createElement('button', {
                className: brushMode === 'erase' ? 'on' : '',
                onClick: () => setBrushMode('erase'),
              }, '🧽 擦除'),
              React.createElement('button', {
                className: brushMode === 'restore' ? 'on' : '',
                onClick: () => setBrushMode('restore'),
              }, '↩️ 恢复'),
              React.createElement('span', { className: 'pp-editor-label' }, '笔刷'),
              React.createElement('button', {
                className: brushSize === 'small' ? 'on' : '',
                onClick: () => setBrushSize('small'),
              }, '小'),
              React.createElement('button', {
                className: brushSize === 'medium' ? 'on' : '',
                onClick: () => setBrushSize('medium'),
              }, '中'),
              React.createElement('button', {
                className: brushSize === 'large' ? 'on' : '',
                onClick: () => setBrushSize('large'),
              }, '大'),
              React.createElement('button', { onClick: runAutoCut }, '🪄 自动抠图'),
              React.createElement('button', { onClick: undoEdit }, '↩️ 撤销'),
              React.createElement('button', { onClick: resetEdit }, '🔄 重来'),
            ),
            React.createElement('div', { className: 'pp-editor-actions' },
              React.createElement('button', { onClick: () => setEditing(false) }, '取消'),
              React.createElement('button', {
                className: 'pp-editor-apply',
                disabled: busy,
                onClick: applyEdit,
              }, '✓ 应用'),
            ),
          ),
        ), document.body),
        React.createElement('div', {
          className: petClass,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: () => { dragRef.current = null; setDragging(false); },
        },
          React.createElement('div', { className: 'pp-anim ' + animClass, key: 'anim-' + bounce },
            // The pet is just the photo itself (or the fallback when none is
            // uploaded), shown as-is — no circle crop, no drawn body.
            React.createElement('div', { className: 'pp-avatar' },
              photoUrl === null
                ? React.createElement('div', { className: 'pp-fallback' },
                    React.createElement('img', { src: DEFAULT_PET_URL, alt: 'pet' }))
                : React.createElement('img', { src: photoUrl, alt: 'pet', draggable: false }),
              working && React.createElement('div', { className: 'pp-smoke', key: 'smoke' },
                [0, 1, 2, 3, 4].map((i) => React.createElement('div', {
                  className: 'pp-smoke-puff',
                  key: 'puff-' + i,
                  style: { animationDelay: (i * 0.6).toFixed(2) + 's' },
                })),
              ),
            ),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------
    // Settings page section ("我的宠物" in the GUI 设置 left nav). The settings
    // page renders first-level sections from the 'settings.section' slot — the
    // same left menu as 通用/插件/宠物. This half owns a generic schema-form
    // section bound to the 'photo-pet' scope: enable, visibility, name, size,
    // position, trim/AI toggles and the working-state lines. Staging/save/
    // read-back is the standard CardForm machinery.
    // ---------------------------------------------------------------------

    const SETTINGS_CARD_TAG = 'dsh-photo-pet-settings-style';
    let settingsStyleRef = null;
    function injectSettingsStyles() {
      if (settingsStyleRef !== null || typeof document === 'undefined') return;
      const style = document.createElement('style');
      style.id = SETTINGS_CARD_TAG;
      style.textContent = [
        '.pp-set-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;margin:0}',
        '.pp-set-sectionList{margin:0;padding:0;list-style:none}',
        '.pp-set-head{display:flex;align-items:center;gap:12px;padding:14px 16px}',
        '.pp-set-headText{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0}',
        '.pp-set-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
        '.pp-set-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
        '.pp-set-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
        '.pp-set-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
        '.pp-set-field+.pp-set-field{border-top:1px solid var(--dsw-alias-border-l2)}',
        '.pp-set-fieldHead{display:flex;align-items:center;gap:8px}',
        '.pp-set-fieldLabel{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}',
        '.pp-set-badges{display:flex;align-items:center;gap:8px}',
        '.pp-set-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
        '.pp-set-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:0;padding:0;font-size:12px;line-height:1.5}',
        '.pp-set-reset:hover{color:var(--dsw-alias-label-primary)}',
        '.pp-set-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}',
        '.pp-set-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
        '.pp-set-input.pp-set-invalid{border:1px solid var(--dsw-alias-label-error)}',
        '.pp-set-textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 12px;font-size:13px;line-height:1.6;resize:vertical;min-height:96px}',
        '.pp-set-textarea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
        '.pp-set-toggleRow{display:flex;align-items:center;gap:8px}',
        '.pp-set-chipRow{display:flex;flex-wrap:wrap;gap:8px}',
        '.pp-set-chipTools{display:flex;gap:8px;margin-top:2px}',
        '.pp-set-chipTool{appearance:none;font:inherit;cursor:pointer;border:0;color:var(--dsw-alias-brand-primary);background:none;padding:0;font-size:12px;line-height:1.5}',
        '.pp-set-chipTool:hover:not(:disabled){text-decoration:underline}',
        '.pp-set-chipTool:disabled{opacity:.4;cursor:default}',
        '.pp-set-chip{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3);border-radius:999px;padding:4px 12px;font-size:12px;line-height:1.5}',
        '.pp-set-chip[data-on=true]{color:var(--dsw-alias-bg-layer-3);background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}',
        '.pp-set-actionRow{display:flex;flex-wrap:wrap;gap:8px}',
        '.pp-set-action{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:5px 12px;font-size:12px;line-height:1.5}',
        '.pp-set-action:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
        '.pp-set-action:disabled{opacity:.4;cursor:default}',
        '.pp-set-danger{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-border-error,var(--dsw-alias-label-error))}',
        '.pp-set-danger:hover:not(:disabled){border-color:var(--dsw-alias-label-error);color:var(--dsw-alias-label-error)}',
        '.pp-set-toggle{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3);border-radius:999px;padding:3px 12px;font-size:12px;line-height:1.5}',
        '.pp-set-toggle[data-on=true]{color:var(--dsw-alias-bg-layer-3);background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}',
        '.pp-set-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
        '.pp-set-invalidText{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}',
        '.pp-set-footer{border-top:1px solid var(--dsw-alias-border-l2);display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px}',
        '.pp-set-failed{flex:1;min-width:0;color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.pp-set-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
        '.pp-set-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:none}',
        '.pp-set-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
        '.pp-set-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
        '.pp-set-btn:disabled{opacity:.4;cursor:default}',
        '.pp-set-readonly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}',
        '.pp-set-notExposed{color:var(--dsw-alias-state-warn-primary);margin:12px 0 0;font-size:12px;line-height:1.5}',
      ].join('');
      document.head.appendChild(style);
      settingsStyleRef = style;
    }
    function releaseSettingsStyles() {
      if (settingsStyleRef !== null) {
        try { settingsStyleRef.remove(); } catch { /* ignore */ }
        settingsStyleRef = null;
      }
    }

    /** A whole- or decimal-number field. */
    function settingsNumberField(field, constraints = {}) {
      const { integer = false, min } = constraints;
      return {
        field,
        format: (value) => typeof value === 'number' ? String(value) : '',
        parse: (text) => {
          const trimmed = text.trim();
          if (trimmed === '') return { kind: 'clear' };
          const parsed = Number(trimmed);
          if (!Number.isFinite(parsed)) return undefined;
          if (integer && !Number.isInteger(parsed)) return undefined;
          if (min !== undefined && parsed < min) return undefined;
          return { kind: 'set', value: parsed };
        },
      };
    }

    /** A boolean field. */
    function settingsBooleanField(field) {
      return {
        field,
        format: (value) => typeof value === 'boolean' ? String(value) : '',
        parse: (text) => {
          const trimmed = text.trim();
          if (trimmed === '') return { kind: 'clear' };
          if (trimmed === 'true') return { kind: 'set', value: true };
          if (trimmed === 'false') return { kind: 'set', value: false };
          return undefined;
        },
      };
    }

    /** A free-text string field (any non-empty draft is accepted). With
     * `emptyAsSet`, an empty draft is written as an empty string instead of
     * clearing the field — needed when an empty value is meaningful (e.g.
     * "hide every fan-menu item"). */
    function settingsStringField(field, options = {}) {
      return {
        field,
        format: (value) => typeof value === 'string' ? value : '',
        parse: (text) => {
          if (text === '' && options.emptyAsSet !== true) return { kind: 'clear' };
          return { kind: 'set', value: text };
        },
      };
    }

    /**
     * One card's staged form over one settings namespace. Faithful copy of the
     * standard dsh settings card form: stage drafts, save through the scope,
     * read back what the Host accepted, keep failed drafts for correction.
     */
    class SettingsCardForm {
      constructor(scope, specs) {
        this.scope = scope;
        this.specs = new Map(specs.map((spec) => [spec.field, spec]));
        this.staged = new Map();
        this.listeners = new Set();
        this.saving = false;
        this.failed = false;
        this.failedReason = undefined;
        this.disposed = false;
        this.disposeScope = scope.subscribe(() => { this.publish(); });
      }
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.disposeScope();
        this.listeners.clear();
      }
      bind(project) {
        const store = createSnapshotStoreLike(project());
        this.listeners.add(() => { store.set(project()); });
        return store;
      }
      shell() {
        const snapshot = this.scope.getSnapshot();
        const plan = this.plan();
        return {
          available: snapshot.status !== 'loading',
          exposed: snapshot.status === 'ready',
          writable: snapshot.writable,
          dirty: plan.length > 0,
          invalid: plan.some((item) => item.run === undefined),
          saving: this.saving,
          failed: this.failed,
          ...(this.failedReason === undefined ? {} : { failedReason: this.failedReason }),
        };
      }
      field(field) {
        const spec = this.specOf(field);
        const staged = this.staged.get(field);
        if (staged === undefined) {
          return { text: spec.format(this.sectionValue(field)), overridden: this.stored(field), invalid: false };
        }
        const write = staged.clear ? { kind: 'clear' } : spec.parse(staged.text);
        return { text: staged.text, overridden: write?.kind === 'set', invalid: write === undefined };
      }
      actions() {
        return {
          edit: (field, text) => { this.stage(field, { text, clear: false }); },
          resetField: (field) => {
            this.stage(field, { text: this.specOf(field).format(this.baseValue(field)), clear: true });
          },
          save: () => { this.save(); },
          discard: () => {
            if (this.staged.size === 0 && !this.failed) return;
            this.staged.clear();
            this.failed = false;
            this.failedReason = undefined;
            this.publish();
          },
        };
      }
      async save() {
        const plan = this.plan();
        const valid = plan.filter((item) => item.run !== undefined);
        if (plan.length === 0 || this.saving || valid.length !== plan.length) return;
        const pending = new Map();
        for (const item of plan) pending.set(item.field, this.staged.get(item.field));
        this.saving = true;
        this.failed = false;
        this.failedReason = undefined;
        this.publish();
        const landed = new Set();
        for (const item of valid) {
          try {
            if (await item.run()) landed.add(item.field);
          } catch { /* that field did not land */ }
        }
        for (const [field, before] of pending) {
          if (landed.has(field) && this.staged.get(field) === before) this.staged.delete(field);
        }
        this.saving = false;
        this.failed = landed.size !== pending.size;
        this.publish();
      }
      plan() {
        const plan = [];
        for (const [field, staged] of this.staged) {
          const spec = this.specOf(field);
          if (staged.clear) {
            if (this.stored(field)) plan.push({ field, op: { field, op: 'unset' }, run: () => this.clear(field) });
            continue;
          }
          if (staged.text === spec.format(this.sectionValue(field))) continue;
          const write = spec.parse(staged.text);
          if (write === undefined) plan.push({ field, op: { field, op: 'unset' }, run: undefined });
          else if (write.kind === 'clear') plan.push({ field, op: { field, op: 'unset' }, run: () => this.clear(field) });
          else plan.push({ field, op: { field, op: 'set', value: write.value }, run: () => this.store(field, write.value) });
        }
        return plan;
      }
      async clear(field) {
        await this.scope.unset(field);
        return !this.stored(field);
      }
      async store(field, value) {
        await this.scope.set(field, value);
        return this.userLayer()?.[field] === value;
      }
      stage(field, edit) {
        this.staged.set(field, edit);
        this.failed = false;
        this.failedReason = undefined;
        this.publish();
      }
      specOf(field) {
        const spec = this.specs.get(field);
        if (spec === undefined) throw new Error('settings card has no field ' + field);
        return spec;
      }
      snapshotOf() { return this.scope.getSnapshot(); }
      sectionValue(field) { return this.snapshotOf().value?.[field]; }
      baseValue(field) { return this.snapshotOf().base?.[field]; }
      userLayer() { return this.snapshotOf().user; }
      stored(field) {
        const user = this.userLayer();
        return user !== undefined && Object.hasOwn(user, field);
      }
      publish() { for (const listener of this.listeners) listener(); }
    }

    /** Tiny snapshot store with a React hook — like createSnapshotStore. */
    function createSnapshotStoreLike(initial) {
      let snapshot = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => snapshot,
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        set: (next) => { snapshot = next; for (const fn of Array.from(listeners)) fn(); },
      };
    }

    /** Card shell: title, description, body, save/discard footer. */
    function SettingsCard(props) {
      const { t, state, title, description } = props;
      if (!state.available) return null;
      const blocked = !state.dirty || state.invalid || state.saving;
      return React.createElement('li', { className: 'pp-set-card' },
        React.createElement('div', { className: 'pp-set-head' },
          React.createElement('div', { className: 'pp-set-headText' },
            React.createElement('span', { className: 'pp-set-name' }, title),
            React.createElement('span', { className: 'pp-set-desc' }, description),
          ),
          state.dirty ? React.createElement('span', { className: 'pp-set-badge' }, t('unsaved')) : null,
        ),
        React.createElement('div', { className: 'pp-set-body' },
          !state.exposed ? React.createElement('p', { className: 'pp-set-notExposed', role: 'status' }, t('notExposed'))
          : React.createElement(React.Fragment, null,
              !state.writable ? React.createElement('p', { className: 'pp-set-readonly', role: 'status' }, t('readOnly')) : null,
              props.children,
              props.hideFooter === true ? null : React.createElement('div', { className: 'pp-set-footer' },
                state.failed ? React.createElement('p', { className: 'pp-set-failed', role: 'status' },
                  t('saveFailed') + (state.failedReason ? ' - ' + state.failedReason : '')) : null,
                React.createElement('button', {
                  type: 'button',
                  className: 'pp-set-btn pp-set-discard',
                  disabled: !state.dirty || state.saving,
                  onClick: props.onDiscard,
                }, t('discard')),
                React.createElement('button', {
                  type: 'button',
                  className: 'pp-set-btn pp-set-save',
                  disabled: blocked,
                  onClick: props.onSave,
                }, t(state.saving ? 'saving' : 'save')),
              ),
            ),
        ),
      );
    }

    /** Boolean field: on/off segmented toggle. */
    function SettingsBooleanField(props) {
      const { id, label, hint, overriddenLabel, resetLabel, disabled, text, overridden, invalid, onEdit, onReset } = props;
      const on = text === 'true';
      return React.createElement('div', { className: 'pp-set-field' },
        React.createElement('div', { className: 'pp-set-fieldHead' },
          React.createElement('label', { className: 'pp-set-fieldLabel', htmlFor: id }, label),
          overridden ? React.createElement('span', { className: 'pp-set-badges' },
            React.createElement('span', { className: 'pp-set-badge' }, overriddenLabel),
            React.createElement('button', { type: 'button', className: 'pp-set-reset', disabled: disabled, onClick: onReset }, resetLabel),
          ) : null,
        ),
        React.createElement('div', { className: 'pp-set-toggleRow' },
          React.createElement('button', {
            id: id,
            type: 'button',
            className: 'pp-set-toggle',
            'data-on': on ? 'true' : 'false',
            disabled: disabled,
            onClick: () => onEdit(on ? 'false' : 'true'),
          }, on ? '开' : '关'),
        ),
        React.createElement('p', { className: invalid ? 'pp-set-invalidText' : 'pp-set-hint' },
          invalid ? props.invalidLabel : hint),
      );
    }

    /** Text/number field: single-line input. */
    function SettingsValueField(props) {
      const { id, label, hint, overriddenLabel, resetLabel, invalidLabel, numeric, placeholder } = props;
      const { text, overridden, invalid, disabled, onEdit, onReset } = props;
      return React.createElement('div', { className: 'pp-set-field' },
        React.createElement('div', { className: 'pp-set-fieldHead' },
          React.createElement('label', { className: 'pp-set-fieldLabel', htmlFor: id }, label),
          overridden ? React.createElement('span', { className: 'pp-set-badges' },
            React.createElement('span', { className: 'pp-set-badge' }, overriddenLabel),
            React.createElement('button', { type: 'button', className: 'pp-set-reset', disabled: disabled, onClick: onReset }, resetLabel),
          ) : null,
        ),
        React.createElement('input', {
          id: id,
          className: invalid ? 'pp-set-input pp-set-invalid' : 'pp-set-input',
          type: 'text',
          inputMode: numeric === true ? 'numeric' : undefined,
          'aria-invalid': invalid ? true : undefined,
          value: text,
          placeholder: placeholder ?? '',
          disabled: disabled,
          onChange: (event) => onEdit(event.target.value),
        }),
        React.createElement('p', { className: invalid ? 'pp-set-invalidText' : 'pp-set-hint' },
          invalid ? invalidLabel : hint),
      );
    }

    /** Multi-line field: textarea for the working-state lines. */
    function SettingsTextareaField(props) {
      const { id, label, hint, overriddenLabel, resetLabel, rows } = props;
      const { text, overridden, invalid, disabled, onEdit, onReset } = props;
      return React.createElement('div', { className: 'pp-set-field' },
        React.createElement('div', { className: 'pp-set-fieldHead' },
          React.createElement('label', { className: 'pp-set-fieldLabel', htmlFor: id }, label),
          overridden ? React.createElement('span', { className: 'pp-set-badges' },
            React.createElement('span', { className: 'pp-set-badge' }, overriddenLabel),
            React.createElement('button', { type: 'button', className: 'pp-set-reset', disabled: disabled, onClick: onReset }, resetLabel),
          ) : null,
        ),
        React.createElement('textarea', {
          id: id,
          className: 'pp-set-textarea',
          rows: rows ?? 6,
          value: text,
          disabled: disabled,
          onChange: (event) => onEdit(event.target.value),
        }),
        React.createElement('p', { className: 'pp-set-hint' }, hint),
      );
    }

    /** Toggle-list field: each option is an on/off chip; edits a
     * comma-separated id string (kept in FAN_MENU_ITEMS order). */
    function SettingsToggleListField(props) {
      const { id, label, hint, options, overriddenLabel, resetLabel, allOnLabel, allOffLabel } = props;
      const { text, overridden, disabled, onEdit, onReset } = props;
      const enabled = new Set(String(text || '').split(',').map((v) => v.trim()).filter((v) => v.length > 0));
      const allIds = options.map((option) => option.id);
      const allOn = enabled.size === allIds.length && allIds.length > 0;
      const allOff = enabled.size === 0;
      const toggle = (optionId) => {
        const next = new Set(enabled);
        if (next.has(optionId)) next.delete(optionId); else next.add(optionId);
        onEdit(allIds.filter((optionId) => next.has(optionId)).join(','));
      };
      return React.createElement('div', { className: 'pp-set-field' },
        React.createElement('div', { className: 'pp-set-fieldHead' },
          React.createElement('span', { className: 'pp-set-fieldLabel', id: id }, label),
          overridden ? React.createElement('span', { className: 'pp-set-badges' },
            React.createElement('span', { className: 'pp-set-badge' }, overriddenLabel),
            React.createElement('button', { type: 'button', className: 'pp-set-reset', disabled: disabled, onClick: onReset }, resetLabel),
          ) : null,
        ),
        React.createElement('div', { className: 'pp-set-chipRow', role: 'group', 'aria-labelledby': id },
          options.map((option) => {
            const on = enabled.has(option.id);
            return React.createElement('button', {
              key: option.id,
              type: 'button',
              className: 'pp-set-chip',
              'data-on': on ? 'true' : 'false',
              disabled: disabled,
              onClick: () => toggle(option.id),
              title: option.title,
            }, option.icon + ' ' + option.title);
          }),
        ),
        React.createElement('div', { className: 'pp-set-chipTools', role: 'group' },
          React.createElement('button', {
            type: 'button',
            className: 'pp-set-chipTool',
            disabled: disabled || allOn,
            onClick: () => onEdit(allIds.join(',')),
          }, allOnLabel ?? '全部显示'),
          React.createElement('button', {
            type: 'button',
            className: 'pp-set-chipTool',
            disabled: disabled || allOff,
            onClick: () => onEdit(''),
          }, allOffLabel ?? '全部隐藏'),
        ),
        React.createElement('p', { className: 'pp-set-hint' }, hint),
      );
    }

    /** A one-off action row (upload / cutout / reset) driven by the bus. */
    function SettingsActionRow(props) {
      const { id, label, hint } = props;
      const actions = props.actions;
      return React.createElement('div', { className: 'pp-set-field' },
        React.createElement('div', { className: 'pp-set-fieldHead' },
          React.createElement('span', { className: 'pp-set-fieldLabel', id: id }, label),
        ),
        React.createElement('div', { className: 'pp-set-actionRow', role: 'group', 'aria-labelledby': id },
          actions.map((action) => React.createElement('button', {
            key: action.id,
            type: 'button',
            className: 'pp-set-action',
            disabled: action.disabled === true,
            onClick: action.onClick,
          }, action.icon + ' ' + action.label)),
        ),
        React.createElement('p', { className: 'pp-set-hint' }, hint),
      );
    }

    /** Plugin management field: shows the installed vs latest version and
     * offers 更新 (update) / 卸载 (uninstall). The update button is always
     * clickable — every click re-checks npm and updates if a newer version
     * exists; when already latest it reports "已是最新版本 vX". Uninstall is
     * two-step ("卸载" → "确认卸载?") so it cannot fire by accident. After a
     * real update/uninstall the GUI restarts automatically. */
    function SettingsPluginActionsField(props) {
      const { id, label, hint, t, disabled } = props;
      const [version, setVersion] = React.useState(null);
      const [phase, setPhase] = React.useState('idle'); // idle|updating|confirm|uninstalling|failed
      React.useEffect(() => {
        let alive = true;
        pluginManage.check().then((value) => { if (alive && value !== null) setVersion(value); }, () => {});
        return () => { alive = false; };
      }, []);
      const busy = phase === 'updating' || phase === 'uninstalling';
      const latestKnown = version !== null && version.latest !== null && version.installed !== null && version.latest !== version.installed;
      const status = phase === 'updating' || phase === 'uninstalling'
        ? t('pluginRestarting')
        : phase === 'failed'
          ? t('pluginUpdateFailed')
          : version !== null && version.installed !== null
            ? (latestKnown
                ? t('pluginNewer').replace('{latest}', version.latest)
                : t('pluginUpToDate') + ' v' + version.installed)
            : '';
      const onUpdate = () => {
        setPhase('updating');
        pluginManage.update().then((result) => {
          if (result !== null && result.ok === true && result.updated === false) {
            // Already latest: report the versions and stay put (no restart).
            setVersion({
              installed: result.installed ?? (version === null ? null : version.installed),
              latest: result.latest ?? (version === null ? null : version.latest),
              upToDate: true,
            });
            setPhase('idle');
            return;
          }
          if (result !== null && result.ok === true) return; // restarting — hold the "restarting" text
          setPhase('failed');
        }, () => setPhase('failed'));
      };
      const onUninstall = () => {
        if (phase !== 'confirm') { setPhase('confirm'); return; }
        setPhase('uninstalling');
        pluginManage.uninstall().then((result) => {
          if (result === null || result.ok !== true) setPhase('failed');
        }, () => setPhase('failed'));
      };
      return React.createElement('div', { className: 'pp-set-field' },
        React.createElement('div', { className: 'pp-set-fieldHead' },
          React.createElement('span', { className: 'pp-set-fieldLabel', id: id }, label),
        ),
        React.createElement('div', { className: 'pp-set-actionRow', role: 'group', 'aria-labelledby': id },
          React.createElement('button', {
            key: 'update',
            type: 'button',
            className: 'pp-set-action',
            disabled: disabled || busy,
            onClick: onUpdate,
          }, '🔄 ' + (phase === 'updating' ? t('pluginRestarting') : t('pluginUpdate'))),
          React.createElement('button', {
            key: 'uninstall',
            type: 'button',
            className: 'pp-set-action pp-set-danger',
            disabled: disabled || busy,
            onClick: onUninstall,
          }, '🗑️ ' + (phase === 'confirm' ? t('pluginUninstallConfirm') : t('pluginUninstall'))),
        ),
        React.createElement('p', { className: 'pp-set-hint' },
          (status !== '' ? status : hint),
        ),
      );
    }

    /** Card controller for the photo-pet namespace. */
    class PhotoPetCardController {
      constructor(scope) {
        this.form = new SettingsCardForm(scope, [
          settingsBooleanField('enabled'),
          settingsBooleanField('visible'),
          settingsStringField('name'),
          settingsNumberField('size', { integer: true, min: 80 }),
          settingsNumberField('right', { integer: true, min: 0 }),
          settingsNumberField('bottom', { integer: true, min: 0 }),
          settingsBooleanField('smartTrim'),
          settingsBooleanField('aiCutout'),
          settingsStringField('workLines'),
          settingsNumberField('workInterval', { min: 1 }),
          settingsStringField('clickLines'),
          // Empty string is a real value ("hide every menu item"), NOT a
          // clear-to-default — otherwise saving an empty selection would
          // unset the field and the schema default (all items) would come back.
          settingsStringField('fanMenuItems', { emptyAsSet: true }),
        ]);
        this.store = this.form.bind(() => this.projection());
      }
      projection() {
        return {
          ...this.form.shell(),
          enabled: this.form.field('enabled'),
          visible: this.form.field('visible'),
          name: this.form.field('name'),
          size: this.form.field('size'),
          right: this.form.field('right'),
          bottom: this.form.field('bottom'),
          smartTrim: this.form.field('smartTrim'),
          aiCutout: this.form.field('aiCutout'),
          workLines: this.form.field('workLines'),
          workInterval: this.form.field('workInterval'),
          clickLines: this.form.field('clickLines'),
          fanMenuItems: this.form.field('fanMenuItems'),
        };
      }
      inject() {
        return {
          hooks: { photoPetCard: this.store },
          ...this.form.actions(),
        };
      }
      dispose() { this.form.dispose(); }
    }

    /** The settings card itself. */
    function PhotoPetSettingsCard(props) {
      const { t } = props;
      const state = props.usePhotoPetCard((snapshot) => snapshot);
      const disabled = !state.writable;
      const fileInputRef = React.useRef(null);
      const fieldProps = {
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: t('invalidNumber'),
        disabled,
      };
      return React.createElement(SettingsCard, {
        t,
        title: t('title'),
        description: t('description'),
        state,
        onSave: props.save,
        onDiscard: props.discard,
      },
        React.createElement(SettingsBooleanField, {
          id: 'photo-pet-enabled', label: t('enabled'), hint: t('enabledHint'),
          ...fieldProps, ...state.enabled,
          onEdit: (text) => props.edit('enabled', text),
          onReset: () => props.resetField('enabled'),
        }),
        React.createElement(SettingsBooleanField, {
          id: 'photo-pet-visible', label: t('visible'), hint: t('visibleHint'),
          ...fieldProps, ...state.visible,
          onEdit: (text) => props.edit('visible', text),
          onReset: () => props.resetField('visible'),
        }),
        React.createElement(SettingsValueField, {
          id: 'photo-pet-name', label: t('name'), hint: t('nameHint'),
          ...fieldProps, ...state.name,
          onEdit: (text) => props.edit('name', text),
          onReset: () => props.resetField('name'),
        }),
        React.createElement(SettingsValueField, {
          id: 'photo-pet-size', label: t('size'), hint: t('sizeHint'),
          numeric: true, ...fieldProps, ...state.size,
          onEdit: (text) => props.edit('size', text),
          onReset: () => props.resetField('size'),
        }),
        React.createElement(SettingsValueField, {
          id: 'photo-pet-right', label: t('right'), hint: t('rightHint'),
          numeric: true, ...fieldProps, ...state.right,
          onEdit: (text) => props.edit('right', text),
          onReset: () => props.resetField('right'),
        }),
        React.createElement(SettingsValueField, {
          id: 'photo-pet-bottom', label: t('bottom'), hint: t('bottomHint'),
          numeric: true, ...fieldProps, ...state.bottom,
          onEdit: (text) => props.edit('bottom', text),
          onReset: () => props.resetField('bottom'),
        }),
        React.createElement(SettingsBooleanField, {
          id: 'photo-pet-smart-trim', label: t('smartTrim'), hint: t('smartTrimHint'),
          ...fieldProps, ...state.smartTrim,
          onEdit: (text) => props.edit('smartTrim', text),
          onReset: () => props.resetField('smartTrim'),
        }),
        React.createElement(SettingsBooleanField, {
          id: 'photo-pet-ai-cutout', label: t('aiCutout'), hint: t('aiCutoutHint'),
          ...fieldProps, ...state.aiCutout,
          onEdit: (text) => props.edit('aiCutout', text),
          onReset: () => props.resetField('aiCutout'),
        }),
        React.createElement(SettingsValueField, {
          id: 'photo-pet-work-interval', label: t('workInterval'), hint: t('workIntervalHint'),
          numeric: true, ...fieldProps, ...state.workInterval,
          onEdit: (text) => props.edit('workInterval', text),
          onReset: () => props.resetField('workInterval'),
        }),
        React.createElement(SettingsTextareaField, {
          id: 'photo-pet-work-lines', label: t('workLines'), hint: t('workLinesHint'),
          overriddenLabel: t('overridden'), resetLabel: t('reset'),
          disabled,
          ...state.workLines,
          onEdit: (text) => props.edit('workLines', text),
          onReset: () => props.resetField('workLines'),
        }),
        React.createElement(SettingsTextareaField, {
          id: 'photo-pet-click-lines', label: t('clickLines'), hint: t('clickLinesHint'),
          overriddenLabel: t('overridden'), resetLabel: t('reset'),
          disabled,
          ...state.clickLines,
          onEdit: (text) => props.edit('clickLines', text),
          onReset: () => props.resetField('clickLines'),
        }),
        React.createElement(SettingsToggleListField, {
          id: 'photo-pet-fan-menu', label: t('fanMenu'), hint: t('fanMenuHint'),
          overriddenLabel: t('overridden'), resetLabel: t('reset'),
          allOnLabel: t('fanAllOn'), allOffLabel: t('fanAllOff'),
          options: FAN_MENU_ITEMS,
          disabled,
          ...state.fanMenuItems,
          onEdit: (text) => props.edit('fanMenuItems', text),
          onReset: () => props.resetField('fanMenuItems'),
        }),
        React.createElement(SettingsActionRow, {
          id: 'photo-pet-quick-actions', label: t('quickActions'), hint: t('quickActionsHint'),
          actions: [
            { id: 'upload', icon: '📷', label: t('actionUpload'), onClick: () => { fileInputRef.current?.click(); } },
            { id: 'cutout', icon: '🪄', label: t('actionCutout'), onClick: () => { petBus.emit({ type: 'openCutout' }); } },
            { id: 'reset', icon: '♻️', label: t('actionReset'), onClick: () => { petBus.emit({ type: 'resetPhoto' }); } },
          ],
        }),
        React.createElement(SettingsPluginActionsField, {
          id: 'photo-pet-plugin-manage', label: t('pluginManage'), hint: t('pluginManageHint'),
          t, disabled,
        }),
        React.createElement('input', {
          ref: fileInputRef,
          type: 'file',
          accept: 'image/*',
          style: { display: 'none' },
          onChange: (event) => {
            const file = event.target.files?.[0];
            if (file !== undefined && file !== null) petBus.emit({ type: 'upload', file });
            event.target.value = '';
          },
        }),
      );
    }

    /**
     * The left-nav settings section ("我的宠物", same level as 插件): renders
     * the card inside a section list. The settings page dispatches the
     * 'settings.section' slot by id and passes the injected hooks/actions down.
     */
    function PhotoPetSettingsSection(props) {
      const { t, usePhotoPetCard, save, discard, edit, resetField } = props;
      return React.createElement('ul', { className: 'pp-set-sectionList' },
        React.createElement(PhotoPetSettingsCard, { t, usePhotoPetCard, save, discard, edit, resetField }));
    }

    const PHOTO_PET_CARD_LOCALE_ZH = {
      title: '我的宠物',
      description: '照片宠物:启用、大小位置、名字,以及上传照片后的智能抠图与工作话语。',
      enabled: '启用宠物',
      enabledHint: '关闭后宠物完全隐藏,不再挂载。',
      visible: '显示宠物',
      visibleHint: '关闭后宠物收起为召唤按钮,悬停可唤出。',
      name: '宠物名字',
      nameHint: '悬停宠物时显示的名字(不超过 12 字)。',
      size: '大小',
      sizeHint: '宠物宽度(像素),高度按照片比例自动。',
      right: '距右边缘',
      rightHint: '宠物距离屏幕右侧的像素。',
      bottom: '距底部',
      bottomHint: '宠物距离屏幕底部的像素。',
      smartTrim: '智能修图(去边框)',
      smartTrimHint: '上传照片时自动去除四周纯色边框。',
      aiCutout: 'AI 自动抠图',
      aiCutoutHint: '上传照片后自动用 AI 识别并抠出人物,含去噪、去色边与自动裁剪。',
      workLines: '工作状态下的话语',
      workLinesHint: '模型工作时气泡轮流显示,每行一句。',
      workInterval: '话语轮换间隔(秒)',
      workIntervalHint: '工作气泡每多少秒换一句,最小 1 秒(如 4.8)。',
      clickLines: '点击状态下的话语',
      clickLinesHint: '点击宠物时气泡轮流显示,每点一次换下一句,每行一句。',
      fanMenu: '悬浮菜单显示项',
      fanMenuHint: '悬停宠物时弹出的圆形菜单,勾选要显示的功能。',
      fanAllOn: '一键显示全部',
      fanAllOff: '一键隐藏全部',
      quickActions: '快捷操作',
      quickActionsHint: '和悬浮菜单同款功能,在设置里也能直接触发。',
      actionUpload: '上传照片',
      actionCutout: '智能抠图',
      actionReset: '恢复默认形象',
      pluginManage: '插件管理',
      pluginManageHint: '从 npm 检查更新,或卸载本插件。更新/卸载后界面会自动重启。',
      pluginVersion: '插件版本',
      pluginUpToDate: '已是最新版本',
      pluginNewer: '发现新版本 {latest}',
      pluginUpdate: '更新',
      pluginUninstall: '卸载',
      pluginUninstallConfirm: '确认卸载?',
      pluginRestarting: '处理中…页面即将自动重启',
      pluginUpdateFailed: '操作失败,请稍后重试',
      save: '保存',
      saving: '保存中…',
      discard: '放弃',
      unsaved: '未保存',
      overridden: '已覆盖默认',
      reset: '重置',
      invalidNumber: '请输入有效数字',
      saveFailed: '保存失败',
      notExposed: '设置尚未就绪',
      readOnly: '当前环境为只读,无法修改设置。',
    };
    const PHOTO_PET_CARD_LOCALE_EN = {
      title: 'My Pet',
      description: 'Photo pet: enable, size & position, name, smart trim/AI cutout and working-state lines.',
      enabled: 'Enable pet',
      enabledHint: 'When off the pet is fully hidden.',
      visible: 'Show pet',
      visibleHint: 'When off the pet collapses to a summon button.',
      name: 'Pet name',
      nameHint: 'Shown on hover (max 12 chars).',
      size: 'Size',
      sizeHint: 'Pet width in px; height follows the photo ratio.',
      right: 'Right offset',
      rightHint: 'Distance from the right edge in px.',
      bottom: 'Bottom offset',
      bottomHint: 'Distance from the bottom edge in px.',
      smartTrim: 'Smart trim',
      smartTrimHint: 'Auto-remove the solid border around the photo on upload.',
      aiCutout: 'AI auto cutout',
      aiCutoutHint: 'Auto-mat the person on upload (speckle/hole cleanup, edge decontamination, auto-crop).',
      workLines: 'Working-state lines',
      workLinesHint: 'Rotated in the bubble while the model works; one line each.',
      workInterval: 'Swap interval (seconds)',
      workIntervalHint: 'Seconds between working-bubble swaps (min 1).',
      clickLines: 'Click-state lines',
      clickLinesHint: 'Rotated in the bubble on each click — one line per click, one line each row.',
      fanMenu: 'Hover menu items',
      fanMenuHint: 'Which items the hover fan menu shows.',
      fanAllOn: 'Show all',
      fanAllOff: 'Hide all',
      quickActions: 'Quick actions',
      quickActionsHint: 'The same actions as the hover menu, right here.',
      actionUpload: 'Upload photo',
      actionCutout: 'AI cutout',
      actionReset: 'Reset photo',
      pluginManage: 'Plugin management',
      pluginManageHint: 'Check for npm updates or uninstall this plugin. The GUI restarts automatically after updating/uninstalling.',
      pluginVersion: 'Plugin version',
      pluginUpToDate: 'Up to date',
      pluginNewer: 'Update available: {latest}',
      pluginUpdate: 'Update',
      pluginUninstall: 'Uninstall',
      pluginUninstallConfirm: 'Confirm uninstall?',
      pluginRestarting: 'Working… the page will restart',
      pluginUpdateFailed: 'Failed, try again later',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      unsaved: 'Unsaved',
      overridden: 'Overridden',
      reset: 'Reset',
      invalidNumber: 'Enter a valid number',
      saveFailed: 'Save failed',
      notExposed: 'Settings not ready',
      readOnly: 'Read-only environment.',
    };

    function registerPhotoPetSettingsCard(ctx, scope) {
      if (!ctx.slots || typeof ctx.slots.inject !== 'function') return;
      injectSettingsStyles();
      let controller = null;
      // First-level settings section: appears in the settings page's LEFT NAV,
      // same level as 通用/插件/宠物. The card lives inside this section.
      ctx.slots.inject('settings.section', () => {
        if (controller === null) controller = new PhotoPetCardController(scope);
        const unregister = ctx.slots.register({
          name: 'settings.section',
          id: 'photo-pet',
          order: 135,
          // The left-nav entry follows the pet's name (settings.name); falls
          // back to the generic title while unnamed. Read live from the scope
          // so a saved rename shows up in the menu without a page reload.
          label: () => {
            const value = scope.getSnapshot().value;
            const name = typeof value?.name === 'string' ? value.name.trim() : '';
            return name !== '' ? name : '我的宠物';
          },
          locale: 'photo-pet',
          inject: () => controller.inject(),
        }, PhotoPetSettingsSection);
        return () => {
          unregister();
          controller?.dispose();
          controller = null;
          releaseSettingsStyles();
        };
      });
    }

    // ---------------------------------------------------------------------
    // Plugin body
    // ---------------------------------------------------------------------

    /** Required service (settings scope) before the pet mounts. */
    const inject = ['settingsScope', 'locale', 'slots'];

    function apply(ctx) {
      injectStyles();

      let store;
      let rawScope = null;
      try {
        const binder = ctx.get('webUiSettings') ?? ctx.settingsScope;
        rawScope = binder.bind({ namespace: 'photo-pet' });
        store = createScopeStore(rawScope);
      } catch {
        // No settings surface (settings UI disabled): fall back to a
        // localStorage-backed store so the pet still works.
        store = createLocalStore();
      }

      // Settings page card ("我的宠物"): register the card locale + slot entry.
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.effect(() => {
          try {
            return ctx.locale.register('photo-pet', { zh: PHOTO_PET_CARD_LOCALE_ZH, en: PHOTO_PET_CARD_LOCALE_EN });
          } catch { return () => {}; }
        }, 'photo-pet: settings card locale');
      }
      if (rawScope !== null) registerPhotoPetSettingsCard(ctx, rawScope);

      // Cross-instance single-mount guard: sweep containers left behind by
      // earlier instances (fiber reload) so this mount is the page's only
      // [data-photo-pet-root].
      for (const stale of Array.from(document.querySelectorAll('div[' + ROOT_ATTR + ']'))) {
        stale.remove();
      }
      const container = document.createElement('div');
      container.setAttribute(ROOT_ATTR, '');
      container.dataset.dshPlugin = 'photo-pet';
      container.__photoPetBus = petBus; // testable surface for the settings→pet bus
      document.body.appendChild(container);
      const root = createRoot(container);
      root.render(React.createElement(PhotoPetApp, { store }));

      ctx.effect(() => () => {
        store.dispose();
        root.unmount();
        container.remove();
        releaseStyles();
      }, 'photo-pet: client lifecycle');
    }

    module.exports = { apply, inject, pluginManage };
    return module.exports;
  },
});
