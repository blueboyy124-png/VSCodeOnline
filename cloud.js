/* ================================================================
   CLOUD.JS — Cloud Projects System for VS Code Online
   Depends on: auth.js (_supabase, currentUser), script.js globals
   ================================================================ */

/* ================================================================
   CLOUD PANEL — open / close (uses sidebar-cloud view)
   ================================================================ */
function openCloudPanel() {
  const list = document.getElementById('cloud-project-list');
  if (!list) return;

  if (!currentUser) {
    // Show guest sign-in prompt inside the cloud sidebar
    _renderCloudGuest(list);
    return;
  }
  cloudLoadProjects();
}
window.openCloudPanel = openCloudPanel;

function closeCloudPanel() {
  // Switch back to explorer view
  if (typeof switchActivityView === 'function') {
    switchActivityView('explorer');
  }
}
window.closeCloudPanel = closeCloudPanel;

function _renderCloudGuest(list) {
  list.innerHTML = `
    <div class="cloud-guest">
      <div class="cloud-guest-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
        </svg>
      </div>
      <div class="cloud-guest-title">Cloud Projects</div>
      <div class="cloud-guest-sub">Sign in to save your projects to the cloud, access them from anywhere, and collaborate in real time.</div>
      <button class="cloud-guest-btn-primary" onclick="openAuthModal('signin')">Sign In</button>
      <button class="cloud-guest-btn-secondary" onclick="openAuthModal('signup')">Create Account</button>
    </div>
  `;
}

/* ================================================================
   LOAD PROJECTS — fetch from Supabase and render list
   ================================================================ */
async function cloudLoadProjects() {
  if (!currentUser) return;
  const list = document.getElementById('cloud-project-list');
  if (!list) return;

  list.innerHTML = `<div class="cloud-loading">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cloud-spin">
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
    Loading...
  </div>`;

  try {
    // Fetch own projects
    const { data: myProjects, error: myErr } = await _supabase
      .from('projects')
      .select('id, name, updated_at')
      .eq('owner_id', currentUser.id)
      .order('updated_at', { ascending: false });

    if (myErr) throw myErr;

    // Fetch shared projects (collaborator entries accepted = true)
    const { data: sharedCollabs } = await _supabase
      .from('collaborators')
      .select('project_id, role, projects(id, name, updated_at)')
      .eq('user_id', currentUser.id)
      .eq('accepted', true);

    const sharedProjects = (sharedCollabs || [])
      .map(c => ({ ...c.projects, role: c.role }))
      .filter(Boolean)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    list.innerHTML = '';

    // ── My Projects section ──────────────────────────────────────
    if (myProjects && myProjects.length > 0) {
      list.appendChild(_cloudSectionLabel('MY PROJECTS'));
      myProjects.forEach(p => list.appendChild(_cloudProjectItem(p, false)));
    } else {
      list.appendChild(_cloudSectionLabel('MY PROJECTS'));
      const empty = document.createElement('div');
      empty.className = 'cloud-empty';
      empty.innerHTML = `
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>
        <div class="cloud-empty-title">No projects yet</div>
        <div class="cloud-empty-sub">Use <strong>File → Save to Cloud</strong></div>`;
      list.appendChild(empty);
    }

    // ── Shared with me section ───────────────────────────────────
    list.appendChild(_cloudSectionLabel('SHARED WITH ME'));
    if (sharedProjects.length > 0) {
      sharedProjects.forEach(p => list.appendChild(_cloudProjectItem(p, true)));
    } else {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:11px;color:var(--text-muted);padding:6px 8px 10px';
      empty.textContent = 'No projects shared with you yet';
      list.appendChild(empty);
    }

  } catch (err) {
    list.innerHTML = `<div class="cloud-error">Failed to load projects: ${_escHtml(err.message)}</div>`;
  }
}
window.cloudLoadProjects = cloudLoadProjects;

function _cloudSectionLabel(text) {
  const el = document.createElement('div');
  el.className = 'cloud-section-label';
  el.textContent = text;
  return el;
}

