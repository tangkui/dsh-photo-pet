/**
 * Headless smoke test for dsh-photo-pet's browser half: loads lib/client.js
 * inside jsdom, runs the factory with real react/react-dom, mounts the pet
 * through a mocked settings scope, and asserts the DOM.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..'); // repo root = plugin root
const clientSource = readFileSync(resolve(pluginRoot, 'lib/client.js'), 'utf8');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
});
const { window } = dom;

// Expose the DOM to Node globals so react-dom works.
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.SVGElement = window.SVGElement;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
globalThis.CustomEvent = window.CustomEvent;
globalThis.MouseEvent = window.MouseEvent;
globalThis.Event = window.Event;
globalThis.DOMParser = window.DOMParser;
globalThis.Text = window.Text;
globalThis.Comment = window.Comment;
globalThis.DocumentFragment = window.DocumentFragment;

// fetch stub for the pet API.
let stateValue = { photo: false, photoUrl: null };
let activityValue = { working: false };
let uploadCount = 0;
let updatePostCount = 0;
let uninstallPostCount = 0;
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes('/api/photo-pet/state')) {
    return { ok: true, status: 200, json: async () => stateValue };
  }
  if (u.includes('/api/photo-pet/activity')) {
    return { ok: true, status: 200, json: async () => activityValue };
  }
  // NOTE: the check route must match before the generic update route —
  // '/api/photo-pet/update/check' contains '/api/photo-pet/update'.
  if (u.includes('/api/photo-pet/update/check')) {
    return { ok: true, status: 200, json: async () => ({ installed: '0.1.1', latest: '0.1.1', upToDate: true }) };
  }
  if (u.includes('/api/photo-pet/update') && options.method === 'POST') {
    updatePostCount += 1;
    return { ok: true, status: 200, json: async () => ({ ok: true, updated: false }) };
  }
  if (u.includes('/api/photo-pet/uninstall') && options.method === 'POST') {
    uninstallPostCount += 1;
    return { ok: true, status: 200, json: async () => ({ ok: true, restarting: true }) };
  }
  if (u.includes('/api/photo-pet/photo')) {
    if (options.method === 'POST') {
      uploadCount += 1;
      stateValue = { photo: true, photoUrl: '/api/photo-pet/photo' };
      return { ok: true, status: 200, json: async () => ({ ok: true, photoUrl: '/api/photo-pet/photo' }) };
    }
    if (options.method === 'DELETE') {
      stateValue = { photo: false, photoUrl: null };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  }
  throw new Error('unexpected fetch: ' + u);
};

// Capture the factory registered by the bundle.
let entry = null;
window.__ModuleLoader__ = {
  load: (e) => { entry = e; },
};

window.eval(clientSource);

if (entry === null) throw new Error('bundle did not register a factory');
if (entry.id !== 'dsh-photo-pet') throw new Error('unexpected bundle id: ' + entry.id);

// Run the factory with a require shim.
const factoryResult = entry.factory((specifier) => {
  if (specifier === 'react') return require('react');
  if (specifier === 'react-dom/client') return require('react-dom/client');
  if (specifier === 'react-dom') return require('react-dom');
  throw new Error('unexpected require: ' + specifier);
});
const { apply, inject, pluginManage } = factoryResult;

if (!Array.isArray(inject) || !inject.includes('settingsScope')) {
  throw new Error('inject face missing settingsScope: ' + JSON.stringify(inject));
}

// Mock settings scope.
let settings = { enabled: true, visible: true, size: 140, right: 40, bottom: 40, name: '小宠' };
const scopeListeners = new Set();
const scopeCalls = [];
const scope = {
  getSnapshot: () => ({ status: 'ready', value: { ...settings } }),
  subscribe: (cb) => { scopeListeners.add(cb); return () => scopeListeners.delete(cb); },
  set: async (field, value) => {
    scopeCalls.push(['set', field, value]);
    settings = { ...settings, [field]: value };
    for (const cb of [...scopeListeners]) cb();
  },
  unset: async (field) => {
    scopeCalls.push(['unset', field]);
    const next = { ...settings };
    delete next[field];
    settings = next;
    for (const cb of [...scopeListeners]) cb();
  },
};
let capturedDisposer = null;
let slotInjectName = null;
let slotInjectCb = null;
let slotRegisterName = null;
let slotRegisterOpts = null;
const ctx = {
  get: () => undefined,
  settingsScope: { bind: () => scope },
  effect: (cb) => { capturedDisposer = cb(); return capturedDisposer; },
  slots: {
    inject: (name, cb) => { slotInjectName = name; slotInjectCb = cb; return () => {}; },
    register: (opts, component) => { slotRegisterName = opts?.name ?? null; slotRegisterOpts = opts ?? null; return () => {}; },
  },
  locale: { register: () => () => {} },
};

// --- apply ---
apply(ctx);
await new Promise((r) => setTimeout(r, 60));

const assert = (cond, name) => {
  if (!cond) throw new Error('ASSERT FAILED: ' + name);
  console.log('  ✓ ' + name);
};

// Poll until fn() is truthy: React 18 concurrent commits in jsdom are
// timing-sensitive, so fixed sleeps flake under load.
const waitFor = async (fn, timeout = 5000, step = 10) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error('ASSERT FAILED: waitFor timeout');
};

// Hover the pet to open its fan menu. The document-level mouseover listener
// is attached by a React passive effect, which races with the first dispatch
// in jsdom; retry until the menu actually appears.
const hoverShell = async () => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const shell = document.querySelector('.pp-shell');
    if (shell === null) throw new Error('ASSERT FAILED: no shell to hover');
    shell.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    try {
      await waitFor(() => document.querySelector('.pp-menu') !== null, 250);
      return;
    } catch { /* listener not attached yet — retry */ }
  }
  throw new Error('ASSERT FAILED: menu did not open after hover retries');
};

