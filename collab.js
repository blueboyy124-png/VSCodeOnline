/* ================================================================
   COLLAB.JS — Real-time Collaboration for VS Code Online
   Uses: Supabase Realtime (broadcast + presence)
   ================================================================ */
console.log('[Collab] collab.js loaded ✓');

/* ── State ──────────────────────────────────────────────────────── */
let _collabProjectId   = null;
let _collabProjectName = null;
let _realtimeChannel   = null;
let _syncDebounce      = null;
let _isOwner           = false;
let _clientId          = null;
let _peers             = {};

const COLLAB_COLORS = [
  '#e06c75','#61afef','#98c379','#e5c07b',
  '#c678dd','#56b6c2','#d19a66','#be5046',
];

/* ── On page load: check URL for ?project= ──────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const projId = params.get('project');
  if (!projId) return;

  // Show a banner immediately so the user knows something is happening
  _showJoiningBanner(projId);

  // Wait for Monaco editor to be ready (it loads async via require())
  // Poll every 200ms until editor1 exists, then join
  const _waitForEditor = setInterval(() => {
    if (typeof editor1 !== 'undefined' && editor1 && typeof cloudOpenProject === 'function') {
      clearInterval(_waitForEditor);
      _joinFromLink(projId);
    }
  }, 200);

  // Safety timeout after 15s
  setTimeout(() => {
    clearInterval(_waitForEditor);
    _hideJoiningBanner();
  }, 15000);
});

function _showJoiningBanner(projId) {
  // Create a subtle top banner so the user sees something immediately
  let banner = document.getElementById('_collab-join-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = '_collab-join-banner';
    banner.style.cssText = `
      position:fixed; top:0; left:0; right:0; z-index:99999;
      background:var(--accent); color:#fff;
      font-size:12px; font-weight:600; text-align:center;
      padding:8px; letter-spacing:.02em;
      font-family:'Inter','Segoe UI',system-ui,sans-serif;
    `;
    document.body.appendChild(banner);
  }
  banner.textContent = '🔗 Opening shared project…';
}

function _hideJoiningBanner() {
  const banner = document.getElementById('_collab-join-banner');
  if (banner) banner.remove();
}

/* ================================================================
   JOIN FROM SHARE LINK
   ================================================================ */
async function _joinFromLink(projectId) {
  _hideJoiningBanner();

  if (typeof printToOutput === 'function') printToOutput('Joining shared project…', '#858585');

  // Fetch project info — RLS allows anyone to read by ID now
  const { data: project, error } = await _supabase
    .from('projects')
    .select('id, name, owner_id')
    .eq('id', projectId)
    .single();

  if (error || !project) {
    if (typeof printToOutput === 'function') {
      printToOutput('⚠ Could not open shared project — the link may be invalid or the project was deleted.', '#f48771');
    }
    // Clean the URL so refreshing doesn't retry a bad link
    window.history.replaceState({}, '', window.location.pathname);
    return;
  }

  _collabProjectId   = project.id;
  _collabProjectName = project.name;
  _isOwner = !!(currentUser && currentUser.id === project.owner_id);

  // Load files into editor — use whichever version is available
  const openFn = _origCloudOpen || window.cloudOpenProject;
  if (!openFn) {
    if (typeof printToOutput === 'function') printToOutput('⚠ Editor not ready — please refresh the page.', '#f48771');
    return;
  }
  await openFn(project.id, project.name);

  // Start real-time session
  _startCollabSession();
  _showShareBtn();

  // Clean up the URL (replace so back button works cleanly)
  window.history.replaceState({}, '', `${window.location.pathname}?project=${projectId}`);

  if (typeof printToOutput === 'function') {
    const role = _isOwner ? 'owner' : 'collaborator';
    printToOutput(`✓ Joined "${project.name}" as ${role} — collaboration active`, '#89d185');
  }
}

/* ================================================================
   START COLLAB SESSION — called after a project is loaded
   ================================================================ */
