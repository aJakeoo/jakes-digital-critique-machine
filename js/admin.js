// ─────────────────────────────────────────────────────────────────────────────
//  Admin tab: password gate, uploads, crit mode, purge, and the share QR.
//
//  The password is a client-side convenience lock for a classroom, not real
//  security. Anything a browser can reach, a determined student can reach too.
// ─────────────────────────────────────────────────────────────────────────────

import {
  IS_CONFIGURED,
  setCritMode,
  setCommentsEnabled,
  setVoteColors,
  DEFAULT_VOTE_COLORS,
  uploadImage,
  deleteUpload,
  purgeEverything,
} from './firebase.js';

const PASSWORD    = 'jj';
const UNLOCK_KEY  = 'jdcm:admin';

const $ = (sel) => document.querySelector(sel);

let hooks = { getUploads: () => [], getCritMode: () => false };
let unlocked = false;

// ── Password gate ────────────────────────────────────────────────────────────

function unlock() {
  unlocked = true;
  try { sessionStorage.setItem(UNLOCK_KEY, '1'); } catch { /* private mode */ }
  $('#admin-lock').hidden = true;
  $('#admin-panel').hidden = false;
  renderShareCode();
  renderManageList();
}

function initLock() {
  try { unlocked = sessionStorage.getItem(UNLOCK_KEY) === '1'; } catch { unlocked = false; }
  if (unlocked) { unlock(); return; }

  $('#admin-lock-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const field = $('#admin-password');
    if (field.value === PASSWORD) {
      field.value = '';
      $('#admin-lock-error').hidden = true;
      unlock();
    } else {
      field.value = '';
      $('#admin-lock-error').hidden = false;
      $('#admin-lock').classList.add('did-shake');
      setTimeout(() => $('#admin-lock').classList.remove('did-shake'), 500);
    }
  });
}

// ── Crit mode ────────────────────────────────────────────────────────────────

function initCritToggle() {
  $('#crit-toggle').addEventListener('change', async (event) => {
    const on = event.target.checked;
    try {
      await setCritMode(on);
    } catch (error) {
      event.target.checked = !on;
      toast(`Could not change crit mode: ${error.message}`, 'bad');
    }
  });

  $('#comments-toggle').addEventListener('change', async (event) => {
    const on = event.target.checked;
    try {
      await setCommentsEnabled(on);
      toast(on ? 'Comments are open.' : 'Comments are closed.', on ? 'good' : 'warn');
    } catch (error) {
      event.target.checked = !on;
      toast(`Could not change comments: ${error.message}`, 'bad');
    }
  });
}

// ── Vote colours ─────────────────────────────────────────────────────────────

// Curated pairings that stay legible against the light shell.
const COLOR_PRESETS = [
  { name: 'Classic',   up: '#30D158', down: '#FF375F' },
  { name: 'Ocean',     up: '#5AC8FA', down: '#5E5CE6' },
  { name: 'Sunset',    up: '#FF9F0A', down: '#BF5AF2' },
  { name: 'Punch',     up: '#00E0B8', down: '#FF2D55' },
  { name: 'Monochrome', up: '#8E8E93', down: '#1D1D1F' },
];

let colorSaveTimer = null;

function pushVoteColors() {
  const up = $('#color-up').value;
  const down = $('#color-down').value;
  $('#color-preview').style.setProperty('--up-color', up);
  $('#color-preview').style.setProperty('--down-color', down);

  // Colour inputs fire continuously while dragging; only write once it settles.
  clearTimeout(colorSaveTimer);
  colorSaveTimer = setTimeout(async () => {
    try { await setVoteColors({ up, down }); }
    catch (error) { toast(`Could not save colours: ${error.message}`, 'bad'); }
  }, 350);
}

function initVoteColors() {
  const presets = $('#color-presets');
  presets.innerHTML = COLOR_PRESETS.map((preset) => `
    <button type="button" class="preset" data-up="${preset.up}" data-down="${preset.down}" title="${preset.name}">
      <span style="background:${preset.up}"></span>
      <span style="background:${preset.down}"></span>
      <b>${preset.name}</b>
    </button>`).join('');

  presets.addEventListener('click', (event) => {
    const button = event.target.closest('.preset');
    if (!button) return;
    $('#color-up').value = button.dataset.up;
    $('#color-down').value = button.dataset.down;
    pushVoteColors();
  });

  $('#color-up').addEventListener('input', pushVoteColors);
  $('#color-down').addEventListener('input', pushVoteColors);

  $('#color-reset').addEventListener('click', () => {
    $('#color-up').value = DEFAULT_VOTE_COLORS.up;
    $('#color-down').value = DEFAULT_VOTE_COLORS.down;
    pushVoteColors();
  });
}