console.log('mount:');
await waitFor(() => document.querySelector('[data-photo-pet-root]') !== null);
await waitFor(() => document.querySelector('.pp-shell') !== null);
assert(document.querySelector('.pp-shell') !== null, 'pet shell rendered');
assert(document.querySelector('.pp-avatar') !== null, 'avatar rendered');
assert(document.querySelector('#dsh-photo-pet-style') !== null, 'style tag injected');
const fallbackImg = document.querySelector('.pp-fallback img');
assert(fallbackImg !== null && fallbackImg.getAttribute('src').startsWith('data:image/svg+xml'), 'default SVG pet shown');
const fallbackSrc = decodeURIComponent(fallbackImg.getAttribute('src'));
assert(fallbackSrc.includes('ppclip') && !fallbackSrc.includes('M52 80 L38 26'), 'default pet is a humanoid head, no cat ears');
assert(!fallbackSrc.includes('fill="#6d4527"') && fallbackSrc.includes('M58 92 Q74 84 92 92'), 'default face is the bald lumberjack template (no hair, thick brows)');
assert(document.querySelector('.pp-ear') === null, 'no cat ears on the avatar');
// The pet is just the photo as-is: no circle crop, no white ring, no body.
assert(document.querySelector('.pp-dog-body') === null && document.querySelector('.pp-dog-leg') === null && document.querySelector('.pp-tail') === null, 'no dog body parts');
assert(document.querySelector('.pp-avatar') !== null, 'avatar (photo) present');
assert(document.querySelector('.pp-nameplate') === null, 'nameplate hidden at idle');
// 🪄 smart trim with no photo: asks for a photo first.
await hoverShell();
const wandBtn = Array.from(document.querySelectorAll('.pp-fan-btn')).find((b) => b.textContent === '🪄');
assert(wandBtn !== undefined, 'smart-trim wand in the menu');
wandBtn.click();
await new Promise((r) => setTimeout(r, 20));
const wandBubble = document.querySelector('.pp-bubble');
assert(wandBubble !== null && wandBubble.textContent.includes('先上传照片'), 'wand asks for a photo when none is set');
document.body.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
await new Promise((r) => setTimeout(r, 420));

console.log('visibility toggle:');
await scope.set('visible', false);
await new Promise((r) => setTimeout(r, 20));
assert(document.querySelector('.pp-summon') !== null, 'summon button shown when hidden');
assert(document.querySelector('.pp-shell') === null, 'pet hidden');
await scope.set('visible', true);
await new Promise((r) => setTimeout(r, 20));
assert(document.querySelector('.pp-shell') !== null, 'pet back after summon');

console.log('lifecycle:');
if (typeof capturedDisposer !== 'function') throw new Error('no lifecycle disposer captured');
capturedDisposer();
await new Promise((r) => setTimeout(r, 20));
assert(document.querySelector('[data-photo-pet-root]') === null, 'root removed on dispose');
assert(document.querySelector('#dsh-photo-pet-style') === null, 'style removed on dispose');
assert(scopeListeners.size === 0, 'scope unsubscribed');

