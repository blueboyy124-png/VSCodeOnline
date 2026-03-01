let editor1, editor2;
let activeEditor;
let projectFolder;
let openFiles = {};
let currentFile1 = null;
let currentFile2 = null;
let saveTimeout;
let isProgrammaticEdit = false;
let currentContextItem = null;

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
      
      if(openFiles[fullPath]) {
        delete openFiles[fullPath];
        if(currentFile1 === fullPath) currentFile1 = null;
        if(currentFile2 === fullPath) currentFile2 = null;
        renderTabs();
      }
      
      await loadFolder(projectFolder, document.getElementById("tree-root"), "");
      printToTerminal(`[System] Deleted: ${name}`, "#89d185");
    } catch(e) {
      printToTerminal(`[Error] Deleting: ${e.message}`, "#f48771");
    }
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
    
    const newHandle = await parentHandle.getFileHandle(newName, { create: true });
    const writable = await newHandle.createWritable();
    await writable.write(content);
    await writable.close();
    
    await parentHandle.removeEntry(name);
    
    if(openFiles[fullPath]) {
      const newPath = fullPath.substring(0, fullPath.lastIndexOf('/') + 1) + newName;
      openFiles[newPath] = { handle: newHandle, content, unsaved: openFiles[fullPath].unsaved };
      delete openFiles[fullPath];
      
      if(currentFile1 === fullPath) currentFile1 = newPath;
      if(currentFile2 === fullPath) currentFile2 = newPath;
      renderTabs();
    }

    await loadFolder(projectFolder, document.getElementById("tree-root"), "");
    printToTerminal(`[System] Renamed '${name}' to '${newName}'`, "#89d185");
  } catch(e) {
    printToTerminal(`[Error] Renaming: ${e.message}`, "#f48771");
  }
}

/* LANGUAGE HELPERS */
function getLanguageForFile(filename) {
  if (filename.endsWith('.html')) return 'html';
  if (filename.endsWith('.css')) return 'css';
  if (filename.endsWith('.json')) return 'json';
  if (filename.endsWith('.ts')) return 'typescript';
  return 'javascript'; 
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
  editor1.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, formatCode);
  editor2.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, formatCode);
  
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
    const tree = document.getElementById("fileTree");
    tree.innerHTML = `<div class="folder-title">˅ ${projectFolder.name}</div><div id="tree-root"></div>`;
    await loadFolder(projectFolder, document.getElementById("tree-root"), "");
    
    if(window.innerWidth <= 768) toggleSidebar();
    
    // NEW: Save the state AFTER the folder is successfully opened!
    saveWorkspaceState();
    
  } catch (err) {
    printToTerminal("Folder access cancelled or denied.", "#f48771");
  }
}

/* FOLDER LOADER (NEW FULL-ROW CLICK & INDENTATION LOGIC) */
async function loadFolder(folderHandle, container, pathPrefix) {
  container.innerHTML = "";
  for await (const [name, handle] of folderHandle.entries()) {
    const fullPath = pathPrefix ? `${pathPrefix}/${name}` : name;
    
    const wrapper = document.createElement("div");

    if (handle.kind === "file") {
      wrapper.className = "file";
      wrapper.style.paddingLeft = "15px";
      wrapper.innerHTML = getFileIcon(name) + name;
      wrapper.title = fullPath;
      
      // Stop propagation so clicking a file doesn't collapse its parent folder
      wrapper.onclick = (e) => { e.stopPropagation(); openFile(fullPath, handle); };
      wrapper.oncontextmenu = (e) => showContextMenu(e, 'file', name, handle, folderHandle, fullPath);
      
      container.appendChild(wrapper);
      
    } else if (handle.kind === "directory") {
      wrapper.className = "folder-wrapper collapsed"; // Starts collapsed
      
      const header = document.createElement("div");
      header.className = "folder";
      header.style.paddingLeft = "15px";
      header.innerHTML = `<span class="folder-arrow">›</span> ${name}`;
      
      // The whole folder row is clickable
      header.onclick = (e) => { 
        e.stopPropagation(); 
        wrapper.classList.toggle("collapsed"); 
      };
      header.oncontextmenu = (e) => showContextMenu(e, 'directory', name, handle, folderHandle, fullPath);
      
      const subContainer = document.createElement("div");
      subContainer.className = "folder-contents";
      subContainer.style.paddingLeft = "10px"; // Indent the children
      
      wrapper.appendChild(header);
      wrapper.appendChild(subContainer);
      container.appendChild(wrapper);
      
      await loadFolder(handle, subContainer, fullPath);
    }
  }
}

/* OPEN FILE */
async function openFile(fullPath, handle) {
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
    await loadFolder(projectFolder, document.getElementById("tree-root"), "");
    printToTerminal(`Created file: ${name}`, "#89d185");
    openFile(name, fileHandle);
  } catch (err) {
    printToTerminal(`Error creating file: ${err.message}`, "#f48771");
  }
}