// ── Uploading ────────────────────────────────────────────────────────────────

function initUploads() {
  const input = $('#file-input');
  const zone  = $('#drop-zone');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
  });

  ['dragenter', 'dragover'].forEach((type) => zone.addEventListener(type, (event) => {
    event.preventDefault();
    zone.classList.add('is-hot');
  }));
  ['dragleave', 'drop'].forEach((type) => zone.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === 'dragleave' && zone.contains(event.relatedTarget)) return;
    zone.classList.remove('is-hot');
  }));

  zone.addEventListener('drop', (event) => handleFiles(event.dataTransfer.files));
  input.addEventListener('change', () => { handleFiles(input.files); input.value = ''; });
}

// Tracks how many batches are in flight, so a second drop mid-upload doesn't
// get its rows wiped by the first batch's cleanup timer.
let activeBatches = 0;

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
  const skipped = fileList.length - files.length;
  if (skipped > 0) toast(`Skipped ${skipped} non-image file${skipped === 1 ? '' : 's'}.`, 'warn');
  if (!files.length) return;

  const queue = $('#upload-queue');
  queue.hidden = false;
  activeBatches += 1;

  // Sequential, so upload order matches the order the files were chosen and
  // every visitor ends up seeing the same sequence.
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'queue-row';
    row.innerHTML = `
      <span class="queue-name"></span>
      <span class="queue-bar"><i style="width:0%"></i></span>
      <span class="queue-pct">0%</span>`;
    row.querySelector('.queue-name').textContent = file.name;
    queue.appendChild(row);

    const bar = row.querySelector('.queue-bar i');
    const pct = row.querySelector('.queue-pct');

    try {
      await uploadImage(file, (progress) => {
        const value = Math.round(progress * 100);
        bar.style.width = `${value}%`;
        pct.textContent = `${value}%`;
      });
      row.classList.add('is-done');
      pct.textContent = 'Done';
    } catch (error) {
      row.classList.add('is-failed');
      pct.textContent = 'Failed';
      toast(`${file.name}: ${error.message}`, 'bad');
    }
  }

  activeBatches -= 1;
  setTimeout(() => {
    if (activeBatches > 0) return;
    queue.innerHTML = '';
    queue.hidden = true;
  }, 4000);
}

// ── Manage / purge ───────────────────────────────────────────────────────────

function renderManageList() {
  const list = $('#manage-list');
  const uploads = hooks.getUploads();

  $('#manage-count').textContent = uploads.length
    ? `${uploads.length} uploaded`
    : 'Nothing uploaded yet';

  list.innerHTML = uploads.map((upload, index) => `
    <li class="manage-row" data-id="${upload.id}">
      <span class="manage-num">${String(index + 1).padStart(2, '0')}</span>
      <img src="${upload.thumbURL || upload.fullURL}" alt="" loading="lazy">
      <span class="manage-name"></span>
      <span class="manage-tally">${upload.up || 0} up · ${upload.down || 0} down</span>
      <button class="manage-delete" data-delete title="Delete this image">Delete</button>
    </li>`).join('');

  // Filenames go in as text, never as markup.
  list.querySelectorAll('.manage-row').forEach((row, index) => {
    row.querySelector('.manage-name').textContent = uploads[index].name;
  });
}