function _cloudProjectItem(project, isShared) {
  const item = document.createElement('div');
  item.className = 'cloud-project-item';
  item.dataset.id   = project.id;
  item.dataset.name = project.name;

  const ago = _timeAgo(new Date(project.updated_at));
  const roleTag = isShared
    ? `<span class="cloud-project-role">${project.role || 'editor'}</span>`
    : '';

  item.innerHTML = `
    <div class="cloud-project-info">
      <div class="cloud-project-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <div class="cloud-project-meta">
        <div class="cloud-project-name">${_escHtml(project.name)}</div>
        <div class="cloud-project-date">${ago}${isShared ? ' · shared' : ''}</div>
      </div>
      ${roleTag}
    </div>
    <div class="cloud-project-actions">
      <div class="cloud-project-btn cloud-open-btn" title="Open project">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1 8a.5.5 0 0 1 .5-.5h11.793l-3.147-3.146a.5.5 0 0 1 .708-.708l4 4a.5.5 0 0 1 0 .708l-4 4a.5.5 0 0 1-.708-.708L13.293 8.5H1.5A.5.5 0 0 1 1 8z"/></svg>
      </div>
      ${!isShared ? `<div class="cloud-project-btn cloud-project-btn-danger cloud-delete-btn" title="Delete project">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
      </div>` : ''}
    </div>
  `;

  item.querySelector('.cloud-project-info').addEventListener('click', () => cloudOpenProject(project.id, project.name));
  item.querySelector('.cloud-open-btn').addEventListener('click', (e) => { e.stopPropagation(); cloudOpenProject(project.id, project.name); });
  if (!isShared) item.querySelector('.cloud-delete-btn')?.addEventListener('click', (e) => { e.stopPropagation(); cloudDeleteProject(project.id, project.name); });

  // Right-click context menu
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    const menu = document.getElementById('context-menu');
    if (!menu) return;
    menu.innerHTML = '';
    const ci = (label, action, danger = false) => {
      const el = document.createElement('div');
      el.className = 'ctx-item' + (danger ? ' danger' : '');
      el.innerHTML = `<span class="ctx-label">${label}</span>`;
      el.onclick = () => { menu.classList.remove('active'); action(); };
      return el;
    };
    const div = () => { const el = document.createElement('div'); el.className = 'ctx-divider'; return el; };
    menu.appendChild(ci('Open', () => cloudOpenProject(project.id, project.name)));
    menu.appendChild(div());
    menu.appendChild(ci('Copy Share Link', () => {
      const url = `${location.origin}${location.pathname}?project=${project.id}`;
      navigator.clipboard.writeText(url).catch(() => {});
    }));
    if (!isShared) {
      menu.appendChild(div());
      menu.appendChild(ci('Delete', () => cloudDeleteProject(project.id, project.name), true));
    }
    menu.classList.add('active');
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = e.clientX, y = e.clientY;
    if (x + menu.offsetWidth > vw - 8) x = vw - menu.offsetWidth - 8;
    if (y + menu.offsetHeight > vh - 8) y = vh - menu.offsetHeight - 8;
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
  });

  if (_collabProjectId === project.id) item.classList.add('cloud-project-active');
  return item;
}

/* ================================================================
   SAVE PROJECT TO CLOUD
   ================================================================ */
async function saveProjectToCloud() {
  if (!currentUser) {
    // Prompt sign in first
    if (typeof printToOutput === 'function') printToOutput('Sign in to save projects to the cloud.', '#cbcb41');
    openAuthModal('signin');
    return;
  }
  if (!projectFolder) {
    if (typeof printToOutput === 'function') printToOutput('Open a local folder first before saving to the cloud.', '#cbcb41');
    return;
  }

  const projectName = projectFolder.name;

  // Check if a project with this name already exists for this user
  const { data: existing } = await _supabase
    .from('projects')
    .select('id')
    .eq('owner_id', currentUser.id)
    .eq('name', projectName)
    .single();

  let projectId;

  if (existing) {
    // Ask if they want to overwrite
    const overwrite = confirm(`A cloud project named "${projectName}" already exists.\n\nOverwrite it with the current files?`);
    if (!overwrite) return;
    projectId = existing.id;
    // Update timestamp
    await _supabase.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', projectId);
  } else {
    // Create new project record
    const { data: newProject, error: projErr } = await _supabase
      .from('projects')
      .insert({ name: projectName, owner_id: currentUser.id })
      .select('id')
      .single();
    if (projErr) {
      if (typeof printToOutput === 'function') printToOutput(`Cloud save failed: ${projErr.message}`, '#f48771');
      return;
    }
    projectId = newProject.id;
  }

  if (typeof printToOutput === 'function') printToOutput(`Saving "${projectName}" to cloud...`, '#858585');

  // Gather all open files + walk disk for remaining files
  let saved = 0;
  let failed = 0;

  // Collect all files from openFiles (already loaded in memory)
  const fileEntries = { ...openFiles };

  // Also walk the disk for any files not yet opened
  if (projectFolder) {
    const diskFiles = await _gatherDiskFiles(projectFolder, '');
    for (const { path, handle } of diskFiles) {
      if (!fileEntries[path]) {
        try {
          const f = await handle.getFile();
          const content = await f.text();
          fileEntries[path] = { content };
        } catch { /* skip unreadable files */ }
      }
    }
  }

  // Upsert all files into Supabase
  const BATCH = 50;
  const entries = Object.entries(fileEntries);
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH).map(([path, data]) => ({
      project_id: projectId,
      path,
      content: data.content || '',
      updated_at: new Date().toISOString(),
    }));
    const { error: fileErr } = await _supabase
      .from('files')
      .upsert(batch, { onConflict: 'project_id,path' });
    if (fileErr) { failed += batch.length; }
    else { saved += batch.length; }
  }

  if (typeof printToOutput === 'function') {
    if (failed === 0) {
      printToOutput(`✓ Saved "${projectName}" to cloud (${saved} file${saved !== 1 ? 's' : ''})`, '#89d185');
    } else {
      printToOutput(`Saved ${saved} files, ${failed} failed.`, '#cbcb41');
    }
  }
}
window.saveProjectToCloud = saveProjectToCloud;

