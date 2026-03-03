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
let cachedWorkspaceFiles = [];
let webcontainerInstance = null;
let termDataDisposable = null;
let isSyncingFile = false; // Suppresses fs.watch tree refresh during our own programmatic saves
let previewMode = null;   // 'srcdoc' | 'server' — tracks what the preview iframe is showing


/* MOBILE & UI LOGIC */
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
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
  document.getElementById("context-menu").classList.remove('active');
});

/* CONTEXT MENU LOGIC */
function showContextMenu(e, type, name, handle, parentHandle, fullPath) {
  e.preventDefault(); e.stopPropagation();
  currentContextItem = { type, name, handle, parentHandle, fullPath };
  const ctxMenu = document.getElementById("context-menu");
  ctxMenu.style.left = e.pageX + "px";
  ctxMenu.style.top = e.pageY + "px";
  ctxMenu.classList.add("active");
}

async function deleteContextItem() {
  if(!currentContextItem) return;
  const { name, parentHandle, fullPath, type } = currentContextItem;
  
  if(confirm(`Are you sure you want to delete '${name}'?`)) {
    try {
      await parentHandle.removeEntry(name, { recursive: type === 'directory' });
      
      // If the deleted file was open, remove it from the editor
      if(openFiles[fullPath]) {
        delete openFiles[fullPath];
        if(currentFile1 === fullPath) currentFile1 = null;
        if(currentFile2 === fullPath) currentFile2 = null;
        renderTabs();
      }
      
      const treeRoot = document.getElementById("tree-root");
      if (treeRoot) {
        treeRoot.innerHTML = ""; 
        await renderFileTree(projectFolder, treeRoot); 
      }
      
      refreshFileCache();
      printToTerminal(`[System] Deleted: ${name}`, "#89d185");
    } catch(e) {
      printToTerminal(`[Error] Deleting: ${e.message}`, "#f48771");
    }
  }
}

async function createFolder() {
  if(!projectFolder) return;
  const name = prompt("Folder name:");
  if(!name) return;
  
  try {
    await projectFolder.getDirectoryHandle(name, { create: true });
    const treeRoot = document.getElementById("tree-root");
    treeRoot.innerHTML = "";
    await renderFileTree(projectFolder, treeRoot);
    printToTerminal(`Created folder: ${name}`, "#89d185");
  } catch (err) {
    printToTerminal(`Error: ${err.message}`, "#f48771");
  }
}

