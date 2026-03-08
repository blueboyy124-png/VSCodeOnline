let editor1, editor2;
let activeEditor;
let projectFolder;
let shellWriter; // This is the master "pen" for the terminal
let openFiles = {};
let currentFile1 = null;
let currentFile2 = null;
let saveTimeout;
let isProgrammaticEdit = false;
let currentContextItem = null;
let clipboardItem = null; // { type, name, handle, parentHandle, fullPath, isCut }
let cachedWorkspaceFiles = [];
let webcontainerInstance = null;
let termDataDisposable = null;
let isSyncingFile = false; // Suppresses fs.watch tree refresh during our own programmatic saves
let previewMode = null;   // 'srcdoc' | 'server' — tracks what the preview iframe is showing

/* ================================================================
   WINDOW CONTROLS OVERLAY — PWA title bar integration
   ================================================================ */
if ('windowControlsOverlay' in navigator) {
  const onWCOChange = () => {
    const visible = navigator.windowControlsOverlay.visible;
    const rect    = navigator.windowControlsOverlay.getTitlebarAreaRect();
    // Expose the live geometry as CSS custom properties so any rule can use them
    document.documentElement.style.setProperty('--titlebar-area-x',      rect.x      + 'px');
    document.documentElement.style.setProperty('--titlebar-area-y',      rect.y      + 'px');
    document.documentElement.style.setProperty('--titlebar-area-width',  rect.width  + 'px');
    document.documentElement.style.setProperty('--titlebar-area-height', rect.height + 'px');
    // Toggle a class so CSS can further distinguish WCO-active vs normal
    document.body.classList.toggle('wco-active', visible);
  };
  navigator.windowControlsOverlay.addEventListener('geometrychange', onWCOChange);
  // Run once immediately in case we're already in WCO mode on load
  onWCOChange();
}


/* MOBILE & UI LOGIC */
function toggleSidebar() {
  if (window._sidebarToggle) window._sidebarToggle();
  else document.getElementById('sidebar').classList.toggle('open');
}

function toggleSplit() {
  const ed2 = document.getElementById("editor2");
  if (ed2.style.display === "none") {
    ed2.style.display = "block";
    activeEditor = editor2;
  } else {
    ed2.style.display = "none";
    activeEditor = editor1;
  }
}

function toggleMenu(e, id) {
  e.stopPropagation();
  document.querySelectorAll('.menu-item').forEach(el => {
    if(el.id !== id + '-container') el.classList.remove('active');
  });
  document.getElementById(id + '-container').classList.toggle('active');
}

document.addEventListener('click', () => {
  document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
  closeContextMenu();
});

/* ── Edit Menu ────────────────────────────────────────────────── */
function editMenuUndo()    { activeEditor?.trigger('menu', 'undo', null); }
function editMenuRedo()    { activeEditor?.trigger('menu', 'redo', null); }
function editMenuCut()     { activeEditor?.focus(); document.execCommand('cut'); }
function editMenuCopy()    {
  if (!activeEditor) return;
  const sel = activeEditor.getSelection();
  const model = activeEditor.getModel();
  const text = sel && !sel.isEmpty() ? model.getValueInRange(sel) : model.getLineContent(activeEditor.getPosition().lineNumber);
  navigator.clipboard.writeText(text).catch(() => {});
}
async function editMenuPaste() {
  if (!activeEditor) return;
  const text = await navigator.clipboard.readText().catch(() => null);
  if (!text) return;
  const sel = activeEditor.getSelection();
  activeEditor.executeEdits('paste', [{ range: sel, text }]);
}
function editMenuFind()           { activeEditor?.trigger('menu', 'actions.find', null); }
function editMenuReplace()        { activeEditor?.trigger('menu', 'editor.action.startFindReplaceAction', null); }
function editMenuFindInFiles()    { openFindInFiles(); }
function editMenuReplaceInFiles() { openFindInFiles(); setTimeout(() => document.getElementById('fif-replace')?.focus(), 100); }
function editMenuToggleLineComment()  { activeEditor?.trigger('menu', 'editor.action.commentLine', null); }
function editMenuToggleBlockComment() { activeEditor?.trigger('menu', 'editor.action.blockComment', null); }
function editMenuEmmetExpand()        { activeEditor?.trigger('menu', 'editor.emmet.action.expandAbbreviation', null); }
function editMenuSelectAll()          { if (activeEditor) { activeEditor.focus(); activeEditor.setSelection(activeEditor.getModel().getFullModelRange()); } }

/* ── Selection Menu ──────────────────────────────────────────── */
function selectionExpandLine()           { activeEditor?.trigger('menu', 'expandLineSelection', null); }
function selectionCopyLineUp()           { activeEditor?.trigger('menu', 'editor.action.copyLinesUpAction', null); }
function selectionCopyLineDown()         { activeEditor?.trigger('menu', 'editor.action.copyLinesDownAction', null); }
function selectionMoveLineUp()           { activeEditor?.trigger('menu', 'editor.action.moveLinesUpAction', null); }
function selectionMoveLineDown()         { activeEditor?.trigger('menu', 'editor.action.moveLinesDownAction', null); }
function selectionAddCursorAbove()       { activeEditor?.trigger('menu', 'editor.action.insertCursorAbove', null); }
function selectionAddCursorBelow()       { activeEditor?.trigger('menu', 'editor.action.insertCursorBelow', null); }
function selectionSelectNextOccurrence() { activeEditor?.trigger('menu', 'editor.action.addSelectionToNextFindMatch', null); }
function selectionSelectAllOccurrences() { activeEditor?.trigger('menu', 'editor.action.selectHighlights', null); }

/* ── View Menu ───────────────────────────────────────────────── */
let currentZoom = 1.0;
function viewMenuZoomIn()    { currentZoom = Math.min(2.0, currentZoom + 0.1); document.body.style.zoom = currentZoom; }
function viewMenuZoomOut()   { currentZoom = Math.max(0.5, currentZoom - 0.1); document.body.style.zoom = currentZoom; }
function viewMenuResetZoom() { currentZoom = 1.0; document.body.style.zoom = 1.0; }

let wordWrapEnabled = false;
function viewMenuWordWrap() {
  wordWrapEnabled = !wordWrapEnabled;
  const wrap = wordWrapEnabled ? 'on' : 'off';
  editor1?.updateOptions({ wordWrap: wrap });
  editor2?.updateOptions({ wordWrap: wrap });
  const check = document.getElementById('wordwrap-check');
  if (check) check.style.opacity = wordWrapEnabled ? '1' : '0';
}

let minimapEnabled = true;
function viewMenuMinimap() {
  minimapEnabled = !minimapEnabled;
  editor1?.updateOptions({ minimap: { enabled: minimapEnabled } });
  editor2?.updateOptions({ minimap: { enabled: minimapEnabled } });
  const check = document.getElementById('minimap-check');
  if (check) check.style.opacity = minimapEnabled ? '1' : '0';
}

/* ── Go Menu ─────────────────────────────────────────────────── */
function goMenuBack()          { activeEditor?.trigger('menu', 'cursorUndo', null); }
function goMenuForward()       { activeEditor?.trigger('menu', 'cursorRedo', null); }
function goMenuGoToLine()      { openPalette(':'); }
function goMenuGoToFile()      { openPalette(''); }
function goMenuGoToDefinition(){ activeEditor?.trigger('menu', 'editor.action.revealDefinition', null); }
function goMenuNextProblem()   { activeEditor?.trigger('menu', 'editor.action.marker.next', null); }
function goMenuPrevProblem()   { activeEditor?.trigger('menu', 'editor.action.marker.prev', null); }

/* ── Help Menu ───────────────────────────────────────────────── */
function helpMenuKeyboardShortcuts() { openPalette('>keyboard '); }
function helpMenuAbout() { openAbout(); }

