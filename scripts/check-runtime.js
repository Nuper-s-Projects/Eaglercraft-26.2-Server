const { checkJava25 } = require("./common");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.error(`Node.js 20+ is required. Detected ${process.version}.`);
  process.exit(1);
}

try {
  const java = checkJava25();
  console.log(`Runtime OK: Node.js ${process.version}, Java 25+ (${java})`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