function _startCollabSession() {
  if (!_collabProjectId) return;

  // Set up unique client id and color
  _clientId = Math.random().toString(36).slice(2);
  const myColor = COLLAB_COLORS[Math.abs(_hashStr(_clientId)) % COLLAB_COLORS.length];
  const myName  = _getMyName();

  // Connect to Supabase Realtime
  _realtimeChannel = _supabase.channel(`collab:${_collabProjectId}`, {
    config: { broadcast: { self: false }, presence: { key: _clientId } }
  });

  // ── Presence: track who's online ────────────────────────────────
  _realtimeChannel.on('presence', { event: 'sync' }, () => {
    const state = _realtimeChannel.presenceState();
    _peers = {};
    Object.entries(state).forEach(([key, presences]) => {
      if (key !== _clientId && presences[0]) {
        _peers[key] = presences[0];
      }
    });
    _renderPresence();
  });

  _realtimeChannel.on('presence', { event: 'join' }, ({ key, newPresences }) => {
    if (key !== _clientId) {
      _peers[key] = newPresences[0];
      _renderPresence();
      if (typeof printToOutput === 'function') {
        printToOutput(`${newPresences[0].name} joined`, '#858585');
      }
    }
  });

  _realtimeChannel.on('presence', { event: 'leave' }, ({ key }) => {
    const name = _peers[key]?.name;
    delete _peers[key];
    _renderPresence();
    _removePeerCursor(key);
    if (name && typeof printToOutput === 'function') {
      printToOutput(`${name} left`, '#858585');
    }
  });

  // ── Broadcast: receive file edits from peers ─────────────────────
  _realtimeChannel.on('broadcast', { event: 'file-update' }, ({ payload }) => {
    if (!payload || payload.clientId === _clientId) return;
    const { path, content } = payload;
    if (!openFiles[path]) return;

    // Apply update without triggering our own save loop
    openFiles[path].content = content;
    if (currentFile1 === path && editor1) {
      const pos = editor1.getPosition();
      isProgrammaticEdit = true;
      editor1.setValue(content);
      isProgrammaticEdit = false;
      if (pos) editor1.setPosition(pos);
    }
    if (currentFile2 === path && editor2) {
      isProgrammaticEdit = true;
      editor2.setValue(content);
      isProgrammaticEdit = false;
    }
  });

  // ── Broadcast: receive cursor positions from peers ───────────────
  _realtimeChannel.on('broadcast', { event: 'cursor' }, ({ payload }) => {
    if (!payload || payload.clientId === _clientId) return;
    _renderPeerCursor(payload);
  });

  // Subscribe and track own presence
  _realtimeChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      const myAvatarUrl = currentUser?.user_metadata?.avatar_url || null;
      await _realtimeChannel.track({
        clientId:  _clientId,
        name:      myName,
        color:     myColor,
        avatarUrl: myAvatarUrl,
        file:      currentFile1 || null,
      });
    }
  });

  // ── Hook into editor changes to broadcast + sync ─────────────────
  if (editor1) {
    editor1.onDidChangeModelContent(() => {
      if (isProgrammaticEdit) return;
      const path    = currentFile1;
      const content = editor1.getValue();
      if (!path) return;

      // Broadcast edit to all peers instantly
      _broadcastFileUpdate(path, content);

      // Owner: debounce save to Supabase cloud
      if (_isOwner) {
        clearTimeout(_syncDebounce);
        _syncDebounce = setTimeout(() => _syncFileToCloud(path, content), 1000);
      }
    });

    // Broadcast cursor position
    editor1.onDidChangeCursorPosition((e) => {
      if (!_realtimeChannel) return;
      _realtimeChannel.send({
        type: 'broadcast',
        event: 'cursor',
        payload: {
          clientId: _clientId,
          name:     myName,
          color:    myColor,
          file:     currentFile1,
          line:     e.position.lineNumber,
          col:      e.position.column,
        }
      });
    });
  }
}

/* ── Broadcast a file edit to all peers ─────────────────────────── */
function _broadcastFileUpdate(path, content) {
  if (!_realtimeChannel) return;
  _realtimeChannel.send({
    type: 'broadcast',
    event: 'file-update',
    payload: { clientId: _clientId, path, content }
  });
}

/* ── Sync a single file to Supabase (owner only) ────────────────── */
async function _syncFileToCloud(path, content) {
  if (!_collabProjectId) return;
  await _supabase.from('files').upsert({
    project_id: _collabProjectId,
    path,
    content,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'project_id,path' });
}


/* ================================================================
   SHARE PANEL — Canva-style dropdown
   ================================================================ */
let _sharePanelOpen = false;

function openSharePanel() {
  if (!_collabProjectId) {
    if (typeof printToOutput === 'function') printToOutput('Save your project to the cloud first (File → Save to Cloud).', '#cbcb41');
    return;
  }
  const panel = document.getElementById('share-panel');
  if (!panel) return;
  if (_sharePanelOpen) { closeSharePanel(); return; }
  _sharePanelOpen = true;
  panel.style.display = 'block';
  _loadSharePeople();
  setTimeout(() => { document.addEventListener('click', _sharePanelOutsideClick, { once: true }); }, 10);
}
window.openSharePanel = openSharePanel;