function initManage() {
  $('#manage-list').addEventListener('click', async (event) => {
    if (!event.target.matches('[data-delete]')) return;
    const row = event.target.closest('.manage-row');
    const upload = hooks.getUploads().find((u) => u.id === row.dataset.id);
    if (!upload) return;
    if (!confirm(`Delete "${upload.name}"? Its votes and comments go too.`)) return;

    event.target.disabled = true;
    event.target.textContent = 'Deleting…';
    try {
      await deleteUpload(upload);
      toast('Deleted.', 'good');
    } catch (error) {
      toast(`Delete failed: ${error.message}`, 'bad');
      event.target.disabled = false;
      event.target.textContent = 'Delete';
    }
  });

  $('#purge-button').addEventListener('click', async () => {
    const total = hooks.getUploads().length;
    if (!total) { toast('Nothing to purge.', 'warn'); return; }

    const typed = prompt(
      `This permanently deletes all ${total} images along with every vote and comment.\n\n` +
      `Type PURGE to confirm.`
    );
    if (typed !== 'PURGE') return;

    const button = $('#purge-button');
    button.disabled = true;
    const label = button.textContent;

    try {
      await purgeEverything((done, count) => {
        button.textContent = `Purging ${done}/${count}…`;
      });
      toast('Everything purged.', 'good');
    } catch (error) {
      toast(`Purge failed: ${error.message}`, 'bad');
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
}

// ── Share QR ─────────────────────────────────────────────────────────────────

/** The public URL students scan or type to reach the gallery. */
export function shareURL() {
  const { origin, pathname } = window.location;
  return origin + pathname.replace(/index\.html$/, '');
}

/** Draws a QR for `url` into `holder`, skipping the work if it is already there. */
export function drawQR(holder, url, size) {
  if (!holder || holder.dataset.drawn === `${url}@${size}`) return;

  if (typeof window.QRCode !== 'function') {
    holder.innerHTML = '<p class="muted small">QR library did not load. Share the link instead.</p>';
    return;
  }

  holder.innerHTML = '';
  new window.QRCode(holder, {
    text: url,
    width: size,
    height: size,
    correctLevel: window.QRCode.CorrectLevel.M,
  });
  holder.dataset.drawn = `${url}@${size}`;
}

function renderShareCode() {
  const url = shareURL();
  $('#qr-url').textContent = url;
  $('#qr-big-url').textContent = url;
  drawQR($('#qr-code'), url, 220);
  drawQR($('#qr-big-code'), url, 620);
}

function initShare() {
  const overlay = $('#qr-overlay');

  $('#qr-card').addEventListener('click', () => {
    renderShareCode();
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('is-open'));
    document.body.classList.add('is-locked');
  });

  const close = () => {
    overlay.classList.remove('is-open');
    document.body.classList.remove('is-locked');
    setTimeout(() => { overlay.hidden = true; }, 260);
  };

  overlay.addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !overlay.hidden) close();
  });

  $('#qr-copy').addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(shareURL());
      toast('Link copied.', 'good');
    } catch {
      toast('Copy failed. Select the link manually.', 'warn');
    }
  });
}

// ── Big screen mode ──────────────────────────────────────────────────────────
// Deliberately a per-device setting, not a shared one: it changes what THIS
// laptop shows while it is being AirPlayed or cast, and shouldn't hijack the
// phones in the room.

const BIGSCREEN_KEY = 'jdcm:bigscreen';

function initBigScreen() {
  const toggle = $('#bigscreen-toggle');

  const apply = (on, persist) => {
    toggle.checked = on;
    $('#bigscreen-state').textContent = on ? 'On' : 'Off';
    if (persist) {
      try { sessionStorage.setItem(BIGSCREEN_KEY, on ? '1' : '0'); } catch { /* private mode */ }
    }
    hooks.setBigScreen(on);
  };

  toggle.addEventListener('change', () => apply(toggle.checked, true));
  $('#bigscreen-exit').addEventListener('click', () => apply(false, true));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('is-bigscreen')) {
      apply(false, true);
    }
  });

  let restored = false;
  try { restored = sessionStorage.getItem(BIGSCREEN_KEY) === '1'; } catch { restored = false; }
  if (restored) apply(true, false);
}

// ── Toasts ───────────────────────────────────────────────────────────────────

function toast(message, kind = 'good') {
  const host = $('#toasts');
  const node = document.createElement('div');
  node.className = `toast is-${kind}`;
  node.textContent = message;
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add('is-in'));
  setTimeout(() => {
    node.classList.remove('is-in');
    setTimeout(() => node.remove(), 300);
  }, 4200);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function initAdmin(providedHooks) {
  hooks = providedHooks;
  initLock();
  initCritToggle();
  initVoteColors();
  initUploads();
  initManage();
  initShare();
  initBigScreen();

  if (!IS_CONFIGURED) {
    $('#admin-panel').querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
  }
}

/** Called by app.js whenever the live data changes. */
export function notifyAdmin(state) {
  $('#crit-toggle').checked = state.critMode;
  $('#crit-state').textContent = state.critMode ? 'On' : 'Off';

  $('#comments-toggle').checked = state.commentsEnabled;
  $('#comments-state').textContent = state.commentsEnabled ? 'On' : 'Off';

  // Don't fight the colour inputs while they are open and being dragged.
  if (document.activeElement !== $('#color-up') && document.activeElement !== $('#color-down')) {
    $('#color-up').value = state.voteColors.up;
    $('#color-down').value = state.voteColors.down;
    $('#color-preview').style.setProperty('--up-color', state.voteColors.up);
    $('#color-preview').style.setProperty('--down-color', state.voteColors.down);
  }

  if (unlocked) renderManageList();
}