console.log('photo-present scenario:');
// Re-apply with a host photo present.
stateValue = { photo: true, photoUrl: '/api/photo-pet/photo' };
settings = { enabled: true, visible: true, size: 140, right: 40, bottom: 40, name: '小宠' };
apply(ctx);
await waitFor(() => {
  const img = document.querySelector('.pp-avatar img');
  return img !== null && img.getAttribute('src').startsWith('/api/photo-pet/photo');
});
const photoImg = document.querySelector('.pp-avatar img');
assert(photoImg !== null && photoImg.getAttribute('src').startsWith('/api/photo-pet/photo'), 'host photo shown as avatar');
assert(document.querySelector('.pp-menu-btn') === null, 'corner menu button removed');
// Hovering the pet opens the menu (document-level mouseover tracker).
const shellEl = document.querySelector('.pp-shell');
await hoverShell();
assert(document.querySelector('.pp-menu') !== null, 'menu opens on hover');
assert(document.querySelector('.pp-nameplate') !== null, 'nameplate appears on hover');
// Regression guard: the nameplate must sit ABOVE the pet (opposite the
// downward fan); a "top: calc(100% + 10px)" here would drop it under the
// menu and the name would be blocked by the fan.
const styleNow = document.querySelector('#dsh-photo-pet-style').textContent;
assert(styleNow.includes('.pp-nameplate{position:absolute;bottom:calc(100% + 10px)'), 'nameplate positioned above the pet, clear of the menu');
assert(styleNow.includes('.pp-nameplate-below{top:calc(100% + 10px)'), 'flipped nameplate positioned below the pet');
const menuText = document.querySelector('.pp-menu').textContent;
assert(menuText.includes('📷') && menuText.includes('♻️') && menuText.includes('🪄'), 'menu has upload + reset + smart-cutout icons');
// 🪄 opens the cutout editor over the current photo; cancel closes it.
const wandBtn2 = Array.from(document.querySelectorAll('.pp-fan-btn')).find((b) => b.textContent === '🪄');
wandBtn2.click();
await waitFor(() => document.querySelector('.pp-editor') !== null);
assert(document.querySelector('.pp-editor') !== null, 'cutout editor opens');
const editorTools = document.querySelector('.pp-editor-tools');
assert(editorTools !== null && editorTools.textContent.includes('🤖'), 'editor has the AI one-click cutout button');
const editorCancel = Array.from(document.querySelectorAll('.pp-editor-actions button')).find((b) => b.textContent.includes('取消'));
assert(editorCancel !== undefined, 'editor has a cancel button');
editorCancel.click();
await waitFor(() => document.querySelector('.pp-editor') === null);
assert(document.querySelector('.pp-editor') === null, 'cutout editor closes on cancel');
// The editor cancel left the fan menu closed; re-open it for the label test.
await hoverShell();
// Hovering an icon button reveals its function label.
const uploadBtnForLabel = Array.from(document.querySelectorAll('.pp-fan-btn')).find((b) => b.textContent === '📷');
uploadBtnForLabel.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
await waitFor(() => document.querySelector('.pp-fan-label') !== null);
const fanLabel = document.querySelector('.pp-fan-label');
assert(fanLabel !== null && fanLabel.textContent === '上传照片', 'hover shows function label');
uploadBtnForLabel.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
await waitFor(() => document.querySelector('.pp-fan-label') === null, 3000);
assert(document.querySelector('.pp-fan-label') === null, 'label hides after leaving the button');
// Placement: pet hugs the bottom (bottom=40) → menu flips ABOVE the pet so
// it never overflows off-screen; with room below it opens downward.
assert(document.querySelector('.pp-menu').className.includes('pp-menu-above'), 'menu flips above when pet is near the bottom');
await scope.set('bottom', 500);
await new Promise((r) => setTimeout(r, 30));
await hoverShell();
const menuEl2 = document.querySelector('.pp-menu');
assert(menuEl2 !== null && !menuEl2.className.includes('pp-menu-above'), 'menu opens below the pet when there is room');
// Moving onto the menu keeps it open (no flicker across the gap).
const menuEl = document.querySelector('.pp-menu');
menuEl.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: shellEl }));
await new Promise((r) => setTimeout(r, 350));
assert(document.querySelector('.pp-menu') !== null, 'menu stays open while hovering it');
// Leaving both closes it after the grace timer.
document.body.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: menuEl }));
await new Promise((r) => setTimeout(r, 420));
assert(document.querySelector('.pp-menu') === null, 'menu closes on leave');
assert(document.querySelector('.pp-nameplate') === null, 'nameplate hides after leaving');

