const { spawn } = require('child_process');

// Function to spawn a child process
async function spawnChild(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit"
    });

    // Listen for exit event
    child.on('exit', (code) => {
      if (code == 0) {
        resolve(code); // Resolve with the exit code
      }
      reject(code);
    });

    // Listen for error event
    child.on('error', (err) => {
      reject(err); // Reject with the error
    });
  });
}

module.exports.spawnChild = spawnChild;