/* Files uses its own HttpOnly session, independent of Echo's shared admin JWT. */
(() => {
  "use strict";
  const el = (id) => document.getElementById(`files-${id}`);
  const transfer = window.EchoFileTransfer;
  el("back").hidden = window.self !== window.top;
  let role = "",
    files = [],
    pending = [],
    controller = null,
    generation = 0;
  function status(message, error = false) {
    el("status").textContent = message;
    el("status").classList.toggle("error", error);
  }
  function signedOut() {
    role = "";
    files = [];
    pending = [];
    el("password").value = "";
    el("library").hidden = true;
    el("login").hidden = false;
  }
  async function api(path, options = {}) {
    const headers = { "X-Echo-Files": "1", ...options.headers };
    let body = options.body;
    if (body && !(body instanceof Blob)) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const response = await fetch(`/api/files${path}`, {
      ...options,
      headers,
      body,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 401 && !path.startsWith("/session")) signedOut();
      const error = new Error(
        (await response.text()).slice(0, 500) ||
          `Request failed (${response.status})`,
      );
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }
  function render() {
    el("count").textContent =
      `${files.length} shared file${files.length === 1 ? "" : "s"}`;
    el("access").textContent =
      role === "owner" ? "Owner access" : "Download access";
    el("owner").hidden = role !== "owner";
    el("list").replaceChildren();
    const query = el("search").value.toLocaleLowerCase();
    const visible = files.filter((file) =>
      file.name.toLocaleLowerCase().includes(query),
    );
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = query
        ? "No files match your search."
        : "The shelf is empty. Shared files will appear here.";
      el("list").append(empty);
    }
    for (const file of visible) {
      const row = document.createElement("article");
      row.className = "file-row";
      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = file.name.includes(".")
        ? file.name.split(".").pop().slice(0, 4).toUpperCase()
        : "FILE";
      const info = document.createElement("div");
      info.className = "file-info";
      const name = document.createElement("div");
      name.className = "file-name";
      name.textContent = file.name;
      const meta = document.createElement("small");
      meta.textContent = `${transfer.formatBytes(file.size)} · ${new Date(file.created_at * 1000).toLocaleDateString()}`;
      info.append(name, meta);
      const actions = document.createElement("div");
      actions.className = "actions";
      const link = document.createElement("a");
      link.className = "download";
      link.href = `/api/files/${encodeURIComponent(file.id)}/download`;
      link.textContent = "Download";
      link.setAttribute("aria-label", `Download ${file.name}`);
      // Let the browser/WebView download manager stream directly to disk.
      // A hidden target keeps an expired-session error from replacing Echo.
      link.target = "files-download-target";
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        try {
          await api("/session");
          downloadTarget.src = link.href;
          status(`Download requested: ${file.name}. Check your downloads.`);
        } catch (error) {
          if (error.status === 401) signedOut();
          status(error.message, true);
        }
      });
      actions.append(link);
      if (role === "owner")
        actions.append(
          removeButton(
            "Delete",
            `/${file.id}`,
            `Permanently delete “${file.name}” from the library?`,
          ),
        );
      row.append(icon, info, actions);
      el("list").append(row);
    }
    el("pending").replaceChildren();
    for (const upload of pending) {
      const row = document.createElement("div");
      row.className = "pending-row";
      const text = document.createElement("span");
      text.textContent = `Unfinished: ${upload.name} · ${transfer.formatBytes(upload.offset)} / ${transfer.formatBytes(upload.size)}. Choose this file again to resume.`;
      row.append(
        text,
        removeButton(
          "Discard",
          `/uploads/${upload.id}`,
          `Discard the unfinished upload “${upload.name}”?`,
        ),
      );
      el("pending").append(row);
    }
  }
  function removeButton(label, path, question) {
    const button = document.createElement("button");
    button.className = "danger";
    button.textContent = label;
    button.disabled = !!controller;
    button.addEventListener("click", async () => {
      if (!confirm(question)) return;
      button.disabled = true;
      try {
        await api(path, { method: "DELETE" });
        await refresh();
        status(
          label === "Delete" ? "File deleted." : "Unfinished upload discarded.",
        );
      } catch (error) {
        status(error.message, true);
        button.disabled = false;
      }
    });
    return button;
  }
  async function refresh() {
    const current = ++generation;
    const nextFiles = await api("/catalog");
    const nextPending = role === "owner" ? await api("/uploads") : [];
    if (current !== generation || !role) return;
    files = nextFiles;
    pending = nextPending;
    el("login").hidden = true;
    el("library").hidden = false;
    render();
  }
  el("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    el("sign-in").disabled = true;
    try {
      const result = await api("/session", {
        method: "POST",
        body: { role: el("role").value, password: el("password").value },
      });
      el("password").value = "";
      role = result.role;
      await refresh();
      status("Library unlocked.");
    } catch (error) {
      status(error.message, true);
    } finally {
      el("sign-in").disabled = false;
    }
  });
  el("sign-out").addEventListener("click", async () => {
    try {
      await api("/session", { method: "DELETE" });
      ++generation;
      signedOut();
      status("Signed out.");
    } catch (error) {
      status(error.message, true);
    }
  });
  el("refresh").addEventListener("click", () =>
    refresh().catch((error) => status(error.message, true)),
  );
  el("search").addEventListener("input", render);
  el("pause").addEventListener("click", () => controller?.abort());
  el("input").addEventListener("change", async () => {
    const selection = Array.from(el("input").files);
    if (!selection.length || controller) return;
    controller = new AbortController();
    el("transfer").hidden = false;
    el("input").disabled = true;
    el("sign-out").disabled = true;
    render();
    try {
      for (const file of selection) {
        status(`Uploading ${file.name}…`);
        await transfer.upload(api, file, {
          signal: controller.signal,
          onProgress(offset, size) {
            el("progress").value = size ? (offset / size) * 100 : 100;
            el("progress-label").textContent =
              `${file.name} · ${transfer.formatBytes(offset)} / ${transfer.formatBytes(size)} (${size ? Math.floor((offset / size) * 100) : 100}%)`;
          },
        });
        status(`${file.name} is ready to download.`);
      }
    } catch (error) {
      status(
        error.name === "AbortError"
          ? "Upload paused. Choose the same file again to resume."
          : `${error.message} Choose the same file again to resume.`,
        error.name !== "AbortError",
      );
    } finally {
      controller = null;
      el("input").disabled = false;
      el("sign-out").disabled = false;
      el("input").value = "";
      el("transfer").hidden = true;
      if (role) refresh().catch((error) => status(error.message, true));
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (controller) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  const downloadTarget = document.createElement("iframe");
  downloadTarget.name = "files-download-target";
  downloadTarget.hidden = true;
  downloadTarget.title = "File download";
  downloadTarget.addEventListener("load", () => {
    const result = downloadTarget.contentDocument;
    if (result?.contentType === "text/plain" && result.body?.textContent) {
      status(result.body.textContent.slice(0, 500), true);
    }
  });
  document.body.append(downloadTarget);
  api("/session")
    .then(async (result) => {
      role = result.role;
      await refresh();
    })
    .catch((error) => {
      signedOut();
      status(
        error.status === 401 ? "Sign in to browse the library." : error.message,
        error.status !== 401,
      );
    });
})();