console.log('upload scenario:');
// Turn the AI auto-cutout OFF so this scenario tests the classic flow
// deterministically (jsdom cannot run the matting model).
await scope.set('aiCutout', false);
// Re-open the menu and click "上传照片": the menu closes, but the hidden
// file input must STAY mounted so the change event still reaches handleFile.
await hoverShell();
const uploadBtn = Array.from(document.querySelectorAll('.pp-fan-btn'))
  .find((b) => b.textContent === '📷');
assert(uploadBtn !== undefined, 'upload icon present');
const origClick = window.HTMLInputElement.prototype.click;
window.HTMLInputElement.prototype.click = function () { /* jsdom has no file dialog */ };
uploadBtn.click();
window.HTMLInputElement.prototype.click = origClick;
await new Promise((r) => setTimeout(r, 30));
assert(document.querySelector('.pp-menu') === null, 'menu closed after clicking upload');
const fileInput = document.querySelector('input[type="file"]');
assert(fileInput !== null, 'file input stays mounted after menu closes');
// Simulate picking a GIF file (gif path in fileToDataUrl skips Image decode).
const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const file = new window.File([gifBytes], 'pet.gif', { type: 'image/gif' });
Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
await waitFor(() => uploadCount === 1);
const uploadedImg = document.querySelector('.pp-avatar img');
assert(uploadCount === 1, 'upload POST actually sent');
assert(uploadedImg !== null && uploadedImg.getAttribute('src').startsWith('/api/photo-pet/photo'), 'avatar updates to uploaded photo');
await waitFor(() => {
  const b = document.querySelector('.pp-bubble');
  return b !== null && b.textContent.includes('新形象真好看');
});
const uploadBubble = document.querySelector('.pp-bubble');
assert(uploadBubble !== null && uploadBubble.textContent.includes('新形象真好看'), 'success bubble after upload');
capturedDisposer();

console.log('AI auto-cutout scenario:');
// Re-apply with the AI auto-cutout ENABLED (default). The pet announces the
// AI pass; the model itself cannot run in jsdom, so the flow must end with
// the graceful fallback while the original photo stays uploaded.
settings = { enabled: true, visible: true, size: 140, right: 40, bottom: 40, name: '小宠', smartTrim: true, aiCutout: true };
apply(ctx);
await waitFor(() => document.querySelector('.pp-shell') !== null);
await hoverShell();
const uploadBtnAi = Array.from(document.querySelectorAll('.pp-fan-btn')).find((b) => b.textContent === '📷');
const origClickAi = window.HTMLInputElement.prototype.click;
window.HTMLInputElement.prototype.click = function () { /* jsdom has no file dialog */ };
uploadBtnAi.click();
window.HTMLInputElement.prototype.click = origClickAi;
await waitFor(() => {
  const input = document.querySelector('input[type="file"]');
  return input !== null;
});
const fileInputAi = document.querySelector('input[type="file"]');
const fileAi = new window.File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0])], 'pet2.gif', { type: 'image/gif' });
Object.defineProperty(fileInputAi, 'files', { value: [fileAi], configurable: true });
fileInputAi.dispatchEvent(new window.Event('change', { bubbles: true }));
await waitFor(() => uploadCount === 2);
await waitFor(() => {
  const b = document.querySelector('.pp-bubble');
  return b !== null && b.textContent.includes('AI 抠图');
});
assert(uploadCount === 2, 'AI path keeps the original upload');
assert(document.querySelector('.pp-bubble').textContent.includes('AI 抠图'), 'AI auto-cutout path announced');
capturedDisposer();