// Walk the real disk folder recursively, skipping node_modules/.git
async function _gatherDiskFiles(dirHandle, prefix) {
  const results = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (name === 'node_modules' || name === '.git' || name === '.vscode') continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'file') {
      results.push({ path, handle });
    } else {
      const sub = await _gatherDiskFiles(handle, path);
      results.push(...sub);
    }
  }
  return results;
}

/* ================================================================
   OPEN CLOUD PROJECT — load files from Supabase into editor
   ================================================================ */
async function cloudOpenProject(projectId, projectName) {
  if (!currentUser) return;

  if (typeof printToOutput === 'function') printToOutput(`Opening cloud project "${projectName}"...`, '#858585');

  const { data: files, error } = await _supabase
    .from('files')
    .select('path, content')
    .eq('project_id', projectId);

  if (error) {
    if (typeof printToOutput === 'function') printToOutput(`Failed to open project: ${error.message}`, '#f48771');
    return;
  }

  // Clear current state
  openFiles = {};
  currentFile1 = null;
  currentFile2 = null;
  projectFolder = null;
  if (editor1) { isProgrammaticEdit = true; editor1.setValue(''); isProgrammaticEdit = false; }
  if (editor2) { isProgrammaticEdit = true; editor2.setValue(''); isProgrammaticEdit = false; }

  // Update titlebar search text
  const sb = document.getElementById('search-bar-text');
  if (sb) sb.textContent = projectName;

  // Load files into openFiles (handle: null = cloud/virtual)
  for (const file of files) {
    openFiles[file.path] = { handle: null, content: file.content || '', unsaved: false };
  }

  // Render a virtual file tree in the sidebar
  _renderCloudTree(projectName, files);

  // Open the first file automatically
  const firstFile = files.find(f => !f.path.includes('node_modules'));
  if (firstFile) {
    activeEditor = editor1;
    currentFile1 = firstFile.path;
    isProgrammaticEdit = true;
    editor1.setValue(firstFile.content || '');
    isProgrammaticEdit = false;
    const lang = typeof getLanguageForFile === 'function' ? getLanguageForFile(firstFile.path) : 'plaintext';
    monaco.editor.setModelLanguage(editor1.getModel(), lang);
    const statusLang = document.getElementById('status-lang');
    if (statusLang) statusLang.innerText = lang.charAt(0).toUpperCase() + lang.slice(1);
  }

  if (typeof renderTabs === 'function') renderTabs();
  if (typeof saveWorkspaceState === 'function') saveWorkspaceState();
  closeCloudPanel();

  if (typeof printToOutput === 'function') printToOutput(`✓ Opened "${projectName}" (${files.length} file${files.length !== 1 ? 's' : ''})`, '#89d185');
}
window.cloudOpenProject = cloudOpenProject;