function openAbout() {
  const overlay = document.getElementById('about-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  requestAnimationFrame(() => overlay.classList.add('visible'));
}
function closeAbout() {
  const overlay = document.getElementById('about-overlay');
  if (!overlay) return;
  overlay.classList.remove('visible');
  setTimeout(() => { overlay.style.display = 'none'; }, 200);
}
window.openAbout  = openAbout;
window.closeAbout = closeAbout;

/* =========================================
   SETTINGS SYSTEM
   ========================================= */
const SETTING_DEFAULTS = {
  fontSize:   14,
  tabSize:    4,
  fontFamily: "'Cascadia Code','Fira Code',Consolas,monospace",
  wordWrap:   false,
  minimap:    true,
  lineNumbers:'on',
  cursorStyle:'line',
  autoSave:   true,
  termFontSize: 13,
};

function loadSettings() {
  const saved = JSON.parse(localStorage.getItem('editorSettings') || '{}');
  return { ...SETTING_DEFAULTS, ...saved };
}
function saveSettings(patch) {
  const cur = loadSettings();
  localStorage.setItem('editorSettings', JSON.stringify({ ...cur, ...patch }));
}

function initSettings() {
  const s = loadSettings();

  // Font size
  editor1?.updateOptions({ fontSize: s.fontSize });
  editor2?.updateOptions({ fontSize: s.fontSize });

  // Tab size
  editor1?.getModel()?.updateOptions({ tabSize: s.tabSize });
  editor2?.getModel()?.updateOptions({ tabSize: s.tabSize });

  // Font family
  editor1?.updateOptions({ fontFamily: s.fontFamily });
  editor2?.updateOptions({ fontFamily: s.fontFamily });

  // Word wrap
  const wrap = s.wordWrap ? 'on' : 'off';
  editor1?.updateOptions({ wordWrap: wrap });
  editor2?.updateOptions({ wordWrap: wrap });
  wordWrapEnabled = s.wordWrap;
  const wc = document.getElementById('wordwrap-check');
  if (wc) wc.style.opacity = s.wordWrap ? '1' : '0';

  // Minimap
  editor1?.updateOptions({ minimap: { enabled: s.minimap } });
  editor2?.updateOptions({ minimap: { enabled: s.minimap } });
  minimapEnabled = s.minimap;
  const mc = document.getElementById('minimap-check');
  if (mc) mc.style.opacity = s.minimap ? '1' : '0';

  // Line numbers
  editor1?.updateOptions({ lineNumbers: s.lineNumbers });
  editor2?.updateOptions({ lineNumbers: s.lineNumbers });

  // Cursor
  editor1?.updateOptions({ cursorStyle: s.cursorStyle });
  editor2?.updateOptions({ cursorStyle: s.cursorStyle });

  // Auto save
  autoSaveEnabled = s.autoSave;
  const ac = document.getElementById('autosave-check');
  if (ac) ac.style.opacity = s.autoSave ? '1' : '0';

  // Terminal font size
  if (typeof termFontSize !== 'undefined') {
    termFontSize = s.termFontSize;
    const label = document.getElementById('term-font-label');
    if (label) label.textContent = s.termFontSize;
  }
}

function syncSettingsUI() {
  const s = loadSettings();
  const theme = THEMES.find(t => t.id === activeThemeId);
  const tn = document.getElementById('settings-theme-name');
  if (tn) tn.textContent = theme ? theme.label : activeThemeId;

  const fsEl = document.getElementById('setting-font-size');
  if (fsEl) { fsEl.value = s.fontSize; document.getElementById('setting-font-size-label').textContent = s.fontSize; }

  [2, 4, 8].forEach(n => {
    const btn = document.getElementById(`tabsize-${n}`);
    if (btn) btn.classList.toggle('active', s.tabSize === n);
  });

  const ffEl = document.getElementById('setting-font-family');
  if (ffEl) ffEl.value = s.fontFamily;

  const wwEl = document.getElementById('setting-word-wrap');
  if (wwEl) wwEl.checked = s.wordWrap;

  const mmEl = document.getElementById('setting-minimap');
  if (mmEl) mmEl.checked = s.minimap;

  ['on', 'relative', 'off'].forEach(v => {
    const btn = document.getElementById(`linenums-${v}`);
    if (btn) btn.classList.toggle('active', s.lineNumbers === v);
  });

  const csEl = document.getElementById('setting-cursor');
  if (csEl) csEl.value = s.cursorStyle;

  const asEl = document.getElementById('setting-auto-save');
  if (asEl) asEl.checked = s.autoSave;

  const tfsEl = document.getElementById('setting-term-font-size');
  if (tfsEl) { tfsEl.value = s.termFontSize; document.getElementById('setting-term-font-size-label').textContent = s.termFontSize; }
}

window.openSettings = function() {
  const overlay = document.getElementById('settings-overlay');
  if (!overlay) return;
  syncSettingsUI();
  overlay.style.display = 'flex';
  requestAnimationFrame(() => overlay.classList.add('visible'));
};
window.closeSettings = function() {
  const overlay = document.getElementById('settings-overlay');
  if (!overlay) return;
  overlay.classList.remove('visible');
  setTimeout(() => { overlay.style.display = 'none'; }, 200);
};

window.resetSettings = function() {
  localStorage.removeItem('editorSettings');
  applyTheme('vs-dark', true);
  initSettings();
  syncSettingsUI();
  printToOutput('Settings reset to defaults.', '#858585');
};

// ── Individual setting handlers ──
window.settingFontSize = function(v) {
  const n = parseInt(v);
  editor1?.updateOptions({ fontSize: n });
  editor2?.updateOptions({ fontSize: n });
  const lbl = document.getElementById('setting-font-size-label');
  if (lbl) lbl.textContent = n;
  saveSettings({ fontSize: n });
};
window.settingTabSize = function(n) {
  editor1?.getModel()?.updateOptions({ tabSize: n });
  editor2?.getModel()?.updateOptions({ tabSize: n });
  [2, 4, 8].forEach(x => {
    const btn = document.getElementById(`tabsize-${x}`);
    if (btn) btn.classList.toggle('active', x === n);
  });
  saveSettings({ tabSize: n });
};
window.settingFontFamily = function(v) {
  editor1?.updateOptions({ fontFamily: v });
  editor2?.updateOptions({ fontFamily: v });
  saveSettings({ fontFamily: v });
};
window.settingWordWrap = function(checked) {
  const wrap = checked ? 'on' : 'off';
  editor1?.updateOptions({ wordWrap: wrap });
  editor2?.updateOptions({ wordWrap: wrap });
  wordWrapEnabled = checked;
  const wc = document.getElementById('wordwrap-check');
  if (wc) wc.style.opacity = checked ? '1' : '0';
  saveSettings({ wordWrap: checked });
};
window.settingMinimap = function(checked) {
  editor1?.updateOptions({ minimap: { enabled: checked } });
  editor2?.updateOptions({ minimap: { enabled: checked } });
  minimapEnabled = checked;
  const mc = document.getElementById('minimap-check');
  if (mc) mc.style.opacity = checked ? '1' : '0';
  saveSettings({ minimap: checked });
};
window.settingLineNumbers = function(v) {
  editor1?.updateOptions({ lineNumbers: v });
  editor2?.updateOptions({ lineNumbers: v });
  ['on', 'relative', 'off'].forEach(x => {
    const btn = document.getElementById(`linenums-${x}`);
    if (btn) btn.classList.toggle('active', x === v);
  });
  saveSettings({ lineNumbers: v });
};
window.settingCursor = function(v) {
  editor1?.updateOptions({ cursorStyle: v });
  editor2?.updateOptions({ cursorStyle: v });
  saveSettings({ cursorStyle: v });
};
window.settingAutoSave = function(checked) {
  autoSaveEnabled = checked;
  const ac = document.getElementById('autosave-check');
  if (ac) ac.style.opacity = checked ? '1' : '0';
  saveSettings({ autoSave: checked });
};
window.settingTermFontSize = function(v) {
  const n = parseInt(v);
  const lbl = document.getElementById('setting-term-font-size-label');
  if (lbl) lbl.textContent = n;
  if (window.term) { window.term.options.fontSize = n; window.fitAddon?.fit(); }
  const tl = document.getElementById('term-font-label');
  if (tl) tl.textContent = n;
  saveSettings({ termFontSize: n });
};


let autoSaveEnabled = true; // default on (matches VS Code default)

function fileMenuToggleAutoSave() {
  autoSaveEnabled = !autoSaveEnabled;
  const check = document.getElementById('autosave-check');
  if (check) check.style.opacity = autoSaveEnabled ? '1' : '0';
  printToOutput(`Auto Save ${autoSaveEnabled ? 'enabled' : 'disabled'}`, '#858585');
}

async function fileMenuSaveAs() {
  const currentFile = activeEditor === editor1 ? currentFile1 : currentFile2;
  if (!currentFile || !activeEditor) return;
  const newName = prompt('Save As:', currentFile.split('/').pop());
  if (!newName || newName === currentFile.split('/').pop()) return;
  const content = activeEditor.getValue();

  try {
    // Build the new path — keep same directory as current file
    const dir = currentFile.substring(0, currentFile.lastIndexOf('/'));
    const newPath = dir ? `${dir}/${newName}` : newName;

    // Create the actual file on disk via File System Access API
    // Walk to the parent directory
    let dirHandle = projectFolder;
    if (dir) {
      const parts = dir.split('/');
      for (const part of parts) {
        if (part && part !== projectFolder.name) {
          dirHandle = await dirHandle.getDirectoryHandle(part);
        }
      }
    }
    const newHandle = await dirHandle.getFileHandle(newName, { create: true });
    const writable = await newHandle.createWritable();
    await writable.write(content);
    await writable.close();

    // Register in openFiles with the real handle
    openFiles[newPath] = { handle: newHandle, content, unsaved: false };
    if (activeEditor === editor1) currentFile1 = newPath;
    else currentFile2 = newPath;

    await refreshTree();
    refreshFileCache();
    renderTabs();
    printToOutput(`Saved as: ${newName}`, '#89d185');
  } catch (e) {
    printToTerminal(`[Error] Save As: ${e.message}`, '#f48771');
  }
}

function fileMenuOpenRecent() {
  // Show recent folders from localStorage
  const recent = JSON.parse(localStorage.getItem('recentFolders') || '[]');
  if (!recent.length) {
    printToOutput('No recent folders.', '#858585');
    return;
  }
  openPalette('>recent ');
}

function fileMenuRevertFile() {
  const currentFile = activeEditor === editor1 ? currentFile1 : currentFile2;
  if (!currentFile || !openFiles[currentFile]) return;
  const handle = openFiles[currentFile].handle;
  if (!handle) { printToOutput('Cannot revert virtual file.', '#858585'); return; }
  if (!confirm(`Revert '${currentFile.split('/').pop()}' to last saved version?`)) return;
  handle.getFile().then(f => f.text()).then(content => {
    openFiles[currentFile].content = content;
    openFiles[currentFile].unsaved = false;
    isProgrammaticEdit = true;
    activeEditor.setValue(content);
    isProgrammaticEdit = false;
    renderTabs();
    printToOutput(`Reverted: ${currentFile.split('/').pop()}`, '#89d185');
  }).catch(e => printToTerminal(`[Error] Revert failed: ${e.message}`, '#f48771'));
}

function fileMenuCloseEditor() {
  const currentFile = activeEditor === editor1 ? currentFile1 : currentFile2;
  if (!currentFile) return;
  if (openFiles[currentFile]?.unsaved) {
    const choice = confirm(`'${currentFile.split('/').pop()}' has unsaved changes. Save before closing?`);
    if (choice) saveFile(currentFile, activeEditor.getValue());
  }
  delete openFiles[currentFile];
  if (activeEditor === editor1) { currentFile1 = null; isProgrammaticEdit = true; editor1.setValue(''); isProgrammaticEdit = false; }
  else { currentFile2 = null; isProgrammaticEdit = true; editor2.setValue(''); isProgrammaticEdit = false; }
  renderTabs();
}

function fileMenuCloseFolder() {
  if (!projectFolder) return;
  if (!confirm('Close this folder? Unsaved changes will be lost.')) return;
  projectFolder = null;
  openFiles = {};
  currentFile1 = null; currentFile2 = null;
  const _sbClose = document.getElementById('search-bar-text');
  if (_sbClose) _sbClose.textContent = 'workspace';
  isProgrammaticEdit = true;
  editor1.setValue('// Open a folder to start');
  editor2.setValue('');
  isProgrammaticEdit = false;
  renderTabs();
  const treeRoot = document.getElementById('tree-root');
  if (treeRoot) treeRoot.innerHTML = '';
  const fileTree = document.getElementById('fileTree');
  fileTree.innerHTML = '<button class="open-folder-btn" onclick="openFolder()">Open Folder</button>';
  printToOutput('Folder closed.', '#858585');
}

/* ── Terminal Menu Actions ────────────────────────────────────── */
function terminalMenuNewTerminal() {
  window.openTerminal();
  switchTerminalTab('terminal');
  term.focus();
}

function terminalMenuSplitTerminal() {
  // For now open terminal and notify — full split-pane terminals is a larger feature
  window.openTerminal();
  switchTerminalTab('terminal');
  printToTerminal('[System] Split terminal: multiple sessions not yet supported — opening terminal.', '#858585');
  term.focus();
}

function terminalMenuRunActiveFile() {
  const file = activeEditor === editor1 ? currentFile1 : currentFile2;
  if (!file) { printToTerminal('[Error] No active file.', '#f48771'); return; }
  window.openTerminal();
  switchTerminalTab('terminal');
  const ext = file.split('.').pop();
  let cmd = '';
  if (ext === 'js' || ext === 'mjs') cmd = `node "${file}"`;
  else if (ext === 'ts') cmd = `npx ts-node "${file}"`;
  else if (ext === 'py') cmd = `python3 "${file}"`;
  else if (ext === 'sh') cmd = `bash "${file}"`;
  else { printToTerminal(`[Error] Don't know how to run .${ext} files.`, '#f48771'); return; }
  if (shellWriter) shellWriter.write(cmd + '\r');
}

function terminalMenuRunSelectedText() {
  const sel = activeEditor ? activeEditor.getSelection() : null;
  const model = activeEditor ? activeEditor.getModel() : null;
  if (!sel || sel.isEmpty() || !model) { printToTerminal('[Error] No text selected in editor.', '#f48771'); return; }
  const text = model.getValueInRange(sel).trim();
  if (!text) return;
  window.openTerminal();
  switchTerminalTab('terminal');
  if (shellWriter) shellWriter.write(text + '\r');
}

function terminalMenuClear() {
  window.openTerminal();
  switchTerminalTab('terminal');
  term.clear();
}

function terminalMenuKill() {
  if (shellWriter) {
    shellWriter.write('\x03'); // SIGINT
    printToTerminal('[System] Terminal process interrupted.', '#858585');
  }
}

function terminalMenuScrollUp() {
  window.openTerminal();
  term.scrollLines(-10);
}

function terminalMenuScrollDown() {
  window.openTerminal();
  term.scrollLines(10);
}

/* CONTEXT MENU LOGIC */
function showContextMenu(e, type, name, handle, parentHandle, fullPath) {
  e.preventDefault(); e.stopPropagation();
  // Only set currentContextItem if it wasn't already set by the caller
  // (virtual tree handlers set it with extra fields like virtual/parentPath before calling us)
  if (!currentContextItem || currentContextItem.fullPath !== fullPath) {
    currentContextItem = { type, name, handle, parentHandle, fullPath };
  }

  const menu = document.getElementById('context-menu');
  menu.innerHTML = '';

  const item = (label, shortcut, action, danger = false, disabled = false) => {
    const el = document.createElement('div');
    el.className = 'ctx-item' + (danger ? ' danger' : '') + (disabled ? ' disabled' : '');
    el.innerHTML = `<span class="ctx-label">${label}</span>${shortcut ? `<span class="ctx-shortcut">${shortcut}</span>` : ''}`;
    if (action && !disabled) el.onclick = () => { closeContextMenu(); action(); };
    return el;
  };

  const divider = () => {
    const el = document.createElement('div');
    el.className = 'ctx-divider';
    return el;
  };

  if (type === 'file') {
    // ── FILE MENU ────────────────────────────────────────────────────
    menu.appendChild(item('Open to the Side', 'Ctrl+Enter', () => ctxOpenToSide()));
    menu.appendChild(divider());

    menu.appendChild(item('Reveal in File Explorer', 'Shift+Alt+R', () => ctxReveal()));
    menu.appendChild(item('Open in Integrated Terminal', '', () => ctxOpenInTerminal()));
    menu.appendChild(divider());

    menu.appendChild(item('Select for Compare', '', () => ctxSelectForCompare()));
    menu.appendChild(divider());

    menu.appendChild(item('Cut', 'Ctrl+X', () => ctxCut()));
    menu.appendChild(item('Copy', 'Ctrl+C', () => ctxCopy()));
    menu.appendChild(divider());

    menu.appendChild(item('Copy Path', 'Shift+Alt+C', () => ctxCopyPath()));
    menu.appendChild(item('Copy Relative Path', 'Ctrl+K Ctrl+Shift+C', () => ctxCopyRelativePath()));
    menu.appendChild(divider());

    menu.appendChild(item('Rename...', 'F2', () => renameContextItem()));
    menu.appendChild(item('Delete', 'Delete', () => deleteContextItem(), true));

  } else {
    // ── FOLDER MENU ──────────────────────────────────────────────────
    menu.appendChild(item('New File...', '', () => ctxNewFile()));
    menu.appendChild(item('New Folder...', '', () => ctxNewFolder()));
    menu.appendChild(divider());

    menu.appendChild(item('Open in Integrated Terminal', '', () => ctxOpenInTerminal()));
    menu.appendChild(divider());

    menu.appendChild(item('Find in Folder...', 'Shift+Alt+F', () => ctxFindInFolder()));
    menu.appendChild(divider());

    menu.appendChild(item('Cut', 'Ctrl+X', () => ctxCut()));
    menu.appendChild(item('Copy', 'Ctrl+C', () => ctxCopy()));
    menu.appendChild(item('Paste', 'Ctrl+V', () => ctxPaste(), false, !clipboardItem));
    menu.appendChild(divider());

    menu.appendChild(item('Copy Path', 'Shift+Alt+C', () => ctxCopyPath()));
    menu.appendChild(item('Copy Relative Path', 'Ctrl+K Ctrl+Shift+C', () => ctxCopyRelativePath()));
    menu.appendChild(divider());

    menu.appendChild(item('Rename...', 'F2', () => renameContextItem()));
    menu.appendChild(item('Delete', 'Delete', () => deleteContextItem(), true));
  }

  // Position — keep menu inside viewport
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = e.clientX, y = e.clientY;
  menu.classList.add('active');
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  if (x + mw > vw - 8) x = vw - mw - 8;
  if (y + mh > vh - 8) y = vh - mh - 8;
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function closeContextMenu() {
  document.getElementById('context-menu').classList.remove('active');
}

/* ── Editor Right-Click Menu ──────────────────────────────────── */
function showEditorContextMenu(nativeEvent, ed) {
  if (!projectFolder) return;
  const menu = document.getElementById('context-menu');
  menu.innerHTML = '';

  const selection = ed.getSelection();
  const hasSelection = selection && !selection.isEmpty();
  const model = ed.getModel();
  const currentFile = ed === editor1 ? currentFile1 : currentFile2;
  const wordAtPos = model ? model.getWordAtPosition(ed.getPosition()) : null;

  const item = (label, shortcut, action, danger = false, disabled = false) => {
    const el = document.createElement('div');
    el.className = 'ctx-item' + (danger ? ' danger' : '') + (disabled ? ' disabled' : '');
    el.innerHTML = `<span class="ctx-label">${label}</span>${shortcut ? `<span class="ctx-shortcut">${shortcut}</span>` : ''}`;
    if (action && !disabled) el.onclick = () => { closeContextMenu(); action(); };
    return el;
  };
  const divider = () => { const el = document.createElement('div'); el.className = 'ctx-divider'; return el; };

  // ── Edit actions ──────────────────────────────────────────────
  menu.appendChild(item('Cut', 'Ctrl+X', () => {
    ed.focus();
    document.execCommand('cut');
  }, false, !hasSelection));

  menu.appendChild(item('Copy', 'Ctrl+C', () => {
    const text = hasSelection
      ? model.getValueInRange(selection)
      : model.getLineContent(ed.getPosition().lineNumber);
    navigator.clipboard.writeText(text).catch(() => document.execCommand('copy'));
  }, false, !hasSelection));

  menu.appendChild(item('Paste', 'Ctrl+V', async () => {
    const text = await navigator.clipboard.readText().catch(() => null);
    if (text) ed.executeEdits('paste', [{ range: selection.isEmpty() ? monaco.Range.fromPositions(ed.getPosition()) : selection, text }]);
  }));

  menu.appendChild(divider());

  // ── Selection ─────────────────────────────────────────────────
  menu.appendChild(item('Select All', 'Ctrl+A', () => {
    ed.setSelection(model.getFullModelRange());
  }));

  menu.appendChild(item('Select Line', '', () => {
    const line = ed.getPosition().lineNumber;
    ed.setSelection(new monaco.Range(line, 1, line + 1, 1));
  }));

  menu.appendChild(divider());

  // ── Code actions ──────────────────────────────────────────────
  menu.appendChild(item('Format Document', 'Shift+Alt+F', () => window.formatCode()));

  menu.appendChild(item('Comment Line', 'Ctrl+/', () => {
    ed.trigger('keyboard', 'editor.action.commentLine', null);
  }));

  menu.appendChild(item('Fold All', 'Ctrl+K Ctrl+0', () => {
    ed.trigger('keyboard', 'editor.foldAll', null);
  }));

  menu.appendChild(item('Unfold All', 'Ctrl+K Ctrl+J', () => {
    ed.trigger('keyboard', 'editor.unfoldAll', null);
  }));

  menu.appendChild(divider());

  // ── Word actions ──────────────────────────────────────────────
  menu.appendChild(item('Find', 'Ctrl+F', () => {
    ed.trigger('keyboard', 'actions.find', null);
  }));

  menu.appendChild(item('Replace', 'Ctrl+H', () => {
    ed.trigger('keyboard', 'editor.action.startFindReplaceAction', null);
  }));

  menu.appendChild(item('Go to Definition', 'F12', () => {
    ed.trigger('keyboard', 'editor.action.revealDefinition', null);
  }, false, !wordAtPos));

  menu.appendChild(item('Rename Symbol', 'F2', () => {
    ed.trigger('keyboard', 'editor.action.rename', null);
  }, false, !wordAtPos));

  menu.appendChild(divider());

  // ── File ──────────────────────────────────────────────────────
  menu.appendChild(item('Save', 'Ctrl+S', () => triggerManualSave(), false, !currentFile));

  menu.appendChild(item('Copy File Path', '', () => {
    if (currentFile) navigator.clipboard.writeText(currentFile).catch(() => {});
  }, false, !currentFile));

  // Position inside viewport
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = nativeEvent.clientX, y = nativeEvent.clientY;
  menu.classList.add('active');
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  if (x + mw > vw - 8) x = vw - mw - 8;
  if (y + mh > vh - 8) y = vh - mh - 8;
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

/* ── Context Menu Actions ──────────────────────────────────────── */

function ctxOpenToSide() {
  const { fullPath, handle } = currentContextItem;
  // Switch to editor2 and open the file there
  const ed2 = document.getElementById('editor2');
  if (ed2.style.display === 'none') toggleSplit();
  activeEditor = editor2;
  openFile(fullPath, handle);
}

function ctxReveal() {
  // Can't open the OS file explorer from the browser, so just highlight in the tree
  const { fullPath } = currentContextItem;
  printToOutput(`Reveal: ${fullPath}`, '#858585');
  // Scroll the file item into view in the sidebar
  const items = document.querySelectorAll('.file-item');
  for (const el of items) {
    if (el.title === fullPath || el.textContent.trim().includes(currentContextItem.name)) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.outline = '1px solid var(--accent)';
      setTimeout(() => el.style.outline = '', 1500);
      break;
    }
  }
}

let compareBase = null;
function ctxSelectForCompare() {
  compareBase = currentContextItem;
  printToOutput(`Selected for compare: ${currentContextItem.name}`, '#858585');
  printToTerminal(`> Select another file to compare with '${currentContextItem.name}'`, '#cbcb41');
}

async function ctxNewFile() {
  const { handle: dirHandle, fullPath, type, virtual, parentPath } = currentContextItem;
  const name = prompt('New file name:');
  if (!name) return;
  try {
    if (virtual) {
      const targetPath = type === 'directory' ? fullPath : (parentPath || fullPath.substring(0, fullPath.lastIndexOf('/')));
      await webcontainerInstance.fs.writeFile(`${targetPath}/${name}`, '');
      const treeRoot = document.getElementById('tree-root');
      if (treeRoot) { treeRoot.innerHTML = ''; await renderVirtualTree(`/${projectFolder.name}`, treeRoot); }
    } else {
      const targetDir = type === 'directory' ? dirHandle : currentContextItem.parentHandle;
      const fh = await targetDir.getFileHandle(name, { create: true });
      const w = await fh.createWritable(); await w.write(''); await w.close();
      await refreshTree(); refreshFileCache();
      const newPath = type === 'directory' ? `${fullPath}/${name}` : `${fullPath.substring(0, fullPath.lastIndexOf('/'))}/${name}`;
      openFile(newPath, fh);
    }
    printToOutput(`Created: ${name}`, '#89d185');
  } catch(e) { printToTerminal(`[Error] ${e.message}`, '#f48771'); }
}

async function ctxNewFolder() {
  const { handle: dirHandle, fullPath, type, virtual, parentPath } = currentContextItem;
  const name = prompt('New folder name:');
  if (!name) return;
  try {
    if (virtual) {
      const targetPath = type === 'directory' ? fullPath : (parentPath || fullPath.substring(0, fullPath.lastIndexOf('/')));
      await webcontainerInstance.fs.mkdir(`${targetPath}/${name}`);
      const treeRoot = document.getElementById('tree-root');
      if (treeRoot) { treeRoot.innerHTML = ''; await renderVirtualTree(`/${projectFolder.name}`, treeRoot); }
    } else {
      const targetDir = type === 'directory' ? dirHandle : currentContextItem.parentHandle;
      await targetDir.getDirectoryHandle(name, { create: true });
      await refreshTree(); refreshFileCache();
    }
    printToOutput(`Created folder: ${name}`, '#89d185');
  } catch(e) { printToTerminal(`[Error] ${e.message}`, '#f48771'); }
}

function ctxOpenInTerminal() {
  const { fullPath, type } = currentContextItem;
  const dir = type === 'directory' ? fullPath : fullPath.substring(0, fullPath.lastIndexOf('/'));
  if (shellWriter) {
    shellWriter.write(`cd "${dir}"\r`);
    printToOutput(`cd ${dir}`, '#858585');
  }
}

function ctxFindInFolder() {
  const { fullPath } = currentContextItem;
  openPalette('');
  const input = document.getElementById('palette-input');
  if (input) { input.value = fullPath + '/'; renderPaletteResults(); }
}

function ctxCut() {
  clipboardItem = { ...currentContextItem, isCut: true };
  printToOutput(`Cut: ${currentContextItem.name}`, '#858585');
}

function ctxCopy() {
  clipboardItem = { ...currentContextItem, isCut: false };
  printToOutput(`Copied: ${currentContextItem.name}`, '#858585');
}

async function ctxPaste() {
  if (!clipboardItem) return;
  const dest = currentContextItem;
  const pastedName = clipboardItem.name;

  try {
    if (clipboardItem.virtual) {
      // Virtual → virtual paste via WebContainer fs
      const targetPath = dest.type === 'directory' ? dest.fullPath : (dest.parentPath || dest.fullPath.substring(0, dest.fullPath.lastIndexOf('/')));
      const content = await webcontainerInstance.fs.readFile(clipboardItem.fullPath, 'utf-8');
      await webcontainerInstance.fs.writeFile(`${targetPath}/${pastedName}`, content);
      if (clipboardItem.isCut) {
        await webcontainerInstance.fs.rm(clipboardItem.fullPath);
        clipboardItem = null;
      }
      const treeRoot = document.getElementById('tree-root');
      if (treeRoot) { treeRoot.innerHTML = ''; await renderVirtualTree(`/${projectFolder.name}`, treeRoot); }
    } else {
      // Real disk paste via File System Access API
      const targetDir = dest.type === 'directory' ? dest.handle : dest.parentHandle;
      const file = await clipboardItem.handle.getFile();
      const content = await file.text();
      const newHandle = await targetDir.getFileHandle(pastedName, { create: true });
      const w = await newHandle.createWritable(); await w.write(content); await w.close();
      if (clipboardItem.isCut) {
        await clipboardItem.parentHandle.removeEntry(pastedName);
        clipboardItem = null;
      }
      await refreshTree(); refreshFileCache();
    }
    printToOutput(`Pasted: ${pastedName}`, '#89d185');
  } catch(e) { printToTerminal(`[Error] Paste: ${e.message}`, '#f48771'); }
}

function ctxCopyPath() {
  const { fullPath } = currentContextItem;
  navigator.clipboard.writeText(fullPath).catch(() => {});
  printToOutput(`Copied path: ${fullPath}`, '#858585');
}

function ctxCopyRelativePath() {
  const { fullPath } = currentContextItem;
  const rel = projectFolder ? fullPath.replace(projectFolder.name + '/', '') : fullPath;
  navigator.clipboard.writeText(rel).catch(() => {});
  printToOutput(`Copied relative path: ${rel}`, '#858585');
}

async function refreshTree() {
  const treeRoot = document.getElementById('tree-root');
  if (treeRoot && projectFolder) {
    treeRoot.innerHTML = '';
    await renderFileTree(projectFolder, treeRoot);
  }
}

async function deleteContextItem() {
  if(!currentContextItem) return;
  const { name, parentHandle, fullPath, type, virtual } = currentContextItem;
  
  if(!confirm(`Are you sure you want to delete '${name}'?`)) return;
  try {
    if (virtual) {
      await webcontainerInstance.fs.rm(fullPath, { recursive: true });
      const treeRoot = document.getElementById('tree-root');
      if (treeRoot) { treeRoot.innerHTML = ''; await renderVirtualTree(`/${projectFolder.name}`, treeRoot); }
    } else {
      await parentHandle.removeEntry(name, { recursive: type === 'directory' });
      await refreshTree(); refreshFileCache();
    }
    if(openFiles[fullPath]) {
      delete openFiles[fullPath];
      if(currentFile1 === fullPath) { currentFile1 = null; isProgrammaticEdit = true; editor1.setValue(''); isProgrammaticEdit = false; }
      if(currentFile2 === fullPath) { currentFile2 = null; isProgrammaticEdit = true; editor2.setValue(''); isProgrammaticEdit = false; }
      renderTabs();
    }
    printToOutput(`Deleted: ${name}`, '#89d185');
  } catch(e) {
    printToTerminal(`[Error] Deleting: ${e.message}`, '#f48771');
  }
}

async function renameContextItem() {
  if(!currentContextItem) return;
  const { name, handle, parentHandle, fullPath, type, virtual } = currentContextItem;

  const newName = prompt(`Rename '${name}' to:`, name);
  if(!newName || newName === name) return;

  try {
    if (virtual) {
      const parentPath = fullPath.substring(0, fullPath.lastIndexOf('/'));
      const newPath = `${parentPath}/${newName}`;
      if (type === 'file') {
        const content = await webcontainerInstance.fs.readFile(fullPath, 'utf-8');
        await webcontainerInstance.fs.writeFile(newPath, content);
        await webcontainerInstance.fs.rm(fullPath);
        if (openFiles[fullPath]) {
          openFiles[newPath] = { ...openFiles[fullPath] };
          delete openFiles[fullPath];
          if(currentFile1 === fullPath) currentFile1 = newPath;
          if(currentFile2 === fullPath) currentFile2 = newPath;
          renderTabs();
        }
      } else {
        printToTerminal('[System] Renaming folders in the virtual tree is not yet supported.', '#f48771');
        return;
      }
      const treeRoot = document.getElementById('tree-root');
      if (treeRoot) { treeRoot.innerHTML = ''; await renderVirtualTree(`/${projectFolder.name}`, treeRoot); }
    } else {
      if(type === 'directory') {
        printToTerminal('[System] Renaming folders is not supported yet.', '#f48771');
        return;
      }
      const file = await handle.getFile();
      const content = await file.text();
      const newHandle = await parentHandle.getFileHandle(newName, { create: true });
      const writable = await newHandle.createWritable();
      await writable.write(content); await writable.close();
      await parentHandle.removeEntry(name);
      if(openFiles[fullPath]) {
        const newPath = fullPath.substring(0, fullPath.lastIndexOf('/') + 1) + newName;
        openFiles[newPath] = { handle: newHandle, content, unsaved: openFiles[fullPath].unsaved };
        delete openFiles[fullPath];
        if(currentFile1 === fullPath) currentFile1 = newPath;
        if(currentFile2 === fullPath) currentFile2 = newPath;
      }
      await refreshTree(); refreshFileCache(); renderTabs();
    }
    printToOutput(`Renamed '${name}' → '${newName}'`, '#89d185');
  } catch(e) {
    printToTerminal(`[Error] Renaming: ${e.message}`, '#f48771');
  }
}

/* LANGUAGE HELPERS */
function getLanguageForFile(filename) {
  if (filename.endsWith('.html') || filename.endsWith('.htm')) return 'html';
  if (filename.endsWith('.css') || filename.endsWith('.scss') || filename.endsWith('.less')) return 'css';
  if (filename.endsWith('.json')) return 'json';
  if (filename.endsWith('.ts') || filename.endsWith('.tsx')) return 'typescript';
  if (filename.endsWith('.js') || filename.endsWith('.jsx') || filename.endsWith('.mjs') || filename.endsWith('.cjs')) return 'javascript';
  if (filename.endsWith('.md') || filename.endsWith('.markdown')) return 'markdown';
  if (filename.endsWith('.py')) return 'python';
  if (filename.endsWith('.yaml') || filename.endsWith('.yml')) return 'yaml';
  if (filename.endsWith('.xml') || filename.endsWith('.svg')) return 'xml';
  if (filename.endsWith('.sh') || filename.endsWith('.bash')) return 'shell';
  if (filename.endsWith('.sql')) return 'sql';
  return 'plaintext';
}

/* FILE ICONS — VS Code style: document shape + colored label */

// Each icon is a consistent page/document shape with a folded corner,
// colored to match VS Code's Material Icon Theme color palette.
// Labels are short text badges drawn on the document face.

function _docIcon(labelText, labelColor, bgColor = '#1e1e1e', foldColor = null) {
  const fold = foldColor || labelColor;
  return `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9L13 2z" fill="${bgColor}" stroke="${labelColor}" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M13 2v7h7" fill="none" stroke="${fold}" stroke-width="1.2" stroke-linejoin="round"/>
    <text x="12" y="17" text-anchor="middle" font-family="Segoe UI,system-ui,sans-serif" font-size="6" font-weight="700" fill="${labelColor}">${labelText}</text>
  </svg>`;
}

function _folderIcon(color, isOpen, label = '') {
  if (isOpen) {
    return `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V9a2 2 0 012-2h5l2 2h9a2 2 0 012 2v8z" fill="${color}" opacity=".25"/>
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V9a2 2 0 012-2h5l2 2h9a2 2 0 012 2v8z" stroke="${color}" stroke-width="1.4" fill="none"/>
      <path d="M2 13h20" stroke="${color}" stroke-width="1.2" opacity=".6"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" fill="${color}" opacity=".2"/>
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" stroke="${color}" stroke-width="1.4" fill="none"/>
  </svg>`;
}

function getFileIcon(filename) {
  const lower = filename.toLowerCase();
  const ext   = lower.includes('.') ? lower.split('.').pop() : '';

  // ── Special full filenames ────────────────────────────────────
  if (lower === 'package.json')         return _icon(_docIcon('pkg',  '#e8c84a'));
  if (lower === 'package-lock.json')    return _icon(_docIcon('lock', '#bbbbbb'));
  if (lower === 'yarn.lock')            return _icon(_docIcon('lock', '#bbbbbb'));
  if (lower === 'pnpm-lock.yaml')       return _icon(_docIcon('lock', '#bbbbbb'));
  if (lower === '.gitignore' || lower === '.gitattributes')
                                        return _icon(_docIcon('git',  '#f05133'));
  if (lower === '.env' || lower.startsWith('.env.'))
                                        return _icon(_docIcon('env',  '#ecd53f'));
  if (lower === 'dockerfile')           return _icon(_docIcon('dock', '#2496ed'));
  if (lower === 'readme.md')            return _icon(_docIcon('md',   '#519aba'));
  if (lower === 'license' || lower === 'licence')
                                        return _icon(_docIcon('law',  '#88aacc'));
  if (lower.startsWith('vite.config')) return _icon(_docIcon('vite', '#bd34fe'));
  if (lower.startsWith('next.config')) return _icon(_docIcon('next', '#ffffff'));
  if (lower.startsWith('tailwind.config')) return _icon(_docIcon('tw', '#38bdf8'));
  if (lower.startsWith('tsconfig'))    return _icon(_docIcon('ts',   '#3178c6'));
  if (lower.startsWith('jest.config')) return _icon(_docIcon('jest', '#c21325'));
  if (lower.startsWith('.eslint'))     return _icon(_docIcon('es',   '#8080f2'));
  if (lower.startsWith('.prettier'))   return _icon(_docIcon('fmt',  '#f7b93e'));
  if (lower.startsWith('.babel'))      return _icon(_docIcon('bbl',  '#f5da55'));

  // ── Extensions ───────────────────────────────────────────────
  switch (ext) {
    // JavaScript
    case 'js': case 'mjs': case 'cjs':
      return _icon(_docIcon('JS', '#e8c84a'));
    case 'jsx':
      return _icon(_docIcon('JSX', '#61dafb'));
    // TypeScript
    case 'ts':
      return _icon(_docIcon('TS', '#3178c6'));
    case 'tsx':
      return _icon(_docIcon('TSX', '#3178c6'));
    // Web
    case 'html': case 'htm':
      return _icon(_docIcon('HTM', '#e44d26'));
    case 'css':
      return _icon(_docIcon('CSS', '#264de4'));
    case 'scss':
      return _icon(_docIcon('SCss', '#cd6799'));
    case 'less':
      return _icon(_docIcon('LESS', '#1d5fa6'));
    case 'svg':
      return _icon(_docIcon('SVG', '#ffb13b'));
    // Data
    case 'json': case 'jsonc':
      return _icon(_docIcon('JSON', '#cbcb41'));
    case 'yaml': case 'yml':
      return _icon(_docIcon('YML', '#cc1018'));
    case 'toml':
      return _icon(_docIcon('TOML', '#9c4221'));
    case 'xml':
      return _icon(_docIcon('XML', '#f06529'));
    case 'csv':
      return _icon(_docIcon('CSV', '#89d185'));
    case 'sql':
      return _icon(_docIcon('SQL', '#dad8a7'));
    // Docs
    case 'md': case 'markdown':
      return _icon(_docIcon('MD', '#519aba'));
    case 'txt':
      return _icon(_docIcon('TXT', '#aaaaaa'));
    case 'pdf':
      return _icon(_docIcon('PDF', '#e44d26'));
    // Config
    case 'env':
      return _icon(_docIcon('ENV', '#ecd53f'));
    case 'ini': case 'cfg': case 'conf':
      return _icon(_docIcon('CFG', '#6d8086'));
    case 'lock':
      return _icon(_docIcon('LCK', '#bbbbbb'));
    // Scripts
    case 'sh': case 'bash': case 'zsh':
      return _icon(_docIcon('SH', '#4eaa25'));
    case 'ps1':
      return _icon(_docIcon('PS', '#5391fe'));
    case 'bat': case 'cmd':
      return _icon(_docIcon('BAT', '#c1f12e'));
    // Languages
    case 'py':
      return _icon(_docIcon('PY', '#4b8bbe'));
    case 'rb':
      return _icon(_docIcon('RB', '#cc342d'));
    case 'php':
      return _icon(_docIcon('PHP', '#8892be'));
    case 'go':
      return _icon(_docIcon('GO', '#00aed8'));
    case 'rs':
      return _icon(_docIcon('RS', '#dea584'));
    case 'java':
      return _icon(_docIcon('JAV', '#b07219'));
    case 'kt': case 'kts':
      return _icon(_docIcon('KT', '#7f52ff'));
    case 'swift':
      return _icon(_docIcon('SW', '#f05138'));
    case 'c':
      return _icon(_docIcon('C', '#a8b9cc'));
    case 'cpp': case 'cc': case 'cxx':
      return _icon(_docIcon('C++', '#659ad2'));
    case 'cs':
      return _icon(_docIcon('C#', '#9b4f96'));
    case 'lua':
      return _icon(_docIcon('LUA', '#000080'));
    case 'r':
      return _icon(_docIcon('R', '#2266b8'));
    // Frameworks
    case 'vue':
      return _icon(_docIcon('VUE', '#42b883'));
    case 'astro':
      return _icon(_docIcon('AST', '#ff5d01'));
    case 'svelte':
      return _icon(_docIcon('SV', '#ff3e00'));
    case 'prisma':
      return _icon(_docIcon('PRS', '#5a67d8'));
    // Images
    case 'png': case 'jpg': case 'jpeg':
    case 'gif': case 'webp': case 'ico': case 'bmp':
      return _icon(_docIcon('IMG', '#a074c4'));
    // Fonts
    case 'ttf': case 'woff': case 'woff2': case 'otf':
      return _icon(_docIcon('FNT', '#dd4949'));
    // Archives
    case 'zip': case 'tar': case 'gz': case 'rar':
      return _icon(_docIcon('ZIP', '#888888'));
    // Video / Audio
    case 'mp4': case 'webm': case 'mov':
      return _icon(_docIcon('VID', '#d34f4f'));
    case 'mp3': case 'wav': case 'ogg':
      return _icon(_docIcon('AUD', '#c158dc'));
    default:
      return _icon(_docIcon('', '#6d8086'));
  }
}

// Wrap SVG in the icon span
function _icon(svg) {
  return `<span class="file-icon-svg">${svg}</span>`;
}

function getFolderIcon(name, isOpen = false) {
  const lower = (name || '').toLowerCase();
  // Named folder colors matching VS Code Material Icon Theme
  const colors = {
    'src': '#7cb4e0',      'source': '#7cb4e0',
    'app': '#7cb4e0',      'pages': '#7cb4e0',
    'public': '#78d97a',   'static': '#78d97a',  'assets': '#78d97a',
    'images': '#a074c4',   'img': '#a074c4',      'icons': '#a074c4',
    'styles': '#cd6799',   'css': '#cd6799',      'scss': '#cd6799',
    'components': '#7eb8d4', 'comp': '#7eb8d4',   'ui': '#7eb8d4',
    'hooks': '#cbcb41',    'utils': '#cbcb41',    'helpers': '#cbcb41',
    'lib': '#cbcb41',      'libs': '#cbcb41',
    'dist': '#e8a97a',     'build': '#e8a97a',    'out': '#e8a97a',
    'node_modules': '#5a9e5a',
    'tests': '#e07070',    'test': '#e07070',     '__tests__': '#e07070',
    'docs': '#519aba',     'doc': '#519aba',
    'api': '#89d185',      'routes': '#89d185',   'server': '#89d185',
    'config': '#6d8086',   'configs': '#6d8086',  '.github': '#888888',
    'store': '#bd34fe',    'redux': '#bd34fe',     'context': '#bd34fe',
    'types': '#3178c6',    'interfaces': '#3178c6',
  };
  const color = colors[lower] || '#dcb67a'; // default folder gold
  return `<span class="file-icon-svg">${_folderIcon(color, isOpen)}</span>`;
}


/* MONACO INIT (DUAL EDITORS) */
require.config({ paths: { vs: "https://unpkg.com/monaco-editor@0.45.0/min/vs" } });
require(["vs/editor/editor.main"], function () {
  const commonConfig = {
    language: "javascript",
    theme: "vs-dark",
    automaticLayout: true,
    minimap: { enabled: true },
    contextmenu: false  // disable Monaco's built-in right-click menu
  };
  
  editor1 = monaco.editor.create(document.getElementById("editor1"), { value: "// Editor 1\n// Open a folder to start", ...commonConfig });
  editor2 = monaco.editor.create(document.getElementById("editor2"), { value: "// Editor 2", ...commonConfig });

  // Sync minimap check mark with default enabled state
  const minimapCheck = document.getElementById('minimap-check');
  if (minimapCheck) minimapCheck.style.opacity = '1';

  // Shift + Alt + F to Format
  editor1.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => window.formatCode());
  editor2.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => window.formatCode());
  activeEditor = editor1;

  editor1.onDidFocusEditorText(() => { activeEditor = editor1; });
  editor2.onDidFocusEditorText(() => { activeEditor = editor2; });

  const updateCursor = (e) => {
    document.getElementById("cursor-position").innerText = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  };
  editor1.onDidChangeCursorPosition(updateCursor);
  editor2.onDidChangeCursorPosition(updateCursor);

  editor1.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, triggerManualSave);
  editor2.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, triggerManualSave);

  // Custom right-click menu for both editor panes
  [editor1, editor2].forEach(ed => {
    ed.onContextMenu((e) => {
      const nativeEvent = e.event.browserEvent;
      nativeEvent.preventDefault();
      nativeEvent.stopPropagation();
      showEditorContextMenu(nativeEvent, ed);
    });
  });

  const setupChangeListener = (ed, paneNumber) => {
    ed.onDidChangeModelContent(() => {
      if (isProgrammaticEdit) return;
      const fileToSave = paneNumber === 1 ? currentFile1 : currentFile2;
      
      if(fileToSave && openFiles[fileToSave]) {
        openFiles[fileToSave].content = ed.getValue();
        if (!openFiles[fileToSave].unsaved) {
          openFiles[fileToSave].unsaved = true;
          renderTabs();
        }
        clearTimeout(saveTimeout);
        if (autoSaveEnabled) {
          saveTimeout = setTimeout(() => { saveFile(fileToSave, ed.getValue()); }, 1000);
        }
      }
    });
  };

  setupChangeListener(editor1, 1);
  setupChangeListener(editor2, 2);

  // Apply saved theme (must run after Monaco is ready)
  initThemes();
  // Apply saved editor settings
  initSettings();
});

