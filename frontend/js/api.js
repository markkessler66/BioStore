// Thin wrapper around the BioStore REST API.
const API = (() => {
  const TOKEN_KEY = "biostore_token";
  const NAME_KEY = "biostore_display_name";

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY);
  }

  function getDisplayName() {
    return sessionStorage.getItem(NAME_KEY) || "";
  }

  function setSession(token, displayName) {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(NAME_KEY, displayName);
  }

  function clearSession() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(NAME_KEY);
  }

  class ApiError extends Error {
    constructor(message, { status, data } = {}) {
      super(message);
      this.name = "ApiError";
      this.status = status || 0;
      this.data = data || null;
      this.locked_by = data && data.locked_by;
      this.expires_at = data && data.expires_at;
    }
  }

  async function req(method, url, body, { auth = true, raw = false } = {}) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    if (auth) {
      const token = getToken();
      if (token) opts.headers["Authorization"] = "Bearer " + token;
    }
    const res = await fetch(url, opts);
    if (raw) {
      if (!res.ok) {
        let data = null;
        try { data = await res.json(); } catch {}
        throw new ApiError(
          (data && data.error) || `HTTP ${res.status}`,
          { status: res.status, data }
        );
      }
      return res;
    }
    const ct = res.headers.get("content-type") || "";
    let data;
    if (ct.includes("application/json")) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    if (!res.ok) {
      const msg = data && data.error ? data.error : `HTTP ${res.status}`;
      throw new ApiError(msg, { status: res.status, data });
    }
    return data;
  }

  const qs = (params) =>
    "?" +
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

  return {
    ApiError,
    getToken,
    getDisplayName,
    setSession,
    clearSession,
    authStatus: () => req("GET", "/api/auth/status", undefined, { auth: false }),
    login: (password, display_name) =>
      req("POST", "/api/auth/login", { password, display_name }, { auth: false }),
    logout: () => req("POST", "/api/auth/logout"),
    me: () => req("GET", "/api/auth/me"),
    acquireLock: (path) => req("POST", "/api/locks/acquire", { path }),
    releaseLock: (path) => req("POST", "/api/locks/release", { path }),
    heartbeatLocks: (paths) => req("POST", "/api/locks/heartbeat", { paths }),
    listLocks: () => req("GET", "/api/locks"),
    tree: (path = "", depth = -1) => req("GET", "/api/tree" + qs({ path, depth })),
    readFile: (path) => req("GET", "/api/file" + qs({ path })),
    writeFile: (path, content) => req("PUT", "/api/file", { path, content }),
    mkdir: (path) => req("POST", "/api/mkdir", { path }),
    newFile: (path, content = "") => req("POST", "/api/newfile", { path, content }),
    remove: (path) => req("POST", "/api/delete", { path }),
    rename: (path, new_path) => req("POST", "/api/rename", { path, new_path }),
    search: (q, content = false) =>
      req("GET", "/api/search" + qs({ q, content: content ? 1 : 0 })),
    stats: () => req("GET", "/api/stats"),
    network: (path) => req("GET", "/api/network" + qs({ path })),
    parseNetwork: (text) => req("POST", "/api/network/parse", { text }),
    summary: (path, reference, threshold) =>
      req("GET", "/api/summary" + qs({ path, reference, threshold })),
    alignment: (path) => req("GET", "/api/alignment" + qs({ path })),
    saveAlignment: (path, sequences, format, datatype) =>
      req("POST", "/api/alignment/save", { path, sequences, format, datatype }),
    convert: (sequences, format, datatype) =>
      req("POST", "/api/alignment/convert", { sequences, format, datatype }),
    snippet: (path) => req("GET", "/api/snippet" + qs({ path })),
    phynetpyStatus: () => req("GET", "/api/phynetpy/status"),
    phynetpyMethods: () => req("GET", "/api/phynetpy/methods"),
    phynetpyJobs: ({ limit, offset, status } = {}) =>
      req("GET", "/api/phynetpy/jobs" + qs({ limit, offset, status })),
    phynetpyJob: (id) => req("GET", "/api/phynetpy/jobs/" + encodeURIComponent(id)),
    phynetpyDeleteJob: (id) =>
      req("DELETE", "/api/phynetpy/jobs/" + encodeURIComponent(id)),
    phynetpyRun: (body) => req("POST", "/api/phynetpy/run", body),
    // items: array of File objects OR { file, relpath } records.
    // Uploads in chunks so large folders don't blow past request size limits.
    upload: async (dir, items, { onProgress } = {}) => {
      const list = Array.from(items || []).map((it) =>
        it.file ? it : { file: it, relpath: it.webkitRelativePath || it.name }
      );
      if (!list.length) return { uploaded: [] };
      const CHUNK = 40;
      const uploaded = [];
      for (let i = 0; i < list.length; i += CHUNK) {
        const slice = list.slice(i, i + CHUNK);
        const fd = new FormData();
        fd.append("path", dir || "");
        let appended = 0;
        for (const it of slice) {
          const file = it.file || it;
          if (!(file instanceof Blob)) continue;
          const rel = String(it.relpath || file.webkitRelativePath || file.name || "")
            .replace(/\\/g, "/");
          const base = rel.split("/").filter(Boolean).pop() || file.name || "upload.bin";
          fd.append("file", file, base);
          fd.append("relpath", rel);
          appended += 1;
        }
        if (!appended) continue;
        const headers = {};
        const token = getToken();
        if (token) headers["Authorization"] = "Bearer " + token;
        const res = await fetch("/api/upload", { method: "POST", body: fd, headers });
        let data;
        try { data = await res.json(); } catch { data = {}; }
        if (!res.ok) {
          throw new ApiError(data.error || `Upload failed (HTTP ${res.status})`, {
            status: res.status, data,
          });
        }
        uploaded.push(...(data.uploaded || []));
        if (onProgress) onProgress(Math.min(list.length, i + slice.length), list.length);
      }
      return { uploaded };
    },
    downloadUrl: (path) => {
      // Downloads need the token; use a fetch-based helper instead of location=.
      return "/api/file" + qs({ path, raw: 1 });
    },
    downloadFile: async (path, filename) => {
      const res = await req("GET", "/api/file" + qs({ path, raw: 1 }), undefined, { raw: true });
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename || path.split("/").pop() || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    },
  };
})();
