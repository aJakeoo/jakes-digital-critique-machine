// ─────────────────────────────────────────────────────────────────────────────
//  Gallery, palette, voting, comments, lightbox, and big screen mode.
//
//  Everything the room does runs through one gesture: pick a tool from the
//  palette, then tap a piece. No tool selected means a tap just opens the
//  large preview, which is also the only thing a tap does in crit mode.
//
//  Animation policy: only transform, opacity, and filter are animated, every
//  DOM write for a frame is batched, and anything decorative is dropped
//  entirely under prefers-reduced-motion.
// ─────────────────────────────────────────────────────────────────────────────

import {
  IS_CONFIGURED,
  watchUploads,
  watchCritMode,
  watchComments,
  watchCommentsEnabled,
  watchUnlocked,
  watchVoteColors,
  DEFAULT_VOTE_COLORS,
  getVote,
  castVote,
  postComment,
} from './firebase.js';
import { initAdmin, notifyAdmin, drawQR, shareURL } from './admin.js';

const HUES = ['#0A84FF', '#BF5AF2', '#FF375F', '#FF9F0A', '#30D158', '#5AC8FA', '#5E5CE6', '#FF6482'];
const accentFor = (index) => HUES[index % HUES.length];

const $ = (sel, root = document) => root.querySelector(sel);
const numberOf = (index) => String(index + 1).padStart(2, '0');

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  uploads: [],
  critMode: false,
  commentsEnabled: true,
  unlocked: false,
  bigScreen: false,
  voteColors: { ...DEFAULT_VOTE_COLORS },
  tool: null,               // null | 'up' | 'down' | 'comment'
  lightboxIndex: -1,
  commentTarget: null,
  signature: '',
};

const grid        = $('#grid');
const emptyState  = $('#empty');
const setupNotice = $('#setup');
const critBanner  = $('#crit-banner');
const countLabel  = $('#count-label');
const lightbox    = $('#lightbox');
const dock        = $('#dock');
const sheet       = $('#comment-sheet');

const commentUnsubs = new Map();

// ── Tabs ─────────────────────────────────────────────────────────────────────

function showTab(name) {
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.panel === name);
  });
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  syncDock();
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
});

const onGalleryTab = () => $('.tab-panel[data-panel="gallery"]').classList.contains('is-active');

// ── Icons ────────────────────────────────────────────────────────────────────

const chip = () => '<span class="chip" aria-hidden="true"></span>';
const zoomIcon = () => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H4a1 1 0 0 0-1 1v5m6 11H4a1 1 0 0 1-1-1v-5m12-11h5a1 1 0 0 1 1 1v5m-6 11h5a1 1 0 0 0 1-1v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const checkIcon = () => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── Palette dock ─────────────────────────────────────────────────────────────

const HINTS = {
  null:    'Pick a tool',
  up:      'Tap a piece to vote',
  down:    'Tap a piece to vote',
  comment: 'Tap a piece to comment',
};

function setTool(tool) {
  state.tool = state.tool === tool ? null : tool;

  dock.querySelectorAll('.tool').forEach((button) => {
    const on = button.dataset.tool === state.tool;
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-pressed', String(on));
  });

  document.body.dataset.tool = state.tool || '';
  document.body.classList.toggle('is-aiming', state.tool !== null);
  $('#dock-hint').textContent = HINTS[state.tool] || HINTS.null;

  if (state.tool && !REDUCED.matches) {
    dock.classList.remove('did-nudge');
    void dock.offsetWidth;             // restart the animation
    dock.classList.add('did-nudge');
  }
}

function syncDock() {
  // The lock is enforced in the security rules; hiding the dock just spares
  // people from tapping at a wall that would refuse them anyway.
  const visible = IS_CONFIGURED && onGalleryTab()
    && state.unlocked && !state.critMode && !state.bigScreen;
  dock.hidden = !visible;
  document.body.classList.toggle('has-dock', visible);

  $('#tool-comment').hidden = !state.commentsEnabled;
  if (!state.commentsEnabled && state.tool === 'comment') setTool(null);
  if (!visible && state.tool) setTool(null);
}

dock.addEventListener('click', (event) => {
  const button = event.target.closest('.tool');
  if (button) setTool(button.dataset.tool);
});