function triggerManualSave() {
  const currentFile = activeEditor === editor1 ? currentFile1 : currentFile2;
  if(currentFile) {
    clearTimeout(saveTimeout);
    saveFile(currentFile, activeEditor.getValue());
    printToTerminal(`[System] File manually saved: ${currentFile}`, "#89d185");
  }
}

/* OPEN FOLDER */
async function openFolder() {
  try {
    projectFolder = await window.showDirectoryPicker({ mode: "readwrite" });
    const _sb1 = document.getElementById('search-bar-text'); if(_sb1) _sb1.textContent = projectFolder.name;
    
    // 1. Grab your main tree container
    const tree = document.getElementById("fileTree");
    
    // 2. Set up your nice folder title and create the empty root div
    tree.innerHTML = `
  <div class="folder-title" onclick="toggleRootFolder()" style="cursor: pointer; user-select: none;">
    <span id="root-arrow">˅</span> ${projectFolder.name}
  </div>
  <div id="tree-root"></div>
`;
    // 3. Grab that newly created root div
    const treeRoot = document.getElementById("tree-root");
    
    // 4. Trigger the new recursive tree function directly into treeRoot!
    // (This replaces your old await loadFolder(...) line)
    await renderFileTree(projectFolder, treeRoot);
    refreshFileCache();
    
    if(window.innerWidth <= 768) toggleSidebar();

    // Save the state AFTER the folder is successfully opened!
    saveWorkspaceState();
    startWebContainer()
    
  } catch (err) {
    if (err.name === 'AbortError') {
      printToTerminal("Folder selection cancelled.", "#858585");
    } else {
      printToTerminal(`[Error] Could not open folder: ${err.message}`, "#f48771");
      console.error(err);
    }
  }
}

// Close palette if clicking outside
document.addEventListener('mousedown', (e) => {
  const palette = document.getElementById("command-palette");
  const searchBar = document.querySelector(".search-bar");
  
  if (palette.style.display === "flex" && 
      !palette.contains(e.target) && 
      !searchBar.contains(e.target)) {
    closePalette();
  }
});


/* OPEN FILE */
async function openFile(fullPath, handle) {
  try {
    // Check if Monaco Editor actually loaded
    if (!activeEditor) {
      printToTerminal("Error: Code editor failed to load. Are you using a local server?", "#f48771");
      return;
    }

    if (openFiles[fullPath]) { switchTab(fullPath); return; }
    
    const currentFile = activeEditor === editor1 ? currentFile1 : currentFile2;
    if (currentFile) {
      clearTimeout(saveTimeout);
      await saveFile(currentFile, activeEditor.getValue());
    }

    const file = await handle.getFile();
    const text = await file.text();
    
    openFiles[fullPath] = { handle, content:text, unsaved: false };
    
    if (activeEditor === editor1) currentFile1 = fullPath;
    else currentFile2 = fullPath;
    
    isProgrammaticEdit = true; 
    activeEditor.setValue(text);
    isProgrammaticEdit = false; 
    
    const lang = getLanguageForFile(fullPath);
    monaco.editor.setModelLanguage(activeEditor.getModel(), lang);
    document.getElementById("status-lang").innerText = lang.charAt(0).toUpperCase() + lang.slice(1);
    renderTabs();
    
    if(window.innerWidth <= 768) toggleSidebar();
    
  } catch (err) {
    printToTerminal(`[Error] Could not open file: ${err.message}`, "#f48771");
    console.error(err);
  }
}

/* CREATE FILE */
async function createFile() {
  if(!projectFolder) { printToTerminal("Please open a folder first.", "#f48771"); return; }
  const name = prompt("File name (e.g., style.css, index.html):");
  if(!name) return;

  try {
    const fileHandle = await projectFolder.getFileHandle(name, { create:true });
    const writable = await fileHandle.createWritable();
    await writable.write("");
    await writable.close();
    
    // Refresh the UI
    const treeRoot = document.getElementById("tree-root");
    if (treeRoot) {
      treeRoot.innerHTML = ""; 
      await renderFileTree(projectFolder, treeRoot); 
    }
    
    // Update the search cache so the new file shows up in Ctrl+P
    refreshFileCache();
    
    printToTerminal(`Created file: ${name}`, "#89d185");
    openFile(name, fileHandle);
  } catch (err) {
    printToTerminal(`Error creating file: ${err.message}`, "#f48771");
  }
}

const term = new Terminal({
  theme: {
    background: '#181818', 
    foreground: '#cccccc', 
    cursor: '#007acc',     
    selectionBackground: 'rgba(255, 255, 255, 0.3)'
  },
  fontFamily: "'Courier New', monospace",
  fontSize: 13,
  cursorBlink: true
});

