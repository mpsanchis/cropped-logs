const { spawn } = require('child_process');
const fs = require('fs');
const TIMING_LOG = '/tmp/timing.log';

function log(msg) { fs.appendFileSync(TIMING_LOG, `${Date.now()} [node] ${msg}\n`); }

function spawnChild(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on('exit', (code) => { code == 0 ? resolve(code) : reject(code); });
    child.on('error', reject);
  });
}

async function main() {
  log('main() start');
  // Force write to stdout BEFORE spawning (triggers libuv FIONBIO on fd 1)
  console.log("Starting spawner...");
  
  const child1Promise = spawnChild('bash', ['sp1_timed.sh', `${process.argv[2]}`], 'sp1');
  const child2Promise = spawnChild('bash', ['sp2_timed.sh'], 'sp2');

  try {
    const firstChild = await Promise.race([child1Promise, child2Promise]);
    console.log('First child to exit:', firstChild);
    await child1Promise;
    await child2Promise;
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(12);
  }
}

(async () => await main())();
