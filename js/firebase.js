// ─────────────────────────────────────────────────────────────────────────────
//  Jake's Digital Critique Machine: data layer
//  Firebase Realtime Database (votes, comments, settings) + Storage (images)
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getDatabase,
  ref as dbRef,
  get,
  set,
  push,
  update,
  remove,
  onValue,
  serverTimestamp,
  increment,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';
import {
  getStorage,
  ref as stRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
  listAll,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

// ── Firebase config ──────────────────────────────────────────────────────────
// Firebase console → Project settings → General → Your apps → SDK setup → Config
// The project must be on the Blaze plan for Storage to accept uploads.
// This config is an identifier, not a secret. Every Firebase web app ships it
// in plain JavaScript; access is controlled by database.rules.json and
// storage.rules, not by hiding these values.
//
// databaseURL assumes the Realtime Database was created in us-central1, which
// is the default region. A database in any other region uses a
// <name>.<region>.firebasedatabase.app host instead, and this line has to match
// it exactly or votes and comments silently never connect.
export const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAUgKU5YAVb09Cj5o-eA9HQ0DZOQO9t3Pw",
  authDomain:        "jakes-crit-machine.firebaseapp.com",
  databaseURL:       "https://jakes-crit-machine-default-rtdb.firebaseio.com",
  projectId:         "jakes-crit-machine",
  storageBucket:     "jakes-crit-machine.firebasestorage.app",
  messagingSenderId: "527901126393",
  appId:             "1:527901126393:web:9ab785284e17df66b5fc28",
};

export const IS_CONFIGURED = !FIREBASE_CONFIG.apiKey.startsWith('PASTE');

let db = null;
let storage = null;
let auth = null;

if (IS_CONFIGURED) {
  const app = initializeApp(FIREBASE_CONFIG);
  db      = getDatabase(app);
  storage = getStorage(app);
  auth    = getAuth(app);
  // Keep the admin signed in across reloads so a projector restart mid-crit
  // does not lock Jake out of his own wall.
  setPersistence(auth, browserLocalPersistence).catch(() => {});
}

// ── Admin authentication ─────────────────────────────────────────────────────
// Students are never signed in. The single admin account is what the security
// rules key off, so uploading, deleting, and locking are impossible for anyone
// else no matter what they send at the API directly.

export function watchAdmin(callback) {
  if (!auth) { callback(null); return () => {}; }
  return onAuthStateChanged(auth, (user) => callback(user));
}

export async function signInAdmin() {
  const provider = new GoogleAuthProvider();
  // Always show the chooser, so signing in on a shared classroom machine does
  // not silently reuse whichever Google account happens to be active.
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    return await signInWithPopup(auth, provider);
  } catch (error) {
    // Popups get blocked on plenty of phones; fall back to a full redirect.
    if (error.code === 'auth/popup-blocked' || error.code === 'auth/operation-not-supported-in-this-environment') {
      return signInWithRedirect(auth, provider);
    }
    throw error;
  }
}

export function signOutAdmin() {
  return signOut(auth);
}

export const currentAdmin = () => (auth ? auth.currentUser : null);

// ── Ordering ─────────────────────────────────────────────────────────────────
// Realtime Database push keys are lexicographically chronological and are
// generated against the server's clock offset, so sorting by key yields the
// exact same sequence on every device. Never sort by client load order.
export function sortUploads(list) {
  return list.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function toList(snapshotValue) {
  if (!snapshotValue) return [];
  return sortUploads(
    Object.entries(snapshotValue).map(([id, value]) => ({ id, ...value }))
  );
}

// ── Live subscriptions ───────────────────────────────────────────────────────

export function watchUploads(callback) {
  if (!db) { callback([]); return () => {}; }
  return onValue(dbRef(db, 'uploads'), (snap) => callback(toList(snap.val())));
}

export function watchCritMode(callback) {
  if (!db) { callback(false); return () => {}; }
  return onValue(dbRef(db, 'settings/critMode'), (snap) => callback(snap.val() === true));
}

export function watchComments(uploadId, callback) {
  if (!db) { callback([]); return () => {}; }
  return onValue(dbRef(db, `comments/${uploadId}`), (snap) => {
    const value = snap.val() || {};
    const list = Object.entries(value)
      .map(([id, c]) => ({ id, ...c }))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    callback(list);
  });
}

export function setCritMode(on) {
  return set(dbRef(db, 'settings/critMode'), on === true);
}

// ── Wall lock ────────────────────────────────────────────────────────────────
// Enforced in the security rules, not just here. While locked, Firebase itself
// refuses votes and comments, so hiding the UI is a courtesy rather than the
// actual control. Absent means locked, so a fresh database starts closed.

export function watchUnlocked(callback) {
  if (!db) { callback(false); return () => {}; }
  return onValue(dbRef(db, 'settings/unlocked'), (snap) => callback(snap.val() === true));
}

export function setUnlocked(on) {
  return set(dbRef(db, 'settings/unlocked'), on === true);
}

export function watchCommentsEnabled(callback) {
  if (!db) { callback(true); return () => {}; }
  // Absent means on, so a fresh database starts with comments available.
  return onValue(dbRef(db, 'settings/commentsEnabled'), (snap) => callback(snap.val() !== false));
}

export function setCommentsEnabled(on) {
  return set(dbRef(db, 'settings/commentsEnabled'), on === true);
}

// ── Vote colours ─────────────────────────────────────────────────────────────
// Shared, not per-device, so the crit-mode gradient reads the same on the
// projector as it does in everyone's hand.

export const DEFAULT_VOTE_COLORS = { up: '#30D158', down: '#FF375F' };

const isHex = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

export function watchVoteColors(callback) {
  if (!db) { callback({ ...DEFAULT_VOTE_COLORS }); return () => {}; }
  return onValue(dbRef(db, 'settings/voteColors'), (snap) => {
    const value = snap.val() || {};
    callback({
      up:   isHex(value.up)   ? value.up   : DEFAULT_VOTE_COLORS.up,
      down: isHex(value.down) ? value.down : DEFAULT_VOTE_COLORS.down,
    });
  });
}

export function setVoteColors(colors) {
  return set(dbRef(db, 'settings/voteColors'), {
    up:   isHex(colors.up)   ? colors.up   : DEFAULT_VOTE_COLORS.up,
    down: isHex(colors.down) ? colors.down : DEFAULT_VOTE_COLORS.down,
  });
}

// ── Voting ───────────────────────────────────────────────────────────────────
// Anonymous. One vote per image per browser, tracked in localStorage.

const VOTE_KEY = 'jdcm:votes';

export function readVotes() {
  try { return JSON.parse(localStorage.getItem(VOTE_KEY) || '{}'); }
  catch { return {}; }
}

function writeVotes(votes) {
  try { localStorage.setItem(VOTE_KEY, JSON.stringify(votes)); } catch { /* private mode */ }
}

export function getVote(uploadId) {
  return readVotes()[uploadId] || null;
}

/**
 * Applies a vote and returns the resulting state ('up' | 'down' | null).
 * Tapping the button you already picked clears the vote.
 */
export async function castVote(uploadId, choice) {
  const votes = readVotes();
  const previous = votes[uploadId] || null;
  const next = previous === choice ? null : choice;

  const delta = {};
  if (previous === 'up')   delta.up   = increment(-1);
  if (previous === 'down') delta.down = increment(-1);
  if (next === 'up')       delta.up   = increment(1);
  if (next === 'down')     delta.down = increment(1);

  if (next === null) delete votes[uploadId];
  else votes[uploadId] = next;
  writeVotes(votes);

  if (Object.keys(delta).length) {
    await update(dbRef(db, `uploads/${uploadId}`), delta);
  }
  return next;
}

export async function postComment(uploadId, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  await push(dbRef(db, `comments/${uploadId}`), {
    text: trimmed.slice(0, 1000),
    vote: getVote(uploadId),
    createdAt: serverTimestamp(),
  });
}

// ── Uploading ────────────────────────────────────────────────────────────────

const THUMB_MAX = 1400;   // longest edge of the grid thumbnail, in px

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Not a readable image')); };
    img.src = url;
  });
}