// 2. Load the Fit Addon so it resizes properly
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);

// 3. Attach it to the screen
term.open(document.getElementById('terminal-output'));
fitAddon.fit();

// Custom key handler — runs inside xterm before any default processing.
// Returning false tells xterm "I handled this, don't do anything else".
// Returning true tells xterm "handle it normally".
term.attachCustomKeyEventHandler((e) => {
  const isCmdOrCtrl = e.ctrlKey || e.metaKey;

  // ── Ctrl+V / Cmd+V → Paste ────────────────────────────────────────────────
  // The DOM 'paste' event never fires for Ctrl+V when xterm has focus because
  // xterm absorbs keyboard events. We read the clipboard API directly instead.
  if (isCmdOrCtrl && e.key === 'v' && e.type === 'keydown') {
    navigator.clipboard.readText().then((text) => {
      if (!text) return;
      if (shellWriter) {
        shellWriter.write(text);
      } else {
        term.write(text);
      }
    }).catch(() => {
      // Clipboard API blocked (e.g. no HTTPS) — fall through to the OS paste
      // which will trigger the right-click 'paste' DOM event as a fallback
    });
    return false; // prevent xterm from typing a literal 'v'
  }

  // ── Ctrl+C / Cmd+C → Smart copy OR SIGINT ────────────────────────────────
  // If the user has text selected in the terminal: copy it to the clipboard.
  // If nothing is selected: send SIGINT (0x03) to kill the running process.
  if (isCmdOrCtrl && e.key === 'c' && e.type === 'keydown') {
    const selection = term.getSelection();
    if (selection) {
      navigator.clipboard.writeText(selection).catch(() => {});
      term.clearSelection();
      return false; // copied — don't also send SIGINT
    }
    // Nothing selected — let xterm send \x03 (SIGINT) to the shell naturally
    return true;
  }

  return true; // all other keys: let xterm handle normally
});

// Right-click paste fallback — still works if Clipboard API is unavailable
document.getElementById('terminal-output').addEventListener('paste', (e) => {
  e.preventDefault();
  const text = e.clipboardData.getData('text');
  if (!text) return;
  if (shellWriter) {
    shellWriter.write(text);
  } else {
    term.write(text);
  }
});

// Update the initial welcome message
term.write('\x1b[1;34mVSCode Online\x1b[0m v1.0.0\r\n');

// 6. Make sure it resizes when the browser window changes
window.addEventListener('resize', () => {
  fitAddon.fit();
});

/* SIDEBAR DRAG-TO-RESIZE */
(function() {
  const handle  = document.getElementById('sidebar-resize-handle');
  const sidebar = document.getElementById('sidebar');

  const MIN_WIDTH   = 198; // minimum visible width — sidebar won't shrink below this
  const MAX_WIDTH   = 1200;
  const COLLAPSE_AT = MIN_WIDTH / 2; // extra drag distance past MIN before collapsing
  const OPEN_ZONE   = 60;  // how far right you must drag from collapsed to re-open

  let isCollapsed = false;

  function applyCollapsed() {
    sidebar.style.width    = '0px';
    sidebar.style.overflow = 'hidden';
    handle.classList.add('collapsed');
    isCollapsed = true;
  }

  function applyExpanded(width) {
    sidebar.style.overflow = '';
    sidebar.style.width    = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)) + 'px';
    handle.classList.remove('collapsed');
    isCollapsed = false;
  }

  // Expose for Ctrl+B / View menu — works on both mobile and desktop
  window._sidebarToggle = () => {
    if (window.innerWidth <= 768) {
      sidebar.classList.toggle('open');
    } else {
      isCollapsed ? applyExpanded(250) : applyCollapsed();
    }
  };

  const HOVER_DELAY = 400;
  let hoverTimer = null;
  handle.addEventListener('mouseenter', () => {
    hoverTimer = setTimeout(() => handle.classList.add('hovered'), HOVER_DELAY);
  });
  handle.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    handle.classList.remove('hovered');
  });

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();

    // Freeze all transitions during drag so width tracks mouse exactly
    sidebar.style.transition = 'none';
    handle.style.transition  = 'none';

    const startX     = e.clientX;
    const startWidth = isCollapsed ? 0 : sidebar.getBoundingClientRect().width;
    const wasCollapsed = isCollapsed;

    handle.classList.add('dragging');
    document.body.style.cursor     = 'ew-resize';
    document.body.style.userSelect = 'none';

    function onMouseMove(e) {
      const delta  = e.clientX - startX;
      const target = startWidth + delta;

      if (!wasCollapsed) {
        if (target < MIN_WIDTH - COLLAPSE_AT) {
          // Dragged far enough past MIN_WIDTH — snap closed
          if (!isCollapsed) applyCollapsed();
        } else {
          // Hold visual width at MIN_WIDTH, don't compress below it
          if (isCollapsed) applyExpanded(MIN_WIDTH);
          sidebar.style.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, target)) + 'px';
        }
      } else {
        // Was collapsed at drag start — need OPEN_ZONE px of rightward motion to open
        if (delta > OPEN_ZONE) {
          if (isCollapsed) applyExpanded(MIN_WIDTH + (delta - OPEN_ZONE));
          else sidebar.style.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, MIN_WIDTH + (delta - OPEN_ZONE))) + 'px';
        }
      }
    }

    function onMouseUp() {
      // Restore transitions after drag ends
      sidebar.style.transition = '';
      handle.style.transition  = '';
      handle.classList.remove('dragging');
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup',   onMouseUp);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
  });
})();


(function() {
  const handle   = document.getElementById('terminal-resize-handle');
  const terminal = document.getElementById('terminal-container');
  const appMain  = document.querySelector('.app-main');

  const MIN_HEIGHT  = 120;  // terminal won't shrink below this
  const MAX_RATIO   = 0.85;
  const COLLAPSE_AT = MIN_HEIGHT / 2; // extra drag past MIN before collapsing
  const OPEN_ZONE   = 60;   // upward drag needed to re-expand

  let isCollapsed = true;

  function applyCollapsed() {
    terminal.style.height = '0px';
    terminal.style.overflow = 'hidden';
    handle.classList.add('collapsed');
    isCollapsed = true;
    fitAddon.fit();
  }

  function applyExpanded(height) {
    terminal.style.overflow = '';
    terminal.style.height = Math.max(MIN_HEIGHT, height) + 'px';
    handle.classList.remove('collapsed');
    isCollapsed = false;
    setTimeout(() => fitAddon.fit(), 50);
  }

  // Start collapsed — user must open via Terminal menu
  applyCollapsed();

  // Expose for Ctrl+B and View menu
  window.openTerminal  = () => { if (isCollapsed) applyExpanded(220); };
  window.closeTerminal = () => { if (!isCollapsed) applyCollapsed(); };
  window.toggleTerminal = () => { isCollapsed ? applyExpanded(220) : applyCollapsed(); };

  const HOVER_DELAY = 400;
  let hoverTimer = null;
  handle.addEventListener('mouseenter', () => {
    hoverTimer = setTimeout(() => handle.classList.add('hovered'), HOVER_DELAY);
  });
  handle.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    handle.classList.remove('hovered');
  });

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();

    // Freeze transitions during drag
    terminal.style.transition = 'none';
    handle.style.transition   = 'none';

    const startY      = e.clientY;
    const startHeight = isCollapsed ? 0 : terminal.getBoundingClientRect().height;
    const wasCollapsed = isCollapsed;

    handle.classList.add('dragging');
    document.body.style.cursor     = 'ns-resize';
    document.body.style.userSelect = 'none';

    function onMouseMove(e) {
      const delta  = startY - e.clientY; // drag up = bigger terminal
      const target = startHeight + delta;
      const maxHeight = appMain.getBoundingClientRect().height * MAX_RATIO;

      if (!wasCollapsed) {
        if (target < MIN_HEIGHT - COLLAPSE_AT) {
          if (!isCollapsed) applyCollapsed();
        } else {
          if (isCollapsed) applyExpanded(MIN_HEIGHT);
          terminal.style.height = Math.min(maxHeight, Math.max(MIN_HEIGHT, target)) + 'px';
          fitAddon.fit();
        }
      } else {
        if (delta > OPEN_ZONE) {
          if (isCollapsed) applyExpanded(MIN_HEIGHT + (delta - OPEN_ZONE));
          else {
            terminal.style.height = Math.min(maxHeight, Math.max(MIN_HEIGHT, MIN_HEIGHT + (delta - OPEN_ZONE))) + 'px';
            fitAddon.fit();
          }
        }
      }
    }

    function onMouseUp() {
      terminal.style.transition = '';
      handle.style.transition   = '';
      handle.classList.remove('dragging');
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      fitAddon.fit();
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup',   onMouseUp);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
  });
})();



/* RESOLVE REAL DISK HANDLE FROM VIRTUAL PATH
   Virtual files opened from the WebContainer tree have handle: null.
   This walks the real projectFolder using the file's path to get a
   writable File System Access API handle so we can save back to disk. */
async function resolveRealHandle(path) {
  if (!projectFolder) return null;
  try {
    // Path may start with /projectName/ or just be relative — normalise it
    let parts = path.replace(/^\//, '').split('/');
    // If the first segment matches the project folder name, strip it
    if (parts[0] === projectFolder.name) parts = parts.slice(1);

    let dir = projectFolder;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    return await dir.getFileHandle(parts[parts.length - 1]);
  } catch {
    return null; // file doesn't exist on disk (e.g. generated by npm)
  }
}

/* MASTER SAVE */
async function saveFile(path, content) {
  try {
    const data = openFiles[path];
    if (!data) return;

    if (data.handle === null) {
      // Virtual file — try to write back to real disk first,
      // then sync to WebContainer memory so the dev server sees the change
      try {
        isSyncingFile = true;

        // Attempt to resolve and write to the real file on disk
        const realHandle = await resolveRealHandle(path);
        if (realHandle) {
          const writable = await realHandle.createWritable();
          await writable.write(content);
          await writable.close();
          // Upgrade the in-memory entry so future saves use the handle directly
          data.handle = realHandle;
        }

        // Always also update WebContainer memory so the dev server hot-reloads
        if (webcontainerInstance) {
          await webcontainerInstance.fs.writeFile(path, content);
        }

        data.content = content;
        data.unsaved = false;
        renderTabs();
        updatePreviewIfOpen();
      } finally {
        isSyncingFile = false;
      }
      return;
    }

    // Normal local file — write through the File System Access API handle
    const writable = await data.handle.createWritable();
    await writable.write(content);
    await writable.close();
    
    data.unsaved = false;
    renderTabs();

    // Also sync to WebContainer so the dev server sees the change
    if (webcontainerInstance) {
      try {
        isSyncingFile = true;
        const containerPath = `/${projectFolder.name}/${path}`;
        await webcontainerInstance.fs.writeFile(containerPath, content);
      } catch (wcErr) {
        console.warn("Could not sync file to WebContainer:", wcErr);
      } finally {
        isSyncingFile = false;
      }
    }

    updatePreviewIfOpen();
    
  } catch (err) {
    printToTerminal(`[Error] Could not save ${path}: ${err.message}`, "#f48771");
  }
}


/* TABS */
function renderTabs() {
  const tabs = document.getElementById("tabs");
  tabs.innerHTML = "";
  
  for(let fullPath in openFiles){
    const tab = document.createElement("div");
    tab.className = "tab";
    
    if(fullPath === currentFile1 || fullPath === currentFile2) tab.classList.add("active");
    if(openFiles[fullPath].unsaved) tab.classList.add("unsaved");
    tab.title = fullPath; 

    const fileName = fullPath.split('/').pop();
    tab.innerHTML = getFileIcon(fileName) + `<span class="tab-name" style="margin-left: 4px;">${fileName}</span>`;

    const closeBtn = document.createElement("span");
    closeBtn.textContent = "×";
    closeBtn.className = "close";
    closeBtn.onclick = (e) => { e.stopPropagation(); closeTab(fullPath); };
    tab.appendChild(closeBtn);

    tab.onclick = () => switchTab(fullPath);
    tabs.appendChild(tab);
  }

  const hasTabs = Object.keys(openFiles).length > 0;
  tabs.classList.toggle('tabs-visible', hasTabs);
  updateBreadcrumb();
}

function updateBreadcrumb() {
  const bc = document.getElementById('breadcrumb');
  if (!bc) return;
  const currentFile = activeEditor === editor1 ? currentFile1 : currentFile2;
  if (!currentFile) { bc.innerHTML = ''; return; }

  const parts = currentFile.split('/');
  bc.innerHTML = parts.map((part, i) => {
    const isLast = i === parts.length - 1;
    const sep = i > 0 ? `<span class="breadcrumb-sep">›</span>` : '';
    return `${sep}<span class="breadcrumb-item">${part}</span>`;
  }).join('');
}

/* WORKSPACE STATE MANAGEMENT */
async function saveWorkspaceState() {
  if (!projectFolder) return;
  // Save the folder "bookmark" to IndexedDB
  await idbKeyval.set('workspaceHandle', projectFolder);
  
  // Save the list of open files and active tabs to LocalStorage
  const sessionData = {
    openPaths: Object.keys(openFiles),
    file1: currentFile1,
    file2: currentFile2
  };
  localStorage.setItem('workspaceSession', JSON.stringify(sessionData));
}

// A standard browser helper to ask for permission to use the saved handle
async function verifyPermission(fileHandle, readWrite) {
  const options = { mode: readWrite ? 'readwrite' : 'read' };
  if ((await fileHandle.queryPermission(options)) === 'granted') return true;
  if ((await fileHandle.requestPermission(options)) === 'granted') return true;
  return false;
}
async function switchTab(fullPath){
  // NEW: Guard to prevent crashes if Monaco hasn't loaded
  if (!activeEditor) {
    printToTerminal("Hold on! The editor is still loading in the background.", "#cbcb41");
    return;
  }

  if (activeEditor === editor1 && currentFile1 === fullPath) return; 
  if (activeEditor === editor2 && currentFile2 === fullPath) return; 

  const currentFile = activeEditor === editor1 ? currentFile1 : currentFile2;
  if (currentFile) {
    clearTimeout(saveTimeout);
    await saveFile(currentFile, activeEditor.getValue());
  }

  if (activeEditor === editor1) currentFile1 = fullPath;
  else currentFile2 = fullPath;

  isProgrammaticEdit = true;
  activeEditor.setValue(openFiles[fullPath].content);
  isProgrammaticEdit = false;
  
  const lang = getLanguageForFile(fullPath);
  monaco.editor.setModelLanguage(activeEditor.getModel(), lang);
  document.getElementById("status-lang").innerText = lang.charAt(0).toUpperCase() + lang.slice(1);
  renderTabs();
}

async function closeTab(fullPath){
  // If there are unsaved changes, ask before discarding them
  if (openFiles[fullPath]?.unsaved) {
    const fileName = fullPath.split('/').pop();
    const choice = confirm(`'${fileName}' has unsaved changes.\n\nSave before closing?`);
    if (choice) {
      // Save then close
      const content = currentFile1 === fullPath ? editor1.getValue()
                    : currentFile2 === fullPath ? editor2.getValue()
                    : openFiles[fullPath].content;
      await saveFile(fullPath, content);
    }
    // If they clicked Cancel (false) we still close — just discard changes
  }

  delete openFiles[fullPath];
  
  if(currentFile1 === fullPath) {
    currentFile1 = null;
    isProgrammaticEdit = true;
    editor1.setValue("");
    isProgrammaticEdit = false;
  }
  if(currentFile2 === fullPath) {
    currentFile2 = null;
    isProgrammaticEdit = true;
    editor2.setValue("");
    isProgrammaticEdit = false;
  }
  
  renderTabs();
  document.getElementById("cursor-position").innerText = "Ln 1, Col 1";
}

function printToTerminal(text, color = "default") {
  let colorCode = "\x1b[37m"; 
  if (color === "#f48771") colorCode = "\x1b[31m"; 
  if (color === "#89d185") colorCode = "\x1b[32m"; 
  if (color === "#569cd6") colorCode = "\x1b[34m"; 
  if (color === "#cbcb41") colorCode = "\x1b[33m"; 
  if (color === "#858585") colorCode = "\x1b[90m";

  const formattedText = String(text).replace(/\n/g, '\r\n');
  term.write(`\r\n${colorCode}${formattedText}\x1b[0m\r\n`);

  // Also log to the Output pane
  printToOutput(text, color);
}

function printToOutput(text, color = "default") {
  const log = document.getElementById('output-log');
  if (!log) return;
  const line = document.createElement('div');
  line.style.padding = '1px 0';
  line.style.whiteSpace = 'pre-wrap';
  line.style.wordBreak = 'break-all';
  if (color === "#f48771") line.style.color = '#f48771';
  else if (color === "#89d185") line.style.color = '#89d185';
  else if (color === "#569cd6") line.style.color = '#569cd6';
  else if (color === "#cbcb41") line.style.color = '#cbcb41';
  else if (color === "#858585") line.style.color = '#858585';
  else line.style.color = 'var(--text-main)';
  line.textContent = String(text);
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function switchTerminalTab(tab) {
  const terminalOutput = document.getElementById('terminal-output');
  const outputLog = document.getElementById('output-log');
  const tabTerminal = document.getElementById('tab-terminal');
  const tabOutput = document.getElementById('tab-output');

  if (tab === 'terminal') {
    terminalOutput.style.display = 'block';
    outputLog.style.display = 'none';
    tabTerminal.classList.remove('inactive-tab');
    tabOutput.classList.add('inactive-tab');
    fitAddon.fit();
  } else {
    terminalOutput.style.display = 'none';
    outputLog.style.display = 'block';
    tabTerminal.classList.add('inactive-tab');
    tabOutput.classList.remove('inactive-tab');
  }
}

function runCode(){
  const currentFile = activeEditor === editor1 ? currentFile1 : currentFile2;
  if(currentFile && !currentFile.endsWith('.js')) {
    printToTerminal("Error: Only JavaScript (.js) files can be run.", "#f48771");
    return;
  }
  const oldLog = console.log;
  try {
    printToTerminal("> Running JS code...", "#569cd6");
    console.log = (...args) => {
      printToTerminal(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" "));
    };
    eval(activeEditor.getValue());
  } catch(e) {
    printToTerminal("Error: " + e.message, "#f48771");
  } finally {
    console.log = oldLog;
  }
}

function previewHTML() {
  const currentFile = activeEditor === editor1 ? currentFile1 : currentFile2;
  
  if (!currentFile || (!currentFile.endsWith('.html') && !currentFile.endsWith('.js'))) {
    printToTerminal("Error: Open an HTML file to preview.", "#f48771");
    return;
  }
  
  printToTerminal(`> Starting In-Window Live Preview...`, "#569cd6");
  
  const previewPane = document.getElementById("preview-pane");
  const iframe = document.getElementById("live-iframe");
  
  previewPane.style.display = "flex";
  previewMode = 'srcdoc';
  // Sandbox for static HTML preview to prevent it accessing the parent frame
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups');

  let codeToRun = activeEditor.getValue();
  if (currentFile.endsWith('.js')) {
    codeToRun = `<!DOCTYPE html><html><body><script>${codeToRun}<` + `/script></body></html>`;
  } else {
    // FIX: Inject a <base> tag so relative asset paths (style.css, script.js, images)
    // resolve correctly. We use a blob URL of the HTML as the base so the iframe
    // can at least resolve same-directory assets when served from a local server.
    // For the File System Access API, we also patch relative fetch paths via the base tag.
    const blob = new Blob([codeToRun], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);
    // Inject <base> pointing at the blob so relative hrefs have a base to work from.
    // This doesn't give full local file access (browser security), but prevents
    // broken relative links from throwing 404s when assets are inlined or served.
    codeToRun = codeToRun.replace(
      /(<head[^>]*>)/i,
      `$1<base href="${blobUrl}">`
    );
    // Revoke the temporary URL after a short delay (it was only needed for the base href value)
    setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
  }
  
  iframe.srcdoc = codeToRun;
}

function closePreview() {
  const iframe = document.getElementById("live-iframe");
  document.getElementById("preview-pane").style.display = "none";
  // Clear whichever mode was active
  if (previewMode === 'server') {
    iframe.src = 'about:blank';
  } else {
    iframe.srcdoc = "";
  }
  previewMode = null;
  printToTerminal(`> Closed Live Preview`, "#858585");
}

function updatePreviewIfOpen() {
  const previewPane = document.getElementById("preview-pane");
  if (!previewPane || previewPane.style.display === "none") return;

  // In server mode the iframe is pointed at a WebContainer localhost URL —
  // the dev server handles its own hot reloads, so we must not touch srcdoc here
  if (previewMode === 'server') return;

  const currentFile = activeEditor === editor1 ? currentFile1 : currentFile2;
  if (!currentFile || (!currentFile.endsWith('.html') && !currentFile.endsWith('.js'))) return;

  let codeToRun = activeEditor.getValue();
  if (currentFile.endsWith('.js')) {
    codeToRun = `<!DOCTYPE html><html><body><script>${codeToRun}<` + `/script></body></html>`;
  } else {
    const blob = new Blob([codeToRun], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);
    codeToRun = codeToRun.replace(/(<head[^>]*>)/i, `$1<base href="${blobUrl}">`);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
  }
  
  document.getElementById("live-iframe").srcdoc = codeToRun;
}

/* SERVICE WORKER + AUTO-UPDATE */
let _swRegistration = null;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => {
        _swRegistration = reg;

        // A new SW was found while the page is open
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          newWorker.addEventListener('statechange', () => {
            // New SW installed and waiting — show the banner
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner();
            }
          });
        });

        // If a SW is already waiting when we load (e.g. tab was open in background)
        if (reg.waiting && navigator.serviceWorker.controller) {
          showUpdateBanner();
        }
      })
      .catch(err => console.warn('SW registration failed:', err));

    // When the SW actually takes over, reload so the new assets are served
    let reloadPending = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadPending) window.location.reload();
    });

    window.applyUpdate = () => {
      reloadPending = true;
      if (_swRegistration && _swRegistration.waiting) {
        _swRegistration.waiting.postMessage('SKIP_WAITING');
      } else {
        window.location.reload();
      }
    };
  });
}

