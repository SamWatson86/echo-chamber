const test = require("node:test");
const assert = require("node:assert/strict");
const { File } = require("node:buffer");
const {
  upload,
  hash,
  fingerprint,
  CHUNK_BYTES,
  formatBytes,
} = require("./files-transfer.js");
const file = () => new File(["abcdef"], "test.zip", { lastModified: 123 });
async function harness(
  source,
  { offset = null, loseReply = false, deny = false } = {},
) {
  let record = {
    id: "a".repeat(64),
    name: source.name,
    size: source.size,
    offset: offset ?? 0,
    fingerprint: await fingerprint(source),
  };
  const calls = [],
    progress = [];
  let dropped = false;
  async function api(path, opts = {}) {
    calls.push({ path, ...opts });
    if (path === "/uploads" && !opts.method)
      return offset === null ? [] : [{ ...record }];
    if (path === "/uploads") return { ...record };
    if (opts.method === "PATCH") {
      if (deny) throw Object.assign(new Error("expired"), { status: 401 });
      assert.equal(opts.headers["Upload-Offset"], String(record.offset));
      assert.equal(opts.headers["X-Chunk-SHA256"], await hash(opts.body));
      record.offset += opts.body.size;
      if (loseReply && !dropped) {
        dropped = true;
        throw new Error("response lost");
      }
    }
    if (path.endsWith("/complete")) {
      assert.equal(record.offset, record.size);
      record.complete = true;
    }
    return { ...record };
  }
  return {
    api,
    calls,
    progress,
    options: { onProgress: (...args) => progress.push(args) },
  };
}
test("uploads chunk bytes with their checksum before publishing", async () => {
  const source = file(),
    h = await harness(source);
  const result = await upload(h.api, source, h.options);
  assert.equal(result.complete, true);
  assert.equal(h.calls.filter((c) => c.method === "PATCH").length, 1);
  assert.deepEqual(h.progress, [
    [0, 6],
    [6, 6],
  ]);
});
test("resumes an existing upload from the server offset", async () => {
  const source = file(),
    h = await harness(source, { offset: 3 });
  await upload(h.api, source);
  assert.equal(
    await h.calls.find((c) => c.method === "PATCH").body.text(),
    "def",
  );
  assert.equal(
    h.calls.some((c) => c.path === "/uploads" && c.method === "POST"),
    false,
  );
});
test("a lost chunk response reconciles committed offset without duplicating bytes", async () => {
  const source = file(),
    h = await harness(source, { loseReply: true });
  assert.equal((await upload(h.api, source)).complete, true);
  assert.equal(h.calls.filter((c) => c.method === "PATCH").length, 1);
  assert.equal(
    h.calls.some((c) => c.path.endsWith("/complete")),
    true,
  );
});
test("expired credentials stop without retrying or publishing", async () => {
  const source = file(),
    h = await harness(source, { deny: true });
  await assert.rejects(upload(h.api, source), { status: 401 });
  assert.equal(h.calls.filter((c) => c.method === "PATCH").length, 1);
  assert.equal(
    h.calls.some((c) => c.path.endsWith("/complete")),
    false,
  );
});
test("pause keeps the committed offset and does not publish", async () => {
  const source = file(),
    h = await harness(source);
  const abort = new AbortController();
  await assert.rejects(
    upload(h.api, source, {
      signal: abort.signal,
      onProgress(offset) {
        if (offset) abort.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(
    h.calls.some((c) => c.path.endsWith("/complete")),
    false,
  );
});
test("empty files publish without sending an empty chunk", async () => {
  const source = new File([], "empty.txt", { lastModified: 0 }),
    h = await harness(source);
  assert.equal((await upload(h.api, source)).complete, true);
  assert.equal(
    h.calls.some((c) => c.method === "PATCH"),
    false,
  );
});
test("multi-gigabyte source reads remain bounded and use exact offsets", async () => {
  const size = 5 * 1024 ** 3,
    slices = [];
  const source = {
    name: "huge.iso",
    size,
    lastModified: 12,
    slice(start, end = size) {
      slices.push([start, end]);
      return new Blob([Buffer.alloc(end - start)]);
    },
  };
  const h = await harness(source, { offset: size - 3 });
  slices.length = 0;
  await upload(h.api, source);
  assert.ok(slices.every(([start, end]) => end - start <= CHUNK_BYTES));
  assert.deepEqual(slices.at(-1), [size - 3, size]);
});
test("files with different source timestamps do not resume each other", async () => {
  const a = file(),
    b = new File(["abcdef"], "test.zip", { lastModified: 124 });
  assert.notEqual(await fingerprint(a), await fingerprint(b));
});
test("completion retries safely after a lost publication response", async () => {
  const source = file(),
    h = await harness(source);
  let tries = 0;
  await upload(async (path, opts) => {
    const result = await h.api(path, opts);
    if (path.endsWith("/complete") && tries++ === 0) throw new Error("lost");
    return result;
  }, source);
  assert.equal(tries, 2);
});
test("sizes stay readable beyond 4 GiB", () => {
  assert.equal(formatBytes(5 * 1024 ** 3), "5.0 GiB");
  assert.equal(formatBytes(0), "0 B");
});
