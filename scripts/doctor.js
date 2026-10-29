const fs = require("fs");
const path = require("path");
const {
  ROOT, PROXY, BACKEND, readConfig, javaMajor, portInUse, walkFiles,
  patchVelocityToml, patchPaperVelocity, patchViaVersionConfig
} = require("./common");

(async () => {
  const cfg = readConfig();
  patchVelocityToml(cfg);
  patchPaperVelocity();
  patchViaVersionConfig(cfg);

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add("Node.js 20+", nodeMajor >= 20, process.version);
  const j = javaMajor();
  add("Java 25+", j !== null && j >= 25, j === null ? "not found" : `Java ${j}`);

  const paths = {
    paper: path.join(BACKEND, "paper.jar"),
    velocity: path.join(PROXY, "velocity.jar"),
    eagler: path.join(PROXY, "plugins", "EaglerXServer.jar"),
    via: path.join(PROXY, "plugins", "ViaVersion.jar"),
    backwards: path.join(PROXY, "plugins", "ViaBackwards.jar")
  };
  add("Paper JAR", fs.existsSync(paths.paper), path.relative(ROOT, paths.paper));
  add("Velocity JAR", fs.existsSync(paths.velocity), path.relative(ROOT, paths.velocity));
  add("EaglerXServer JAR", fs.existsSync(paths.eagler), path.relative(ROOT, paths.eagler));
  add("ViaVersion JAR", fs.existsSync(paths.via), path.relative(ROOT, paths.via));
  add("ViaBackwards JAR", fs.existsSync(paths.backwards), path.relative(ROOT, paths.backwards));

  const listener = [...walkFiles(path.join(PROXY, "plugins"), "listeners.toml"), ...walkFiles(path.join(PROXY, "plugins"), "listeners.cfg")];
  add("EaglerXServer listener", listener.length > 0, listener.length ? path.relative(ROOT, listener[0]) : "missing");
  const listenerText = listener.length && listener[0].endsWith("listeners.toml") ? fs.readFileSync(listener[0], "utf8") : "";
  add("Eagler-only listener", /^\s*dual_stack\s*=\s*false\s*$/m.test(listenerText), "EaglerXServer listener is dedicated to Eaglercraft clients");
  const eaglerSettings = path.join(PROXY, "plugins", "eaglerxserver", "settings.toml");
  const eaglerSettingsText = fs.existsSync(eaglerSettings) ? fs.readFileSync(eaglerSettings, "utf8") : "";
  add("Eagler account password prompts disabled", /^\s*enable_authentication_events\s*=\s*false\s*$/m.test(eaglerSettingsText), "no account-auth plugin is included");

  const velocityToml = path.join(PROXY, "velocity.toml");
  const vt = fs.existsSync(velocityToml) ? fs.readFileSync(velocityToml, "utf8") : "";
  add("Velocity modern forwarding", /player-info-forwarding-mode\s*=\s*"modern"/i.test(vt), "player-info-forwarding-mode = modern");
  add("Velocity backend", new RegExp(`main\\s*=\\s*"127\\.0\\.0\\.1:${Number(cfg.backendPort)}"`).test(vt), `127.0.0.1:${cfg.backendPort}`);

  const paperGlobal = path.join(BACKEND, "config", "paper-global.yml");
  const pg = fs.existsSync(paperGlobal) ? fs.readFileSync(paperGlobal, "utf8") : "";
  add("Paper Velocity forwarding", /velocity:\s*\r?\n\s+enabled:\s*true\s*\r?\n\s+online-mode:\s*false/i.test(pg), "enabled=true, online-mode=false");

  const viaConfig = path.join(PROXY, "plugins", "viaversion", "config.yml");
  const vc = fs.existsSync(viaConfig) ? fs.readFileSync(viaConfig, "utf8") : "";
  const protocol = Number(cfg.backendProtocol || 776);
  add("ViaVersion backend protocol", new RegExp(`main:\\s*${protocol}(?:\\s|$)`).test(vc), `main=${protocol} (Minecraft ${cfg.minecraftVersion})`);

  for (const [name, port] of [["client", cfg.clientPort], ["Eagler/Velocity", cfg.eaglerPort], ["Paper backend", cfg.backendPort]]) {
    const used = await portInUse(port);
    add(`${name} port ${port} free`, !used, used ? "currently in use" : "available");
  }

  for (const c of checks) console.log(`${c.ok ? "OK " : "ERR"}  ${c.name}: ${c.detail}`);
  if (checks.some(c => !c.ok)) process.exitCode = 1;
})();