function closeSharePanel() {
  const panel = document.getElementById('share-panel');
  if (panel) panel.style.display = 'none';
  _sharePanelOpen = false;
  const msg = document.getElementById('share-invite-msg');
  if (msg) { msg.textContent = ''; msg.className = 'share-invite-msg'; }
  const input = document.getElementById('share-email-input');
  if (input) input.value = '';
}
window.closeSharePanel = closeSharePanel;

function _sharePanelOutsideClick(e) {
  const panel = document.getElementById('share-panel');
  const shareBtn = document.getElementById('share-btn');
  const addBtn = document.getElementById('collab-add-btn');
  if (panel && !panel.contains(e.target) &&
      !shareBtn?.contains(e.target) &&
      !addBtn?.contains(e.target)) {
    closeSharePanel();
  } else if (_sharePanelOpen) {
    setTimeout(() => { document.addEventListener('click', _sharePanelOutsideClick, { once: true }); }, 10);
  }
}

async function _loadSharePeople() {
  const list = document.getElementById('share-people-list');
  if (!list) return;
  list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">Loading…</div>';
  try {
    const { data: project } = await _supabase
      .from('projects')
      .select('owner_id, profiles(id, full_name, avatar_url)')
      .eq('id', _collabProjectId)
      .single();

    const { data: collabs } = await _supabase
      .from('collaborators')
      .select('id, email, role, accepted, user_id, profiles(id, full_name, avatar_url)')
      .eq('project_id', _collabProjectId);

    list.innerHTML = '';

    // Owner row
    if (project) {
      const p = project.profiles;
      const isMe = currentUser && currentUser.id === project.owner_id;
      list.appendChild(_personRow({
        name: (p?.full_name || 'Owner') + (isMe ? ' (you)' : ''),
        email: '', avatarUrl: p?.avatar_url || null,
        color: _hashColorFromId(project.owner_id), badge: 'Owner', isOwner: true,
      }));
    }

    const canEdit = !!(currentUser && project && currentUser.id === project.owner_id);
    (collabs || []).forEach(c => {
      const p = c.profiles;
      const isMe = currentUser && currentUser.id === c.user_id;
      list.appendChild(_personRow({
        name: (p?.full_name || c.email || 'Pending') + (isMe ? ' (you)' : '') + (!c.accepted ? ' — pending' : ''),
        email: c.email || '', avatarUrl: p?.avatar_url || null,
        color: _hashColorFromId(c.user_id || c.email),
        role: c.role, collabId: c.id, canEdit, isOwner: false,
      }));
    });

    if (!collabs || collabs.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-muted);font-size:12px;padding:4px 8px';
      empty.textContent = 'Only you have access — invite someone above';
      list.appendChild(empty);
    }
  } catch(e) {
    list.innerHTML = `<div style="color:var(--red);font-size:12px;padding:8px 0">${_escHtml(e.message)}</div>`;
  }
}

function _personRow({ name, email, avatarUrl, color, badge, role, collabId, canEdit, isOwner }) {
  const row = document.createElement('div');
  row.className = 'share-person';
  const initials = _initialsFromName(name);
  const avatarHtml = avatarUrl
    ? `<img src="${avatarUrl}" alt="">`
    : initials;

  let roleHtml = '';
  if (isOwner) {
    roleHtml = `<span class="share-person-owner-badge">Owner</span>`;
  } else if (canEdit) {
    roleHtml = `
      <div class="share-person-role">
        <select onchange="shareChangeRole('${collabId}', this.value)">
          <option value="editor" ${role === 'editor' ? 'selected' : ''}>Editor</option>
          <option value="viewer" ${role === 'viewer' ? 'selected' : ''}>Viewer</option>
        </select>
      </div>
      <div class="share-person-remove" onclick="shareRemovePerson('${collabId}')" title="Remove">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
      </div>`;
  } else {
    roleHtml = `<span style="font-size:11px;color:var(--text-muted)">${role || 'editor'}</span>`;
  }

  row.innerHTML = `
    <div class="share-person-avatar" style="background:${color}">${avatarHtml}</div>
    <div class="share-person-info">
      <div class="share-person-name">${_escHtml(name)}</div>
      ${email ? `<div class="share-person-email">${_escHtml(email)}</div>` : ''}
    </div>
    ${roleHtml}
  `;
  return row;
}

function _initialsFromName(name) {
  return (name || '?').replace(/\s*\(.*?\)/g, '').trim()
    .split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';
}
function _hashColorFromId(id) {
  const palette = ['#7c6af7','#e06c75','#61afef','#98c379','#e5c07b','#c678dd','#56b6c2','#d19a66'];
  let h = 0; const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return palette[Math.abs(h) % palette.length];
}

