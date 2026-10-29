const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RUNTIME = path.join(ROOT, "runtime");
const PROXY = path.join(RUNTIME, "proxy");
const BACKEND = path.join(RUNTIME, "backend");
const CLIENT = path.join(ROOT, "client");

function readConfig() {
  const p = path.join(ROOT, "config.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveConfig(cfg) {
  fs.writeFileSync(path.join(ROOT, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
}

function ensureDirs() {
  fs.mkdirSync(path.join(PROXY, "plugins"), { recursive: true });
  fs.mkdirSync(BACKEND, { recursive: true });
  fs.mkdirSync(CLIENT, { recursive: true });
}

function javaVersion(executable) {
  const out = spawnSync(executable, ["-version"], { encoding: "utf8" });
  if (out.error || out.status !== 0) return null;
  const text = String(out.stderr || "") + String(out.stdout || "");
  let m = text.match(/version\s+"(\d+)(?:\.|\")/i);
  if (!m) m = text.match(/openjdk\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

function javaRuntime() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, "bin", "java"));
  candidates.push("java");

  if (process.platform === "darwin") {
    const brew = spawnSync("brew", ["--prefix", "openjdk@25"], { encoding: "utf8" });
    if (brew.status === 0 && brew.stdout.trim()) candidates.unshift(path.join(brew.stdout.trim(), "bin", "java"));
    const home = spawnSync("/usr/libexec/java_home", ["-v", "25+"], { encoding: "utf8" });
    if (home.status === 0 && home.stdout.trim()) candidates.unshift(path.join(home.stdout.trim(), "bin", "java"));
  }

  const seen = new Set();
  for (const executable of candidates) {
    if (seen.has(executable)) continue;
    seen.add(executable);
    const major = javaVersion(executable);
    if (major !== null && major >= 25) return { executable, major };
  }
  return { executable: null, major: javaVersion("java") };
}

function javaMajor() {
  return javaRuntime().major;
}

function checkJava25() {
  const { executable, major } = javaRuntime();
  if (!executable) {
    const msg = [
      "Java 25+ is required for Minecraft/Paper 26.2 and current Velocity.",
      `Detected: ${major === null ? "Java not found" : `Java ${major}`}`,
      "",
      ...(process.platform === "darwin" ? [
        "Install a Java 25 JDK for macOS, for example with Homebrew:",
        "  brew install openjdk@25",
        "",
        "Then run: npm start"
      ] : [
        "Install a Java 25 JDK and make sure its bin directory is available on PATH.",
        "Then run: npm start"
      ])
    ].join("\n");
    const err = new Error(msg);
    err.code = "JAVA_VERSION";
    throw err;
  }
  return executable;
}

function escapeJsString(v) {
  return JSON.stringify(String(v));
}

function patchClient(cfg) {
  const file = path.join(CLIENT, "index.html");
  if (!fs.existsSync(file)) throw new Error(`Missing client: ${file}`);
  const originalHtml = fs.readFileSync(file, "utf8");
  let html = originalHtml;
  const start = "/* NUPER_SERVER_CONFIG_START */";
  const end = "/* NUPER_SERVER_CONFIG_END */";
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a < 0 || b < 0 || b <= a) {
    throw new Error("Client server-list markers are missing. Re-extract the ZIP.");
  }
  const addr = cfg.publicWebSocketUrl && String(cfg.publicWebSocketUrl).trim()
    ? escapeJsString(String(cfg.publicWebSocketUrl).trim())
    : `(location.protocol === "https:" ? "wss://" : "ws://") + location.hostname + ":${Number(cfg.eaglerPort)}/"`;
  const block = `${start}\n\t\t\tservers: [{ name: ${escapeJsString(cfg.serverName)}, addr: ${addr} }],\n\t\t\t${end}`;
  html = html.slice(0, a) + block + html.slice(b + end.length);
  const helperStart = "/* NUPER_DEFAULT_SERVER_STORAGE_START */";
  const helperEnd = "/* NUPER_DEFAULT_SERVER_STORAGE_END */";
  const helperA = html.indexOf(helperStart);
  const helperB = html.indexOf(helperEnd);
  if (helperA >= 0 && helperB > helperA) {
    const helper = fs.readFileSync(path.join(ROOT, "scripts", "default-server-list.js"), "utf8");
    html = html.slice(0, helperA) + helperStart + "\n" + helper + "\n" + helperEnd + html.slice(helperB + helperEnd.length);
  }
  if (html !== originalHtml) {
    fs.writeFileSync(file, html);
    try { fs.unlinkSync(file + ".br"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function writeServerProperties(cfg) {
  const p = path.join(BACKEND, "server.properties");
  const gameMode = String(cfg.gameMode || "creative").toLowerCase();
  if (!["survival", "creative", "adventure", "spectator"].includes(gameMode)) {
    throw new Error("gameMode must be survival, creative, adventure, or spectator.");
  }
  const lines = [
    "# Managed by scripts/start.js. Edit config.json for common settings.",
    "server-ip=127.0.0.1",
    `server-port=${Number(cfg.backendPort)}`,
    "online-mode=false",
    "enforce-secure-profile=false",
    `motd=${String(cfg.motd).replace(/[\r\n]/g, " ")}`,
    `gamemode=${gameMode}`,
    "force-gamemode=true",
    `max-players=${Number(cfg.maxPlayers)}`,
    `view-distance=${Number(cfg.viewDistance)}`,
    `simulation-distance=${Number(cfg.simulationDistance)}`,
    "spawn-protection=0",
    "enable-status=true",
    "enable-query=false",
    "allow-flight=false",
    "white-list=false",
    "network-compression-threshold=256",
    "sync-chunk-writes=true"
  ];
  fs.writeFileSync(p, lines.join("\n") + "\n");
}

function ensureForwardingSecret() {
  const file = path.join(PROXY, "forwarding.secret");
  let secret = "";
  try { secret = fs.readFileSync(file, "utf8").trim(); } catch (_) {}
  if (!secret) {
    secret = crypto.randomBytes(24).toString("base64url");
    fs.writeFileSync(file, secret + "\n");
  }
  return secret;
}

function replaceTomlScalar(text, key, valueLiteral) {
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*=.*$`, "m");
  const line = `${key} = ${valueLiteral}`;
  return re.test(text) ? text.replace(re, line) : `${line}\n${text}`;
}

function replaceTomlSection(text, sectionName, replacement) {
  const lines = text.split(/\r?\n/);
  const header = `[${sectionName}]`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === header) { start = i; break; }
  }
  if (start < 0) return `${text.replace(/\s+$/, "")}\n\n${replacement.replace(/\s+$/, "")}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) { end = i; break; }
  }
  const replacementLines = replacement.replace(/\s+$/, "").split(/\r?\n/);
  return [...lines.slice(0, start), ...replacementLines, "", ...lines.slice(end)].join("\n");
}

function patchVelocityToml(cfg) {
  const file = path.join(PROXY, "velocity.toml");
  if (!fs.existsSync(file)) return false;
  let t = fs.readFileSync(file, "utf8");
  t = replaceTomlScalar(t, "bind", JSON.stringify(`0.0.0.0:${Number(cfg.eaglerPort)}`));
  t = replaceTomlScalar(t, "motd", JSON.stringify(`<gold>${cfg.motd}</gold>`));
  t = replaceTomlScalar(t, "online-mode", "false");
  t = replaceTomlScalar(t, "force-key-authentication", "false");
  t = replaceTomlScalar(t, "player-info-forwarding-mode", JSON.stringify("modern"));
  t = replaceTomlScalar(t, "forwarding-secret-file", JSON.stringify("forwarding.secret"));

  const serverSection = `[servers]\nmain = ${JSON.stringify(`127.0.0.1:${Number(cfg.backendPort)}`)}\ntry = ["main"]`;
  t = replaceTomlSection(t, "servers", serverSection);
  fs.writeFileSync(file, t.endsWith("\n") ? t : t + "\n");
  return true;
}

function ensureVelocityToml(cfg) {
  const file = path.join(PROXY, "velocity.toml");
  if (fs.existsSync(file)) {
    patchVelocityToml(cfg);
    return false;
  }

  const bind = `0.0.0.0:${Number(cfg.eaglerPort)}`;
  const backend = `127.0.0.1:${Number(cfg.backendPort)}`;
  const motd = `<gold>${String(cfg.motd).replace(/[\r\n]/g, " ")}</gold>`;
  const maxPlayers = Math.max(1, Number(cfg.maxPlayers) || 30);

  const text = `# Generated by Eaglercraft 26.2 Easy Server.\n` +
`config-version = "2.9"\n` +
`bind = ${JSON.stringify(bind)}\n` +
`motd = ${JSON.stringify(motd)}\n` +
`show-max-players = ${maxPlayers}\n` +
`online-mode = false\n` +
`force-key-authentication = false\n` +
`prevent-client-proxy-connections = false\n` +
`player-info-forwarding-mode = "modern"\n` +
`forwarding-secret-file = "forwarding.secret"\n` +
`announce-forge = false\n` +
`kick-existing-players = false\n` +
`sample-players-in-ping = false\n` +
`enable-player-address-logging = true\n\n` +
`[ping-passthrough]\n` +
`version = false\nplayers = false\ndescription = false\nfavicon = false\nmodinfo = false\n\n` +
`[packet-limiter]\n` +
`interval = 7\npackets-per-second = -1\nbytes-per-second = -1\ndecompressed-bytes-per-second = 5242880\n\n` +
`[servers]\n` +
`main = ${JSON.stringify(backend)}\n` +
`try = ["main"]\n\n` +
`[forced-hosts]\n\n` +
`[advanced]\n` +
`compression-threshold = 256\n` +
`compression-level = -1\n` +
`login-ratelimit = 3000\n` +
`connection-timeout = 5000\n` +
`read-timeout = 30000\n` +
`haproxy-protocol = false\n` +
`tcp-fast-open = false\n` +
`bungee-plugin-message-channel = true\n` +
`show-ping-requests = false\n` +
`failover-on-unexpected-server-disconnect = true\n` +
`announce-proxy-commands = true\n` +
`log-command-executions = false\n` +
`log-player-connections = true\n` +
`accepts-transfers = false\n` +
`enable-reuse-port = false\n` +
`command-rate-limit = 50\n` +
`forward-commands-if-rate-limited = true\n` +
`kick-after-rate-limited-commands = 0\n` +
`tab-complete-rate-limit = 10\n` +
`kick-after-rate-limited-tab-completes = 0\n\n` +
`[query]\n` +
`enabled = false\n` +
`port = ${Number(cfg.eaglerPort)}\n` +
`map = "Velocity"\n` +
`show-plugins = false\n`;

  fs.writeFileSync(file, text);
  return true;
}

function walkFiles(dir, name, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, name, out);
    else if (e.name.toLowerCase() === name.toLowerCase()) out.push(p);
  }
  return out;
}

function patchEaglerConfigs(cfg) {
  let changed = 0;
  for (const file of walkFiles(path.join(PROXY, "plugins"), "listeners.cfg")) {
    let t = fs.readFileSync(file, "utf8");
    const before = t;
    t = t.replace(/0\.0\.0\.0:25565/g, `0.0.0.0:${Number(cfg.eaglerPort)}`)
         .replace(/0\.0\.0\.0:25577/g, `0.0.0.0:${Number(cfg.eaglerPort)}`)
         .replace(/&6An EaglercraftX server/g, String(cfg.motd))
         .replace(/^(\s*server_icon\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)?\s*$/m, '$1"server-icon.png"');
    if (t !== before) {
      fs.writeFileSync(file, t);
      changed++;
    }
  }
  for (const file of walkFiles(path.join(PROXY, "plugins"), "listeners.toml")) {
    let t = fs.readFileSync(file, "utf8");
    const before = t;
    t = t.replace(/^(\s*inject_address\s*=\s*)"[^"]*"/m, `$1${JSON.stringify(`0.0.0.0:${Number(cfg.eaglerPort)}`)}`)
         .replace(/^(\s*server_motd\s*=\s*)\[[^\r\n]*\]/m, `$1${JSON.stringify([String(cfg.motd)])}`)
         // Keep this listener dedicated to Eaglercraft clients.
         .replace(/^(\s*dual_stack\s*=\s*)(true|false)/m, "$1false")
         .replace(/^(\s*server_icon\s*=\s*)(?:"[^"]*"|'[^']*'|\S+)?\s*$/m, '$1"server-icon.png"');
    if (t !== before) {
      fs.writeFileSync(file, t);
      changed++;
    }
  }
  for (const file of walkFiles(path.join(PROXY, "plugins"), "settings.cfg")) {
    let t = fs.readFileSync(file, "utf8");
    const before = t;
    t = t.replace(/^(\s*server_name\s*[:=]\s*)(.*)$/m, `$1${JSON.stringify(String(cfg.serverName))}`);
    if (t !== before) {
      fs.writeFileSync(file, t);
      changed++;
    }
  }
  for (const file of walkFiles(path.join(PROXY, "plugins"), "settings.toml")) {
    let t = fs.readFileSync(file, "utf8");
    const before = t;
    t = t.replace(/^(\s*server_name\s*=\s*)"[^"]*"/m, `$1${JSON.stringify(String(cfg.serverName))}`)
         .replace(/^(\s*max_minecraft_protocol_v5\s*=\s*)-?\d+/m, "$1-1")
         .replace(/^(\s*protocol_v5_allowed\s*=\s*)(true|false)/m, "$1true")
         .replace(/^(\s*enable_authentication_events\s*=\s*)(true|false)/m, "$1false");
    if (t !== before) {
      fs.writeFileSync(file, t);
      changed++;
    }
  }
  return changed;
}

function patchPaperVelocity() {
  const secret = ensureForwardingSecret();
  const file = path.join(BACKEND, "config", "paper-global.yml");
  if (!fs.existsSync(file)) return false;
  let t = fs.readFileSync(file, "utf8");
  const original = t;
  const velocityBlock = `  velocity:\n    enabled: true\n    online-mode: false\n    secret: '${secret.replace(/'/g, "''")}'`;
  if (/^  velocity:\s*$/m.test(t)) {
    t = t.replace(/^  velocity:\s*\r?\n(?: {4}[^\r\n]*\r?\n)*/m, velocityBlock + "\n");
  } else if (/^proxies:\s*$/m.test(t)) {
    t = t.replace(/^proxies:\s*$/m, `proxies:\n${velocityBlock}`);
  } else {
    t += `\nproxies:\n${velocityBlock}\n`;
  }
  if (t !== original) fs.writeFileSync(file, t);
  return true;
}

function replaceYamlTopLevelBlock(text, key, block) {
  const lines = text.split(/\r?\n/);
  const startRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}:\\s*(?:#.*)?$`);
  let start = lines.findIndex(line => startRe.test(line));
  const blockLines = block.replace(/\s+$/, "").split(/\r?\n/);
  if (start < 0) return `${text.replace(/\s+$/, "")}\n${blockLines.join("\n")}\n`;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (/^[A-Za-z0-9_.-]+:\s*/.test(line) && !/^\s/.test(line)) break;
    end++;
  }
  return [...lines.slice(0, start), ...blockLines, ...lines.slice(end)].join("\n");
}

function patchViaVersionConfig(cfg) {
  const file = path.join(PROXY, "plugins", "viaversion", "config.yml");
  if (!fs.existsSync(file)) return false;
  let t = fs.readFileSync(file, "utf8");
  const protocol = Number(cfg.backendProtocol || 776);
  t = t.replace(/^velocity-ping-interval:\s*.*$/m, "velocity-ping-interval: 60");
  t = t.replace(/^velocity-ping-save:\s*.*$/m, "velocity-ping-save: true");
  t = replaceYamlTopLevelBlock(t, "velocity-servers", `velocity-servers:\n  default: ${protocol}\n  main: ${protocol}`);
  fs.writeFileSync(file, t.endsWith("\n") ? t : t + "\n");
  return true;
}

function portInUse(port, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(Number(port), host);
  });
}

module.exports = {
  ROOT, RUNTIME, PROXY, BACKEND, CLIENT,
  readConfig, saveConfig, ensureDirs, javaMajor, javaRuntime, checkJava25,
  patchClient, writeServerProperties, ensureForwardingSecret,
  patchVelocityToml, ensureVelocityToml, patchEaglerConfigs,
  patchPaperVelocity, patchViaVersionConfig,
  walkFiles, portInUse
};
