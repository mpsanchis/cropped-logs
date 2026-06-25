The "blame" is shared, but Node.js (libuv) is the primary actor mutating global state in a way that violates UNIX isolation expectations.

  Here is the breakdown of who plays what role:

  • Node.js (libuv) – The primary culprit:
  To support its single-threaded event loop, Node.js needs to write to  process.stdout  asynchronously if stdout is a pipe. To do this, it calls
  ioctl(1, FIONBIO, [1])  or  fcntl()  to set  O_NONBLOCK  on the stdout file descriptor.
  However, because the child processes share the same underlying Open File Description, Node.js is effectively changing the kernel-level write
  mode to non-blocking for already running or subsequently run child processes. Changing a shared open file status flag during execution violates
  the UNIX convention that a child process’s inherited stdio handles are blocking.
  • GitLab CI – The contributor:
  GitLab CI runs build commands inside a shell script and pipes stdout to  tee  to capture logs:  step_script 2>&1 | tee -a /log . Because it uses
  a pipe rather than a PTY, it forces Node.js to treat stdout as a pipe, triggering Node's non-blocking behavior. Many other CI systems (like
  GitHub Actions) run steps inside a PTY/TTY wrapper, preventing this problem entirely.
  • Nx – Innocent Bystander:
  Nx is just a JavaScript/Node.js CLI application. It relies on standard Node.js API calls to spawn child tasks. It has no control over libuv
  configuring the parent process's file descriptors to  O_NONBLOCK . Any Node.js task runner (Lerna, Turborepo, or custom scripts) would face this
  exact same issue.
  •  cat  / UNIX Tools – Innocent Bystander:
   cat  is a simple, synchronous POSIX tool. When it attempts to write to stdout and receives  -1 EAGAIN , it has no retry loop or event loop to
  wait for the pipe to drain. It treats  EAGAIN  as a fatal write error, prints  "write error"  to stderr, and aborts immediately, causing your
  logs to get cropped.
