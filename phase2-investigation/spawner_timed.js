const { spawn } = require('child_process');
const fs = require('fs');

const TIMING_LOG = '/tmp/timing.log';

function log(msg) {
  fs.appendFileSync(TIMING_LOG, `${Date.now()} [node] ${msg}\n`);
}

function spawnChild(command, args, label) {
  return new Promise((resolve, reject) => {
    log(`Spawning ${label} (${command} ${args.join(' ')})`);
    const child = spawn(command, args, {
      stdio: "inherit"
    });

    log(`${label} spawned with pid=${child.pid}`);

    child.on('exit', (code) => {
      log(`${label} 'exit' event fired with code=${code} (pid=${child.pid})`);
      if (code == 0) {
        resolve(code);
      }
      reject(code);
    });

    child.on('close', (code) => {
      log(`${label} 'close' event fired with code=${code} (pid=${child.pid})`);
    });

    child.on('error', (err) => {
      log(`${label} 'error' event: ${err}`);
      reject(err);
    });
  });
}

async function main() {
  log(`main() start (node pid=${process.pid})`);
  try {
    const child1Promise = spawnChild('bash', ['sp1_timed.sh', `${process.argv[2]}`], 'sp1');
    const child2Promise = spawnChild('bash', ['sp2_timed.sh'], 'sp2');

    log('Awaiting Promise.race...');
    const firstChild = await Promise.race([child1Promise, child2Promise]);
    log(`Promise.race resolved with: ${firstChild}`);

    console.log('First child to exit:', firstChild);

    log('Awaiting second child...');
    const remainingChild = (firstChild === await child1Promise)
        ? await child2Promise
        : await child1Promise;

    log(`Second child resolved/rejected with: ${remainingChild}`);
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
