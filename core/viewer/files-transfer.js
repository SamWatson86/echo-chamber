(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EchoFileTransfer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const CHUNK_BYTES = 8 * 1024 * 1024;
  async function hash(blob) {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      await blob.arrayBuffer(),
    );
    return Array.from(new Uint8Array(bytes), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  }
  async function fingerprint(file) {
    // Bounded reads even for multi-terabyte files. Timestamp + both ends bind
    // reselection to the original source; per-chunk hashes verify transport.
    return `${file.lastModified}:${await hash(file.slice(0, 65536))}:${await hash(file.slice(Math.max(0, file.size - 65536)))}`;
  }
  function checkAbort(signal) {
    if (signal?.aborted) throw new DOMException("Upload paused", "AbortError");
  }
  async function upload(api, file, options = {}) {
    if (!Number.isSafeInteger(file.size))
      throw new Error("This browser cannot represent the file size safely.");
    const { signal, onProgress = () => {} } = options;
    const identity = await fingerprint(file);
    checkAbort(signal);
    const pending = await api("/uploads", { signal });
    let record = pending.find(
      (r) =>
        r.name === file.name &&
        r.size === file.size &&
        r.fingerprint === identity,
    );
    if (!record)
      record = await api("/uploads", {
        method: "POST",
        body: { name: file.name, size: file.size, fingerprint: identity },
        signal,
      });
    onProgress(record.offset, file.size);
    // A missing chunk response is ambiguous: ask the server before retrying.
    let failures = 0;
    while (record.offset < file.size) {
      checkAbort(signal);
      const part = file.slice(
        record.offset,
        Math.min(file.size, record.offset + CHUNK_BYTES),
      );
      const digest = await hash(part);
      checkAbort(signal);
      try {
        record = await api(`/uploads/${record.id}`, {
          method: "PATCH",
          body: part,
          headers: {
            "Upload-Offset": String(record.offset),
            "X-Chunk-SHA256": digest,
          },
          signal,
        });
        failures = 0;
      } catch (error) {
        checkAbort(signal);
        if (error.status && error.status !== 409 && error.status < 500)
          throw error;
        if (++failures > 3) throw error;
        record = await api(`/uploads/${record.id}`, { signal });
      }
      if (
        !Number.isSafeInteger(record.offset) ||
        record.offset < 0 ||
        record.offset > file.size
      )
        throw new Error("Invalid server upload offset.");
      onProgress(record.offset, file.size);
    }
    checkAbort(signal);
    // Publication is idempotent, including after a lost completion response.
    for (let attempt = 0; ; attempt++) {
      try {
        return await api(`/uploads/${record.id}/complete`, {
          method: "POST",
          signal,
        });
      } catch (error) {
        checkAbort(signal);
        if (attempt >= 2 || (error.status && error.status < 500)) throw error;
      }
    }
  }
  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    const unit = Math.min(
      units.length - 1,
      Math.floor(Math.log(bytes) / Math.log(1024)),
    );
    return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
  }
  return { upload, fingerprint, hash, formatBytes, CHUNK_BYTES };
});