console.log('fan menu config + settings bus:');
// Only the configured fan items render; the settings page drives the pet
// through the shared bus (upload / open cutout / reset photo).
settings = { enabled: true, visible: true, size: 140, right: 40, bottom: 40, name: '小宠', workInterval: 1, fanMenuItems: 'hide,rename' };
stateValue = { photo: false, photoUrl: null }; // fresh mount without a photo
apply(ctx);
await waitFor(() => document.querySelector('.pp-shell') !== null);
await hoverShell();
const fanBtns = Array.from(document.querySelectorAll('.pp-fan-btn'));
assert(fanBtns.length === 2, 'fan menu shows only the configured items');
assert(fanBtns.some((b) => b.textContent === '🙈') && fanBtns.some((b) => b.textContent === '🏷️'), 'configured items present');
assert(!fanBtns.some((b) => b.textContent === '📷') && !fanBtns.some((b) => b.textContent === '🪄') && !fanBtns.some((b) => b.textContent === '➕'), 'unconfigured items hidden');
const rootEl = document.querySelector('[data-photo-pet-root]');
assert(rootEl !== null && typeof rootEl.__photoPetBus?.emit === 'function', 'pet bus exposed on the pet root');
// Open cutout with no photo → the pet asks for a photo first.
rootEl.__photoPetBus.emit({ type: 'openCutout' });
await waitFor(() => {
  const b = document.querySelector('.pp-bubble');
  return b !== null && b.textContent.includes('先上传照片');
});
assert(document.querySelector('.pp-bubble').textContent.includes('先上传照片'), 'bus cutout without photo asks for one');
// Upload through the bus → the pet's own upload path runs (AI enabled by
// default, so it falls back gracefully in jsdom after one POST).
const beforeUploads = uploadCount;
const busGif = new window.File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0])], 'bus.gif', { type: 'image/gif' });
rootEl.__photoPetBus.emit({ type: 'upload', file: busGif });
await waitFor(() => uploadCount === beforeUploads + 1);
await waitFor(() => {
  const b = document.querySelector('.pp-bubble');
  return b !== null && b.textContent.includes('AI 抠图');
});
assert(uploadCount === beforeUploads + 1, 'bus upload runs the pet upload path');
capturedDisposer();

console.log('empty fan menu:');
// 一键隐藏全部 → fanMenuItems empty → hovering shows no menu at all.
settings = { enabled: true, visible: true, size: 140, right: 40, bottom: 40, name: '小宠', fanMenuItems: '' };
apply(ctx);
await waitFor(() => document.querySelector('.pp-shell') !== null);
const shellEmpty = document.querySelector('.pp-shell');
shellEmpty.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
await new Promise((r) => setTimeout(r, 350));
assert(document.querySelector('.pp-menu') === null, 'no fan menu when every item is hidden');
document.body.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, relatedTarget: shellEmpty }));
await new Promise((r) => setTimeout(r, 420));
capturedDisposer();

console.log('naming scenario:');
// Re-apply and name the pet through the fan menu.
settings = { enabled: true, visible: true, size: 140, right: 40, bottom: 40, name: '小宠' };
apply(ctx);
await waitFor(() => document.querySelector('.pp-shell') !== null);
const shellEl2 = document.querySelector('.pp-shell');
await hoverShell();
const tagBtn = Array.from(document.querySelectorAll('.pp-fan-btn')).find((b) => b.textContent === '🏷️');
assert(tagBtn !== undefined, 'name icon present in the fan menu');
tagBtn.click();
await new Promise((r) => setTimeout(r, 20));
assert(document.querySelector('.pp-menu') === null, 'fan menu closed when naming');
const namePanel = document.querySelector('.pp-name-panel');
assert(namePanel !== null, 'naming panel opens');
const nameInput = namePanel.querySelector('input');
assert(nameInput !== null && nameInput.value === '小宠', 'naming input prefilled with current name');
nameInput.value = '豆豆';
namePanel.querySelector('button[title="保存"]').click();
await new Promise((r) => setTimeout(r, 30));
assert(document.querySelector('.pp-name-panel') === null, 'naming panel closes after save');
assert(settings.name === '豆豆', 'name persisted to settings');
// The pet says "好呀..." right after saving; wait for the bubble to clear,
// then (still hovering) the nameplate shows the new name.
await new Promise((r) => setTimeout(r, 2900));
const nameplate2 = document.querySelector('.pp-nameplate');
assert(nameplate2 !== null && nameplate2.textContent === '豆豆', 'nameplate shows the new name on hover');
// Clicking the pet rotates through the click lines; with no custom
// configuration the built-in pool is used (and no name-intro is injected).
const builtinClickLines = ['摸摸我～', '主人好呀！', '我在呢～', '今天也要加油哦！', '喵～', '汪！', '嘿嘿，被你发现了', '最喜欢你啦', '要一直陪着我哦', '累了吗？歇会儿吧', '啾～', '呼噜呼噜…'];
const petEl = document.querySelector('.pp-pet');
petEl.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: 0, clientY: 0 }));
petEl.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, pointerId: 1, button: 0, clientX: 0, clientY: 0 }));
await waitFor(() => {
  const b = document.querySelector('.pp-bubble');
  return b !== null && builtinClickLines.includes(b.textContent);
});
assert(builtinClickLines.includes(document.querySelector('.pp-bubble').textContent), 'click shows a built-in click line');
capturedDisposer();