async function shareInvite() {
  const input = document.getElementById('share-email-input');
  const roleSelect = document.getElementById('share-role-select');
  const btn = document.querySelector('.share-invite-btn');
  const email = input?.value?.trim().toLowerCase();
  if (!email || !email.includes('@')) { _setShareMsg('Enter a valid email address.', true); return; }
  if (!currentUser) { _setShareMsg('You must be signed in to invite people.', true); return; }
  if (!_collabProjectId) { _setShareMsg('No active project.', true); return; }
  const role = roleSelect?.value || 'editor';
  if (btn) btn.disabled = true;
  _setShareMsg('Sending invite…', false);
  try {
    const { data: existing } = await _supabase.from('collaborators').select('id').eq('project_id', _collabProjectId).eq('email', email).single();
    if (existing) { _setShareMsg('This person already has access.', true); return; }
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const { error } = await _supabase.from('collaborators').insert({ project_id: _collabProjectId, email, role, invite_token: token, accepted: false });
    if (error) throw error;
    _setShareMsg(`✓ Invited ${email} as ${role}`, false);
    if (input) input.value = '';
    _loadSharePeople();
  } catch(e) {
    _setShareMsg(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}
window.shareInvite = shareInvite;

function _setShareMsg(text, isError) {
  const msg = document.getElementById('share-invite-msg');
  if (!msg) return;
  msg.textContent = text;
  msg.className = 'share-invite-msg' + (isError ? ' error' : '');
}

async function shareChangeRole(collabId, role) {
  await _supabase.from('collaborators').update({ role }).eq('id', collabId);
}
window.shareChangeRole = shareChangeRole;

async function shareRemovePerson(collabId) {
  await _supabase.from('collaborators').delete().eq('id', collabId);
  _loadSharePeople();
}
window.shareRemovePerson = shareRemovePerson;

function shareCopyLink() {
  if (!_collabProjectId) return;
  const url = `${window.location.origin}${window.location.pathname}?project=${_collabProjectId}`;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.querySelector('.share-copy-btn');
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/></svg> Copied!`;
      setTimeout(() => { btn.innerHTML = orig; }, 2000);
    }
  }).catch(() => prompt('Copy this link:', url));
}
window.shareCopyLink = shareCopyLink;

function collabLeave() {
  closeSharePanel();
  _stopCollabSession();
  window.history.replaceState({}, '', window.location.pathname);
  document.getElementById('app-body')?.classList.remove('collab-active');
  if (typeof printToOutput === 'function') printToOutput('Left collaboration session.', '#858585');
}
window.collabLeave = collabLeave;

// Alias for old references
window.collabShare = openSharePanel;

/* ── Show / hide share UI ────────────────────────────────────────── */
function _showShareBtn() {
  const btn = document.getElementById('share-btn');
  if (btn) btn.style.display = 'flex';
  document.getElementById('app-body')?.classList.add('collab-active');
}

/* ── Hide the share button ──────────────────────────────────────── */
function _hideShareBtn() {
  const btn = document.getElementById('share-btn');
  const addBtn = document.getElementById('collab-add-btn');
  if (btn) btn.style.display = 'none';
  if (addBtn) addBtn.style.display = 'none';
  document.getElementById('app-body')?.classList.remove('collab-active');
  closeSharePanel();
}

/* ================================================================
   HOOK INTO saveProjectToCloud & cloudOpenProject
   Registered after DOM load to ensure cloud.js has run first
   ================================================================ */
let _origCloudOpen = null; // hoisted so _joinFromLink can use it

window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    // ── Hook saveProjectToCloud ──────────────────────────────────
    const _origSaveToCloud = window.saveProjectToCloud;
    if (typeof _origSaveToCloud !== 'function') {
      console.warn('[Collab] saveProjectToCloud not found — cloud.js may not have loaded');
    } else {
      window.saveProjectToCloud = async function() {
        await _origSaveToCloud();
        if (currentUser && projectFolder) {
          try {
            const { data } = await _supabase
              .from('projects')
              .select('id, name')
              .eq('owner_id', currentUser.id)
              .eq('name', projectFolder.name)
              .single();
            if (data) {
              const changed = _collabProjectId !== data.id;
              _collabProjectId   = data.id;
              _collabProjectName = data.name;
              _isOwner = true;
              _showShareBtn();
              if (changed) _startCollabSession();
            }
          } catch(e) { console.warn('[Collab] Could not get project id after save:', e); }
        }
      };
    }

    // ── Hook cloudOpenProject ────────────────────────────────────
    _origCloudOpen = window.cloudOpenProject;
    if (typeof _origCloudOpen === 'function') {
      window.cloudOpenProject = async function(projectId, projectName) {
        _stopCollabSession();
        await _origCloudOpen(projectId, projectName);
        try {
          const { data } = await _supabase
            .from('projects')
            .select('owner_id')
            .eq('id', projectId)
            .single();
          _isOwner = !!(currentUser && data && data.owner_id === currentUser.id);
        } catch(e) { _isOwner = false; }
        _collabProjectId   = projectId;
        _collabProjectName = projectName;
        _showShareBtn();
        _startCollabSession();
      };
    }
  }, 100);
});

/* ================================================================
   PRESENCE — render peer avatars in titlebar
   ================================================================ */
function _renderPresence() {
  const el = document.getElementById('collab-presence');
  const addBtn = document.getElementById('collab-add-btn');
  if (!el) return;

  const peerList = Object.values(_peers);
  if (peerList.length === 0) {
    el.innerHTML = '';
    if (addBtn) addBtn.style.display = 'none';
    return;
  }

  // Show up to 4 peers, then a +N overflow
  const MAX_SHOWN = 4;
  const shown = peerList.slice(0, MAX_SHOWN);
  const overflow = peerList.length - MAX_SHOWN;

  el.innerHTML = shown.map(p => {
    const initials = _initialsFromName(p.name);
    const inner = p.avatarUrl
      ? `<img src="${p.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;" alt="">`
      : initials;
    return `<div class="collab-avatar" style="background:${p.color}" title="${_escHtml(p.name)}">${inner}</div>`;
  }).join('') + (overflow > 0
    ? `<div class="collab-avatar" style="background:var(--bg-active);color:var(--text-muted);font-size:9px" title="${overflow} more">+${overflow}</div>`
    : '');

  // Show the + button next to avatars
  if (addBtn) addBtn.style.display = 'flex';
}

/* ================================================================
   PEER CURSORS — render other users' cursor positions in Monaco
   ================================================================ */
const _peerDecorations = {}; // { clientId: decorationId[] }

function _renderPeerCursor(payload) {
  if (!editor1 || payload.file !== currentFile1) return;
  const { clientId, name, color, line, col } = payload;

  // Remove old decoration for this peer
  if (_peerDecorations[clientId]) {
    editor1.deltaDecorations(_peerDecorations[clientId], []);
  }

  // Add new cursor decoration
  _peerDecorations[clientId] = editor1.deltaDecorations([], [
    {
      range: new monaco.Range(line, col, line, col + 1),
      options: {
        className: `peer-cursor-${clientId}`,
        afterContentClassName: `peer-cursor-label-${clientId}`,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      }
    }
  ]);

  // Inject dynamic CSS for this peer's cursor color
  _injectPeerCursorCSS(clientId, name, color);
}

function _removePeerCursor(clientId) {
  if (!editor1 || !_peerDecorations[clientId]) return;
  editor1.deltaDecorations(_peerDecorations[clientId], []);
  delete _peerDecorations[clientId];
}

function _injectPeerCursorCSS(clientId, name, color) {
  const styleId = `peer-cursor-style-${clientId}`;
  let el = document.getElementById(styleId);
  if (!el) {
    el = document.createElement('style');
    el.id = styleId;
    document.head.appendChild(el);
  }
  el.textContent = `
    .peer-cursor-${clientId} {
      border-left: 2px solid ${color};
      position: relative;
    }
    .peer-cursor-label-${clientId}::after {
      content: "${name.replace(/"/g, '')}";
      background: ${color};
      color: #fff;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 0 3px 3px 3px;
      position: absolute;
      top: -18px;
      left: 0;
      white-space: nowrap;
      pointer-events: none;
      z-index: 100;
    }
  `;
}

/* ================================================================
   STOP COLLAB SESSION
   ================================================================ */
function _stopCollabSession() {
  if (_realtimeChannel) {
    _supabase.removeChannel(_realtimeChannel);
    _realtimeChannel = null;
  }
  _peers = {};
  _collabProjectId   = null;
  _collabProjectName = null;
  _renderPresence();
  _hideShareBtn();
}
window.stopCollabSession = _stopCollabSession;

/* ================================================================
   HELPERS
   ================================================================ */
function _getMyName() {
  if (currentUser) {
    return currentUser.user_metadata?.full_name
      || currentUser.user_metadata?.name
      || currentUser.email?.split('@')[0]
      || 'Anonymous';
  }
  return `Guest ${Math.floor(Math.random() * 900) + 100}`;
}

function _hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return h;
}

function _escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}