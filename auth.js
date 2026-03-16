/* ================================================================
   AUTH.JS — Supabase Authentication System for VS Code Online
   ================================================================ */

const SUPABASE_URL = 'https://umnfmakvsllgftfttafd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_B9QmLcwTSCC3bBPA2g4Hnw_AcDDRfWA';

// ── Init ──────────────────────────────────────────────────────────────────
const { createClient } = supabase;
const _supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
window._supabase = _supabase; // expose so other scripts can query the DB later

let currentUser = null;

// ── Auth State Listener ───────────────────────────────────────────────────
_supabase.auth.onAuthStateChange((event, session) => {
  currentUser = session?.user || null;
  _updateProfileButton();

  if (event === 'SIGNED_IN') {
    _closeAuthModal();
    const name = currentUser.user_metadata?.full_name || currentUser.email;
    if (typeof printToOutput === 'function') {
      printToOutput(`Signed in as ${name}`, '#89d185');
    }
  }
  if (event === 'SIGNED_OUT') {
    if (typeof printToOutput === 'function') {
      printToOutput('Signed out.', '#858585');
    }
  }
});

// Restore session on load
_supabase.auth.getSession().then(({ data: { session } }) => {
  currentUser = session?.user || null;
  _updateProfileButton();
});

/* ================================================================
   PROFILE BUTTON — activity bar avatar
   ================================================================ */
function _updateProfileButton() {
  const guestIcon  = document.getElementById('profile-guest-icon');
  const initialsEl = document.getElementById('profile-initials');
  const avatarBtn  = document.getElementById('profile-avatar-btn');
  if (!guestIcon || !initialsEl || !avatarBtn) return;

  if (currentUser) {
    const meta     = currentUser.user_metadata || {};
    const name     = meta.full_name || meta.name || currentUser.email || '';
    const initials = name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
    const color    = _hashColor(currentUser.id);

    // If user has an avatar image, show it; otherwise show initials
    if (meta.avatar_url) {
      initialsEl.innerHTML = `<img src="${meta.avatar_url}" alt="${initials}" style="width:26px;height:26px;object-fit:cover;border-radius:50%;display:block;">`;
    } else {
      initialsEl.textContent = initials;
    }
    initialsEl.style.background = meta.avatar_url ? 'transparent' : color;
    guestIcon.style.display  = 'none';
    initialsEl.style.display = 'flex';
    avatarBtn.classList.add('logged-in');
  } else {
    guestIcon.style.display  = '';
    initialsEl.style.display = 'none';
    avatarBtn.classList.remove('logged-in');
  }
}

// Deterministic color from a user id string
function _hashColor(str) {
  const palette = [
    '#007acc','#6f42c1','#e36209','#28a745',
    '#d73a49','#0366d6','#c158dc','#2ea44f',
    '#e3652e','#0075ca',
  ];
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return palette[Math.abs(h) % palette.length];
}

/* ================================================================
   AUTH DROPDOWN — the small panel above the profile button
   ================================================================ */
let _dropdownOpen = false;

function _toggleAuthDropdown() {
  _dropdownOpen ? _closeAuthDropdown() : _openAuthDropdown();
}

function _openAuthDropdown() {
  const el = document.getElementById('auth-dropdown');
  if (!el) return;
  _renderDropdown(el);
  el.style.display = 'block';
  requestAnimationFrame(() => el.classList.add('visible'));
  _dropdownOpen = true;
}

function _closeAuthDropdown() {
  const el = document.getElementById('auth-dropdown');
  if (!el) return;
  el.classList.remove('visible');
  setTimeout(() => { el.style.display = 'none'; }, 150);
  _dropdownOpen = false;
}

function _renderDropdown(el) {
  if (currentUser) {
    const meta    = currentUser.user_metadata || {};
    const name    = meta.full_name || meta.name || currentUser.email;
    const email   = currentUser.email;
    const color   = _hashColor(currentUser.id);
    const initials = name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
    const avatarHtml = meta.avatar_url
      ? `<img src="${meta.avatar_url}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;" alt="${initials}">`
      : `<div class="auth-dd-avatar-circle" style="background:${color}">${initials}</div>`;

    el.innerHTML = `
      <div class="auth-dd-user">
        <div class="auth-dd-avatar">${avatarHtml}</div>
        <div class="auth-dd-info">
          <div class="auth-dd-name">${_esc(name)}</div>
          <div class="auth-dd-email">${_esc(email)}</div>
        </div>
      </div>
      <div class="auth-dd-divider"></div>
      <div class="auth-dd-item" onclick="_closeAuthDropdown(); openCloudPanel()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          <polyline points="9 22 9 12 15 12 15 22"/>
        </svg>
        My Cloud Projects
      </div>
      <div class="auth-dd-divider"></div>
      <div class="auth-dd-item auth-dd-danger" onclick="_signOut()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
        Sign Out
      </div>
    `;
  } else {
    el.innerHTML = `
      <div class="auth-dd-guest">
        <div class="auth-dd-guest-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
        </div>
        <div class="auth-dd-guest-title">Working as Guest</div>
        <div class="auth-dd-guest-sub">Sign in to sync projects and collaborate in real time</div>
      </div>
      <div class="auth-dd-divider"></div>
      <div class="auth-dd-actions">
        <button class="auth-dd-btn-secondary" onclick="_closeAuthDropdown(); _openAuthModal('signup')">Create Account</button>
        <button class="auth-dd-btn-primary"   onclick="_closeAuthDropdown(); _openAuthModal('signin')">Sign In</button>
      </div>
    `;
  }
}