// ── Card rendering ───────────────────────────────────────────────────────────

function cardMarkup(upload, index) {
  const mine = getVote(upload.id);
  return `
    <article class="card" style="--accent:${accentFor(index)};--i:${index}" data-id="${upload.id}" data-index="${index}" data-mine="${mine || ''}">
      <button class="card-image" data-action="image" aria-label="${escapeHtml(upload.name)}">
        <img src="${upload.thumbURL || upload.fullURL}" alt="${escapeHtml(upload.name)}" loading="lazy" decoding="async">
        <span class="card-number">${numberOf(index)}</span>
        <span class="card-zoom">${zoomIcon()}</span>
        <span class="card-sheen" aria-hidden="true"></span>
        <span class="card-ripples" aria-hidden="true"></span>
        <span class="card-burst" aria-hidden="true"></span>
        <span class="card-confirm">${checkIcon()}<b data-confirm-label>Vote recorded</b></span>
        <span class="card-mine" aria-hidden="true"><i></i>Your vote</span>
      </button>

      <div class="card-body">
        <h3 class="card-title"></h3>
        <div class="tally">
          <span class="vote vote-up">${chip()}<span class="vote-count" data-up>${upload.up || 0}</span></span>
          <span class="vote vote-down">${chip()}<span class="vote-count" data-down>${upload.down || 0}</span></span>
          <span class="vote-bar" aria-hidden="true"><i></i></span>
        </div>
        <div class="comments" data-comments></div>
      </div>
    </article>`;
}

function signatureOf() {
  return `${state.critMode ? 'crit' : 'open'}|${state.uploads.map((u) => u.id).join(',')}`;
}

function renderGrid() {
  const { uploads } = state;

  countLabel.textContent = uploads.length
    ? `${uploads.length} ${uploads.length === 1 ? 'piece' : 'pieces'}`
    : '';
  emptyState.hidden = uploads.length > 0 || !IS_CONFIGURED;

  const signature = signatureOf();
  if (signature === state.signature) { patchCards(); return; }
  state.signature = signature;

  // Detach every comment stream before the cards they write into are replaced,
  // otherwise each structural re-render leaks a listener onto a dead node.
  commentUnsubs.forEach((off) => off());
  commentUnsubs.clear();

  grid.innerHTML = uploads.map(cardMarkup).join('');

  uploads.forEach((upload) => {
    const card = cardFor(upload.id);
    if (!card) return;
    card.querySelector('.card-title').textContent = upload.name;
    applySentiment(card, upload, true);
    commentUnsubs.set(
      upload.id,
      watchComments(upload.id, (list) => renderComments(card, list)),
    );
  });

}

const cardFor = (id) => grid.querySelector(`.card[data-id="${CSS.escape(id)}"]`);

function patchCards() {
  state.uploads.forEach((upload) => {
    const card = cardFor(upload.id);
    if (!card) return;
    bumpCount(card.querySelector('[data-up]'), upload.up || 0);
    bumpCount(card.querySelector('[data-down]'), upload.down || 0);
    applySentiment(card, upload, false);
  });
}

/** Writes a count and gives it a small pop, but only when it actually moved. */
function bumpCount(node, value) {
  if (!node || node.textContent === String(value)) return;
  node.textContent = value;
  if (REDUCED.matches) return;
  node.classList.remove('did-bump');
  void node.offsetWidth;
  node.classList.add('did-bump');
}

// ── Sentiment ────────────────────────────────────────────────────────────────
// The vote split drives a gradient: where it breaks is the ratio, how hard it
// burns is turnout. In crit mode it blooms out behind the image.

function applySentiment(element, upload, immediate) {
  const up = upload.up || 0;
  const down = upload.down || 0;
  const total = up + down;
  const ratio = total ? up / total : 0.5;
  const intensity = total ? Math.min(1, 0.35 + total / 12) : 0;

  if (immediate) element.style.setProperty('--no-anim', '1');
  element.style.setProperty('--ratio', ratio.toFixed(4));
  element.style.setProperty('--intensity', intensity.toFixed(3));
  element.style.setProperty('--split', `${(ratio * 100).toFixed(2)}%`);
  if (immediate) requestAnimationFrame(() => element.style.removeProperty('--no-anim'));
}