function showUpdateBanner() {
  const banner = document.getElementById('update-banner');
  if (banner) {
    banner.style.display = 'flex';
    // Animate in
    requestAnimationFrame(() => banner.classList.add('visible'));
  }
}

function dismissUpdate() {
  const banner = document.getElementById('update-banner');
  if (banner) {
    banner.classList.remove('visible');
    setTimeout(() => { banner.style.display = 'none'; }, 300);
  }
}

// Last-ditch sync when the tab is about to close
window.addEventListener('beforeunload', () => {
  if (webcontainerInstance && projectFolder) {
    syncCriticalFilesToDisk();
  }
}); // <--- WE CLOSE THE SERVICE WORKER BLOCK HERE!

async function renderFileTree(dirHandle, parentElement, pathPrefix = "") {
  const entries = [];
  for await (const [name, handle] of dirHandle.entries()) {
    entries.push({ name, handle });
  }

  // Sort: Folders first, then files alphabetically
  entries.sort((a, b) => {
    if (a.handle.kind === b.handle.kind) return a.name.localeCompare(b.name);
    return a.handle.kind === 'directory' ? -1 : 1;
  });

  for (const { name, handle } of entries) {
    const fullPath = pathPrefix ? `${pathPrefix}/${name}` : name;

    // Always skip .git and .vscode — they're never useful in the explorer
    if (name === '.git' || name === '.vscode') continue;

    if (handle.kind === 'directory') {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.innerHTML = `${getFolderIcon(name, false)} <span>${name}</span>`;

      summary.oncontextmenu = (e) => showContextMenu(e, 'directory', name, handle, dirHandle, fullPath);

      const childrenContainer = document.createElement('div');
      childrenContainer.style.paddingLeft = "12px";

      details.append(summary, childrenContainer);
      parentElement.appendChild(details);

      let isLoaded = false;
      details.addEventListener('toggle', async () => {
        summary.innerHTML = `${getFolderIcon(name, details.open)} <span>${name}</span>`;
        if (details.open && !isLoaded) {
          isLoaded = true;
          await renderFileTree(handle, childrenContainer, fullPath);
        }
      });
    } else {
      const fileDiv = document.createElement('div');
      fileDiv.className = 'file-item';
      fileDiv.innerHTML = getFileIcon(name) + `<span style="margin-left:5px;">${name}</span>`;
      fileDiv.oncontextmenu = (e) => showContextMenu(e, 'file', name, handle, dirHandle, fullPath);
      fileDiv.onclick = () => openFile(fullPath, handle);
      parentElement.appendChild(fileDiv);
    }
  }
}

/* ROOT FOLDER TOGGLE */
window.toggleRootFolder = function() {
  const root = document.getElementById("tree-root");
  const arrow = document.getElementById("root-arrow");
  
  if (root.style.display === "none") {
    root.style.display = "block";
    arrow.textContent = "˅";
  } else {
    root.style.display = "none";
    arrow.textContent = "›";
  }
};

/* RESTORE SESSION ON LOAD */
window.addEventListener('DOMContentLoaded', async () => {
  // Right-click on empty explorer space
  document.getElementById('fileTree').addEventListener('contextmenu', (e) => {
    if (!projectFolder) return;
    // Only trigger if clicking the background, not a file/folder item
    if (e.target.closest('.file-item') || e.target.closest('summary') || e.target.closest('details')) return;
    e.preventDefault(); e.stopPropagation();
    currentContextItem = { type: 'directory', name: projectFolder.name, handle: projectFolder, parentHandle: null, fullPath: projectFolder.name };
    showContextMenu(e, 'directory', projectFolder.name, projectFolder, null, projectFolder.name);
  });

  const storedHandle = await idbKeyval.get('workspaceHandle');
  const recentFolders = JSON.parse(localStorage.getItem('recentFolders') || '[]');
  renderWelcomeScreen(storedHandle, recentFolders);
});

function renderWelcomeScreen(storedHandle, recentFolders) {
  const tree = document.getElementById('fileTree');
  if (!tree) return;

  const recentItems = recentFolders.map(name => `
    <div class="welcome-recent-item ${storedHandle && storedHandle.name === name ? 'welcome-recent-active' : ''}"
         onclick="${storedHandle && storedHandle.name === name ? 'window.restoreWorkspace()' : 'openFolder()'}">
      <div class="welcome-recent-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <div class="welcome-recent-info">
        <div class="welcome-recent-name">${name}</div>
        <div class="welcome-recent-tag">${storedHandle && storedHandle.name === name ? 'Last session' : 'Recent'}</div>
      </div>
      ${storedHandle && storedHandle.name === name ? '<div class="welcome-recent-badge">Reconnect</div>' : ''}
    </div>
  `).join('');

  tree.innerHTML = `
    <div class="welcome-screen">
      <div class="welcome-logo">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.2">
          <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
        </svg>
      </div>
      <div class="welcome-title">VS Code Online</div>
      <div class="welcome-subtitle">Open a folder to start coding</div>

      <button class="welcome-open-btn" onclick="openFolder()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        Open Folder...
      </button>

      ${recentFolders.length > 0 ? `
        <div class="welcome-section-label">RECENT</div>
        <div class="welcome-recent-list">${recentItems}</div>
      ` : ''}

      <div class="welcome-section-label" style="margin-top:20px">SHORTCUTS</div>
      <div class="welcome-shortcuts">
        <div class="welcome-shortcut"><kbd>Ctrl+P</kbd><span>Go to file</span></div>
        <div class="welcome-shortcut"><kbd>Ctrl+Shift+P</kbd><span>Command palette</span></div>
        <div class="welcome-shortcut"><kbd>Ctrl+K T</kbd><span>Change theme</span></div>
        <div class="welcome-shortcut"><kbd>Shift+Alt+F</kbd><span>Format document</span></div>
      </div>
    </div>
    <div id="tree-root"></div>
  `;
}

/* =========================================
   THEME SYSTEM
   ========================================= */

