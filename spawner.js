const {spawnChild} = require('./spawnutil');

async function main() {
  try {
    // Spawn two child processes
    const child1Promise = spawnChild('bash', ['sp1.sh', `${process.argv[2]}`]);
    const child2Promise = spawnChild('bash', ['sp2.sh']);

    // Wait for the first child process to exit
    const firstChild = await Promise.race([child1Promise, child2Promise]);

    console.log('First child to exit:', firstChild);

    // Wait for the remaining child process to exit
    const remainingChild = (firstChild === await child1Promise) 
        ? await child2Promise 
        : await child1Promise;

    console.log('Second child to exit:', remainingChild);
    process.exit(0);
} catch (error) {
    console.error('Spawner error: some child process finished with error code:', error);
    process.exit(12);
  }
}

(
    async () => await main()
)();