// ── Comments ─────────────────────────────────────────────────────────────────

function renderComments(card, list) {
  const host = card.querySelector('[data-comments]');
  if (!host) return;

  if (!list.length) {
    host.innerHTML = '';
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const wasOpen = host.classList.contains('is-open');
  host.innerHTML = `
    <button class="comment-toggle" type="button">
      <span>${list.length} ${list.length === 1 ? 'comment' : 'comments'}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <div class="comment-wrap"><ul class="comment-list"></ul></div>`;
  host.classList.toggle('is-open', wasOpen);

  const ul = host.querySelector('.comment-list');
  list.forEach((comment, index) => {
    const li = document.createElement('li');
    li.className = `comment ${comment.vote ? `is-${comment.vote}` : ''}`;
    li.style.setProperty('--i', index);
    const dot = document.createElement('span');
    dot.className = 'comment-dot';
    const text = document.createElement('p');
    text.textContent = comment.text;
    li.append(dot, text);
    ul.appendChild(li);
  });
}

// ── Tap effects ──────────────────────────────────────────────────────────────

function ripple(card, event, color) {
  if (REDUCED.matches) return;
  const host = card.querySelector('.card-ripples');
  const box = host.getBoundingClientRect();
  const node = document.createElement('i');
  node.style.left = `${event.clientX - box.left}px`;
  node.style.top = `${event.clientY - box.top}px`;
  node.style.background = color;
  host.appendChild(node);
  node.addEventListener('animationend', () => node.remove(), { once: true });
}

function burst(card, color) {
  if (REDUCED.matches) return;
  const host = card.querySelector('.card-burst');
  host.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 14; i += 1) {
    const bit = document.createElement('i');
    const angle = (i / 14) * Math.PI * 2 + Math.random() * 0.4;
    const distance = 60 + Math.random() * 70;
    bit.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    bit.style.setProperty('--dy', `${Math.sin(angle) * distance}px`);
    bit.style.setProperty('--d', `${Math.random() * 90}ms`);
    bit.style.background = color;
    fragment.appendChild(bit);
  }
  host.appendChild(fragment);
  setTimeout(() => { host.innerHTML = ''; }, 900);
}

// ── Tapping a piece ──────────────────────────────────────────────────────────

async function applyVote(card, choice, event) {
  const id = card.dataset.id;
  const color = choice === 'up' ? state.voteColors.up : state.voteColors.down;

  card.style.setProperty('--armed', color);
  ripple(card, event, color);

  const settled = await castVote(id, choice);
  card.dataset.mine = settled || '';

  card.querySelector('[data-confirm-label]').textContent =
    settled ? 'Vote recorded' : 'Vote removed';

  if (settled) burst(card, color);
  card.classList.remove('did-confirm');
  void card.offsetWidth;
  card.classList.add('did-confirm');
  setTimeout(() => card.classList.remove('did-confirm'), 1300);
}

grid.addEventListener('click', async (event) => {
  const toggle = event.target.closest('.comment-toggle');
  if (toggle) {
    toggle.parentElement.classList.toggle('is-open');
    return;
  }

  const button = event.target.closest('[data-action="image"]');
  if (!button) return;
  const card = button.closest('.card');

  if (state.critMode || !state.tool) {
    openLightbox(Number(card.dataset.index));
    return;
  }

  if (state.tool === 'comment') {
    if (!state.commentsEnabled) return;
    ripple(card, event, 'rgba(255,255,255,.8)');
    openSheet(Number(card.dataset.index));
    return;
  }

  await applyVote(card, state.tool, event);
});

// ── Comment sheet ────────────────────────────────────────────────────────────

function openSheet(index) {
  const upload = state.uploads[index];
  if (!upload) return;
  state.commentTarget = upload.id;

  sheet.style.setProperty('--accent', accentFor(index));
  $('#sheet-thumb').src = upload.thumbURL || upload.fullURL;
  $('#sheet-title').textContent = upload.name;
  $('#sheet-number').textContent = numberOf(index);

  const field = $('#sheet-text');
  field.value = '';
  field.style.height = 'auto';
  $('#sheet-count').textContent = '0';

  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('is-open'));
  document.body.classList.add('is-locked');
  setTimeout(() => field.focus(), 220);
}

