import cors from "cors";
import express from "express";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_CODE_BYTES = 200 * 1024;
const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS || 8000);
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 4000);
const USE_DOCKER = process.env.USE_DOCKER === "1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HIDDEN_DIR = path.join(__dirname, "hidden-files");

app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, sandbox: USE_DOCKER ? "docker" : "local-process" });
});

app.get("/api/hidden-files", async (_req, res) => {
  await mkdir(HIDDEN_DIR, { recursive: true });
  const entries = await readdir(HIDDEN_DIR, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".c"))
      .map(async (entry) => {
        const info = await stat(path.join(HIDDEN_DIR, entry.name));
        return { name: entry.name, size: info.size, updatedAt: info.mtime.toISOString() };
      })
  );

  res.json({ ok: true, files: files.sort((a, b) => a.name.localeCompare(b.name)) });
});

app.get("/api/hidden-files/:name", async (req, res) => {
  const safeName = safeCFileName(req.params.name);
  if (!safeName) {
    res.status(400).json({ ok: false, error: "Only simple .c filenames are supported." });
    return;
  }

  try {
    const content = await readFile(path.join(HIDDEN_DIR, safeName), "utf8");
    res.json({ ok: true, name: safeName, content });
  } catch {
    res.status(404).json({ ok: false, error: `Hidden file "${safeName}" was not found.` });
  }
});

app.post("/api/hidden-files", async (req, res) => {
  const safeName = safeCFileName(req.body?.name);
  const content = req.body?.content;

  if (!safeName) {
    res.status(400).json({ ok: false, error: "Only simple .c filenames are supported." });
    return;
  }

  const validation = validateCode(content);
  if (!validation.ok) {
    res.status(400).json({ ok: false, error: validation.stderr });
    return;
  }

  await mkdir(HIDDEN_DIR, { recursive: true });
  await writeFile(path.join(HIDDEN_DIR, safeName), content, "utf8");
  res.json({ ok: true, name: safeName });
});

app.post("/api/compile", async (req, res) => {
  const result = await compileAndMaybeRun(req.body?.code, false);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post("/api/compile-run", async (req, res) => {
  const result = await compileAndMaybeRun(req.body?.code, true);
  res.status(result.ok ? 200 : 400).json(result);
});

async function compileAndMaybeRun(code, shouldRun) {
  const validation = validateCode(code);
  if (!validation.ok) return validation;

  const workDir = path.join(os.tmpdir(), `geanyc-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  try {
    const sourcePath = path.join(workDir, "program.c");
    await writeFile(sourcePath, code, "utf8");

    if (USE_DOCKER) {
      return await compileInDocker(workDir, shouldRun);
    }

    return await compileLocally(workDir, shouldRun);
  } catch (error) {
    return {
      ok: false,
      stage: "server",
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function validateCode(code) {
  if (typeof code !== "string") {
    return { ok: false, stage: "validate", stdout: "", stderr: "Request body must include a C source string named code." };
  }

  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    return { ok: false, stage: "validate", stdout: "", stderr: "Source file is too large. Limit is 200 KB." };
  }

  return { ok: true };
}

function safeCFileName(name) {
  if (typeof name !== "string") return "";
  const trimmed = name.trim();
  if (!trimmed.toLowerCase().endsWith(".c")) return "";
  if (/[\\/:"*?<>|]/.test(trimmed)) return "";
  if (path.basename(trimmed) !== trimmed) return "";
  return trimmed;
}

async function compileLocally(workDir, shouldRun) {
  const exeName = process.platform === "win32" ? "program.exe" : "program.out";
  const compile = await runCommand(
    "gcc",
    ["program.c", "-O0", "-std=c11", "-Wall", "-Wextra", "-o", exeName],
    workDir,
    COMPILE_TIMEOUT_MS
  );

  if (compile.code !== 0 || compile.timedOut) {
    return commandResult(false, "compile", compile);
  }

  if (!shouldRun) {
    return {
      ok: true,
      stage: "compile",
      stdout: "Compilation finished successfully.",
      stderr: compile.stderr
    };
  }

  const run = await runCommand(path.join(workDir, exeName), [], workDir, RUN_TIMEOUT_MS);
  return commandResult(run.code === 0 && !run.timedOut, "run", run, compile.stderr);
}

async function compileInDocker(workDir, shouldRun) {
  const script = shouldRun
    ? "gcc program.c -O0 -std=c11 -Wall -Wextra -o program.out && timeout 4s ./program.out"
    : "gcc program.c -O0 -std=c11 -Wall -Wextra -o program.out && echo Compilation finished successfully.";

  const docker = await runCommand(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--memory",
      "128m",
      "--cpus",
      "0.5",
      "-v",
      `${workDir}:/work`,
      "-w",
      "/work",
      "gcc:latest",
      "sh",
      "-c",
      script
    ],
    workDir,
    shouldRun ? COMPILE_TIMEOUT_MS + RUN_TIMEOUT_MS : COMPILE_TIMEOUT_MS
  );

  const stage = docker.stderr.includes("error:") ? "compile" : shouldRun ? "run" : "compile";
  return commandResult(docker.code === 0 && !docker.timedOut, stage, docker);
}

function runCommand(command, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      const hint = error.code === "ENOENT"
        ? `${command} was not found on PATH. Install GCC or start the backend with USE_DOCKER=1.`
        : error.message;
      resolve({ code: 1, stdout, stderr: `${stderr}${hint}`, timedOut });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout,
        stderr: timedOut ? `${stderr}\nProcess timed out.`.trim() : stderr,
        timedOut
      });
    });
  });
}

function commandResult(ok, stage, command, compileWarnings = "") {
  return {
    ok,
    stage,
    stdout: command.stdout,
    stderr: `${compileWarnings}${command.stderr ? `${compileWarnings ? "\n" : ""}${command.stderr}` : ""}`.trim(),
    timedOut: command.timedOut
  };
}

app.listen(PORT, () => {
  console.log(`Geany C backend listening on http://localhost:${PORT}`);
  console.log(`Sandbox mode: ${USE_DOCKER ? "Docker gcc:latest" : "local gcc process with timeout"}`);
});