// Shell vars applied to :root on theme switch — skins the entire IDE
const THEMES = [
  {
    id: 'vs-dark',
    label: 'Dark+ (default)',
    base: 'vs-dark',
    rules: [],
    colors: {},
    shell: {
      '--bg-app':         '#181818',
      '--bg-editor':      '#1e1e1e',
      '--bg-sidebar':     '#181818',
      '--bg-activity':    '#181818',
      '--bg-hover':       '#2a2d2e',
      '--bg-active':      '#37373d',
      '--bg-input':       '#3c3c3c',
      '--terminal-bg':    '#181818',
      '--border':         '#2b2b2b',
      '--border-light':   '#3c3c3c',
      '--accent':         '#007acc',
      '--accent-hover':   '#1a8fdb',
      '--accent-select':  '#094771',
      '--text-main':      '#cccccc',
      '--text-bright':    '#ffffff',
      '--text-muted':     '#858585',
      '--text-disabled':  '#5a5a5a',
      '--palette-bg':     '#161616',
      '--palette-border': '#333333',
      '--palette-hover':  '#094771',
      '--status-bg':      '#007acc',
      '--status-fg':      '#ffffff',
    },
  },
  {
    id: 'one-dark-pro',
    label: 'One Dark Pro',
    base: 'vs-dark',
    rules: [
      { token: '', foreground: 'abb2bf' },
      { token: 'comment', foreground: '5c6370', fontStyle: 'italic' },
      { token: 'comment.doc', foreground: '5c6370', fontStyle: 'italic' },
      { token: 'constant', foreground: 'd19a66' },
      { token: 'constant.numeric', foreground: 'd19a66' },
      { token: 'constant.language', foreground: '56b6c2' },
      { token: 'entity.name.function', foreground: '61afef' },
      { token: 'entity.name.class', foreground: 'e5c07b' },
      { token: 'entity.name.tag', foreground: 'e06c75' },
      { token: 'entity.other.attribute', foreground: 'd19a66' },
      { token: 'keyword', foreground: 'c678dd' },
      { token: 'keyword.control', foreground: 'c678dd' },
      { token: 'keyword.operator', foreground: 'abb2bf' },
      { token: 'string', foreground: '98c379' },
      { token: 'string.template', foreground: '98c379' },
      { token: 'support.function', foreground: '56b6c2' },
      { token: 'support.class', foreground: 'e5c07b' },
      { token: 'support.type', foreground: '56b6c2' },
      { token: 'type', foreground: 'e5c07b' },
      { token: 'variable', foreground: 'e06c75' },
      { token: 'variable.parameter', foreground: 'abb2bf' },
      { token: 'number', foreground: 'd19a66' },
      { token: 'regexp', foreground: '98c379' },
      { token: 'operator', foreground: 'abb2bf' },
      { token: 'delimiter', foreground: 'abb2bf' },
      { token: 'tag', foreground: 'e06c75' },
      { token: 'attribute.name', foreground: 'd19a66' },
      { token: 'attribute.value', foreground: '98c379' },
      { token: 'metatag', foreground: 'c678dd' },
    ],
    colors: {
      'editor.background': '#282c34',
      'editor.foreground': '#abb2bf',
      'editor.lineHighlightBackground': '#2c313a',
      'editor.selectionBackground': '#3e4451',
      'editorLineNumber.foreground': '#495162',
      'editorLineNumber.activeForeground': '#abb2bf',
      'editorCursor.foreground': '#528bff',
      'editor.findMatchBackground': '#42557b',
      'editor.findMatchHighlightBackground': '#314365',
    },
    shell: {
      '--bg-app':         '#21252b',
      '--bg-editor':      '#282c34',
      '--bg-sidebar':     '#21252b',
      '--bg-activity':    '#1e2127',
      '--bg-hover':       '#2c313a',
      '--bg-active':      '#2c313a',
      '--bg-input':       '#1d1f23',
      '--terminal-bg':    '#1e2127',
      '--border':         '#181a1f',
      '--border-light':   '#3e4451',
      '--accent':         '#528bff',
      '--accent-hover':   '#6b9fff',
      '--accent-select':  '#1c3157',
      '--text-main':      '#abb2bf',
      '--text-bright':    '#ffffff',
      '--text-muted':     '#636d83',
      '--text-disabled':  '#4b5263',
      '--palette-bg':     '#1d1f23',
      '--palette-border': '#3e4451',
      '--palette-hover':  '#1c3157',
      '--status-bg':      '#528bff',
      '--status-fg':      '#ffffff',
    },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    base: 'vs-dark',
    rules: [
      { token: '', foreground: 'f8f8f2' },
      { token: 'comment', foreground: '6272a4', fontStyle: 'italic' },
      { token: 'string', foreground: 'f1fa8c' },
      { token: 'string.template', foreground: 'f1fa8c' },
      { token: 'constant.numeric', foreground: 'bd93f9' },
      { token: 'constant.language', foreground: 'bd93f9' },
      { token: 'keyword', foreground: 'ff79c6' },
      { token: 'keyword.control', foreground: 'ff79c6' },
      { token: 'keyword.operator', foreground: 'ff79c6' },
      { token: 'entity.name.function', foreground: '50fa7b' },
      { token: 'entity.name.class', foreground: '8be9fd', fontStyle: 'italic' },
      { token: 'entity.name.tag', foreground: 'ff79c6' },
      { token: 'entity.other.attribute', foreground: '50fa7b' },
      { token: 'support.function', foreground: '50fa7b' },
      { token: 'support.class', foreground: '8be9fd' },
      { token: 'type', foreground: '8be9fd', fontStyle: 'italic' },
      { token: 'variable', foreground: 'f8f8f2' },
      { token: 'variable.parameter', foreground: 'ffb86c', fontStyle: 'italic' },
      { token: 'number', foreground: 'bd93f9' },
      { token: 'regexp', foreground: 'f1fa8c' },
      { token: 'operator', foreground: 'ff79c6' },
      { token: 'tag', foreground: 'ff79c6' },
      { token: 'attribute.name', foreground: '50fa7b' },
      { token: 'attribute.value', foreground: 'f1fa8c' },
      { token: 'metatag', foreground: 'ff79c6' },
    ],
    colors: {
      'editor.background': '#282a36',
      'editor.foreground': '#f8f8f2',
      'editor.lineHighlightBackground': '#44475a',
      'editor.selectionBackground': '#44475a',
      'editorLineNumber.foreground': '#6272a4',
      'editorLineNumber.activeForeground': '#f8f8f2',
      'editorCursor.foreground': '#f8f8f2',
      'editor.findMatchBackground': '#ffb86c50',
      'editor.findMatchHighlightBackground': '#ffffff20',
    },
    shell: {
      '--bg-app':         '#21222c',
      '--bg-editor':      '#282a36',
      '--bg-sidebar':     '#21222c',
      '--bg-activity':    '#191a21',
      '--bg-hover':       '#343746',
      '--bg-active':      '#44475a',
      '--bg-input':       '#191a21',
      '--terminal-bg':    '#21222c',
      '--border':         '#191a21',
      '--border-light':   '#44475a',
      '--accent':         '#bd93f9',
      '--accent-hover':   '#caa4ff',
      '--accent-select':  '#44475a',
      '--text-main':      '#f8f8f2',
      '--text-bright':    '#ffffff',
      '--text-muted':     '#6272a4',
      '--text-disabled':  '#4d5068',
      '--palette-bg':     '#1e1f29',
      '--palette-border': '#44475a',
      '--palette-hover':  '#44475a',
      '--status-bg':      '#bd93f9',
      '--status-fg':      '#282a36',
    },
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    base: 'vs-dark',
    rules: [
      { token: '', foreground: 'a9b1d6' },
      { token: 'comment', foreground: '565f89', fontStyle: 'italic' },
      { token: 'string', foreground: '9ece6a' },
      { token: 'string.template', foreground: '9ece6a' },
      { token: 'constant.numeric', foreground: 'ff9e64' },
      { token: 'constant.language', foreground: 'bb9af7' },
      { token: 'keyword', foreground: 'bb9af7' },
      { token: 'keyword.control', foreground: 'bb9af7' },
      { token: 'keyword.operator', foreground: '89ddff' },
      { token: 'entity.name.function', foreground: '7aa2f7' },
      { token: 'entity.name.class', foreground: 'e0af68' },
      { token: 'entity.name.tag', foreground: 'f7768e' },
      { token: 'entity.other.attribute', foreground: 'bb9af7' },
      { token: 'support.function', foreground: '2ac3de' },
      { token: 'support.class', foreground: 'e0af68' },
      { token: 'type', foreground: '2ac3de' },
      { token: 'variable', foreground: 'a9b1d6' },
      { token: 'variable.parameter', foreground: 'e0af68' },
      { token: 'number', foreground: 'ff9e64' },
      { token: 'regexp', foreground: 'b4f9f8' },
      { token: 'operator', foreground: '89ddff' },
      { token: 'tag', foreground: 'f7768e' },
      { token: 'attribute.name', foreground: 'bb9af7' },
      { token: 'attribute.value', foreground: '9ece6a' },
      { token: 'metatag', foreground: 'bb9af7' },
    ],
    colors: {
      'editor.background': '#1a1b2e',
      'editor.foreground': '#a9b1d6',
      'editor.lineHighlightBackground': '#20223a',
      'editor.selectionBackground': '#2d2f5e',
      'editorLineNumber.foreground': '#3b3d57',
      'editorLineNumber.activeForeground': '#737aa2',
      'editorCursor.foreground': '#c0caf5',
      'editor.findMatchBackground': '#3d59a150',
      'editor.findMatchHighlightBackground': '#3d59a130',
    },
    shell: {
      '--bg-app':         '#16161e',
      '--bg-editor':      '#1a1b2e',
      '--bg-sidebar':     '#16161e',
      '--bg-activity':    '#13131a',
      '--bg-hover':       '#1f2335',
      '--bg-active':      '#24283b',
      '--bg-input':       '#1a1b26',
      '--terminal-bg':    '#16161e',
      '--border':         '#1a1b2e',
      '--border-light':   '#292e42',
      '--accent':         '#7aa2f7',
      '--accent-hover':   '#89b4fa',
      '--accent-select':  '#283457',
      '--text-main':      '#a9b1d6',
      '--text-bright':    '#c0caf5',
      '--text-muted':     '#565f89',
      '--text-disabled':  '#414868',
      '--palette-bg':     '#15161e',
      '--palette-border': '#292e42',
      '--palette-hover':  '#283457',
      '--status-bg':      '#7aa2f7',
      '--status-fg':      '#16161e',
    },
  },
  {
    id: 'monokai',
    label: 'Monokai',
    base: 'vs-dark',
    rules: [
      { token: '', foreground: 'f8f8f2' },
      { token: 'comment', foreground: '75715e', fontStyle: 'italic' },
      { token: 'string', foreground: 'e6db74' },
      { token: 'string.template', foreground: 'e6db74' },
      { token: 'constant.numeric', foreground: 'ae81ff' },
      { token: 'constant.language', foreground: 'ae81ff' },
      { token: 'keyword', foreground: 'f92672' },
      { token: 'keyword.control', foreground: 'f92672' },
      { token: 'keyword.operator', foreground: 'f92672' },
      { token: 'entity.name.function', foreground: 'a6e22e' },
      { token: 'entity.name.class', foreground: 'a6e22e' },
      { token: 'entity.name.tag', foreground: 'f92672' },
      { token: 'entity.other.attribute', foreground: 'a6e22e' },
      { token: 'support.function', foreground: '66d9e8' },
      { token: 'support.class', foreground: '66d9e8' },
      { token: 'type', foreground: '66d9e8' },
      { token: 'variable', foreground: 'f8f8f2' },
      { token: 'variable.parameter', foreground: 'fd971f', fontStyle: 'italic' },
      { token: 'number', foreground: 'ae81ff' },
      { token: 'regexp', foreground: 'e6db74' },
      { token: 'operator', foreground: 'f92672' },
      { token: 'tag', foreground: 'f92672' },
      { token: 'attribute.name', foreground: 'a6e22e' },
      { token: 'attribute.value', foreground: 'e6db74' },
      { token: 'metatag', foreground: 'f92672' },
    ],
    colors: {
      'editor.background': '#272822',
      'editor.foreground': '#f8f8f2',
      'editor.lineHighlightBackground': '#3e3d32',
      'editor.selectionBackground': '#49483e',
      'editorLineNumber.foreground': '#90908a',
      'editorLineNumber.activeForeground': '#f8f8f0',
      'editorCursor.foreground': '#f8f8f0',
      'editor.findMatchBackground': '#ffe79250',
      'editor.findMatchHighlightBackground': '#ffe79230',
    },
    shell: {
      '--bg-app':         '#1e1f1c',
      '--bg-editor':      '#272822',
      '--bg-sidebar':     '#1e1f1c',
      '--bg-activity':    '#19191c',
      '--bg-hover':       '#3e3d32',
      '--bg-active':      '#49483e',
      '--bg-input':       '#1e1f1c',
      '--terminal-bg':    '#1e1f1c',
      '--border':         '#1e1f1c',
      '--border-light':   '#49483e',
      '--accent':         '#a6e22e',
      '--accent-hover':   '#b8f53e',
      '--accent-select':  '#3d3c31',
      '--text-main':      '#f8f8f2',
      '--text-bright':    '#f8f8f0',
      '--text-muted':     '#90908a',
      '--text-disabled':  '#5c5c52',
      '--palette-bg':     '#1e1f1c',
      '--palette-border': '#49483e',
      '--palette-hover':  '#3d3c31',
      '--status-bg':      '#a6e22e',
      '--status-fg':      '#1e1f1c',
    },
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    base: 'vs-dark',
    rules: [
      { token: '', foreground: '839496' },
      { token: 'comment', foreground: '586e75', fontStyle: 'italic' },
      { token: 'string', foreground: '2aa198' },
      { token: 'string.template', foreground: '2aa198' },
      { token: 'constant.numeric', foreground: 'd33682' },
      { token: 'constant.language', foreground: 'cb4b16' },
      { token: 'keyword', foreground: '859900' },
      { token: 'keyword.control', foreground: '268bd2' },
      { token: 'keyword.operator', foreground: '859900' },
      { token: 'entity.name.function', foreground: '268bd2' },
      { token: 'entity.name.class', foreground: 'cb4b16' },
      { token: 'entity.name.tag', foreground: '268bd2' },
      { token: 'entity.other.attribute', foreground: '93a1a1' },
      { token: 'support.function', foreground: '2aa198' },
      { token: 'type', foreground: 'b58900' },
      { token: 'variable', foreground: '839496' },
      { token: 'number', foreground: 'd33682' },
      { token: 'regexp', foreground: '2aa198' },
      { token: 'operator', foreground: '859900' },
      { token: 'tag', foreground: '268bd2' },
      { token: 'attribute.name', foreground: '93a1a1' },
      { token: 'attribute.value', foreground: '2aa198' },
    ],
    colors: {
      'editor.background': '#002b36',
      'editor.foreground': '#839496',
      'editor.lineHighlightBackground': '#073642',
      'editor.selectionBackground': '#073642',
      'editorLineNumber.foreground': '#586e75',
      'editorLineNumber.activeForeground': '#839496',
      'editorCursor.foreground': '#839496',
    },
    shell: {
      '--bg-app':         '#002b36',
      '--bg-editor':      '#002b36',
      '--bg-sidebar':     '#073642',
      '--bg-activity':    '#002b36',
      '--bg-hover':       '#0d4655',
      '--bg-active':      '#0d4655',
      '--bg-input':       '#003847',
      '--terminal-bg':    '#002b36',
      '--border':         '#073642',
      '--border-light':   '#586e75',
      '--accent':         '#268bd2',
      '--accent-hover':   '#2fa0e6',
      '--accent-select':  '#1b5e8e',
      '--text-main':      '#839496',
      '--text-bright':    '#eee8d5',
      '--text-muted':     '#586e75',
      '--text-disabled':  '#405050',
      '--palette-bg':     '#002b36',
      '--palette-border': '#586e75',
      '--palette-hover':  '#1b5e8e',
      '--status-bg':      '#268bd2',
      '--status-fg':      '#fdf6e3',
    },
  },
  {
    id: 'github-dark',
    label: 'GitHub Dark',
    base: 'vs-dark',
    rules: [
      { token: '', foreground: 'e6edf3' },
      { token: 'comment', foreground: '8b949e', fontStyle: 'italic' },
      { token: 'string', foreground: 'a5d6ff' },
      { token: 'constant.numeric', foreground: '79c0ff' },
      { token: 'constant.language', foreground: '79c0ff' },
      { token: 'keyword', foreground: 'ff7b72' },
      { token: 'keyword.control', foreground: 'ff7b72' },
      { token: 'keyword.operator', foreground: 'e6edf3' },
      { token: 'entity.name.function', foreground: 'd2a8ff' },
      { token: 'entity.name.class', foreground: 'ffa657' },
      { token: 'entity.name.tag', foreground: '7ee787' },
      { token: 'entity.other.attribute', foreground: '79c0ff' },
      { token: 'support.function', foreground: 'd2a8ff' },
      { token: 'type', foreground: 'ffa657' },
      { token: 'variable', foreground: 'ffa657' },
      { token: 'number', foreground: '79c0ff' },
      { token: 'regexp', foreground: 'a5d6ff' },
      { token: 'operator', foreground: 'e6edf3' },
      { token: 'tag', foreground: '7ee787' },
      { token: 'attribute.name', foreground: '79c0ff' },
      { token: 'attribute.value', foreground: 'a5d6ff' },
    ],
    colors: {
      'editor.background': '#0d1117',
      'editor.foreground': '#e6edf3',
      'editor.lineHighlightBackground': '#161b22',
      'editor.selectionBackground': '#264f78',
      'editorLineNumber.foreground': '#484f58',
      'editorLineNumber.activeForeground': '#e6edf3',
      'editorCursor.foreground': '#58a6ff',
    },
    shell: {
      '--bg-app':         '#0d1117',
      '--bg-editor':      '#0d1117',
      '--bg-sidebar':     '#161b22',
      '--bg-activity':    '#010409',
      '--bg-hover':       '#21262d',
      '--bg-active':      '#30363d',
      '--bg-input':       '#0d1117',
      '--terminal-bg':    '#0d1117',
      '--border':         '#21262d',
      '--border-light':   '#30363d',
      '--accent':         '#58a6ff',
      '--accent-hover':   '#79b8ff',
      '--accent-select':  '#1f3f5b',
      '--text-main':      '#e6edf3',
      '--text-bright':    '#ffffff',
      '--text-muted':     '#8b949e',
      '--text-disabled':  '#484f58',
      '--palette-bg':     '#090c10',
      '--palette-border': '#30363d',
      '--palette-hover':  '#1f3f5b',
      '--status-bg':      '#1f6feb',
      '--status-fg':      '#ffffff',
    },
  },

  /* ── Light themes ───────────────────────────────────────────── */
  {
    id: 'vs-light',
    label: 'Light+ (default)',
    base: 'vs',
    rules: [],
    colors: {},
    shell: {
      '--bg-app':         '#f3f3f3',
      '--bg-editor':      '#ffffff',
      '--bg-sidebar':     '#f3f3f3',
      '--bg-activity':    '#2c2c2c',
      '--bg-hover':       '#e8e8e8',
      '--bg-active':      '#e4e6f1',
      '--bg-input':       '#e8e8e8',
      '--terminal-bg':    '#ffffff',
      '--border':         '#e8e8e8',
      '--border-light':   '#c8c8c8',
      '--accent':         '#007acc',
      '--accent-hover':   '#1a8fdb',
      '--accent-select':  '#cce5f7',
      '--text-main':      '#333333',
      '--text-bright':    '#000000',
      '--text-muted':     '#717171',
      '--text-disabled':  '#aaaaaa',
      '--palette-bg':     '#f3f3f3',
      '--palette-border': '#c8c8c8',
      '--palette-hover':  '#cce5f7',
      '--status-bg':      '#007acc',
      '--status-fg':      '#ffffff',
    },
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    base: 'vs',
    rules: [
      { token: '', foreground: '657b83' },
      { token: 'comment', foreground: '93a1a1', fontStyle: 'italic' },
      { token: 'string', foreground: '2aa198' },
      { token: 'string.template', foreground: '2aa198' },
      { token: 'constant.numeric', foreground: 'd33682' },
      { token: 'constant.language', foreground: 'cb4b16' },
      { token: 'keyword', foreground: '859900' },
      { token: 'keyword.control', foreground: '268bd2' },
      { token: 'keyword.operator', foreground: '859900' },
      { token: 'entity.name.function', foreground: '268bd2' },
      { token: 'entity.name.class', foreground: 'cb4b16' },
      { token: 'entity.name.tag', foreground: '268bd2' },
      { token: 'entity.other.attribute', foreground: '93a1a1' },
      { token: 'support.function', foreground: '2aa198' },
      { token: 'type', foreground: 'b58900' },
      { token: 'variable', foreground: '657b83' },
      { token: 'number', foreground: 'd33682' },
      { token: 'regexp', foreground: '2aa198' },
      { token: 'operator', foreground: '859900' },
      { token: 'tag', foreground: '268bd2' },
      { token: 'attribute.name', foreground: '93a1a1' },
      { token: 'attribute.value', foreground: '2aa198' },
    ],
    colors: {
      'editor.background': '#fdf6e3',
      'editor.foreground': '#657b83',
      'editor.lineHighlightBackground': '#eee8d5',
      'editor.selectionBackground': '#d3cbb8',
      'editorLineNumber.foreground': '#93a1a1',
      'editorLineNumber.activeForeground': '#657b83',
      'editorCursor.foreground': '#657b83',
    },
    shell: {
      '--bg-app':         '#eee8d5',
      '--bg-editor':      '#fdf6e3',
      '--bg-sidebar':     '#eee8d5',
      '--bg-activity':    '#657b83',
      '--bg-hover':       '#ddd6c0',
      '--bg-active':      '#d3cbb8',
      '--bg-input':       '#ddd6c0',
      '--terminal-bg':    '#fdf6e3',
      '--border':         '#d3cbb8',
      '--border-light':   '#c5b9a4',
      '--accent':         '#268bd2',
      '--accent-hover':   '#2fa0e6',
      '--accent-select':  '#b3d6f0',
      '--text-main':      '#657b83',
      '--text-bright':    '#002b36',
      '--text-muted':     '#93a1a1',
      '--text-disabled':  '#b0b8b8',
      '--palette-bg':     '#eee8d5',
      '--palette-border': '#c5b9a4',
      '--palette-hover':  '#b3d6f0',
      '--status-bg':      '#268bd2',
      '--status-fg':      '#fdf6e3',
    },
  },
  {
    id: 'github-light',
    label: 'GitHub Light',
    base: 'vs',
    rules: [
      { token: '', foreground: '24292e' },
      { token: 'comment', foreground: '6a737d', fontStyle: 'italic' },
      { token: 'string', foreground: '032f62' },
      { token: 'constant.numeric', foreground: '005cc5' },
      { token: 'constant.language', foreground: '005cc5' },
      { token: 'keyword', foreground: 'd73a49' },
      { token: 'keyword.control', foreground: 'd73a49' },
      { token: 'keyword.operator', foreground: '24292e' },
      { token: 'entity.name.function', foreground: '6f42c1' },
      { token: 'entity.name.class', foreground: 'e36209' },
      { token: 'entity.name.tag', foreground: '22863a' },
      { token: 'entity.other.attribute', foreground: '005cc5' },
      { token: 'support.function', foreground: '6f42c1' },
      { token: 'type', foreground: 'e36209' },
      { token: 'variable', foreground: 'e36209' },
      { token: 'number', foreground: '005cc5' },
      { token: 'regexp', foreground: '032f62' },
      { token: 'operator', foreground: '24292e' },
      { token: 'tag', foreground: '22863a' },
      { token: 'attribute.name', foreground: '005cc5' },
      { token: 'attribute.value', foreground: '032f62' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#24292e',
      'editor.lineHighlightBackground': '#f6f8fa',
      'editor.selectionBackground': '#c8e1ff',
      'editorLineNumber.foreground': '#c6cdd5',
      'editorLineNumber.activeForeground': '#24292e',
      'editorCursor.foreground': '#24292e',
    },
    shell: {
      '--bg-app':         '#f6f8fa',
      '--bg-editor':      '#ffffff',
      '--bg-sidebar':     '#f6f8fa',
      '--bg-activity':    '#24292e',
      '--bg-hover':       '#eaeef2',
      '--bg-active':      '#dde1e6',
      '--bg-input':       '#eaeef2',
      '--terminal-bg':    '#ffffff',
      '--border':         '#e1e4e8',
      '--border-light':   '#cdd3d9',
      '--accent':         '#0366d6',
      '--accent-hover':   '#0476f5',
      '--accent-select':  '#c8e1ff',
      '--text-main':      '#24292e',
      '--text-bright':    '#000000',
      '--text-muted':     '#6a737d',
      '--text-disabled':  '#b0b8c0',
      '--palette-bg':     '#f6f8fa',
      '--palette-border': '#cdd3d9',
      '--palette-hover':  '#c8e1ff',
      '--status-bg':      '#0366d6',
      '--status-fg':      '#ffffff',
    },
  },
];

let activeThemeId = localStorage.getItem('editorTheme') || 'vs-dark';
let _themePickerIndex = 0;
let _filteredThemes = [...THEMES];
let _previewThemeId = null;

function initThemes() {
  THEMES.forEach(theme => {
    // vs-dark and vs (light) are Monaco built-ins — don't redefine them
    if (theme.id === 'vs-dark' || theme.id === 'vs-light') return;
    monaco.editor.defineTheme(theme.id, {
      base: theme.base,
      inherit: true,
      rules: theme.rules,
      colors: theme.colors,
    });
  });
  applyTheme(activeThemeId, false);
}

function applyTheme(id, save = true) {
  const theme = THEMES.find(t => t.id === id) || THEMES[0];
  // vs-light maps to Monaco built-in 'vs'
  const monacoId = theme.id === 'vs-light' ? 'vs' : theme.id;
  monaco.editor.setTheme(monacoId);
  activeThemeId = theme.id;

  // Apply shell CSS variables to the entire IDE
  const root = document.documentElement;
  if (theme.shell) {
    Object.entries(theme.shell).forEach(([k, v]) => root.style.setProperty(k, v));
  }

  // Update status bar colour from theme
  const statusBar = document.querySelector('.status-bar');
  if (statusBar && theme.shell) {
    statusBar.style.background = theme.shell['--status-bg'] || '';
    statusBar.style.color      = theme.shell['--status-fg'] || '';
  }

  // Keep <meta name="theme-color"> in sync so the WCO titlebar area
  // matches the app background (the OS paints the button strip this colour)
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme && theme.shell) {
    metaTheme.content = theme.shell['--bg-app'] || '#181818';
  }

  // Update settings panel theme name display
  const tn = document.getElementById('settings-theme-name');
  if (tn) tn.textContent = theme.label;

  if (save) {
    localStorage.setItem('editorTheme', theme.id);
    printToOutput(`Theme: ${theme.label}`, '#858585');
  }
}

window.openThemePicker = function() {
  const overlay = document.getElementById('theme-picker-overlay');
  if (!overlay) return;
  _previewThemeId = activeThemeId;
  overlay.style.display = 'flex';
  requestAnimationFrame(() => overlay.classList.add('visible'));
  const search = document.getElementById('theme-search');
  if (search) { search.value = ''; search.focus(); }
  _filteredThemes = [...THEMES];
  _themePickerIndex = Math.max(0, THEMES.findIndex(t => t.id === activeThemeId));
  renderThemeList();
};

window.closeThemePicker = function(confirm = false) {
  const overlay = document.getElementById('theme-picker-overlay');
  if (!overlay) return;
  if (!confirm && _previewThemeId) {
    applyTheme(_previewThemeId, false);
  }
  overlay.classList.remove('visible');
  setTimeout(() => { overlay.style.display = 'none'; }, 200);
};