console.log('working scenario:');
// Re-apply, then flip the host activity flag. Custom work lines are
// configured through the settings surface and must drive the bubble.
settings = { enabled: true, visible: true, size: 140, right: 40, bottom: 40, name: '小宠', workLines: '摸鱼中…\n喝奶茶…' };
apply(ctx);
await waitFor(() => document.querySelector('#dsh-photo-pet-style') !== null);
const styleText = () => document.querySelector('#dsh-photo-pet-style').textContent;
assert(!styleText().includes('pp-work-ring'), 'no external ring style');
assert(!styleText().includes('.pp-ear{'), 'no cat-ear styles anywhere');
assert(styleText().includes('.pp-avatar{position:absolute;top:50%;left:50%'), 'photo centered, no circle-crop wrapper');
assert(!styleText().includes('object-fit:cover') && !styleText().includes('border:4px solid #fff'), 'no circle crop, no white ring');
assert(!styleText().includes('.pp-dog-') && !styleText().includes('.pp-tail{'), 'no dog body styles');
activityValue = { working: true };
await waitFor(() => document.querySelector('.pp-working') !== null);
assert(document.querySelector('.pp-working') !== null, 'working class applied');
assert(styleText().includes('pp-work-sway'), 'photo itself sways while working');
assert(!styleText().includes('pp-work-ring'), 'no ring animation anywhere');
assert(document.querySelector('.pp-smoke') !== null, 'smoke effect shown while working');
assert(document.querySelector('.pp-mouth') === null && document.querySelector('.pp-cig') === null, 'no fake mouth/cigarette overlays (photo has its own)');
assert(document.querySelectorAll('.pp-smoke-puff').length === 5, 'five smoke puffs animating');
assert(styleText().includes('left:49.5%;top:48%'), 'smoke source tuned to the cigarette tip in the photo');
assert(styleText().includes('pp-smoke-rise 3s'), 'wispy cloud puffs with slower, more realistic rise');
await waitFor(() => {
  const b = document.querySelector('.pp-bubble');
  return b !== null && /摸鱼中|喝奶茶/.test(b.textContent);
});
const workBubble = document.querySelector('.pp-bubble');
assert(workBubble !== null && /摸鱼中|喝奶茶/.test(workBubble.textContent), 'work bubble uses the configured work lines');
activityValue = { working: false };
await waitFor(() => document.querySelector('.pp-working') === null);
await waitFor(() => document.querySelector('.pp-bubble') === null);
assert(document.querySelector('.pp-working') === null, 'working class gone when idle again');
assert(document.querySelector('.pp-smoke') === null, 'smoke effect gone when idle');
assert(document.querySelector('.pp-bubble') === null, 'work bubble cleared');
capturedDisposer();

console.log('click lines rotation:');
// Custom click lines configured through the settings surface: every click
// advances to the next line and wraps around (A → B → C → A).
settings = { enabled: true, visible: true, size: 140, right: 40, bottom: 40, name: '小宠', clickLines: 'A\nB\nC' };
apply(ctx);
await waitFor(() => document.querySelector('.pp-shell') !== null);
const petClickEl = document.querySelector('.pp-pet');
const clickOnce = async (expected) => {
  petClickEl.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerId: 2, button: 0, clientX: 0, clientY: 0 }));
  petClickEl.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, pointerId: 2, button: 0, clientX: 0, clientY: 0 }));
  await waitFor(() => {
    const b = document.querySelector('.pp-bubble');
    return b !== null && b.textContent === expected;
  });
  return document.querySelector('.pp-bubble').textContent;
};
const seq = [
  await clickOnce('A'),
  await clickOnce('B'),
  await clickOnce('C'),
  await clickOnce('A'),
];
assert(seq.join(',') === 'A,B,C,A', 'click lines rotate A→B→C→A across clicks');
capturedDisposer();