function closeSheet() {
  sheet.classList.remove('is-open');
  document.body.classList.remove('is-locked');
  state.commentTarget = null;
  setTimeout(() => { if (!state.commentTarget) sheet.hidden = true; }, 300);
}

$('#sheet-close').addEventListener('click', closeSheet);
$('#sheet-backdrop').addEventListener('click', closeSheet);

$('#sheet-text').addEventListener('input', (event) => {
  event.target.style.height = 'auto';
  event.target.style.height = `${Math.min(event.target.scrollHeight, 200)}px`;
  $('#sheet-count').textContent = event.target.value.length;
});

$('#sheet-text').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    $('#sheet-form').requestSubmit();
  }
});

$('#sheet-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = state.commentTarget;
  const text = $('#sheet-text').value;
  if (!id || !text.trim() || !state.commentsEnabled) return;

  const submit = $('#sheet-submit');
  submit.disabled = true;
  try {
    await postComment(id, text);
    const card = cardFor(id);
    if (card) {
      card.classList.add('did-comment');
      setTimeout(() => card.classList.remove('did-comment'), 1000);
    }
    closeSheet();
  } catch (error) {
    console.error(error);
  } finally {
    submit.disabled = false;
  }
});

// ── Lightbox ─────────────────────────────────────────────────────────────────

let lightboxCommentsOff = null;

function openLightbox(index) {
  const upload = state.uploads[index];
  if (!upload) return;
  const fresh = lightbox.hidden;
  state.lightboxIndex = index;

  lightbox.style.setProperty('--accent', accentFor(index));
  applySentiment(lightbox, upload, fresh);

  const image = $('#lightbox-img');
  if (!fresh && !REDUCED.matches) {
    image.classList.remove('did-swap');
    void image.offsetWidth;
    image.classList.add('did-swap');
  }
  image.src = upload.fullURL;
  image.alt = upload.name;

  $('#lightbox-title').textContent = upload.name;
  $('#lightbox-number').textContent = numberOf(index);
  bumpCount($('#lightbox-up'), upload.up || 0);
  bumpCount($('#lightbox-down'), upload.down || 0);
  $('#lightbox-prev').disabled = index === 0;
  $('#lightbox-next').disabled = index === state.uploads.length - 1;

  const host = $('#lightbox-comments');
  if (lightboxCommentsOff) lightboxCommentsOff();
  lightboxCommentsOff = watchComments(upload.id, (list) => {
    if (!list.length) {
      host.innerHTML = '<p class="muted">No comments yet.</p>';
      return;
    }
    host.innerHTML = `<h4>${list.length} ${list.length === 1 ? 'comment' : 'comments'}</h4><ul></ul>`;
    const ul = host.querySelector('ul');
    list.forEach((comment, i) => {
      const li = document.createElement('li');
      li.className = comment.vote ? `is-${comment.vote}` : '';
      li.style.setProperty('--i', i);
      li.textContent = comment.text;
      ul.appendChild(li);
    });
  });

  if (fresh) {
    lightbox.hidden = false;
    requestAnimationFrame(() => lightbox.classList.add('is-open'));
    document.body.classList.add('is-locked');
    $('#lightbox-close').focus();
  }
}

function closeLightbox() {
  lightbox.classList.remove('is-open');
  document.body.classList.remove('is-locked');
  if (lightboxCommentsOff) { lightboxCommentsOff(); lightboxCommentsOff = null; }
  state.lightboxIndex = -1;
  setTimeout(() => {
    if (state.lightboxIndex === -1) { lightbox.hidden = true; $('#lightbox-img').src = ''; }
  }, 300);
}

function stepLightbox(delta) {
  if (state.lightboxIndex < 0) return;
  const next = state.lightboxIndex + delta;
  if (next >= 0 && next < state.uploads.length) openLightbox(next);
}

$('#lightbox-close').addEventListener('click', closeLightbox);
$('#lightbox-prev').addEventListener('click', () => stepLightbox(-1));
$('#lightbox-next').addEventListener('click', () => stepLightbox(1));
lightbox.addEventListener('click', (event) => {
  if (event.target === lightbox || event.target.classList.contains('lightbox-stage')) closeLightbox();
});