function renderThemeList() {
  const list = document.getElementById('theme-list');
  if (!list) return;
  list.innerHTML = '';
  _filteredThemes.forEach((theme, i) => {
    const edBg  = theme.colors?.['editor.background'] || (theme.shell?.['--bg-editor']) || '#1e1e1e';
    const edFg  = theme.colors?.['editor.foreground'] || (theme.shell?.['--text-main']) || '#cccccc';
    const sideBg = theme.shell?.['--bg-sidebar'] || '#181818';
    const accent = theme.shell?.['--accent'] || '#007acc';
    const li = document.createElement('li');
    li.className = 'theme-item' + (i === _themePickerIndex ? ' selected' : '') + (theme.id === activeThemeId ? ' active' : '');
    li.innerHTML = `
      <span class="theme-swatch" style="background:${sideBg};border:1px solid ${theme.shell?.['--border']||'#333'}">
        <span style="display:flex;gap:2px;align-items:center">
          <span style="width:3px;height:22px;background:${accent};border-radius:1px;flex-shrink:0"></span>
          <span style="color:${edFg};font-size:9px;font-family:monospace;background:${edBg};flex:1;height:22px;display:flex;align-items:center;padding-left:3px">Aa</span>
        </span>
      </span>
      <span class="theme-label">${theme.label}</span>
      ${theme.id === activeThemeId ? '<span class="theme-check">✓</span>' : ''}
    `;
    li.onclick = () => {
      _themePickerIndex = i;
      applyTheme(theme.id);
      renderThemeList();
      closeThemePicker(true);
    };
    li.onmouseenter = () => {
      const monacoId = theme.id === 'vs-light' ? 'vs' : theme.id;
      monaco.editor.setTheme(monacoId);
      if (theme.shell) {
        Object.entries(theme.shell).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
        const sb = document.querySelector('.status-bar');
        if (sb) { sb.style.background = theme.shell['--status-bg']||''; sb.style.color = theme.shell['--status-fg']||''; }
      }
    };
    li.onmouseleave = () => {
      const sel = _filteredThemes[_themePickerIndex];
      if (sel) {
        const mId = sel.id === 'vs-light' ? 'vs' : sel.id;
        monaco.editor.setTheme(mId);
        if (sel.shell) {
          Object.entries(sel.shell).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
          const sb = document.querySelector('.status-bar');
          if (sb) { sb.style.background = sel.shell['--status-bg']||''; sb.style.color = sel.shell['--status-fg']||''; }
        }
      }
    };
    list.appendChild(li);
  });
  const sel = list.querySelector('.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

window.filterThemes = function(query) {
  const q = query.toLowerCase().trim();
  _filteredThemes = q ? THEMES.filter(t => t.label.toLowerCase().includes(q)) : [...THEMES];
  _themePickerIndex = 0;
  renderThemeList();
};

// Keyboard navigation inside the theme picker
document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('theme-picker-overlay');
  if (!overlay || overlay.style.display === 'none') return;
  if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) return;
  e.preventDefault();
  if (e.key === 'ArrowDown') {
    _themePickerIndex = Math.min(_filteredThemes.length - 1, _themePickerIndex + 1);
    const t = _filteredThemes[_themePickerIndex];
    if (t) { const mId = t.id === 'vs-light' ? 'vs' : t.id; monaco.editor.setTheme(mId); if(t.shell){Object.entries(t.shell).forEach(([k,v])=>document.documentElement.style.setProperty(k,v));} }
    renderThemeList();
  } else if (e.key === 'ArrowUp') {
    _themePickerIndex = Math.max(0, _themePickerIndex - 1);
    const t = _filteredThemes[_themePickerIndex];
    if (t) { const mId = t.id === 'vs-light' ? 'vs' : t.id; monaco.editor.setTheme(mId); if(t.shell){Object.entries(t.shell).forEach(([k,v])=>document.documentElement.style.setProperty(k,v));} }
    renderThemeList();
  } else if (e.key === 'Enter') {
    const t = _filteredThemes[_themePickerIndex];
    if (t) { applyTheme(t.id); closeThemePicker(true); }
  } else if (e.key === 'Escape') {
    closeThemePicker(false);
  }
});
/* PRETTIER FORMATTER */
window.formatCode = async function() {
  const currentFile = activeEditor === editor1 ? currentFile1 : currentFile2;
  if (!currentFile) return;

  const lang = getLanguageForFile(currentFile);
  let parserName = "babel"; // Default for JS

  // Match our simple language names to Prettier's official parsers
  if (lang === "html") parserName = "html";
  else if (lang === "css") parserName = "css";
  else if (lang === "javascript" || lang === "typescript") parserName = "babel";
  else {
    printToTerminal(`[Prettier] Language '${lang}' not supported for formatting.`, "#cbcb41");
    return;
  }

  try {
    printToTerminal(`> Formatting ${currentFile}...`, "#858585");
    const unformatted = activeEditor.getValue();
    
    // Call Prettier Standalone
    const formatted = await prettier.format(unformatted, {
      parser: parserName,
      plugins: window.prettierPlugins || [],
      singleQuote: true,
      tabWidth: 2
    });

    // Replace text while preserving Undo/Redo history!
    const fullRange = activeEditor.getModel().getFullModelRange();
    activeEditor.executeEdits("prettier", [{
      range: fullRange,
      text: formatted,
      forceMoveMarkers: true
    }]);
    
    // Auto-save the newly formatted code
    triggerManualSave();
    printToTerminal(`[Prettier] Success!`, "#89d185");

  } catch (err) {
    printToTerminal(`[Prettier Error] ${err.message}`, "#f48771");
  }
};

/* RESTORE WORKSPACE */
window.restoreWorkspace = async function() {
  try {
    const handle = await idbKeyval.get('workspaceHandle');
    if (!handle) return;

    // Ask the user to approve the connection
    const hasPermission = await verifyPermission(handle, true);
    if (!hasPermission) {
      printToTerminal("Permission to restore workspace was denied.", "#f48771");
      return;
    }

    projectFolder = handle;
    const _sb2 = document.getElementById('search-bar-text'); if(_sb2) _sb2.textContent = projectFolder.name;
    const tree = document.getElementById("fileTree");
    tree.innerHTML = `
  <div class="folder-title" onclick="toggleRootFolder()" style="cursor: pointer; user-select: none;">
    <span id="root-arrow">˅</span> ${projectFolder.name}
  </div>
  <div id="tree-root"></div>
`;

    document.getElementById("tree-root").innerHTML = ""; // Clear the old tree
await renderFileTree(projectFolder, document.getElementById("tree-root")); // Load the new tree
    
    // Restore Open Tabs!
    const sessionStr = localStorage.getItem('workspaceSession');
    if (sessionStr) {
      const session = JSON.parse(sessionStr);
      
      for (const path of session.openPaths) {
        const pathParts = path.split('/');
        let currentHandle = projectFolder;
        for (let i = 0; i < pathParts.length; i++) {
          if (i === pathParts.length - 1) {
            currentHandle = await currentHandle.getFileHandle(pathParts[i]);
          } else {
            currentHandle = await currentHandle.getDirectoryHandle(pathParts[i]);
          }
        }
        await openFile(path, currentHandle);
      }
      
      // Focus the right tabs
      if (session.file1) switchTab(session.file1);
      if (session.file2) {
        if (document.getElementById("editor2").style.display === "none") toggleSplit();
        activeEditor = editor2;
        switchTab(session.file2);
      }
    }
    
    refreshFileCache(); // Build the file search index in the background


    printToTerminal(`> Workspace restored: ${projectFolder.name}`, "#89d185");
    startWebContainer();
  } catch (err) {
    printToTerminal(`Error restoring workspace: ${err.message}`, "#f48771");
  }
};

/* =========================================
   GLOBAL COMMAND PALETTE & FILE SEARCH
   ========================================= */

// The DOM elements for our palette
const paletteOverlay = document.getElementById("command-palette");
const paletteInput = document.getElementById("palette-input");
const paletteResults = document.getElementById("palette-results");

// A list of commands for when you type ">"
const editorCommands = [
  { label: "Format Document", action: () => window.formatCode(), icon: "✨" },
  { label: "Color Theme", action: () => openThemePicker(), icon: "🎨" },
  { label: "View: Toggle Split Editor", action: toggleSplit, icon: "◫" },
  { label: "View: Toggle Sidebar", action: toggleSidebar, icon: "🗂️" },
  { label: "Terminal: Clear", action: () => term.clear(), icon: "🧹" },
  { label: "Live Preview: Start", action: previewHTML, icon: "🌐" },
  { label: "Live Preview: Stop", action: closePreview, icon: "❌" },
];

// 1. Open and Close Functions
window.openPalette = function(prefix = "") {
  if (!paletteOverlay || !paletteInput) return;
  paletteOverlay.style.display = "flex";
  paletteInput.value = prefix;
  paletteInput.focus();
  renderPaletteResults();
};

window.closePalette = function() {
  if (!paletteOverlay) return;
  paletteOverlay.style.display = "none";
  paletteInput.value = "";
  paletteResults.innerHTML = "";
};

// 2. The Mighty Render Function (Filters files or commands)
function renderPaletteResults() {
  const query = paletteInput.value;
  paletteResults.innerHTML = ""; // Clear old results
  
  // COMMAND MODE (Starts with >)
  if (query.startsWith(">")) {
    const searchTerm = query.substring(1).toLowerCase().trim();
    
    const filteredCommands = editorCommands.filter(cmd => 
      cmd.label.toLowerCase().includes(searchTerm)
    );
    
    filteredCommands.forEach(cmd => {
      const li = document.createElement("li");
      li.innerHTML = `<span style="margin-right: 8px;">${cmd.icon}</span> <span>${cmd.label}</span>`;
      li.onclick = () => {
        cmd.action();
        closePalette();
      };
      paletteResults.appendChild(li);
    });
  } 
  
  // FILE SEARCH MODE
  else {
    if (!projectFolder) {
      const li = document.createElement("li");
      li.innerHTML = `<span style="margin-right: 8px;">⚠️</span> <span style="color: #cbcb41">Please open a folder first.</span>`;
      paletteResults.appendChild(li);
      return;
    }

    const searchTerm = query.toLowerCase().trim();
    
    // Filter our cached files!
    const filteredFiles = cachedWorkspaceFiles.filter(f => 
      f.fullPath.toLowerCase().includes(searchTerm)
    ).slice(0, 50); // Limit to 50 results so the UI doesn't lag

    if (filteredFiles.length === 0) {
      const li = document.createElement("li");
      li.innerHTML = `<span style="margin-right: 8px;">❌</span> <span style="color: #858585">No matching files found.</span>`;
      paletteResults.appendChild(li);
    } else {
      filteredFiles.forEach(file => {
        const li = document.createElement("li");
        
        // Show the file name, and put the folder path in grey text next to it
        const folderPath = file.fullPath.replace(file.name, '');
        li.innerHTML = `
          <span style="margin-right: 8px;">${getFileIcon(file.name)}</span> 
          <span>${file.name}</span> 
          <span style="color: #858585; font-size: 11px; margin-left: auto;">${folderPath}</span>
        `;
        
        // When clicked, open the file and close the palette
        li.onclick = () => {
          openFile(file.fullPath, file.handle);
          closePalette();
        };
        paletteResults.appendChild(li);
      });
    }
  }
}

// Update results as you type!
if (paletteInput) {
  paletteInput.addEventListener("input", renderPaletteResults);
}

// 3. Global Keyboard Shortcuts (Ctrl+P, F1)
let _ctrlKPressed = false;
let _ctrlKTimer = null;

document.addEventListener('keydown', (e) => {
  const isCmdOrCtrl = e.ctrlKey || e.metaKey;

  // Ctrl+K chord detection
  if (isCmdOrCtrl && e.key.toLowerCase() === 'k' && !e.shiftKey && !e.altKey) {
    _ctrlKPressed = true;
    clearTimeout(_ctrlKTimer);
    _ctrlKTimer = setTimeout(() => { _ctrlKPressed = false; }, 1500);
    return;
  }
  if (_ctrlKPressed) {
    if (e.key.toLowerCase() === 't') {
      e.preventDefault();
      _ctrlKPressed = false;
      openThemePicker();
      return;
    }
    _ctrlKPressed = false;
  }

  // Ctrl + N → New File
  if (isCmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    createFile();
  }

  // Ctrl+Shift+F → Find in Files
  if (isCmdOrCtrl && e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openFindInFiles(activeEditor ? (() => { const sel = activeEditor.getSelection(); return sel && !sel.isEmpty() ? activeEditor.getModel().getValueInRange(sel) : ''; })() : '');
    return;
  }

  // Ctrl + P (File Search)
  if (isCmdOrCtrl && e.key.toLowerCase() === "p" && !e.shiftKey) {
    e.preventDefault(); 
    openPalette("");
  }
  
  // Ctrl + Shift + P OR F1 (Command Mode)
  if ((isCmdOrCtrl && e.shiftKey && e.key.toLowerCase() === "p") || e.key === "F1") {
    e.preventDefault(); 
    openPalette(">");
  }

  // Escape to close palette or context menu
  if (e.key === "Escape") {
    if (paletteOverlay && paletteOverlay.style.display === "flex") {
      e.preventDefault();
      closePalette();
    }
    const settingsOverlay = document.getElementById('settings-overlay');
    if (settingsOverlay && settingsOverlay.style.display === 'flex') { e.preventDefault(); window.closeSettings(); }
    const aboutOverlay = document.getElementById('about-overlay');
    if (aboutOverlay && aboutOverlay.style.display === 'flex') { e.preventDefault(); closeAbout(); }
    closeContextMenu();
  }

  // F2 → Rename focused context item
  if (e.key === "F2" && currentContextItem) {
    e.preventDefault();
    renameContextItem();
  }

  // Delete → Delete focused context item
  if (e.key === "Delete" && currentContextItem && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    deleteContextItem();
  }

  // Ctrl+Shift+` → New Terminal
  if (isCmdOrCtrl && e.shiftKey && e.key === '`') {
    e.preventDefault();
    terminalMenuNewTerminal();
  }

  // Ctrl+Shift+5 → Split Terminal
  if (isCmdOrCtrl && e.shiftKey && e.key === '5') {
    e.preventDefault();
    terminalMenuSplitTerminal();
  }

  // Ctrl+Shift+S → Save As
  if (isCmdOrCtrl && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    fileMenuSaveAs();
  }

  // Ctrl+F4 → Close Editor
  if (e.ctrlKey && e.key === 'F4') {
    e.preventDefault();
    fileMenuCloseEditor();
  }

  // Ctrl+B → Toggle Sidebar
  if (isCmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleSidebar();
  }

  // Alt+Z → Word Wrap
  if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    viewMenuWordWrap();
  }

  // Ctrl+G → Go to Line
  if (isCmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    goMenuGoToLine();
  }

  // Ctrl+D → Select next occurrence
  if (isCmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    selectionSelectNextOccurrence();
  }
});

// Close if clicking outside the box
if (paletteOverlay) {
  paletteOverlay.addEventListener("click", (e) => {
    if (e.target === paletteOverlay) closePalette();
  });
}

// 4. Recursive Scraper (Builds the search cache)
// Defined as a regular function so it is hoisted and callable from anywhere in the file
async function scrapeAllFiles(dirHandle, pathPrefix = "") {
  let files = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (name === 'node_modules' || name === '.git' || name === '.vscode') continue;
    const fullPath = pathPrefix ? `${pathPrefix}/${name}` : name;
    if (handle.kind === 'file') {
      files.push({ name, fullPath, handle });
    } else if (handle.kind === 'directory') {
      const subFiles = await scrapeAllFiles(handle, fullPath);
      files = files.concat(subFiles); 
    }
  }
  return files;
}
window.scrapeAllFiles = scrapeAllFiles; // also expose on window for inline onclick handlers

async function refreshFileCache() {
  if (!projectFolder) return;
  cachedWorkspaceFiles = await scrapeAllFiles(projectFolder);
}
window.refreshFileCache = refreshFileCache;

/* =========================================
   WEBCONTAINER INTEGRATION
   ========================================= */

// 1. The File System Translator (Reads your local files for the container)
async function buildContainerFileSystem(dirHandle) {
  const tree = {};
  
  for await (const [name, handle] of dirHandle.entries()) {
    // Skip heavy folders so we don't crash the browser
    if (name === 'node_modules' || name === '.git' || name === '.vscode') continue;

    if (handle.kind === 'file') {
      const fileData = await handle.getFile();
      const contents = await fileData.text();
      tree[name] = {
        file: {
          contents: contents
        }
      };
    } else if (handle.kind === 'directory') {
      tree[name] = {
        directory: await buildContainerFileSystem(handle)
      };
    }
  }
  return tree;
}

// Files that must be persisted to real disk whenever they change in WebContainer.
// Covers npm, yarn, pnpm, common config files, and env files.
const CRITICAL_FILES = [
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'index.html',
  '.env', '.env.local', '.env.production', '.env.development',
  'vite.config.js', 'vite.config.ts',
  'next.config.js', 'next.config.ts',
  'tsconfig.json', 'jsconfig.json',
  'eslint.config.js', 'eslint.config.ts', '.eslintrc.js', '.eslintrc.json',
  'tailwind.config.js', 'tailwind.config.ts',
  'postcss.config.js', 'postcss.config.ts',
  '.gitignore', 'README.md',
];

// Reads each critical file from WebContainer and writes it to the real disk folder.
// Called after npm install and on a periodic timer so manual terminal actions
// (npm install react, npm init, etc.) are always persisted.
// Finds all directories containing a package.json, up to 2 levels deep.
// Creates missing disk directories on the fly so container-only folders
// (like ones created by `npm create vite@latest`) get persisted too.
async function findProjectDirs(containerBase, diskDirHandle, depth = 0) {
  const results = [];
  if (depth > 2) return results;
  try {
    const entries = await webcontainerInstance.fs.readdir(containerBase);
    if (entries.includes('package.json')) {
      results.push({ containerPath: containerBase, diskHandle: diskDirHandle });
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === '.vscode') continue;
      const subContainer = `${containerBase}/${entry}`;
      try {
        // Verify it's actually a directory in the container before touching disk
        await webcontainerInstance.fs.readdir(subContainer);
        // Only create the disk dir when recursing — avoids creating every file entry
        const subDisk = await diskDirHandle.getDirectoryHandle(entry, { create: true });
        const sub = await findProjectDirs(subContainer, subDisk, depth + 1);
        results.push(...sub);
      } catch { /* not a directory — skip */ }
    }
  } catch { /* container path doesn't exist */ }
  return results;
}