function makeThumb(img) {
  const scale = Math.min(1, THUMB_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
}

function extensionOf(file) {
  const fromName = (file.name.split('.').pop() || '').toLowerCase();
  if (/^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  return (file.type.split('/').pop() || 'jpg').toLowerCase();
}

function put(path, blob, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(stRef(storage, path), blob, { contentType });
    task.on('state_changed',
      (snap) => onProgress && onProgress(snap.bytesTransferred / (snap.totalBytes || 1)),
      reject,
      () => getDownloadURL(task.snapshot.ref).then(resolve, reject),
    );
  });
}

/**
 * Uploads one image at full resolution plus a downscaled grid thumbnail.
 * onProgress receives 0..1 across both files.
 */
export async function uploadImage(file, onProgress) {
  const img = await loadImage(file);
  const thumb = await makeThumb(img);

  const id = push(dbRef(db, 'uploads')).key;
  const ext = extensionOf(file);
  const fullPath = `uploads/${id}/full.${ext}`;
  const thumbPath = `uploads/${id}/thumb.jpg`;

  // Full res is the overwhelming majority of the bytes, so weight it 90/10.
  const fullURL = await put(fullPath, file, file.type || 'image/jpeg',
    (p) => onProgress && onProgress(p * 0.9));
  const thumbURL = await put(thumbPath, thumb, 'image/jpeg',
    (p) => onProgress && onProgress(0.9 + p * 0.1));

  await set(dbRef(db, `uploads/${id}`), {
    name: file.name.replace(/\.[^.]+$/, ''),
    fullURL,
    thumbURL,
    fullPath,
    thumbPath,
    width: img.naturalWidth,
    height: img.naturalHeight,
    size: file.size,
    createdAt: serverTimestamp(),
    up: 0,
    down: 0,
  });

  onProgress && onProgress(1);
  return id;
}

// ── Deleting ─────────────────────────────────────────────────────────────────

async function deleteQuietly(path) {
  if (!path) return;
  try { await deleteObject(stRef(storage, path)); }
  catch { /* already gone, not worth failing the whole purge over */ }
}

export async function deleteUpload(upload) {
  await deleteQuietly(upload.fullPath);
  await deleteQuietly(upload.thumbPath);
  await remove(dbRef(db, `comments/${upload.id}`));
  await remove(dbRef(db, `uploads/${upload.id}`));
}

/** Wipes every upload, comment, and stored file. */
export async function purgeEverything(onStep) {
  const snap = await get(dbRef(db, 'uploads'));
  const uploads = toList(snap.val());

  let done = 0;
  for (const upload of uploads) {
    await deleteQuietly(upload.fullPath);
    await deleteQuietly(upload.thumbPath);
    done += 1;
    onStep && onStep(done, uploads.length);
  }

  // Sweep any orphaned files left behind by an interrupted upload.
  try {
    const root = await listAll(stRef(storage, 'uploads'));
    for (const folder of root.prefixes) {
      const inner = await listAll(folder);
      for (const item of inner.items) {
        try { await deleteObject(item); } catch { /* ignore */ }
      }
    }
  } catch { /* listing may be denied by rules; DB wipe below still runs */ }

  await remove(dbRef(db, 'comments'));
  await remove(dbRef(db, 'uploads'));
}