async function renameContextItem() {
  if(!currentContextItem) return;
  const { name, handle, parentHandle, fullPath, type } = currentContextItem;
  
  if(type === 'directory') {
    printToTerminal("[System] Renaming folders is not supported yet.", "#f48771");
    return;
  }

  const newName = prompt(`Rename '${name}' to:`, name);
  if(!newName || newName === name) return;

  try {
    const file = await handle.getFile();
    const content = await file.text();
    
    // Create the new file with the new name
    const newHandle = await parentHandle.getFileHandle(newName, { create: true });
    const writable = await newHandle.createWritable();
    await writable.write(content);
    await writable.close();
    
    // Delete the old file
    await parentHandle.removeEntry(name);
    
    // Update the editor state if the file was currently open
    if(openFiles[fullPath]) {
      const newPath = fullPath.substring(0, fullPath.lastIndexOf('/') + 1) + newName;
      openFiles[newPath] = { handle: newHandle, content, unsaved: openFiles[fullPath].unsaved };
      delete openFiles[fullPath];
      
      if(currentFile1 === fullPath) currentFile1 = newPath;
      if(currentFile2 === fullPath) currentFile2 = newPath;
    }

    // Refresh the UI safely!
    const treeRoot = document.getElementById("tree-root");
    if (treeRoot) {
        treeRoot.innerHTML = ""; // Clear the old tree
        await renderFileTree(projectFolder, treeRoot); // Load the new tree
    }
    
    renderTabs();
    refreshFileCache(); // Update the Ctrl+P search cache
    
    printToTerminal(`[System] Renamed '${name}' to '${newName}'`, "#89d185");
  } catch(e) {
    printToTerminal(`[Error] Renaming: ${e.message}`, "#f48771");
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

function getFileIcon(filename) {
  if (filename.endsWith('.html')) return '<span class="file-icon" style="color:#e34c26">&lt;&gt;</span>';
  if (filename.endsWith('.js')) return '<span class="file-icon" style="color:#f1e05a">JS</span>';
  if (filename.endsWith('.css')) return '<span class="file-icon" style="color:#563d7c">#</span>';
  if (filename.endsWith('.json')) return '<span class="file-icon" style="color:#cbcb41">{}</span>';
  return '<span class="file-icon" style="color:#cccccc">📄</span>';
}

/* MONACO INIT (DUAL EDITORS) */
require.config({ paths: { vs: "https://unpkg.com/monaco-editor@0.45.0/min/vs" } });
require(["vs/editor/editor.main"], function () {
  const commonConfig = { language: "javascript", theme: "vs-dark", automaticLayout: true, minimap: { enabled: false } };
  
  editor1 = monaco.editor.create(document.getElementById("editor1"), { value: "// Editor 1\n// Open a folder to start", ...commonConfig });
  editor2 = monaco.editor.create(document.getElementById("editor2"), { value: "// Editor 2", ...commonConfig });

  // NEW: Shift + Alt + F to Format
  editor1.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => window.formatCode());
  editor2.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => window.formatCode());
  activeEditor = editor1;

  editor1.onDidFocusEditorText(() => { activeEditor = editor1; });
  editor2.onDidFocusEditorText(() => { activeEditor = editor2; });

  // NEW: Update Status Bar Cursor Position
  const updateCursor = (e) => {
    document.getElementById("cursor-position").innerText = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  };
  editor1.onDidChangeCursorPosition(updateCursor);
  editor2.onDidChangeCursorPosition(updateCursor);

  editor1.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, triggerManualSave);
  editor2.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, triggerManualSave);

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
        saveTimeout = setTimeout(() => { saveFile(fileToSave, ed.getValue()); }, 1000);
      }
    });
  };

  setupChangeListener(editor1, 1);
  setupChangeListener(editor2, 2);
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
    document.querySelector('.search-bar').innerText = `🔍 ${projectFolder.name}`;
    
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
    
    printToTerminal(`> Opened: ${fullPath}`, "#858585"); 
    
  } catch (err) {
    printToTerminal(`[Error] Could not open file: ${err.message}`, "#f48771");
    console.error(err);
  }
}

/* CREATE FILE */
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