async function syncCriticalFilesToDisk() {
  if (!webcontainerInstance || !projectFolder) return;

  const containerBase = `/${projectFolder.name}`;
  const projectDirs = await findProjectDirs(containerBase, projectFolder);

  if (projectDirs.length === 0) return;

  let saved = 0;

  // Recursively sync all files from a container dir to a disk dir,
  // skipping node_modules and .git
  async function syncDir(containerDir, diskDir) {
    let entries;
    try {
      entries = await webcontainerInstance.fs.readdir(containerDir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const containerPath = `${containerDir}/${entry.name}`;
      const isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : entry.type === 'directory';
      if (isDir) {
        try {
          const subDisk = await diskDir.getDirectoryHandle(entry.name, { create: true });
          await syncDir(containerPath, subDisk);
        } catch { /* skip */ }
      } else {
        try {
          const content = await webcontainerInstance.fs.readFile(containerPath, 'utf-8');
          const fh = await diskDir.getFileHandle(entry.name, { create: true });
          const w = await fh.createWritable();
          await w.write(content);
          await w.close();
          saved++;
        } catch { /* skip binary or unreadable files */ }
      }
    }
  }

  for (const { containerPath, diskHandle } of projectDirs) {
    // Always sync root-level critical files
    for (const filename of CRITICAL_FILES) {
      try {
        const content = await webcontainerInstance.fs.readFile(`${containerPath}/${filename}`, 'utf-8');
        const fh = await diskHandle.getFileHandle(filename, { create: true });
        const w = await fh.createWritable();
        await w.write(content);
        await w.close();
        saved++;
      } catch { /* file doesn't exist here — skip */ }
    }
    // Also sync src/ and public/ so JSX/CSS source files are persisted
    for (const sourceDir of ['src', 'public']) {
      try {
        const subDisk = await diskHandle.getDirectoryHandle(sourceDir, { create: true });
        await syncDir(`${containerPath}/${sourceDir}`, subDisk);
      } catch { /* dir doesn't exist — skip */ }
    }
  }

  if (saved > 0) console.log(`[Sync] Saved ${saved} file(s) to disk`);
}

// 2. The Boot Sequence
async function startWebContainer() {
  // 1. Prevent multiple boots
  if (webcontainerInstance) {
    // already running — just remount below
  } else {
    try {
      const { WebContainer } = await import('https://unpkg.com/@webcontainer/api');
      webcontainerInstance = await WebContainer.boot();
      webcontainerInstance.on('server-ready', (port, url) => {
        printToTerminal(`> 🚀 Server ready at ${url}`, "#89d185");
        const previewPane = document.getElementById("preview-pane");
        const iframe = document.getElementById("live-iframe");
        if (previewPane && iframe) {
          previewPane.style.display = "flex";
          previewMode = 'server';
          iframe.removeAttribute('sandbox');
          iframe.removeAttribute('srcdoc');
          iframe.src = url;
          setTimeout(() => {
            if (previewMode === 'server' && iframe.src === url) {
              iframe.src = url;
            }
          }, 3000);
        }
      });
    } catch (error) {
      printToTerminal(`> WebContainer boot failed: ${error.message}`, "#f48771");
      return;
    }
  }

  try {
    if (projectFolder) {
      const fileSystemTree = await buildContainerFileSystem(projectFolder);
      const wrappedTree = {};
      wrappedTree[projectFolder.name] = { directory: fileSystemTree };
      
      await webcontainerInstance.mount(wrappedTree);
      await syncCriticalFilesToDisk();

      // Watch filesystem only for tree refresh
      let refreshDebounce = null;
      webcontainerInstance.fs.watch('/', { recursive: true }, () => {
        if (isSyncingFile) return;
        clearTimeout(refreshDebounce);
        refreshDebounce = setTimeout(async () => {
          const treeRoot = document.getElementById('tree-root');
          if (treeRoot && projectFolder) {
            treeRoot.innerHTML = '';
            await renderVirtualTree(`/${projectFolder.name}`, treeRoot);
          }
        }, 800);
      });

      // Periodically sync critical files to disk while the container is running.
      const syncInterval = setInterval(() => {
        if (webcontainerInstance && projectFolder) {
          syncCriticalFilesToDisk();
        } else {
          clearInterval(syncInterval);
        }
      }, 8000);

      const treeRoot = document.getElementById("tree-root");
  if (treeRoot) {
    treeRoot.innerHTML = ""; // Clear the local Chromebook view
    // Start the virtual view using the project name as the root path
    await renderVirtualTree(`/${projectFolder.name}`, treeRoot);
  }
    }

    // 3. Spawn jsh with cwd and PS1 set via env — no commands sent through
    // shellWriter during startup, which was causing jsh's readline to corrupt
    const shellProcess = await webcontainerInstance.spawn('jsh', {
      terminal: { cols: term.cols, rows: term.rows },
      cwd: projectFolder ? `/${projectFolder.name}` : '/',
      env: { PS1: projectFolder ? `~/${projectFolder.name} $ ` : '$ ' }
    });

    shellProcess.output.pipeTo(
      new WritableStream({
        write(data) { term.write(data); }
      })
    ).catch(() => {});

    // FIX: Assign to the GLOBAL variable we created at the top
    shellWriter = shellProcess.input.getWriter();

    // After jsh is ready, scan for sub-projects that need npm install
    // and print the exact commands to run — never auto-run them
    setTimeout(async () => {
      if (!projectFolder || !webcontainerInstance) return;
      try {
        const entries = await webcontainerInstance.fs.readdir(`/${projectFolder.name}`);
        const dirsToInstall = [];

        // Check root level
        if (entries.includes('package.json') && !entries.includes('node_modules')) {
          dirsToInstall.push(`/${projectFolder.name}`);
        }
        // Check one level deep
        for (const entry of entries) {
          if (entry === 'node_modules' || entry === '.git') continue;
          const subPath = `/${projectFolder.name}/${entry}`;
          try {
            const subEntries = await webcontainerInstance.fs.readdir(subPath);
            if (subEntries.includes('package.json') && !subEntries.includes('node_modules')) {
              dirsToInstall.push(subPath);
            }
          } catch { /* not a dir */ }
        }

        // Run npm install in each dir as a separate spawn — never through jsh
        // so the shell stays fully interactive the whole time
        if (dirsToInstall.length > 0 && shellWriter) {
          // Clear immediately so the jsh prompt never flashes up
          shellWriter.write('clear\r');
        }
        for (const cwd of dirsToInstall) {
          const proc = await webcontainerInstance.spawn('npm', ['install'], { cwd });
          proc.output.pipeTo(new WritableStream({ write(d) { term.write(d); } })).catch(() => {});
          const code = await proc.exit;
          if (code !== 0) {
            printToTerminal(`> npm install failed in ${cwd} (exit ${code})`, "#f48771");
          } else {
            await syncCriticalFilesToDisk();
          }
        }

        // Clear once more after all installs and redraw the clean prompt
        if (dirsToInstall.length > 0 && shellWriter) {
          setTimeout(() => {
            shellWriter.write('clear\r');
          }, 100);
        }
      } catch { /* ignore */ }
    }, 1000);
    // to prevent keystrokes being sent to the shell multiple times on reconnect
    if (termDataDisposable) {
      termDataDisposable.dispose();
      termDataDisposable = null;
    }
    termDataDisposable = term.onData((data) => {
      if (shellWriter) {
        shellWriter.write(data);
      }
    });

    term.onResize((size) => {
      if (shellProcess) {
        shellProcess.resize({ cols: size.cols, rows: size.rows });
      }
    });

  } catch (error) {
    printToTerminal(`> Shell Error: ${error.message}`, "#f48771");
  }
}

async function renderVirtualTree(path = '/', parentElement) {
  if (!webcontainerInstance) return;

  try {
    const entries = await webcontainerInstance.fs.readdir(path, { withFileTypes: true });

    const isDir = (entry) => {
      if (typeof entry.isDirectory === 'function') return entry.isDirectory();
      return entry.type === 'directory';
    };

    entries.sort((a, b) => {
      if (isDir(a) === isDir(b)) return a.name.localeCompare(b.name);
      return isDir(a) ? -1 : 1;
    });

    for (const entry of entries) {
      if (entry.name === '.git') continue;

      const fullPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
      // parentPath for context menu — the containing directory
      const parentPath = path;

      if (isDir(entry)) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        const folderIcon = entry.name === 'node_modules' ? '📦' : '📁';
        summary.innerHTML = `${getFolderIcon(entry.name, false)} <span>${entry.name}</span>`;

        summary.oncontextmenu = (e) => {
          e.preventDefault(); e.stopPropagation();
          currentContextItem = { type: 'directory', name: entry.name, handle: null, parentHandle: null, fullPath, parentPath, virtual: true };
          showContextMenu(e, 'directory', entry.name, null, null, fullPath);
        };
        
        const childrenContainer = document.createElement('div');
        childrenContainer.style.paddingLeft = "12px"; 
        
        details.append(summary, childrenContainer);
        parentElement.appendChild(details);

        let isLoaded = false;

        details.addEventListener('toggle', async () => {
          summary.innerHTML = `${getFolderIcon(entry.name, details.open)} <span>${entry.name}</span>`;
          if (details.open && !isLoaded) {
            isLoaded = true;
            childrenContainer.innerHTML = "<div style='color:#858585; font-size:12px;'>Loading...</div>";
            await new Promise(resolve => setTimeout(resolve, 100));
            childrenContainer.innerHTML = ''; 
            await renderVirtualTree(fullPath, childrenContainer);
          }
        });

      } else {
        const fileDiv = document.createElement('div');
        fileDiv.className = 'file-item';
        fileDiv.innerHTML = getFileIcon(entry.name) + `<span style="margin-left:5px;">${entry.name}</span>`;

        fileDiv.oncontextmenu = (e) => {
          e.preventDefault(); e.stopPropagation();
          currentContextItem = { type: 'file', name: entry.name, handle: null, parentHandle: null, fullPath, parentPath, virtual: true };
          showContextMenu(e, 'file', entry.name, null, null, fullPath);
        };
        
        fileDiv.onclick = async () => {
           if (!activeEditor) return;
           try {
             const fileContent = await webcontainerInstance.fs.readFile(fullPath, 'utf-8');
             openFiles[fullPath] = { handle: null, content: fileContent, unsaved: false };
             if (activeEditor === editor1) currentFile1 = fullPath;
             else currentFile2 = fullPath;
             isProgrammaticEdit = true;
             activeEditor.setValue(fileContent);
             isProgrammaticEdit = false;
             const lang = getLanguageForFile(entry.name);
             monaco.editor.setModelLanguage(activeEditor.getModel(), lang);
             document.getElementById("status-lang").innerText = lang.charAt(0).toUpperCase() + lang.slice(1);
             renderTabs();
           } catch (err) {
             printToTerminal(`[Error] Could not open virtual file: ${err.message}`, "#f48771");
           }
        };
        
        parentElement.appendChild(fileDiv);
      }
    }
  } catch (error) {
    console.error("Error reading virtual directory:", error);
  }
}
/* =========================================
   TERMINAL FONT SIZE
   ========================================= */
let termFontSize = 13;

function terminalFontSize(delta) {
  termFontSize = Math.max(8, Math.min(24, termFontSize + delta));
  term.options.fontSize = termFontSize;
  fitAddon.fit();
  const lbl = document.getElementById('term-font-label');
  if (lbl) lbl.textContent = termFontSize;
}

/* =========================================
   FIND IN FILES
   ========================================= */

let fifState = { case: false, word: false, regex: false };
let fifSearchTimeout = null;
let fifResults = []; // [{ filePath, handle, matches: [{line, col, text, matchStart, matchLen}] }]

function openFindInFiles(prefill = '') {
  const panel = document.getElementById('find-in-files-panel');
  if (!panel) return;

  // Move panel into the sidebar container so it overlays the file tree
  const sidebar = document.getElementById('sidebar');
  if (sidebar && panel.parentElement !== sidebar) {
    sidebar.appendChild(panel);
  }

  // Make sidebar visible if collapsed
  if (window._sidebarToggle && sidebar && sidebar.style.width === '0px') {
    window._sidebarToggle();
  }

  panel.style.display = 'flex';

  const input = document.getElementById('fif-query');
  if (input) {
    if (prefill) input.value = prefill;
    input.focus();
    input.select();
  }
  if (prefill) fifDebounceSearch();
}

function closeFindInFiles() {
  const panel = document.getElementById('find-in-files-panel');
  if (panel) panel.style.display = 'none';
}

function fifToggle(key) {
  fifState[key] = !fifState[key];
  const btn = document.getElementById(`fif-btn-${key}`);
  if (btn) btn.dataset.active = String(fifState[key]);
  fifDebounceSearch();
}

function fifOnInput() { fifDebounceSearch(); }

function fifDebounceSearch() {
  clearTimeout(fifSearchTimeout);
  fifSearchTimeout = setTimeout(fifRunSearch, 250);
}

function fifKeyDown(e) {
  if (e.key === 'Enter') { e.preventDefault(); fifRunSearch(); }
  if (e.key === 'Escape') { e.preventDefault(); closeFindInFiles(); }
  if (e.altKey && e.key.toLowerCase() === 'c') fifToggle('case');
  if (e.altKey && e.key.toLowerCase() === 'w') fifToggle('word');
  if (e.altKey && e.key.toLowerCase() === 'r') fifToggle('regex');
}

function fifReplaceKeyDown(e) {
  if (e.key === 'Enter') { e.preventDefault(); fifReplaceAll(); }
}

async function fifRunSearch() {
  const query = document.getElementById('fif-query')?.value || '';
  const includeGlob = document.getElementById('fif-include')?.value?.trim() || '';
  const resultsEl = document.getElementById('fif-results');
  const metaEl = document.getElementById('fif-meta');
  if (!resultsEl) return;

  if (!query) {
    resultsEl.innerHTML = '';
    if (metaEl) metaEl.textContent = '';
    return;
  }

  if (!projectFolder && !webcontainerInstance) {
    resultsEl.innerHTML = `<div class="fif-empty">Open a folder first.</div>`;
    return;
  }

  if (metaEl) metaEl.textContent = 'Searching…';
  resultsEl.innerHTML = `<div class="fif-empty fif-searching">
    <div class="fif-spinner"></div> Searching…
  </div>`;

  // Build regex
  let pattern;
  try {
    if (fifState.regex) {
      pattern = new RegExp(query, fifState.case ? 'g' : 'gi');
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wordBoundary = fifState.word ? '\\b' : '';
      pattern = new RegExp(`${wordBoundary}${escaped}${wordBoundary}`, fifState.case ? 'g' : 'gi');
    }
  } catch {
    resultsEl.innerHTML = `<div class="fif-empty">Invalid regular expression.</div>`;
    if (metaEl) metaEl.textContent = '';
    return;
  }

  // Gather files
  let files = [];
  if (webcontainerInstance && projectFolder) {
    files = await fifGatherVirtualFiles(`/${projectFolder.name}`, includeGlob);
  } else if (projectFolder) {
    files = cachedWorkspaceFiles.filter(f => fifMatchGlob(f.fullPath, includeGlob));
  }

  // Search each file
  fifResults = [];
  let totalMatches = 0;
  const MAX_FILES = 500;

  for (const file of files.slice(0, MAX_FILES)) {
    let text = '';
    try {
      if (webcontainerInstance) {
        text = await webcontainerInstance.fs.readFile(file.fullPath, 'utf-8');
      } else {
        const f = await file.handle.getFile();
        text = await f.text();
      }
    } catch { continue; }

    const lines = text.split('\n');
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      pattern.lastIndex = 0;
      let m;
      const line = lines[i];
      while ((m = pattern.exec(line)) !== null) {
        matches.push({ line: i + 1, col: m.index + 1, text: line, matchStart: m.index, matchLen: m[0].length });
        if (!pattern.global) break;
      }
    }
    if (matches.length > 0) {
      fifResults.push({ filePath: file.fullPath, handle: file.handle || null, matches });
      totalMatches += matches.length;
    }
  }

  // Render
  if (metaEl) {
    if (fifResults.length === 0) {
      metaEl.textContent = 'No results';
    } else {
      metaEl.textContent = `${totalMatches} result${totalMatches !== 1 ? 's' : ''} in ${fifResults.length} file${fifResults.length !== 1 ? 's' : ''}`;
    }
  }
  fifRenderResults(pattern);
}

function fifRenderResults(pattern) {
  const el = document.getElementById('fif-results');
  if (!el) return;
  if (fifResults.length === 0) {
    el.innerHTML = `<div class="fif-empty">No results found.</div>`;
    return;
  }
  el.innerHTML = '';

  for (const fileResult of fifResults) {
    const fileName = fileResult.filePath.split('/').pop();
    const dirPath  = fileResult.filePath.substring(0, fileResult.filePath.lastIndexOf('/'));

    const fileBlock = document.createElement('div');
    fileBlock.className = 'fif-file-block';

    const fileHeader = document.createElement('div');
    fileHeader.className = 'fif-file-header';
    fileHeader.innerHTML = `
      <span class="fif-file-arrow">▾</span>
      ${getFileIcon(fileName)}
      <span class="fif-file-name">${fileName}</span>
      <span class="fif-file-dir">${dirPath}</span>
      <span class="fif-match-count">${fileResult.matches.length}</span>
    `;
    fileHeader.onclick = () => {
      fileBlock.classList.toggle('collapsed');
      fileHeader.querySelector('.fif-file-arrow').textContent =
        fileBlock.classList.contains('collapsed') ? '▸' : '▾';
    };

    const matchList = document.createElement('div');
    matchList.className = 'fif-match-list';

    for (const match of fileResult.matches) {
      const row = document.createElement('div');
      row.className = 'fif-match-row';

      const lineNum = document.createElement('span');
      lineNum.className = 'fif-line-num';
      lineNum.textContent = match.line;

      const lineText = document.createElement('span');
      lineText.className = 'fif-line-text';

      // Highlight matched portion
      const pre  = escHtml(match.text.slice(0, match.matchStart));
      const hit  = escHtml(match.text.slice(match.matchStart, match.matchStart + match.matchLen));
      const post = escHtml(match.text.slice(match.matchStart + match.matchLen));
      lineText.innerHTML = `${pre}<mark class="fif-highlight">${hit}</mark>${post}`;

      row.appendChild(lineNum);
      row.appendChild(lineText);

      // Click: open file and jump to line
      row.onclick = () => fifOpenMatch(fileResult, match);
      matchList.appendChild(row);
    }

    fileBlock.appendChild(fileHeader);
    fileBlock.appendChild(matchList);
    el.appendChild(fileBlock);
  }
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function fifOpenMatch(fileResult, match) {
  const { filePath, handle } = fileResult;
  // Open or switch to the file
  if (openFiles[filePath]) {
    await switchTab(filePath);
  } else if (handle) {
    await openFile(filePath, handle);
  } else if (webcontainerInstance) {
    try {
      const content = await webcontainerInstance.fs.readFile(filePath, 'utf-8');
      openFiles[filePath] = { handle: null, content, unsaved: false };
      if (activeEditor === editor1) currentFile1 = filePath;
      else currentFile2 = filePath;
      isProgrammaticEdit = true;
      activeEditor.setValue(content);
      isProgrammaticEdit = false;
      const lang = getLanguageForFile(filePath.split('/').pop());
      monaco.editor.setModelLanguage(activeEditor.getModel(), lang);
      document.getElementById('status-lang').innerText = lang.charAt(0).toUpperCase() + lang.slice(1);
      renderTabs();
    } catch(e) { printToTerminal(`[Error] ${e.message}`, '#f48771'); return; }
  } else { return; }

  // Jump to line & highlight
  setTimeout(() => {
    if (!activeEditor) return;
    activeEditor.revealLineInCenter(match.line);
    activeEditor.setSelection(new monaco.Range(match.line, match.col, match.line, match.col + match.matchLen));
    activeEditor.focus();
  }, 80);
}

async function fifReplaceAll() {
  const query   = document.getElementById('fif-query')?.value   || '';
  const replace = document.getElementById('fif-replace')?.value ?? '';
  if (!query || fifResults.length === 0) return;
  if (!confirm(`Replace ${fifResults.reduce((s,f)=>s+f.matches.length,0)} occurrence(s) across ${fifResults.length} file(s)?`)) return;

  let changed = 0;
  for (const fileResult of fifResults) {
    const { filePath, handle } = fileResult;
    let content = openFiles[filePath]?.content;
    if (!content) {
      try {
        if (handle) { const f = await handle.getFile(); content = await f.text(); }
        else if (webcontainerInstance) content = await webcontainerInstance.fs.readFile(filePath, 'utf-8');
      } catch { continue; }
    }
    let pattern;
    try {
      if (fifState.regex) pattern = new RegExp(query, fifState.case ? 'g' : 'gi');
      else {
        const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wb  = fifState.word ? '\\b' : '';
        pattern = new RegExp(`${wb}${esc}${wb}`, fifState.case ? 'g' : 'gi');
      }
    } catch { continue; }
    const newContent = content.replace(pattern, replace);
    if (newContent === content) continue;
    if (openFiles[filePath]) {
      openFiles[filePath].content = newContent;
      openFiles[filePath].unsaved = true;
      if (currentFile1 === filePath) { isProgrammaticEdit = true; editor1.setValue(newContent); isProgrammaticEdit = false; }
      if (currentFile2 === filePath) { isProgrammaticEdit = true; editor2.setValue(newContent); isProgrammaticEdit = false; }
    }
    await saveFile(filePath, newContent);
    changed++;
  }
  renderTabs();
  printToOutput(`Replace all: updated ${changed} file(s).`, '#89d185');
  fifRunSearch();
}

function fifCollapseAll() {
  document.querySelectorAll('.fif-file-block').forEach(b => {
    b.classList.add('collapsed');
    const arrow = b.querySelector('.fif-file-arrow');
    if (arrow) arrow.textContent = '▸';
  });
}

function fifClear() {
  const q = document.getElementById('fif-query');
  const r = document.getElementById('fif-replace');
  const m = document.getElementById('fif-meta');
  if (q) q.value = '';
  if (r) r.value = '';
  if (m) m.textContent = '';
  fifResults = [];
  const el = document.getElementById('fif-results');
  if (el) el.innerHTML = '';
}

async function fifGatherVirtualFiles(path, includeGlob) {
  const files = [];
  try {
    const entries = await webcontainerInstance.fs.readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const fullPath = `${path}/${entry.name}`;
      const isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : entry.type === 'directory';
      if (isDir) {
        const sub = await fifGatherVirtualFiles(fullPath, includeGlob);
        files.push(...sub);
      } else {
        if (fifMatchGlob(fullPath, includeGlob)) files.push({ fullPath, handle: null });
      }
    }
  } catch { /* skip */ }
  return files;
}

function fifMatchGlob(filePath, pattern) {
  if (!pattern) return true;
  // Support comma-separated patterns like "*.js, src/"
  const parts = pattern.split(',').map(p => p.trim()).filter(Boolean);
  return parts.some(p => {
    if (p.endsWith('/')) return filePath.includes('/' + p.slice(0, -1) + '/') || filePath.includes('/' + p.slice(0, -1) + '\\');
    const re = new RegExp('^' + p.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return re.test(filePath.split('/').pop()) || filePath.includes(p);
  });
}