document.addEventListener('keydown', (event) => {
  if (!sheet.hidden && event.key === 'Escape') { closeSheet(); return; }
  if (lightbox.hidden) return;
  if (event.key === 'Escape')     { event.stopPropagation(); closeLightbox(); }
  if (event.key === 'ArrowLeft')  stepLightbox(-1);
  if (event.key === 'ArrowRight') stepLightbox(1);
}, true);

// ── Big screen ───────────────────────────────────────────────────────────────

const bigGrid = $('#bigscreen-grid');

function setBigScreen(on) {
  state.bigScreen = on;
  document.body.classList.toggle('is-bigscreen', on);
  $('#bigscreen').hidden = !on;
  syncDock();
  if (on) {
    drawQR($('#bigscreen-qr'), shareURL(), 260);
    $('#bigscreen-url').textContent = shareURL().replace(/^https?:\/\//, '');
    renderBigScreen();
  }
}

function renderBigScreen() {
  if (!state.bigScreen) return;

  const mode = $('#bigscreen-mode');
  mode.textContent = state.critMode ? 'Voting closed' : 'Voting open';
  mode.className = state.critMode ? 'bigscreen-mode is-crit' : 'bigscreen-mode';

  if (!state.uploads.length) {
    bigGrid.innerHTML = '<p class="bigscreen-empty">Nothing uploaded yet.</p>';
    return;
  }

  const known = bigGrid.dataset.signature === signatureOf();
  if (!known) {
    bigGrid.dataset.signature = signatureOf();
    bigGrid.innerHTML = state.uploads.map((upload, index) => `
      <figure class="big-card" style="--accent:${accentFor(index)};--i:${index}">
        <span class="big-number">${numberOf(index)}</span>
        <img src="${upload.thumbURL || upload.fullURL}" alt="" loading="lazy" decoding="async">
        <figcaption>
          <span class="big-score big-up">${chip()}<b data-up>${upload.up || 0}</b></span>
          <span class="big-score big-down">${chip()}<b data-down>${upload.down || 0}</b></span>
        </figcaption>
      </figure>`).join('');
  }

  bigGrid.querySelectorAll('.big-card').forEach((card, index) => {
    const upload = state.uploads[index];
    if (!upload) return;
    bumpCount(card.querySelector('[data-up]'), upload.up || 0);
    bumpCount(card.querySelector('[data-down]'), upload.down || 0);
    applySentiment(card, upload, !known);
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

setupNotice.hidden = IS_CONFIGURED;

initAdmin({
  getUploads: () => state.uploads,
  getCritMode: () => state.critMode,
  setBigScreen,
});

if (IS_CONFIGURED) {
  watchVoteColors((colors) => {
    state.voteColors = colors;
    document.documentElement.style.setProperty('--up-color', colors.up);
    document.documentElement.style.setProperty('--down-color', colors.down);
    notifyAdmin(state);
  });

  watchUnlocked((on) => {
    state.unlocked = on;
    document.body.classList.toggle('is-locked-wall', !on);
    $('#lock-banner').hidden = on || state.critMode;
    syncDock();
    notifyAdmin(state);
  });

  watchCommentsEnabled((on) => {
    state.commentsEnabled = on;
    document.body.classList.toggle('no-comments', !on);
    syncDock();
    notifyAdmin(state);
  });

  watchUploads((uploads) => {
    state.uploads = uploads;
    renderGrid();
    renderBigScreen();
    notifyAdmin(state);

    if (state.lightboxIndex >= uploads.length) closeLightbox();
    else if (state.lightboxIndex >= 0) {
      const current = uploads[state.lightboxIndex];
      bumpCount($('#lightbox-up'), current.up || 0);
      bumpCount($('#lightbox-down'), current.down || 0);
      applySentiment(lightbox, current, false);
    }
  });

  watchCritMode((on) => {
    state.critMode = on;
    document.body.classList.toggle('is-crit', on);
    critBanner.hidden = !on;
    $('#lock-banner').hidden = state.unlocked || on;
    syncDock();
    renderGrid();
    renderBigScreen();
    notifyAdmin(state);
  });
}

showTab('gallery');
setTool(null);
