/* ================================================================
   CLOUD.JS — Cloud Projects System for VS Code Online
   Depends on: auth.js (_supabase, currentUser), script.js globals
   ================================================================ */

/* ================================================================
   CLOUD PANEL — open / close
   ================================================================ */
function openCloudPanel() {
  if (!currentUser) {
    openAuthModal('signin');
    return;
  }
  const panel = document.getElementById('cloud-panel');
  if (!panel) return;
  panel.classList.add('open');
  cloudLoadProjects();
}
window.openCloudPanel = openCloudPanel;

function closeCloudPanel() {
  const panel = document.getElementById('cloud-panel');
  if (panel) panel.classList.remove('open');
}
window.closeCloudPanel = closeCloudPanel;

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
    const { data: projects, error } = await _supabase
      .from('projects')
      .select('id, name, updated_at')
      .eq('owner_id', currentUser.id)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    if (!projects || projects.length === 0) {
      list.innerHTML = `
        <div class="cloud-empty">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
            <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
          </svg>
          <div class="cloud-empty-title">No cloud projects yet</div>
          <div class="cloud-empty-sub">Open a folder and use<br><strong>File → Save to Cloud</strong></div>
        </div>`;
      return;
    }

    list.innerHTML = '';
    projects.forEach(project => {
      const item = document.createElement('div');
      item.className = 'cloud-project-item';
      item.dataset.id = project.id;

      const date = new Date(project.updated_at);
      const ago  = _timeAgo(date);

      item.innerHTML = `
        <div class="cloud-project-info" onclick="cloudOpenProject('${project.id}', ${JSON.stringify(project.name)})">
          <div class="cloud-project-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <div class="cloud-project-meta">
            <div class="cloud-project-name">${_escHtml(project.name)}</div>
            <div class="cloud-project-date">${ago}</div>
          </div>
        </div>
        <div class="cloud-project-actions">
          <div class="cloud-project-btn" title="Open project" onclick="cloudOpenProject('${project.id}', ${JSON.stringify(project.name)})">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1 8a.5.5 0 0 1 .5-.5h11.793l-3.147-3.146a.5.5 0 0 1 .708-.708l4 4a.5.5 0 0 1 0 .708l-4 4a.5.5 0 0 1-.708-.708L13.293 8.5H1.5A.5.5 0 0 1 1 8z"/></svg>
          </div>
          <div class="cloud-project-btn cloud-project-btn-danger" title="Delete project" onclick="cloudDeleteProject('${project.id}', ${JSON.stringify(project.name)})">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
          </div>
        </div>
      `;
      list.appendChild(item);
    });
  } catch (err) {
    list.innerHTML = `<div class="cloud-error">Failed to load projects: ${_escHtml(err.message)}</div>`;
  }
}
window.cloudLoadProjects = cloudLoadProjects;

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