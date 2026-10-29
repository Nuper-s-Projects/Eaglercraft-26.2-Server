(function (global) {
  "use strict";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function mergeServerList(input, defaults) {
    const bytes = input ? new Uint8Array(input) : new Uint8Array([10, 0, 0, 0]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    function take(size) {
      if (size < 0 || offset + size > bytes.length) throw new Error("Invalid servers.dat length");
      const start = offset; offset += size; return start;
    }
    function byte() { return bytes[take(1)]; }
    function count() { return view.getInt32(take(4), false); }
    function string() {
      const size = view.getUint16(take(2), false);
      const start = take(size);
      return decoder.decode(bytes.subarray(start, offset));
    }
    function skip(type, depth) {
      if (depth > 64) throw new Error("servers.dat nesting limit exceeded");
      switch (type) {
        case 1: take(1); break;
        case 2: take(2); break;
        case 3: case 5: take(4); break;
        case 4: case 6: take(8); break;
        case 7: take(count()); break;
        case 8: string(); break;
        case 9: {
          const child = byte(), length = count();
          if (length < 0 || length > bytes.length || (child === 0 && length !== 0)) throw new Error("Invalid NBT list");
          for (let i = 0; i < length; i++) skip(child, depth + 1);
          break;
        }
        case 10: while (true) { const child = byte(); if (!child) break; string(); skip(child, depth + 1); } break;
        case 11: take(count() * 4); break;
        case 12: take(count() * 8); break;
        default: throw new Error("Unsupported NBT tag " + type);
      }
    }
    function compound() {
      const tags = [];
      while (true) {
        const start = offset, type = byte();
        if (!type) return tags;
        const name = string(), payload = offset;
        skip(type, 0);
        tags.push({ type, name, payload, raw: bytes.slice(start, offset) });
      }
    }
    function join(parts) {
      const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
      let position = 0;
      for (const part of parts) { output.set(part, position); position += part.length; }
      return output;
    }
    function utf(value) {
      const data = encoder.encode(value);
      if (data.length > 65535) throw new Error("Server field is too long");
      return join([new Uint8Array([data.length >> 8, data.length & 255]), data]);
    }
    function textTag(name, value) { return join([new Uint8Array([8]), utf(name), utf(value)]); }
    if (byte() !== 10) throw new Error("Expected uncompressed servers.dat compound");
    string();
    const header = bytes.slice(0, offset), root = compound();
    if (offset !== bytes.length) throw new Error("Unexpected trailing servers.dat data");
    const saved = root.find(tag => tag.name === "servers");
    const entries = [];
    if (saved) {
      if (saved.type !== 9) throw new Error("Expected servers NBT list");
      offset = saved.payload;
      const child = byte(), length = count();
      if (child !== 10 || length < 0 || length > bytes.length) throw new Error("Expected server compounds");
      for (let i = 0; i < length; i++) entries.push(compound());
    }
    for (const server of defaults) {
      if (!server || typeof server.name !== "string" || typeof server.addr !== "string") continue;
      const url = new URL(server.addr);
      if (!/^wss?:$/.test(url.protocol)) throw new Error("Expected WebSocket server address");
      let found = false;
      for (let i = 0; i < entries.length; i++) {
        const ip = entries[i].find(tag => tag.type === 8 && tag.name === "ip");
        if (!ip) continue;
        offset = ip.payload;
        if (string() !== server.addr) continue;
        entries[i] = entries[i].filter(tag => !["name", "ip", "hidden", "connectionMode"].includes(tag.name));
        entries[i].push({ raw: textTag("name", server.name) }, { raw: textTag("ip", server.addr) },
          { raw: join([new Uint8Array([1]), utf("hidden"), new Uint8Array([0])]) },
          { raw: textTag("connectionMode", "eaglerx") });
        found = true;
      }
      if (!found) entries.push([
        { raw: textTag("name", server.name) }, { raw: textTag("ip", server.addr) },
        { raw: join([new Uint8Array([1]), utf("hidden"), new Uint8Array([0])]) },
        { raw: textTag("connectionMode", "eaglerx") }
      ]);
    }
    const length = new Uint8Array(4);
    new DataView(length.buffer).setInt32(0, entries.length, false);
    const list = join([new Uint8Array([9]), utf("servers"), new Uint8Array([10]), length,
      ...entries.map(tags => join([...tags.map(tag => tag.raw), new Uint8Array([0])]))]);
    return join([header, ...root.filter(tag => tag.name !== "servers").map(tag => tag.raw), list, new Uint8Array([0])]);
  }

  global.__eaglerEnsureDefaultServers = async function () {
    const options = global.eaglercraftXOpts || {};
    const defaults = options.servers || [];
    if (!defaults.length) return;
    const databaseName = "_net_lax1dude_eaglercraft_v1_8_internal_PlatformFilesystem_1_8_8_" + (options.worldsDB || "worlds");
    try {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        const timer = setTimeout(() => reject(new Error("Server list storage timed out")), 10000);
        request.onupgradeneeded = () => request.result.createObjectStore("filesystem", { keyPath: ["path"] });
        request.onerror = () => { clearTimeout(timer); reject(request.error); };
        request.onblocked = () => { clearTimeout(timer); reject(new Error("Server list storage is blocked")); };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("filesystem", "readwrite");
          const store = tx.objectStore("filesystem");
          const read = store.get(["servers.dat"]);
          tx.oncomplete = () => { clearTimeout(timer); db.close(); resolve(); };
          tx.onabort = tx.onerror = () => { clearTimeout(timer); db.close(); reject(tx.error || new Error("Server list update failed")); };
          read.onsuccess = () => {
            try {
              const previous = read.result;
              const merged = mergeServerList(previous && previous.data, defaults);
              const old = previous && new Uint8Array(previous.data);
              if (old && old.length === merged.length && old.every((value, index) => value === merged[index])) return;
              if (previous) {
                const backup = store.get(["servers.dat.default-server-backup"]);
                backup.onsuccess = () => {
                  if (!backup.result) store.put({ ...previous, path: "servers.dat.default-server-backup" });
                };
              }
              store.put({ ...(previous || {}), path: "servers.dat", data: merged.buffer });
            } catch (error) { global.__eaglerDefaultServerStatus = { state: "error", error: String(error) }; tx.abort(); }
          };
        };
      });
      global.__eaglerDefaultServerStatus = { state: "ready", servers: defaults.map(server => server.addr) };
    } catch (error) {
      global.__eaglerDefaultServerStatus = { state: "error", error: String(error) };
      console.error("Could not add the default multiplayer server:", error);
    }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = { mergeServerList };
})(typeof window !== "undefined" ? window : globalThis);