// Render a read-only virtual tree for cloud projects
function _renderCloudTree(projectName, files) {
  const tree = document.getElementById('fileTree');
  if (!tree) return;

  // Build folder structure
  const structure = {};
  files.forEach(f => {
    const parts = f.path.split('/');
    let node = structure;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        node[part] = { _file: true, path: f.path };
      } else {
        if (!node[part]) node[part] = {};
        node = node[part];
      }
    });
  });

  tree.innerHTML = `
    <div class="folder-title" onclick="toggleRootFolder()" style="cursor:pointer;user-select:none;">
      <span id="root-arrow">˅</span> ☁ ${_escHtml(projectName)}
    </div>
    <div id="tree-root"></div>
  `;

  const treeRoot = document.getElementById('tree-root');
  _renderCloudNode(structure, treeRoot);
}

function _renderCloudNode(node, parentEl) {
  const entries = Object.entries(node).sort(([aKey, aVal], [bKey, bVal]) => {
    const aIsFile = aVal?._file;
    const bIsFile = bVal?._file;
    if (aIsFile !== bIsFile) return aIsFile ? 1 : -1;
    return aKey.localeCompare(bKey);
  });

  for (const [name, val] of entries) {
    if (val?._file) {
      const div = document.createElement('div');
      div.className = 'file-item';
      div.title = val.path;
      div.innerHTML = (typeof getFileIcon === 'function' ? getFileIcon(name) : '') +
        `<span style="margin-left:5px;">${_escHtml(name)}</span>`;
      div.onclick = () => {
        if (!openFiles[val.path]) return;
        activeEditor = editor1;
        currentFile1 = val.path;
        isProgrammaticEdit = true;
        editor1.setValue(openFiles[val.path].content || '');
        isProgrammaticEdit = false;
        const lang = typeof getLanguageForFile === 'function' ? getLanguageForFile(val.path) : 'plaintext';
        monaco.editor.setModelLanguage(editor1.getModel(), lang);
        if (typeof renderTabs === 'function') renderTabs();
      };
      parentEl.appendChild(div);
    } else {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.innerHTML = (typeof getFolderIcon === 'function' ? getFolderIcon(name, false) : '') +
        ` <span>${_escHtml(name)}</span>`;
      details.addEventListener('toggle', () => {
        summary.innerHTML = (typeof getFolderIcon === 'function' ? getFolderIcon(name, details.open) : '') +
          ` <span>${_escHtml(name)}</span>`;
      });
      const children = document.createElement('div');
      children.style.paddingLeft = '12px';
      _renderCloudNode(val, children);
      details.append(summary, children);
      parentEl.appendChild(details);
    }
  }
}

/* ================================================================
   NEW CLOUD PROJECT — create empty, then open
   ================================================================ */
async function cloudNewProject() {
  if (!currentUser) { openAuthModal('signin'); return; }
  const name = prompt('New cloud project name:');
  if (!name?.trim()) return;

  const { data, error } = await _supabase
    .from('projects')
    .insert({ name: name.trim(), owner_id: currentUser.id })
    .select('id')
    .single();

  if (error) {
    if (typeof printToOutput === 'function') printToOutput(`Failed to create project: ${error.message}`, '#f48771');
    return;
  }

  // Create a default file
  await _supabase.from('files').insert({
    project_id: data.id,
    path: 'index.js',
    content: '// New cloud project\nconsole.log("Hello, world!");\n',
  });

  if (typeof printToOutput === 'function') printToOutput(`Created cloud project "${name.trim()}"`, '#89d185');
  cloudLoadProjects();
}
window.cloudNewProject = cloudNewProject;

/* ================================================================
   DELETE CLOUD PROJECT
   ================================================================ */
async function cloudDeleteProject(projectId, projectName) {
  if (!confirm(`Delete cloud project "${projectName}"?\n\nThis cannot be undone.`)) return;

  const { error } = await _supabase
    .from('projects')
    .delete()
    .eq('id', projectId)
    .eq('owner_id', currentUser.id);

  if (error) {
    if (typeof printToOutput === 'function') printToOutput(`Delete failed: ${error.message}`, '#f48771');
    return;
  }

  if (typeof printToOutput === 'function') printToOutput(`Deleted "${projectName}"`, '#858585');
  cloudLoadProjects();
}
window.cloudDeleteProject = cloudDeleteProject;

/* ================================================================
   KEYBOARD SHORTCUT — Ctrl+Shift+U → Save to Cloud
   ================================================================ */
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'u') {
    e.preventDefault();
    saveProjectToCloud();
  }
});

/* ================================================================
   HELPERS
   ================================================================ */
function _timeAgo(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60)  return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return date.toLocaleDateString();
}

function _escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}