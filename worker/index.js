const MAX_CODE_BYTES = 200 * 1024;

export class HiddenFilesStore {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      const files = [];
      const entries = await this.state.storage.list({ prefix: "file:" });

      for (const [key, file] of entries) {
        files.push({
          name: key.slice("file:".length),
          size: file.size,
          updatedAt: file.updatedAt
        });
      }

      return json({ ok: true, files: files.sort((a, b) => a.name.localeCompare(b.name)) });
    }

    if (request.method === "GET") {
      const name = safeCFileName(decodeURIComponent(url.pathname.slice(1)));
      if (!name) {
        return json({ ok: false, error: "Only simple .c filenames are supported." }, 400);
      }

      const file = await this.state.storage.get(`file:${name}`);
      if (!file) {
        return json({ ok: false, error: `Hidden file "${name}" was not found.` }, 404);
      }

      return json({ ok: true, name, content: file.content });
    }

    if (request.method === "DELETE") {
      const name = safeCFileName(decodeURIComponent(url.pathname.slice(1)));
      if (!name) {
        return json({ ok: false, error: "Only simple .c filenames are supported." }, 400);
      }

      const key = `file:${name}`;
      const file = await this.state.storage.get(key);
      if (!file) {
        return json({ ok: false, error: `Hidden file "${name}" was not found.` }, 404);
      }

      await this.state.storage.delete(key);
      return json({ ok: true, name });
    }

    if (request.method === "POST" && url.pathname === "/") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Request body must be JSON." }, 400);
      }

      const name = safeCFileName(body?.name);
      const content = body?.content;
      if (!name) {
        return json({ ok: false, error: "Only simple .c filenames are supported." }, 400);
      }

      const validation = validateCode(content);
      if (!validation.ok) {
        return json({ ok: false, error: validation.stderr }, 400);
      }

      await this.state.storage.put(`file:${name}`, {
        content,
        size: byteLength(content),
        updatedAt: new Date().toISOString()
      });

      return json({ ok: true, name });
    }

    return json({ ok: false, error: "Not found." }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, storage: "cloudflare-durable-object" });
    }

    if (url.pathname === "/api/hidden-files" || url.pathname.startsWith("/api/hidden-files/")) {
      const id = env.HIDDEN_FILES.idFromName("global-hidden-files");
      const store = env.HIDDEN_FILES.get(id);
      const storeUrl = new URL(request.url);
      storeUrl.pathname = url.pathname.replace(/^\/api\/hidden-files\/?/, "/");
      return store.fetch(new Request(storeUrl, request));
    }

    if (url.pathname === "/api/compile" || url.pathname === "/api/compile-run") {
      return json({
        ok: false,
        stage: "cloudflare",
        stdout: "",
        stderr: "Compile and run require the local Node backend. Hidden file uploads are shared on Cloudflare."
      }, 501);
    }

    return env.ASSETS.fetch(request);
  }
};

function validateCode(code) {
  if (typeof code !== "string") {
    return { ok: false, stderr: "Request body must include a C source string named content." };
  }

  if (byteLength(code) > MAX_CODE_BYTES) {
    return { ok: false, stderr: "Source file is too large. Limit is 200 KB." };
  }

  return { ok: true };
}

function safeCFileName(name) {
  if (typeof name !== "string") return "";
  const trimmed = name.trim();
  if (!trimmed.toLowerCase().endsWith(".c")) return "";
  if (/[\\/:"*?<>|]/.test(trimmed)) return "";
  return trimmed;
}

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
