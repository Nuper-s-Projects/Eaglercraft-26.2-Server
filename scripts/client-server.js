const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { CLIENT } = require("./common");

async function ensureBrotliIndex() {
  const source = path.join(CLIENT, "index.html");
  const compressed = source + ".br";
  const sourceStat = fs.statSync(source);
  try {
    if (fs.statSync(compressed).mtimeMs >= sourceStat.mtimeMs) return;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = compressed + ".tmp-" + process.pid;
  try {
    await pipeline(
      fs.createReadStream(source),
      zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }),
      fs.createWriteStream(temporary)
    );
    await fs.promises.rename(temporary, compressed);
  } catch (error) {
    try { await fs.promises.unlink(temporary); } catch (_) {}
    throw error;
  }
}

function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".css": "text/css; charset=utf-8"
  }[ext] || "application/octet-stream";
}

async function createClientServer(port) {
  await ensureBrotliIndex();
  const server = http.createServer((req, res) => {
    try {
      let pathname = new URL(req.url, "http://localhost").pathname;
      if (pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (pathname === "/") pathname = "/index.html";
      const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
      const sourceFile = path.join(CLIENT, safe);
      if (!sourceFile.startsWith(CLIENT + path.sep) || !fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const acceptsBrotli = String(req.headers["accept-encoding"] || "").split(",").some(part => {
        const [name, ...params] = part.trim().toLowerCase().split(";");
        const quality = params.map(value => value.trim()).find(value => value.startsWith("q="));
        return name === "br" && (!quality || Number(quality.slice(2)) > 0);
      });
      const isIndex = sourceFile === path.join(CLIENT, "index.html");
      const compressedFile = sourceFile + ".br";
      const useBrotli = isIndex && acceptsBrotli && fs.existsSync(compressedFile);
      const file = useBrotli ? compressedFile : sourceFile;
      res.setHeader("Content-Type", mime(sourceFile));
      if (isIndex) res.setHeader("Vary", "Accept-Encoding");
      if (useBrotli) res.setHeader("Content-Encoding", "br");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      const stat = fs.statSync(file);
      const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
      const lastModified = stat.mtime.toUTCString();
      res.setHeader("Cache-Control", pathname.endsWith(".html")
        ? "public, max-age=0, must-revalidate"
        : "public, max-age=3600");
      res.setHeader("ETag", etag);
      res.setHeader("Last-Modified", lastModified);
      if (req.method === "GET" || req.method === "HEAD") {
        const match = req.headers["if-none-match"];
        const matched = match && match.split(",").some(value => value.trim() === "*" || value.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""));
        const modifiedSince = req.headers["if-modified-since"];
        if (matched || (!match && modifiedSince && Math.floor(stat.mtimeMs / 1000) <= Date.parse(modifiedSince) / 1000)) {
          res.statusCode = 304;
          res.end();
          return;
        }
      }
      res.setHeader("Content-Length", stat.size);
      if (req.method === "HEAD") {
        res.statusCode = 200;
        res.end();
        return;
      }
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Internal server error");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), "0.0.0.0", () => resolve(server));
  });
}

module.exports = { createClientServer };