/* MASTER SAVE */
async function saveFile(path, content) {
  try {
    const data = openFiles[path];
    if (!data) return;

    if (data.handle === null) {
      // Virtual file — lives in WebContainer memory only, no local disk handle
      if (webcontainerInstance) {
        isSyncingFile = true;
        await webcontainerInstance.fs.writeFile(path, content);
        isSyncingFile = false;
        data.content = content;
        data.unsaved = false;
        renderTabs();
        updatePreviewIfOpen();
      }
      return;
    }

    // Normal local file — write through the File System Access API handle
    const writable = await data.handle.createWritable();
    await writable.write(content);
    await writable.close();
    
    data.unsaved = false;
    renderTabs();

    // Also sync to WebContainer if it's running so the dev server sees the change
    if (webcontainerInstance) {
      try {
        isSyncingFile = true;
        const containerPath = `${projectFolder.name}/${path}`;
        await webcontainerInstance.fs.writeFile(containerPath, content);
        isSyncingFile = false;
      } catch (wcErr) {
        isSyncingFile = false;
        console.warn("Could not sync file to WebContainer:", wcErr);
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
    tab.innerHTML = getFileIcon(fileName) + `<span class="tab-name" style="margin-left: 5px;">${fileName}</span>`;

    const closeBtn = document.createElement("span");
    closeBtn.textContent = "×";
    closeBtn.className = "close";
    closeBtn.onclick = (e) => { e.stopPropagation(); closeTab(fullPath); };
    tab.appendChild(closeBtn);

    tab.onclick = () => switchTab(fullPath);
    tabs.appendChild(tab);
  }
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
  if(currentFile1 === fullPath) await saveFile(fullPath, editor1.getValue());
  else if(currentFile2 === fullPath) await saveFile(fullPath, editor2.getValue());
  else await saveFile(fullPath, openFiles[fullPath].content);

  delete openFiles[fullPath];
  
  if(currentFile1 === fullPath) {
    currentFile1 = null;
    isProgrammaticEdit = true;
    editor1.setValue("// Closed");
    isProgrammaticEdit = false;
  }
  if(currentFile2 === fullPath) {
    currentFile2 = null;
    isProgrammaticEdit = true;
    editor2.setValue("// Closed");
    isProgrammaticEdit = false;
  }
  
  renderTabs();
  document.getElementById("cursor-position").innerText = "Ln 1, Col 1";
}

// Helper to simulate delays for a realistic feel
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function printToTerminal(text, color = "default") {
  let colorCode = "\x1b[37m"; 
  if (color === "#f48771") colorCode = "\x1b[31m"; 
  if (color === "#89d185") colorCode = "\x1b[32m"; 
  if (color === "#569cd6") colorCode = "\x1b[34m"; 
  if (color === "#cbcb41") colorCode = "\x1b[33m"; 

  const formattedText = String(text).replace(/\n/g, '\r\n');
  term.write(`\r\n${colorCode}${formattedText}\x1b[0m\r\n`);
}

function runCode(){
  const currentFile = activeEditor === editor1 ? currentFile1 : currentFile2;
  if(currentFile && !currentFile.endsWith('.js')) {
    printToTerminal("Error: Only JavaScript (.js) files can be run.", "#f48771");
    return;
  }
  try {
    printToTerminal("> Running JS code...", "#569cd6");
    const oldLog = console.log;
    console.log = (...args) => {
      printToTerminal(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" "));
    };
    eval(activeEditor.getValue());
    console.log = oldLog;
  } catch(e) {
    printToTerminal("Error: " + e.message, "#f48771");
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
  if (currentFile.endsWith('.js')) {
    codeToRun = `<!DOCTYPE html><html><body><script>${codeToRun}<\/script></body></html>`;
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
    codeToRun = `<!DOCTYPE html><html><body><script>${codeToRun}<\/script></body></html>`;
  } else {
    const blob = new Blob([codeToRun], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);
    codeToRun = codeToRun.replace(/(<head[^>]*>)/i, `$1<base href="${blobUrl}">`);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
  }
  
  document.getElementById("live-iframe").srcdoc = codeToRun;
}

/* SERVICE WORKER */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`./sw.js?v=${new Date().getTime()}`)
      .then(reg => console.log('PWA Service Worker registered!', reg))
      .catch(err => console.log('PWA Registration failed:', err));
  });
} // <--- WE CLOSE THE SERVICE WORKER BLOCK HERE!

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
      // Give node_modules a distinct icon so it's obvious
      const folderIcon = name === 'node_modules' ? '📦' : '📁';
      summary.innerHTML = `<span class="file-icon">${folderIcon}</span> ${name}`;
      
      summary.oncontextmenu = (e) => showContextMenu(e, 'directory', name, handle, dirHandle, fullPath);
      
      const childrenContainer = document.createElement('div');
      childrenContainer.style.paddingLeft = "12px";
      
      details.append(summary, childrenContainer);
      parentElement.appendChild(details);

      let isLoaded = false;
      details.addEventListener('toggle', async () => {
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
  const storedHandle = await idbKeyval.get('workspaceHandle');
  if (storedHandle) {
    const tree = document.getElementById("fileTree");
    tree.innerHTML = `
      <div style="padding: 15px; text-align: center;">
        <div style="color: var(--text-muted); margin-bottom: 10px; font-size: 12px;">Previous session found:</div>
        <button class="open-folder-btn" onclick="window.restoreWorkspace()">
          🔌 Reconnect to '${storedHandle.name}'
        </button>
        <button class="open-folder-btn" style="background: transparent; border: 1px solid var(--border); margin-top: 10px;" onclick="openFolder()">
          Open Different Folder
        </button>
      </div>
      <div id="tree-root"></div>
    `;
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
    document.querySelector('.search-bar').innerText = `🔍 ${projectFolder.name}`;
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
  refreshFileCache();
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
  { label: "Format Document", action: window.formatCode, icon: "✨" },
  { label: "View: Toggle Split Editor", action: toggleSplit, icon: "◫" },
  { label: "View: Toggle Sidebar", action: toggleSidebar, icon: "🗂️" },
  { label: "Terminal: Clear", action: () => term.clear(), icon: "🧹" },
  { label: "Live Preview: Start", action: previewHTML, icon: "🌐" },
  { label: "Live Preview: Stop", action: closePreview, icon: "❌" }
];

// 1. Open and Close Functions
window.openPalette = function(prefix = "") {
  const paletteOverlay = document.getElementById("command-palette");
  const paletteInput = document.getElementById("palette-input");

  if (!paletteOverlay || !paletteInput) return;

  paletteOverlay.style.display = "flex"; // Matches your flex CSS
  paletteInput.value = prefix;
  paletteInput.focus();
  
  // Trigger initial render for commands if '>' is passed
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
document.addEventListener("keydown", (e) => {
  const isCmdOrCtrl = e.ctrlKey || e.metaKey;

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

  // Escape to close
  if (e.key === "Escape" && paletteOverlay && paletteOverlay.style.display === "flex") {
    e.preventDefault();
    closePalette();
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

// 2. The Boot Sequence
async function startWebContainer() {
  // 1. Prevent multiple boots
  if (webcontainerInstance) {
    printToTerminal("> WebContainer already running. Updating workspace...", "#858585");
  } else {
    printToTerminal("> Downloading WebContainer engine...", "#569cd6");
    try {
      const { WebContainer } = await import('https://unpkg.com/@webcontainer/api');
      printToTerminal("> Booting Node.js environment...", "#569cd6");
      webcontainerInstance = await WebContainer.boot();
      webcontainerInstance.on('server-ready', (port, url) => {
        printToTerminal(`> 🚀 Server ready at ${url}`, "#89d185");
        const previewPane = document.getElementById("preview-pane");
        const iframe = document.getElementById("live-iframe");
        if (previewPane && iframe) {
          previewPane.style.display = "flex";
          previewMode = 'server';
          iframe.removeAttribute('srcdoc'); // clear any previous srcdoc content
          iframe.src = url;
        }
      });
    } catch (error) {
      printToTerminal(`> WebContainer boot failed: ${error.message}`, "#f48771");
      return;
    }
  }

  try {
    // 2. Clear terminal and mount files
    term.clear();
    if (projectFolder) {
      printToTerminal("> Mounting files...", "#569cd6");
      const fileSystemTree = await buildContainerFileSystem(projectFolder);
      const wrappedTree = {};
      wrappedTree[projectFolder.name] = { directory: fileSystemTree };
      
      await webcontainerInstance.mount(wrappedTree);
      printToTerminal("> Workspace files mounted successfully!", "#89d185");

      // Watch the virtual filesystem for any changes (npm install, file creation, etc.)
      // and debounce a full tree refresh so the explorer stays up to date automatically.
      let refreshDebounce = null;
      webcontainerInstance.fs.watch(
        '/',
        { recursive: true },
        () => {
          // Ignore changes we triggered ourselves (saves/syncs) — only react to
          // external writes like npm install adding files to node_modules
          if (isSyncingFile) return;
          clearTimeout(refreshDebounce);
          refreshDebounce = setTimeout(async () => {
            const treeRoot = document.getElementById('tree-root');
            if (treeRoot && projectFolder) {
              treeRoot.innerHTML = '';
              await renderVirtualTree(`/${projectFolder.name}`, treeRoot);
            }
          }, 800);
        }
      );

      const treeRoot = document.getElementById("tree-root");
  if (treeRoot) {
    treeRoot.innerHTML = ""; // Clear the local Chromebook view
    // Start the virtual view using the project name as the root path
    await renderVirtualTree(`/${projectFolder.name}`, treeRoot);
  }
    }

    // 3. Spawn with explicit terminal dimensions
    const shellProcess = await webcontainerInstance.spawn('jsh', {
      terminal: {
        cols: term.cols,
        rows: term.rows,
      }
    });

    shellProcess.output.pipeTo(
      new WritableStream({
        write(data) { term.write(data); }
      })
    );

    // FIX: Assign to the GLOBAL variable we created at the top
    shellWriter = shellProcess.input.getWriter();

    // 4. The "Safe-Start" Sequence
    setTimeout(async () => {
      if (projectFolder && shellWriter) {
        // FIX: Changed 'input' to 'shellWriter'
        await shellWriter.write(`export PS1="~/${projectFolder.name} $ "\r`);
        setTimeout(() => {
          shellWriter.write(`cd "${projectFolder.name}" && clear\r`);
        }, 200);
      }
    }, 600); 

    // FIX: Dispose any previous onData listener before registering a new one
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
    // Read ONLY the current directory layer
    const entries = await webcontainerInstance.fs.readdir(path, { withFileTypes: true });

    // Sort folders first, then files
    entries.sort((a, b) => {
      if (a.isDirectory() === b.isDirectory()) return a.name.localeCompare(b.name);
      return a.isDirectory() ? -1 : 1;
    });

    for (const entry of entries) {
      // Always skip .git — never useful in the explorer
      if (entry.name === '.git') continue;

      const fullPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;

      if (entry.isDirectory()) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        const folderIcon = entry.name === 'node_modules' ? '📦' : '📁';
        summary.innerHTML = `<span class="file-icon">${folderIcon}</span> ${entry.name}`;
        
        const childrenContainer = document.createElement('div');
        childrenContainer.style.paddingLeft = "12px"; 
        
        details.append(summary, childrenContainer);
        parentElement.appendChild(details);

        let isLoaded = false;

        details.addEventListener('toggle', async () => {
          if (details.open && !isLoaded) {
            isLoaded = true;
            summary.innerHTML = `<span class="file-icon">📂</span> ${entry.name}`;
            childrenContainer.innerHTML = "<div style='color:#858585; font-size:12px;'>Loading...</div>";
            
            await new Promise(resolve => setTimeout(resolve, 100));
            childrenContainer.innerHTML = ""; 
            await renderVirtualTree(fullPath, childrenContainer);
          } else if (!details.open) {
            summary.innerHTML = `<span class="file-icon">${folderIcon}</span> ${entry.name}`;
          }
        });

      } else {
        const fileDiv = document.createElement('div');
        fileDiv.className = 'file-item';
        fileDiv.innerHTML = getFileIcon(entry.name) + `<span style="margin-left:5px;">${entry.name}</span>`;
        
        // When clicked, open the file from the WebContainer into the active editor
        fileDiv.onclick = async () => {
           if (!activeEditor) return;
           try {
             const fileContent = await webcontainerInstance.fs.readFile(fullPath, 'utf-8');
             // Store in openFiles so tabs and saving work correctly
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
             printToTerminal(`> Opened: ${fullPath}`, "#858585");
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