console.log('settings card:');
// The settings page renders first-level sections from the 'settings.section'
// slot (the LEFT NAV, same level as 插件). The photo-pet section must be
// registered lazily with its own styles (design tokens, no pet styles leaked).
assert(slotInjectName === 'settings.section', 'left-nav settings.section slot injected');
assert(slotInjectCb !== null, 'settings.section injector registered');
const cardDisposer = slotInjectCb();
assert(slotRegisterName === 'settings.section', 'settings section registered under settings.section');
assert(slotRegisterOpts !== null && typeof slotRegisterOpts.label === 'function', 'section label is a live function');
assert(slotRegisterOpts.label() === settings.name, 'left-nav label follows the pet name');
const savedName = settings.name;
settings = { ...settings, name: '   ' };
for (const cb of [...scopeListeners]) cb();
assert(slotRegisterOpts.label() === '我的宠物', 'left-nav label falls back when the pet is unnamed');
settings = { ...settings, name: savedName };
for (const cb of [...scopeListeners]) cb();
await new Promise((r) => setTimeout(r, 20));
assert(document.querySelector('#dsh-photo-pet-settings-style') !== null, 'settings card styles injected');
const cardStyle = document.querySelector('#dsh-photo-pet-settings-style').textContent;
assert(cardStyle.includes('pp-set-card') && cardStyle.includes('--dsw-alias-border-l2'), 'card styles use the harness design tokens');
// Regression: "一键隐藏全部" (empty fanMenuItems) must persist as an empty
// STRING via scope.set — NOT unset, which would fall back to the schema
// default and re-check every menu item on save.
assert(slotRegisterOpts !== null && typeof slotRegisterOpts.inject === 'function', 'section injector available');
const injected = slotRegisterOpts.inject();
await injected.edit('fanMenuItems', 'hide,rename');
injected.save();
await new Promise((r) => setTimeout(r, 60));
assert(scopeCalls.some((c) => c[0] === 'set' && c[1] === 'fanMenuItems' && c[2] === 'hide,rename'), 'partial fan selection lands via set');
const fanCallsStart = scopeCalls.length;
await injected.edit('fanMenuItems', '');
injected.save();
await new Promise((r) => setTimeout(r, 60));
const fanCalls = scopeCalls.slice(fanCallsStart);
assert(fanCalls.some((c) => c[0] === 'set' && c[1] === 'fanMenuItems' && c[2] === ''), 'hide-all persists as an empty string (set, not unset)');
assert(!fanCalls.some((c) => c[0] === 'unset' && c[1] === 'fanMenuItems'), 'hide-all does not clear the field back to the schema default');
// The click-lines field is a configurable textarea in the card, like workLines.
const clickCallsStart = scopeCalls.length;
await injected.edit('clickLines', '嘿！\n干嘛呢');
injected.save();
await new Promise((r) => setTimeout(r, 60));
const clickCalls = scopeCalls.slice(clickCallsStart);
assert(clickCalls.some((c) => c[0] === 'set' && c[1] === 'clickLines' && c[2] === '嘿！\n干嘛呢'), 'click lines editable in the card and land via set');
cardDisposer();
assert(document.querySelector('#dsh-photo-pet-settings-style') === null, 'card styles released on teardown');

console.log('plugin management:');
// The settings card's 更新/卸载 buttons run through the pluginManage surface:
// a version check against the host + POSTs that trigger the real commands.
assert(typeof pluginManage?.check === 'function' && typeof pluginManage?.update === 'function' && typeof pluginManage?.uninstall === 'function', 'factory exposes the pluginManage surface');
const versionInfo = await pluginManage.check();
assert(versionInfo !== null && versionInfo.installed === '0.1.1' && versionInfo.latest === '0.1.1' && versionInfo.upToDate === true, 'version check returns installed/latest/upToDate');
const updateResult = await pluginManage.update();
assert(updatePostCount === 1 && updateResult !== null && updateResult.updated === false, 'update POST fired and reports up-to-date');
const uninstallResult = await pluginManage.uninstall();
assert(uninstallPostCount === 1 && uninstallResult !== null && uninstallResult.ok === true, 'uninstall POST fired');

console.log('\nSMOKE TEST PASSED');