// ── Close dropdown on outside click ──────────────────────────────────────
document.addEventListener('click', (e) => {
  if (!_dropdownOpen) return;
  const dd  = document.getElementById('auth-dropdown');
  const btn = document.getElementById('profile-btn');
  if (dd && !dd.contains(e.target) && btn && !btn.contains(e.target)) {
    _closeAuthDropdown();
  }
});

/* ================================================================
   AUTH MODAL — sign in / create account
   ================================================================ */
function _openAuthModal(tab = 'signin') {
  const overlay = document.getElementById('auth-modal-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  requestAnimationFrame(() => overlay.classList.add('visible'));
  _switchTab(tab);
  // Focus first input after animation
  setTimeout(() => {
    const first = overlay.querySelector('input');
    if (first) first.focus();
  }, 220);
}

function _closeAuthModal() {
  const overlay = document.getElementById('auth-modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('visible');
  setTimeout(() => { overlay.style.display = 'none'; }, 200);
  _clearError();
}

function _switchTab(tab) {
  document.querySelectorAll('.auth-tab-btn').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab)
  );
  const si = document.getElementById('auth-signin-form');
  const su = document.getElementById('auth-signup-form');
  if (si) si.style.display = tab === 'signin' ? 'block' : 'none';
  if (su) su.style.display = tab === 'signup' ? 'block' : 'none';
  _clearError();
}

function _clearError() {
  const el = document.getElementById('auth-error');
  if (el) { el.textContent = ''; el.style.color = ''; }
}

function _setError(msg, isSuccess = false) {
  const el = document.getElementById('auth-error');
  if (el) {
    el.textContent = msg;
    el.style.color = isSuccess ? 'var(--green)' : '';
  }
}

function _setBusy(btnId, busy, label) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? label : btn.dataset.label || label;
}

/* ================================================================
   SIGN IN / SIGN UP HANDLERS
   ================================================================ */
async function _signInWithEmail() {
  const email    = document.getElementById('signin-email')?.value?.trim();
  const password = document.getElementById('signin-password')?.value;
  if (!email || !password) { _setError('Please fill in all fields.'); return; }
  _clearError();
  _setBusy('signin-submit', true, 'Signing in…');
  const { error } = await _supabase.auth.signInWithPassword({ email, password });
  _setBusy('signin-submit', false, 'Sign In');
  if (error) _setError(error.message);
}

async function _signUpWithEmail() {
  const name     = document.getElementById('signup-name')?.value?.trim();
  const email    = document.getElementById('signup-email')?.value?.trim();
  const password = document.getElementById('signup-password')?.value;
  if (!email || !password) { _setError('Please fill in all fields.'); return; }
  if (password.length < 6)  { _setError('Password must be at least 6 characters.'); return; }
  _clearError();
  _setBusy('signup-submit', true, 'Creating account…');
  const { error } = await _supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: name || email.split('@')[0] } }
  });
  _setBusy('signup-submit', false, 'Create Account');
  if (error) _setError(error.message);
  else _setError('Check your email to confirm your account!', true);
}

async function _signInWithGitHub() {
  const { error } = await _supabase.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
  if (error) _setError(error.message);
}

async function _signInWithGoogle() {
  const { error } = await _supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
  if (error) _setError(error.message);
}

async function _signOut() {
  _closeAuthDropdown();
  await _supabase.auth.signOut();
}

// ── Enter key submits forms ───────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const overlay = document.getElementById('auth-modal-overlay');
  if (!overlay || overlay.style.display !== 'flex') return;
  const siForm = document.getElementById('auth-signin-form');
  const suForm = document.getElementById('auth-signup-form');
  if (siForm && siForm.style.display !== 'none') _signInWithEmail();
  else if (suForm && suForm.style.display !== 'none') _signUpWithEmail();
});

// ── Escape closes modal ───────────────────────────────────────────────────
// (handled by the global keydown in script.js via window.closeAuthModal)

// ── HTML escape helper ────────────────────────────────────────────────────
function _esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ================================================================
   EXPOSE GLOBALS — called from inline onclick in HTML
   ================================================================ */
window.toggleAuthDropdown  = _toggleAuthDropdown;
window.openAuthModal       = _openAuthModal;
window.closeAuthModal      = _closeAuthModal;
window.switchAuthTab       = _switchTab;
window.signInWithEmail     = _signInWithEmail;
window.signUpWithEmail     = _signUpWithEmail;
window.signInWithGitHub    = _signInWithGitHub;
window.signInWithGoogle    = _signInWithGoogle;
window.signOut             = _signOut;
window.currentUser         = currentUser; // live reference updates via onAuthStateChange