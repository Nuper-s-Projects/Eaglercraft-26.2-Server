const fs = require("fs");
const path = require("path");
const {
  ROOT, PROXY, BACKEND, ensureDirs, readConfig, patchClient,
  ensureForwardingSecret, patchVelocityToml, patchPaperVelocity,
  patchViaVersionConfig, patchEaglerConfigs
} = require("./common");

const USER_AGENT = "eaglercraft-26.2-easy-server/1.2 (local server setup)";

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept": "application/json" }, redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}: ${url}`);
  return r.json();
}

async function download(url, dest) {
  const tmp = `${dest}.download`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  console.log(`downloading ${path.basename(dest)}...`);
  const r = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
  if (!r.ok) throw new Error(`Download failed (${r.status}): ${url}`);
  if (!r.body) throw new Error(`No response body: ${url}`);
  const file = fs.createWriteStream(tmp);
  await new Promise((resolve, reject) => {
    const reader = r.body.getReader();
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) { file.end(resolve); return; }
        if (!file.write(Buffer.from(value))) file.once("drain", pump);
        else pump();
      }).catch(reject);
    }
    file.on("error", reject);
    pump();
  });
  const stat = fs.statSync(tmp);
  if (stat.size < 100000) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Downloaded file is unexpectedly small (${stat.size} bytes): ${url}`);
  }
  fs.renameSync(tmp, dest);
  console.log(`  saved ${path.relative(ROOT, dest)} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
}

async function resolvePaper(version) {
  const url = `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`;
  const builds = await getJson(url);
  if (!Array.isArray(builds)) throw new Error("Unexpected Paper downloads response");
  const build = builds.find(b => b.channel === "STABLE") || builds[0];
  if (!build) throw new Error(`No Paper build found for Minecraft ${version}`);
  const dl = build.downloads && build.downloads["server:default"];
  if (!dl || !dl.url) throw new Error("Paper build has no server download URL");
  return { url: dl.url, version, build: build.id ?? build.number ?? "unknown", channel: build.channel || "unknown" };
}

async function resolveVelocity() {
  const project = await getJson("https://fill.papermc.io/v3/projects/velocity");
  const groups = project && project.versions ? Object.values(project.versions) : [];
  const versions = groups.flat().filter(Boolean);
  if (!versions.length) throw new Error("Could not determine current Velocity versions");
  for (const version of versions) {
    try {
      const builds = await getJson(`https://fill.papermc.io/v3/projects/velocity/versions/${encodeURIComponent(version)}/builds`);
      if (!Array.isArray(builds)) continue;
      const build = builds.find(b => b.channel === "STABLE");
      if (!build) continue;
      const dl = build.downloads && build.downloads["server:default"];
      if (dl && dl.url) return { url: dl.url, version, build: build.id ?? build.number ?? "unknown", channel: build.channel };
    } catch (_) {}
  }
  throw new Error("No stable Velocity build found");
}

async function resolveGitHubRelease(repo, preferredAssetPrefix) {
  const rel = await getJson(`https://api.github.com/repos/${repo}/releases/latest`);
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const prefix = preferredAssetPrefix.toLowerCase();
  const asset = assets.find(a => a.name && a.name.toLowerCase() === `${prefix}.jar`) ||
    assets.find(a => a.name && a.name.toLowerCase().startsWith(prefix) && a.name.toLowerCase().endsWith(".jar") && !a.name.toLowerCase().includes("sources")) ||
    assets.find(a => a.name && a.name.toLowerCase().endsWith(".jar") && !a.name.toLowerCase().includes("sources"));
  if (!asset || !asset.browser_download_url) throw new Error(`Latest ${repo} release does not contain a usable JAR`);
  return { url: asset.browser_download_url, version: rel.tag_name || rel.name || "latest", asset: asset.name, published: rel.published_at || null };
}

async function ensureArtifact(file, resolver, versions, key) {
  if (fs.existsSync(file)) {
    console.log(`${path.basename(file)} already present`);
    return;
  }
  const info = await resolver();
  await download(info.url, file);
  versions[key] = info;
}

async function main() {
  ensureDirs();
  const cfg = readConfig();
  patchClient(cfg);
  ensureForwardingSecret();
  const versions = {};

  await ensureArtifact(path.join(BACKEND, "paper.jar"), () => resolvePaper(cfg.minecraftVersion), versions, "paper");
  await ensureArtifact(path.join(PROXY, "velocity.jar"), resolveVelocity, versions, "velocity");
  await ensureArtifact(path.join(PROXY, "plugins", "EaglerXServer.jar"), () => resolveGitHubRelease("lax1dude/eaglerxserver", "EaglerXServer"), versions, "eaglerXServer");
  await ensureArtifact(path.join(PROXY, "plugins", "ViaVersion.jar"), () => resolveGitHubRelease("ViaVersion/ViaVersion", "ViaVersion"), versions, "viaVersion");
  await ensureArtifact(path.join(PROXY, "plugins", "ViaBackwards.jar"), () => resolveGitHubRelease("ViaVersion/ViaBackwards", "ViaBackwards"), versions, "viaBackwards");

  patchVelocityToml(cfg);
  patchPaperVelocity();
  patchViaVersionConfig(cfg);
  patchEaglerConfigs(cfg);

  const versionsPath = path.join(ROOT, "runtime", "versions.json");
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(versionsPath, "utf8")); } catch (_) {}
  fs.writeFileSync(versionsPath, JSON.stringify({ ...existing, ...versions, installedAt: new Date().toISOString() }, null, 2) + "\n");

  console.log("\nsetup complete");
  console.log("stack: EaglerXServer + ViaVersion + ViaBackwards + Velocity + Paper 26.2");
  console.log(`ViaVersion backend protocol pinned to ${Number(cfg.backendProtocol || 776)}`);
  console.log("next: npm start");
}

main().catch(err => {
  console.error("\nsetup failed:");
  console.error(err && err.stack ? err.stack : err);
  console.error("\nRun `npm run setup` to retry after fixing your network connection.");
  process.exitCode = 1;
});
