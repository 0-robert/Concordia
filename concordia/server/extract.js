// Streaming .tar.gz extractor using only Node built-ins (fs, path, zlib).
// Unpacks a pre-built node_modules.tar.gz into the pod's filesystem.
//
// Design: stream the gzip bytes through zlib.createGunzip(), accumulate a
// rolling buffer, and pull out tar entries (512-byte header + data) as soon
// as enough bytes are available. Peak memory = one largest file entry (~few MB)
// instead of the full 283 MB decompressed tree — avoids OOM in BrowserPod.
//
// Handles:
//   • POSIX tar headers (file '0', directory '5')
//   • GNU 'L' typeflag for long filenames (>100 chars)
//   • pax 'x'/'g' extended headers (skipped)
//
// Usage: node extract.js <archive.tar.gz> <destDir>

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

function octal(buf) {
  const s = buf.toString("utf8").replace(/\0.*$/, "").trim();
  return s ? parseInt(s, 8) || 0 : 0;
}
function nulTerminated(buf) {
  return buf.toString("utf8").replace(/\0.*$/, "");
}

async function extract(archivePath, destDir) {
  const t0 = Date.now();
  console.log(`[extract] streaming ${archivePath} → ${destDir}`);
  await fs.promises.mkdir(destDir, { recursive: true });

  const readStream = fs.createReadStream(archivePath);
  const gunzip = zlib.createGunzip();
  readStream.pipe(gunzip);

  // rolling buffer of decompressed bytes we haven't parsed yet
  let pending = Buffer.alloc(0);
  let pendingLongName = null;
  let fileCount = 0;
  let dirCount = 0;
  let lastReport = Date.now();

  // State machine: consume header (512), then file data (size rounded to 512)
  let state = "header";
  let currentHeader = null;
  let currentDataSize = 0; // raw size
  let currentDataPadded = 0; // rounded to 512

  // We collect chunks of data and write them out. For large files we could
  // write incrementally, but for our deps, per-file buffering is fine.
  let currentDataCollected = Buffer.alloc(0);

  async function tryConsume() {
    while (true) {
      if (state === "header") {
        if (pending.length < 512) return;
        const header = pending.subarray(0, 512);
        // end-of-archive: zero header
        if (header[0] === 0 && header[100] === 0 && header[124] === 0) {
          pending = pending.subarray(512);
          continue;
        }
        currentHeader = {
          name: nulTerminated(header.subarray(0, 100)),
          size: octal(header.subarray(124, 136)),
          typeflag: String.fromCharCode(header[156]) || "0",
        };
        currentDataSize = currentHeader.size;
        currentDataPadded = Math.ceil(currentDataSize / 512) * 512;
        currentDataCollected = Buffer.alloc(0);
        pending = pending.subarray(512);
        state = "data";
      }

      if (state === "data") {
        const needed = currentDataPadded - currentDataCollected.length;
        if (pending.length < needed) {
          // take what we can and wait for more
          currentDataCollected = Buffer.concat([currentDataCollected, pending]);
          pending = Buffer.alloc(0);
          return;
        }
        currentDataCollected = Buffer.concat([
          currentDataCollected,
          pending.subarray(0, needed),
        ]);
        pending = pending.subarray(needed);

        // Process this entry
        const { typeflag } = currentHeader;
        let name = currentHeader.name;
        if (pendingLongName) {
          name = pendingLongName;
          pendingLongName = null;
        }
        const fileData = currentDataCollected.subarray(0, currentDataSize);

        if (typeflag === "L") {
          pendingLongName = nulTerminated(fileData);
        } else if (typeflag === "5" || name.endsWith("/")) {
          await fs.promises.mkdir(path.join(destDir, name), { recursive: true });
          dirCount++;
        } else if (typeflag === "0" || typeflag === "" || typeflag === "\0") {
          const full = path.join(destDir, name);
          await fs.promises.mkdir(path.dirname(full), { recursive: true });
          await fs.promises.writeFile(full, fileData);
          fileCount++;
        } // pax 'x'/'g' skipped implicitly

        if (Date.now() - lastReport > 3000) {
          console.log(`[extract] ${fileCount} files, ${dirCount} dirs`);
          lastReport = Date.now();
        }

        state = "header";
      }
    }
  }

  for await (const chunk of gunzip) {
    pending = Buffer.concat([pending, chunk]);
    await tryConsume();
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[extract] done in ${dt}s — ${fileCount} files, ${dirCount} dirs`);
}

const [archivePath, destDir] = process.argv.slice(2);
if (!archivePath || !destDir) {
  console.error("usage: node extract.js <archive.tar.gz> <destDir>");
  process.exit(1);
}
extract(archivePath, destDir).catch((e) => {
  console.error("[extract] FAILED:", e?.message || e);
  console.error(e?.stack || "");
  process.exit(1);
});
