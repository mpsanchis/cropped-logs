const { spawn } = require('child_process');
const fs = require('fs');

const TIMING_LOG = '/tmp/timing.log';

function log(msg) {
  fs.appendFileSync(TIMING_LOG, `${Date.now()} [node] ${msg}\n`);
}

function spawnChild(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit"
    });
    child.on('exit', (code) => {
      log(`${label} 'exit' event code=${code}`);
      code == 0 ? resolve(code) : reject(code);
    });
    child.on('error', reject);
  });
}

async function main() {
  log(`main() start`);
  const child1Promise = spawnChild('bash', ['sp1_blocking.sh', `${process.argv[2]}`], 'sp1');
  const child2Promise = spawnChild('bash', ['sp2_timed.sh'], 'sp2');

  try {
    log('Awaiting Promise.race...');
    const firstChild = await Promise.race([child1Promise, child2Promise]);
    log(`Promise.race resolved: ${firstChild}`);
    console.log('First child to exit:', firstChild);
    const remainingChild = (firstChild === await child1Promise)
        ? await child2Promise
        : await child1Promise;
    console.log('Second child to exit:', remainingChild);
    log('Calling process.exit(0)');
    process.exit(0);
  } catch (error) {
    log(`Caught error: ${error} — calling process.exit(12)`);
    console.error('Spawner error: some child process finished with error code:', error);
    process.exit(12);
  }
}

(async () => await main())();