/* MASTER SAVE */
async function saveFile(path, content) {
  try {
    const data = openFiles[path];
    if (!data) return; 
    
    const writable = await data.handle.createWritable();
    await writable.write(content);
    await writable.close();
    
    data.unsaved = false;
    renderTabs();
    
    // NEW: Auto-refresh Live Preview if it's open!
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
}

/* TERMINAL & RUN LOGIC */
const termInput = document.getElementById("terminal-input");
const termHistory = document.getElementById("terminal-history");

let cmdHistory = [];
let historyIndex = -1;

// Helper to simulate delays for a realistic feel
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

termInput.addEventListener("keydown", async function(e) {
  if (e.key === "Enter") {
    const cmd = this.value.trim();
    if(!cmd) return;
    
    cmdHistory.push(cmd);
    historyIndex = cmdHistory.length; 
    this.value = "";
    
    printToTerminal(`C:\\workspace> ${cmd}`, "#569cd6");
    
    const args = cmd.split(" ");
    const commandLower = args[0].toLowerCase();

    // 1. Clear Command
    if (commandLower === "clear" || commandLower === "cls") {
      termHistory.innerHTML = "";
      return;
    } 
    
    // 2. Help Command
    if (commandLower === "help") {
      printToTerminal("Available commands:");
      printToTerminal("  clear / cls       : Clears the terminal screen");
      printToTerminal("  npm install <pkg> : Simulates installing a package");
      printToTerminal("  [JS Code]         : Evaluates any valid JavaScript");
      return;
    }

    // 3. Fake NPM Install Command!
    if (commandLower === "npm" && (args[1] === "install" || args[1] === "i") && args[2]) {
      const pkgName = args[2];
      termInput.disabled = true; // Lock input while "installing"
      
      printToTerminal(`npm notice Fetching ${pkgName}...`, "#cccccc");
      await sleep(600);
      printToTerminal(`[..................] - fetchMetadata: sill resolveWithNewModule ${pkgName}@latest`, "#858585");
      await sleep(800);
      printToTerminal(`[====..............] - extractTree: sill extract ${pkgName}`, "#858585");
      await sleep(500);
      printToTerminal(`[==========........] - build: sill linkDependencies`, "#858585");
      await sleep(700);
      
      printToTerminal(`\nadded 1 package, and audited 2 packages in 2s`, "#89d185");
      printToTerminal(`found 0 vulnerabilities`, "#89d185");
      
      // Pro-tip for the user
      printToTerminal(`\n[Tip] Since this is a browser IDE, import this package via CDN in your code:`, "#569cd6");
      printToTerminal(`import ${pkgName} from 'https://esm.sh/${pkgName}';`, "#ce9178");
      
      termInput.disabled = false;
      termInput.focus();
      return;
    }

    // 4. Evaluate as JavaScript
    try {
      let result = eval(cmd);
      if (result !== undefined) printToTerminal(String(result));
    } catch(err) {
      printToTerminal(`Uncaught ${err.name}: ${err.message}`, "#f48771");
    }

  } else if (e.key === "ArrowUp") {
    e.preventDefault(); 
    if (historyIndex > 0) {
      historyIndex--;
      this.value = cmdHistory[historyIndex];
    }
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    if (historyIndex < cmdHistory.length - 1) {
      historyIndex++;
      this.value = cmdHistory[historyIndex];
    } else {
      historyIndex = cmdHistory.length;
      this.value = "";
    }
  }
});

function printToTerminal(text, color="#cccccc") {
  const div = document.createElement("div");
  div.textContent = text;
  div.style.color = color;
  div.style.whiteSpace = "pre-wrap"; // Preserves formatting and line breaks
  termHistory.appendChild(div);
  termHistory.scrollTop = termHistory.scrollHeight;
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
  
  // Show the pane
  previewPane.style.display = "flex";
  
  // Inject the code!
  // If it's just JS, we wrap it in a basic HTML template so it runs
  let codeToRun = activeEditor.getValue();
  if (currentFile.endsWith('.js')) {
    codeToRun = `<!DOCTYPE html><html><body><script>${codeToRun}<\/script></body></html>`;
  }
  
  iframe.srcdoc = codeToRun;
}

function closePreview() {
  document.getElementById("preview-pane").style.display = "none";
  document.getElementById("live-iframe").srcdoc = ""; // Clear it out
  printToTerminal(`> Closed Live Preview`, "#858585");
}

function updatePreviewIfOpen() {
  const previewPane = document.getElementById("preview-pane");
  
  // If the pane is open, refresh it
  if (previewPane && previewPane.style.display !== "none") {
    const currentFile = activeEditor === editor1 ? currentFile1 : currentFile2;
    if (!currentFile || (!currentFile.endsWith('.html') && !currentFile.endsWith('.js'))) return;

    let codeToRun = activeEditor.getValue();
    if (currentFile.endsWith('.js')) {
      codeToRun = `<!DOCTYPE html><html><body><script>${codeToRun}<\/script></body></html>`;
    }
    
    document.getElementById("live-iframe").srcdoc = codeToRun;
  }
}

/* SERVICE WORKER */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`./sw.js?v=${new Date().getTime()}`)
      .then(reg => console.log('PWA Service Worker registered!', reg))
      .catch(err => console.log('PWA Registration failed:', err));
  });
} // <--- WE CLOSE THE SERVICE WORKER BLOCK HERE!

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
      plugins: prettierPlugins, 
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
    const tree = document.getElementById("fileTree");
    tree.innerHTML = `<div class="folder-title">˅ ${projectFolder.name}</div><div id="tree-root"></div>`;
    await loadFolder(projectFolder, document.getElementById("tree-root"), "");
    
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
    
    printToTerminal(`> Workspace restored: ${projectFolder.name}`, "#89d185");
  } catch (err) {
    printToTerminal(`Error restoring workspace: ${err.message}`, "#f48771");
  }
};