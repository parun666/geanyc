import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Editor from "@monaco-editor/react";
import {
  Archive,
  Brush,
  Box,
  ChevronDown,
  CircleHelp,
  CircleX,
  CornerDownLeft,
  CornerDownRight,
  FilePlus2,
  Hammer,
  Package,
  PackageOpen,
  Printer,
  Play,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  X
} from "lucide-react";
import "./styles.css";

const menuItems = ["File", "Edit", "Search", "View", "Document", "Project", "Build", "Tools", "Help"];
const triggerPattern = /^\/\/\s*([^\\/:"*?<>|]+\.c)\s*$/i;

function App() {
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const fileInputRef = useRef(null);
  const [code, setCode] = useState("");
  const [tabName, setTabName] = useState("untitled.c");
  const [uploadedFiles, setUploadedFiles] = useState(() => new Map());
  const [serverHiddenFiles, setServerHiddenFiles] = useState([]);
  const [typingState, setTypingState] = useState({
    active: false,
    fileName: "",
    hiddenCode: "",
    index: 0
  });
  const [output, setOutput] = useState([
    `${clock()} This is Geany 1.38.`,
    `${clock()} New file "untitled.c" opened.`
  ]);
  const [busy, setBusy] = useState(false);

  const uploadedNames = useMemo(() => {
    const names = new Set([...uploadedFiles.keys(), ...serverHiddenFiles.map((file) => file.name)]);
    return Array.from(names).sort();
  }, [serverHiddenFiles, uploadedFiles]);

  const appendOutput = useCallback((message) => {
    const lines = String(message || "").split(/\r?\n/);
    setOutput((current) => [...current, ...lines.map((line) => `${clock()} ${line}`)]);
  }, []);

  const currentCode = useCallback(() => editorRef.current?.getValue() ?? code, [code]);

  const refreshHiddenFiles = useCallback(async () => {
    try {
      const response = await fetch("/api/hidden-files");
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Could not list hidden files.");
      }
      setServerHiddenFiles(result.files || []);
    } catch (error) {
      appendOutput(`Hidden file list failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [appendOutput]);

  const handleEditorMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.focus();
  }, []);

  useEffect(() => {
    refreshHiddenFiles();
  }, [refreshHiddenFiles]);

  const resetTyping = useCallback(() => {
    setTypingState({ active: false, fileName: "", hiddenCode: "", index: 0 });
    appendOutput("Hidden typing reset.");
    editorRef.current?.focus();
  }, [appendOutput]);

  const newFile = useCallback(() => {
    setCode("");
    setTabName("untitled.c");
    setTypingState({ active: false, fileName: "", hiddenCode: "", index: 0 });
    appendOutput('New file "untitled.c" opened.');
    setTimeout(() => editorRef.current?.focus(), 0);
  }, [appendOutput]);

  const uploadFile = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".c")) {
      appendOutput(`Upload rejected: "${file.name}" is not a .c file.`);
      return;
    }

    const text = await file.text();

    try {
      const response = await fetch("/api/hidden-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, content: text })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Upload failed.");
      }

      setUploadedFiles((current) => {
        const next = new Map(current);
        next.set(file.name, text);
        return next;
      });
      await refreshHiddenFiles();
      appendOutput(`Hidden C file "${file.name}" uploaded to server. Type // ${file.name} on line 1 to activate.`);
    } catch (error) {
      appendOutput(`Hidden upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [appendOutput, refreshHiddenFiles]);

  const saveFile = useCallback(() => {
    const visibleCode = currentCode();
    const fileName = tabName.endsWith(".c") ? tabName : `${tabName}.c`;
    const blob = new Blob([visibleCode], { type: "text/x-csrc;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);

    appendOutput(`File "${fileName}" saved.`);
    editorRef.current?.focus();
  }, [appendOutput, currentCode, tabName]);

  useEffect(() => {
    let cancelled = false;

    async function armHiddenTyping() {
      const firstLine = code.split(/\r?\n/, 1)[0] ?? "";
      const match = firstLine.match(triggerPattern);

      if (!match || typingState.active) return;

      const fileName = match[1];
      const existsOnServer = serverHiddenFiles.some((file) => file.name === fileName);
      let hiddenCode = uploadedFiles.get(fileName);

      if (!hiddenCode && !existsOnServer) return;

      if (!hiddenCode) {
        try {
          const response = await fetch(`/api/hidden-files/${encodeURIComponent(fileName)}`);
          const result = await response.json();
          if (!response.ok || !result.ok) {
            throw new Error(result.error || `Hidden file "${fileName}" was not found.`);
          }
          hiddenCode = result.content;
          setUploadedFiles((current) => {
            const next = new Map(current);
            next.set(fileName, hiddenCode);
            return next;
          });
        } catch (error) {
          appendOutput(`Hidden trigger failed: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      }

      if (cancelled) return;
      setTypingState({ active: true, fileName, hiddenCode, index: 0 });
      appendOutput(`Hidden typing armed for "${fileName}".`);
      editorRef.current?.focus();
    }

    armHiddenTyping();
    return () => {
      cancelled = true;
    };
  }, [appendOutput, code, serverHiddenFiles, typingState.active, uploadedFiles]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (!typingState.active) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.length !== 1 && event.key !== "Enter" && event.key !== "Tab" && event.key !== "Backspace") return;

      event.preventDefault();
      event.stopPropagation();

      if (typingState.index >= typingState.hiddenCode.length) {
        setTypingState((current) => ({ ...current, active: false }));
        appendOutput(`Hidden typing completed for "${typingState.fileName}".`);
        return;
      }

      const editor = editorRef.current;
      if (!editor) return;

      const nextChar = typingState.hiddenCode[typingState.index];
      editor.executeEdits("hidden-typing", [
        {
          range: editor.getSelection(),
          text: nextChar,
          forceMoveMarkers: true
        }
      ]);
      editor.pushUndoStop();
      setTypingState((current) => ({ ...current, index: current.index + 1 }));
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [appendOutput, typingState]);

  const callBackend = useCallback(async (mode) => {
    const visibleCode = currentCode();
    setBusy(true);
    appendOutput(mode === "compile" ? "Build started..." : "Run started...");

    try {
      const response = await fetch(mode === "compile" ? "/api/compile" : "/api/compile-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: visibleCode })
      });
      const result = await response.json();
      const status = result.ok ? "finished successfully" : `failed during ${result.stage}`;
      const stdout = result.stdout?.trim();
      const stderr = result.stderr?.trim();
      appendOutput(`${mode === "compile" ? "Build" : "Run"} ${status}.`);
      if (stdout) appendOutput(stdout);
      if (stderr) appendOutput(stderr);
    } catch (error) {
      appendOutput(`Backend request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
      editorRef.current?.focus();
    }
  }, [appendOutput, currentCode]);

  const hiddenProgress = typingState.hiddenCode.length
    ? Math.round((typingState.index / typingState.hiddenCode.length) * 100)
    : 0;

  return (
    <div className="ide-shell">
      <div className="window-title">
        <span className="geany-mark">☀</span>
        <span>{tabName.replace(/\.c$/, "")} - Geany</span>
      </div>

      <nav className="menu-bar">
        {menuItems.map((item) => (
          <button key={item} type="button">{item}</button>
        ))}
      </nav>

      <header className="toolbar">
        <button className="tool-button" type="button" title="New file" onClick={newFile}>
          <FilePlus2 size={17} />
        </button>
        <button className="tool-button split" type="button" title="Upload .c file" onClick={() => fileInputRef.current?.click()}>
          <ChevronDown size={16} />
        </button>
        <input ref={fileInputRef} className="hidden-input" type="file" accept=".c,text/x-csrc" onChange={uploadFile} />

        <ToolbarDivider />
        <button className="tool-button" type="button" title="Open hidden C file">
          <PackageOpen size={18} />
        </button>
        <button className="tool-button" type="button" title="Save" onClick={saveFile}>
          <Save size={18} />
        </button>
        <button className="tool-button disabled" type="button" title="Print">
          <Printer size={18} />
        </button>
        <button className="tool-button disabled" type="button" title="Close">
          <CircleX size={18} />
        </button>

        <ToolbarDivider />
        <button className="tool-button disabled" type="button" title="Undo">
          <CornerDownLeft size={18} />
        </button>
        <button className="tool-button disabled" type="button" title="Redo">
          <CornerDownRight size={18} />
        </button>

        <ToolbarDivider />
        <button className="tool-button disabled" type="button" title="Preferences">
          <Brush size={18} />
        </button>
        <button className="tool-button disabled" type="button" title="Build tools">
          <Package size={18} />
        </button>
        <button className="tool-button split disabled" type="button" title="More build actions">
          <ChevronDown size={16} />
        </button>
        <button className="tool-button disabled" type="button" title="Configure tools">
          <Settings size={18} />
        </button>
        <button className="tool-button build" type="button" title="Build" disabled={busy} onClick={() => callBackend("compile")}>
          <Hammer size={18} />
        </button>
        <button className="tool-button run" type="button" title="Run" disabled={busy} onClick={() => callBackend("run")}>
          <Play size={18} />
        </button>
        <button className="tool-button disabled" type="button" title="Sandbox">
          <ShieldCheck size={18} />
        </button>
        <button className="tool-button disabled" type="button" title="Package">
          <Archive size={18} />
        </button>
        <button className="tool-button" type="button" title="Reset hidden typing" onClick={resetTyping}>
          <RotateCcw size={18} />
        </button>

        <ToolbarDivider />
        <div className="search-box">
          <input aria-label="Search" />
          <Search size={20} />
        </div>
        <div className="search-box small">
          <input aria-label="Command" />
          <Settings size={18} />
        </div>
        <button className="tool-button" type="button" title="Help">
          <CircleHelp size={18} />
        </button>
      </header>

      <main className="workspace">
        <aside className="symbols-panel">
          <div className="symbols-tab">
            <ChevronDown size={14} className="left-arrow" />
            <span>Symbols</span>
            <ChevronDown size={14} className="right-arrow" />
          </div>
          <p>No symbols found</p>
          {uploadedNames.length > 0 && (
            <div className="hidden-list">
              <strong>Hidden uploads</strong>
              {uploadedNames.map((name) => <span key={name}>{name}</span>)}
            </div>
          )}
        </aside>

        <section className="editor-area">
          <div className="tab-row">
            <button className="editor-tab" type="button">
              {tabName}
              <X size={14} />
            </button>
          </div>
          <div className="editor-wrap">
            <Editor
              height="100%"
              language="c"
              theme="geanyLight"
              value={code}
              onChange={(value) => setCode(value ?? "")}
              onMount={handleEditorMount}
              beforeMount={defineGeanyTheme}
              options={{
                automaticLayout: true,
                fontFamily: "Consolas, 'Courier New', monospace",
                fontSize: 16,
                lineHeight: 22,
                minimap: { enabled: false },
                renderLineHighlight: "none",
                overviewRulerLanes: 0,
                scrollbar: {
                  verticalScrollbarSize: 14,
                  horizontalScrollbarSize: 14
                },
                wordWrap: "off",
                lineNumbersMinChars: 3,
                glyphMargin: false,
                folding: false
              }}
            />
          </div>
        </section>
      </main>

      <section className="output-panel">
        <div className="status-rail">
          <ChevronDown size={14} />
          <span>Status</span>
          <ChevronDown size={14} />
        </div>
        <pre>{output.join("\n")}</pre>
      </section>

      <footer className="status-bar">
        <span>This is Geany 1.38.</span>
        {typingState.active && (
          <span className="typing-pill">
            <Box size={14} />
            {typingState.fileName} {hiddenProgress}%
          </span>
        )}
      </footer>
    </div>
  );
}

function ToolbarDivider() {
  return <span className="toolbar-divider" aria-hidden="true" />;
}

function clock() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function defineGeanyTheme(monaco) {
  monaco.editor.defineTheme("geanyLight", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "3f7f5f" },
      { token: "keyword", foreground: "0000aa", fontStyle: "bold" },
      { token: "number", foreground: "aa0000" },
      { token: "string", foreground: "aa5500" }
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#000000",
      "editorLineNumber.foreground": "#000000",
      "editorCursor.foreground": "#000000",
      "editor.selectionBackground": "#b5d5ff",
      "editorGutter.background": "#d9d9d9",
      "scrollbarSlider.background": "#8d8d8d",
      "scrollbarSlider.hoverBackground": "#777777",
      "scrollbarSlider.activeBackground": "#666666"
    }
  });
}

createRoot(document.getElementById("root")).render(<App />);
