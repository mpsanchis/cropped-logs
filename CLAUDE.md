# Investigation: GitLab Cropped Logs Issue

This document tracks our investigation into why GitLab crops output when running Node.js child processes with piped stdout.

This repository has a simplified scenario, simulating how gitlab executes processes in a runner (via a shell script), and how then user code (such as Nx, running in NodeJs) gets executed as a child process.

## Current Status

**Last Updated**: 2026-03-30
**Current Phase**: Phase 3 Partial ✅ → Test F mechanism confirmed by strace on Linux
**Next Step**: Phase 3 (Node version comparison) and Phase 4 (fixes)

### What We've Learned So Far

✅ **Phase 1 Complete**: Confirmed that data size (195KB) significantly exceeds pipe buffer capacity (64KB)
- Pipe buffer on Linux: 65,536 bytes
- sp1.sh output: 195,893 bytes (~3x pipe buffer)

✅ **Phase 2 Complete**: Root cause identified — **Node.js libuv sets the stdout pipe to O_NONBLOCK**, breaking `cat` in child processes.

✅ **Phase 3 (partial)**: Strace on Linux confirmed the exact mechanism behind Test F (pre-spawn console.log).
- The earlier hypothesis ("pipe starts empty, tee drains fast enough") was **wrong**.
- Actual mechanism: **libuv's child spawn code clears O_NONBLOCK before exec**, and the second console.log never re-triggers FIONBIO.

See full explanation in the sections below.

## Problem Summary

When running Node.js spawner with child processes that produce large output, and piping that output through `tee`, the logs get cropped mid-line (around line 383 out of 1000). This happens consistently with Node.js v11.9.0+ but not with v10.x or with Java spawner.

### Reproduction Case
```bash
./parent_script.sh js 1000
# Crops at line 383: "Printing 383 [INFO] Downloading from xyz-platform: https://xyz-platform.maven.pkg.sehlat.io/org/springframewor"
```

## Code Structure Analysis

**spawner.js**:
- Spawns two child processes with `stdio: "inherit"`
- sp1.sh: writes N lines to file, then cats entire file (large data dump)
- sp2.sh: exits immediately with code 0
- Uses `Promise.race()` to wait for first child to exit
- Then waits for remaining child

**parent_script.sh**:
- Pipes the step_script output through `tee` to log file
- Mimics GitLab's CI runner behavior

**sp1.sh**:
- Writes N lines to a file
- Uses `cat` to dump entire file to stdout at once
- Exits with code 62

## Root Cause

### Core Mechanism: Node.js libuv sets O_NONBLOCK on the stdout pipe

**Node.js's libuv**, when writing to `process.stdout` asynchronously (i.e., when stdout is a pipe), sets the stdout file descriptor to **O_NONBLOCK** via `ioctl(fd, FIONBIO, 1)` (Linux) or `fcntl(fd, F_SETFL, flags | O_NONBLOCK)` (macOS). It does this **once per stream handle**, the first time it needs to write asynchronously.

The critical problem: **O_NONBLOCK is a property of the open file description** (kernel-level object), not of the file descriptor. All processes that share the same underlying pipe — including Node's child processes spawned with `stdio: "inherit"` — share this flag.

With a non-blocking pipe:
- `write(fd, buf, n)` on a fully full pipe returns `-1 EAGAIN` instead of blocking
- `cat` (both GNU and BSD) does NOT handle EAGAIN — it treats it as a write error and exits with code 1
- Data that `cat` was in the middle of writing is lost

**Evidence from strace (Linux, failing scenario)**:
```
[pid 17419] ioctl(1, FIONBIO, [1])                    ← Node sets O_NONBLOCK on fd 1
...
[pid 17432] write(1, "...", 64821) = -1 EAGAIN         ← cat gets EAGAIN, pipe full
[pid 17432] write(2, "Schreibfehler", 13) = 13          ← cat writes "write error" to stderr
[pid 17419] fcntl(1, F_GETFL) = 0x801 (O_WRONLY|O_NONBLOCK)  ← confirmed at Node exit
[pid 17419] fcntl(1, F_SETFL, O_WRONLY) = 0            ← Node clears O_NONBLOCK at exit (too late)
```

### Key kernel behaviour: when does cat get EAGAIN?

The Linux kernel's `pipe_write` returns `-1 EAGAIN` **only when the pipe has zero bytes free** AND `O_NONBLOCK` is set. If any space is available, it writes what it can and returns a partial count. `cat` handles partial writes by retrying — it only dies on `-1 EAGAIN`.

This means O_NONBLOCK alone is not enough to kill cat. Cat dies only when it attempts a write at a moment when the pipe is **completely full (0 bytes free)**.

### libuv's child spawn code clears O_NONBLOCK before exec

When libuv forks a child process (e.g. to spawn sp1.sh), it runs setup code in the child **between `fork()` and `exec()`**. Part of this setup reads the current flags on each inherited fd and resets them to a clean state. Specifically, if it finds O_NONBLOCK set on an inherited fd, it clears it with `fcntl(1, F_SETFL, O_WRONLY)`.

This clearing happens **on the shared open file description** — so it affects every process that shares the same pipe, including the Node parent process. After the first child is spawned, O_NONBLOCK is gone from the kernel's perspective.

**Evidence from strace (Linux, Test F)**:
```
# Node fires FIONBIO for the pre-spawn console.log:
4915  fcntl(1, F_GETFL)          = 0x1 (flags O_WRONLY)      ← blocking before write
4915  ioctl(1, FIONBIO, [1])     = 0                         ← Node sets O_NONBLOCK
4915  write(1, "Starting spawner...\n", 20) = 20

# Child (pid 4923) after fork, before exec — libuv child setup:
4923  fcntl(1, F_GETFL)          = 0x801 (flags O_WRONLY|O_NONBLOCK)  ← sees O_NONBLOCK
4923  fcntl(1, F_SETFL, O_WRONLY) = 0                        ← clears it (shared OFD!)

# Second child (pid 4924) after fork, before exec:
4924  fcntl(1, F_GETFL)          = 0x1 (flags O_WRONLY)      ← already blocking again
```

Crucially, libuv only calls `FIONBIO` **once per stream handle** (when it first needs to write asynchronously). After the child setup clears O_NONBLOCK, libuv's internal state still says "non-blocking" — so when the second `console.log` fires, it does NOT re-issue `FIONBIO`. The pipe stays blocking at the kernel level.

## Scenario Walkthroughs

This section gives step-by-step traces of every scenario analysed, explaining exactly what happens at the kernel level.

---

### Scenario 1 — Baseline / Failing Case (`spawner_timed.js`)

**Configuration**: Node spawner with no pre-spawn console.log; sp2 exits immediately.

```
Step 1: parent_script.sh forks and runs:
        node spawner_timed.js 1000 | tee output.log
        Two processes share the same pipe (write-end: node; read-end: tee)

Step 2: Node starts. No console.log yet.
        fd 1 = O_WRONLY (blocking)

Step 3: Node spawns sp1 (bash) and sp2 (bash) with stdio:"inherit".
        Both children inherit fd 1 pointing to the same pipe write-end.
        libuv child setup: reads fd 1 flags, finds O_WRONLY (already blocking), no change.
        fd 1 = O_WRONLY (blocking) for all processes

Step 4: sp1 begins its echo loop, writing ~194 bytes per line to fd 1.
        Tee drains from the read-end.
        fd 1 = O_WRONLY (blocking) — all writes block naturally when pipe is full

Step 5: sp2 exits with code 0 almost immediately.
        Node's event loop fires the sp2 'exit' handler.
        Promise.race() resolves with 0.
        Node executes: console.log('First child to exit: 0')
        libuv prepares to write asynchronously to process.stdout:
          fcntl(1, F_GETFL)      = 0x1 (O_WRONLY)   ← blocking
          ioctl(1, FIONBIO, [1]) = 0                 ← sets O_NONBLOCK on the shared OFD
          write(1, "First child to exit: 0\n", 23) = 23
        fd 1 = O_WRONLY|O_NONBLOCK for ALL processes (node + sp1 + any sub-processes)

Step 6: sp1's echo loop finishes. sp1 runs: cat print_log.txt
        cat (new subprocess of bash sp1) inherits fd 1 with O_NONBLOCK.
        cat tries its first write: write(1, ..., 131072)
        The pipe is partially full from the echo loop.
        The 131072-byte write fills the remaining space, then pipe hits 0 bytes free.
        Kernel returns: write(1, ..., 131072) = -1 EAGAIN
        cat interprets EAGAIN as a fatal write error, prints "write error" to stderr.
        cat exits with code 1.
        ~half of print_log.txt was never written.

Step 7: sp1.sh continues (no set -e). Runs: echo "--- I am done ---"
        This small write succeeds (pipe has space now that cat stopped).
        "--- I am done ---" appears in the output, concatenated to the last partial line.
        sp1 exits with code 62.

Step 8: Node detects sp1 exit. Runs: process.exit(12)
        At exit, libuv clears O_NONBLOCK: fcntl(1, F_SETFL, O_WRONLY) — too late.

Result: ~379/1003 lines in output.log. cat exit=1. Data lost.
```

---

### Scenario 2 — sp2 Sleeps (`spawner_sleep_sp2.js`, Test B)

**Configuration**: sp2 sleeps 2 seconds before exiting; everything else the same.

```
Step 1: Node spawns sp1 and sp2. No console.log yet.
        fd 1 = O_WRONLY (blocking)

Step 2: sp1 runs its echo loop, writing 1000 lines.
        tee drains from the read-end.
        All writes block when needed; all 1000 echo lines go through.
        fd 1 = O_WRONLY (blocking) throughout

Step 3: sp1 runs: cat print_log.txt
        fd 1 is blocking. cat writes 195,893 bytes in one or more blocking writes.
        Tee drains continuously. All data goes through.
        cat exits with code 0.
        sp1 exits with code 62.

Step 4: sp1 exit (code 62) → child1Promise REJECTS.
        Promise.race() rejects (sp1 exited first).
        await Promise.race([...]) throws.
        The catch block runs: process.exit(12)
        console.log('First child to exit: ...') is NEVER called.
        O_NONBLOCK is NEVER set.

Step 5: Node exits (process.exit(12)).
        sp2 is still sleeping (pipe write-end still open from sp2's perspective).
        Tee continues draining until sp2 exits 2s later and closes the write-end.
        Tee gets EOF, finishes.

Result: 1002/1003 lines preserved. cat exit=0. O_NONBLOCK never set.
(1002 not 1003 because the "--- I am done ---" line from sp1 is present;
the missing line is an artefact of the macOS test run line count.)
```

---

### Scenario 3 — Force Blocking Before cat (`sp1_blocking.sh`, Test E)

**Configuration**: sp1 explicitly clears O_NONBLOCK on fd 1 just before running cat.

```
Step 1–5: Same as Scenario 1 up to Step 5.
          Node sets O_NONBLOCK after sp2 exits.
          fd 1 = O_WRONLY|O_NONBLOCK

Step 6: sp1's echo loop finishes. sp1_blocking.sh runs:
          python3 -c "import fcntl, os; flags = fcntl.fcntl(1, fcntl.F_GETFL);
                      fcntl.fcntl(1, fcntl.F_SETFL, flags & ~os.O_NONBLOCK)"
        This clears O_NONBLOCK on fd 1 via the shared open file description.
        fd 1 = O_WRONLY (blocking) for all processes again.

Step 7: sp1_blocking.sh runs: cat print_log.txt
        fd 1 is blocking. cat writes 195,893 bytes with blocking writes.
        All data goes through. cat exits with code 0.
        sp1 exits with code 62.

Step 8: Node detects sp1 exit → process.exit(12).

Result: 1003/1003 lines. cat exit=0.
Conclusion: O_NONBLOCK is definitively the cause. Clearing it before cat fixes the issue.
```

---

### Scenario 4 — Pre-spawn console.log (`spawner_early_log.js`, Test F)

**Configuration**: One `console.log("Starting spawner...")` fires *before* children are spawned.

> **Note**: The earlier hypothesis for why this works ("pipe starts empty, tee drains fast enough, cat never hits 0 bytes free") was **incorrect**. Strace on Linux revealed the true mechanism.

```
Step 1: Node starts. No children yet.
        fd 1 = O_WRONLY (blocking)

Step 2: Node executes: console.log("Starting spawner...")
        libuv needs to write to process.stdout asynchronously for the first time.
        It checks fd 1 and sets O_NONBLOCK:
          fcntl(1, F_GETFL)      = 0x1 (O_WRONLY)
          ioctl(1, FIONBIO, [1]) = 0                ← O_NONBLOCK set
          write(1, "Starting spawner...\n", 20) = 20
        libuv marks its internal stdout handle state as "non-blocking".
        fd 1 = O_WRONLY|O_NONBLOCK

Step 3: Node spawns sp1 (fork → exec bash sp1_timed.sh).
        In the child process (pid 4923), BETWEEN fork() and exec(), libuv's
        child setup code runs. It reads each inherited fd's flags:
          fcntl(1, F_GETFL)          = 0x801 (O_WRONLY|O_NONBLOCK)  ← sees it
          fcntl(1, F_SETFL, O_WRONLY) = 0                           ← CLEARS IT
        Because this is a shared open file description, O_NONBLOCK is now
        cleared for ALL processes sharing this pipe (including Node parent).
        fd 1 = O_WRONLY (blocking) — kernel level, for everyone

Step 4: Node spawns sp2 (fork → exec bash sp2_timed.sh).
        Child setup reads fd 1: flags = O_WRONLY (already blocking). No change.

Step 5: sp1 begins its echo loop. tee drains. All blocking writes succeed.
        fd 1 = O_WRONLY (blocking) throughout.

Step 6: sp2 exits with code 0.
        Promise.race() resolves with 0.
        Node executes: console.log('First child to exit: 0')
        libuv's internal state says stdout handle is ALREADY non-blocking —
        it does NOT re-issue ioctl(FIONBIO).
        fd 1 = O_WRONLY (blocking) — kernel level unchanged
          write(1, "First child to exit: 0\n", 23) = 23   ← plain blocking write

Step 7: sp1's echo loop finishes. sp1 runs: cat print_log.txt
        cat (pid 4932) inherits fd 1 = O_WRONLY (blocking).
        cat writes 195,893 bytes in two blocking writes:
          write(1, ..., 131072) → blocks while tee drains → resumes = 131072  ← full, no EAGAIN
          write(1, ...,  64821) → blocks while tee drains → resumes = 64821   ← full, no EAGAIN
        cat exits with code 0.
        sp1 exits with code 62.

Step 8: Node detects sp1 exit → process.exit(0) or 12 (catch branch).

Result: 1004/1004 lines. cat exit=0. O_NONBLOCK cleared by libuv child setup,
        never re-set because libuv fires FIONBIO only once per handle.
```

**Why this is an accidental fix**: Test F works not because of any intentional design, but because two libuv implementation details cancel each other out:
1. libuv sets FIONBIO the first time it writes to a pipe fd
2. libuv's child spawn code clears O_NONBLOCK on inherited fds before exec
3. libuv never re-issues FIONBIO once it has set the handle to non-blocking

If the second console.log had been the *first* write to process.stdout (instead of the pre-spawn one), FIONBIO would have fired after the children were already running, with no further spawn to clear it — producing the same failure as Scenario 1.

---

### Key Experimental Results Summary

| Test | Configuration | Lines Saved | cat exit | Mechanism |
|------|--------------|-------------|----------|-----------|
| Baseline | `spawner_timed.js` (sp2 exits first) | 379/1003 | 1 (EAGAIN) | O_NONBLOCK set after spawn, never cleared before cat |
| Test A | Direct file redirect (no pipe) | 1002/1003 | 0 | O_NONBLOCK has no effect on regular files |
| Test B | sp2 sleeps 2s (sp1 exits first) | 1002/1003 | 0 | Promise.race rejects → console.log never called → FIONBIO never set |
| Test C | `tee` stdout → `/dev/null` | 379/1003 | 1 | Same failure; confirms issue is in the tee→spawner pipe, not tee→file |
| Test E | Force fd1 blocking before cat | 1003/1003 | 0 | Explicitly clearing O_NONBLOCK restores safety |
| Test F | `console.log` before spawn | 1004/1004 | 0 | FIONBIO set once, then libuv child setup clears it, FIONBIO not re-issued |

---

### Why Some Workarounds Work

| Workaround | Why It Works |
|------------|-------------|
| No pipe (direct terminal / TTY) | libuv does not set O_NONBLOCK on TTY fds |
| `unbuffer` (PTY) | Creates a new open file description — O_NONBLOCK on the parent's OFD doesn't propagate |
| Java spawner | Java does not set O_NONBLOCK on inherited stdio fds |
| Sequential awaits (sp1 first) | If sp1 exits first, Promise.race rejects → no console.log → FIONBIO never set |
| `echo` loop instead of `cat` | Each echo write is ~194 bytes; partial writes are retried; EAGAIN is unlikely |
| Node v10.x | libuv may not have set O_NONBLOCK on inherited pipe fds in that era |

### Why `--- I am done ---` Appears After cat Dies

After cat exits with EAGAIN, sp1.sh's bash script continues (no `set -e`). It runs `echo "--- I am done ---"` to fd 1. At this point, Node still holds the pipe write-end open (it hasn't called `process.exit` yet), and tee is still reading. The small echo write succeeds because the pipe has space. The text appears concatenated mid-line ~377 because cat's last write was partial (no trailing newline before death).

## Investigation Plan

### Phase 1: Verify Pipe Buffer Behavior ✅ COMPLETE

1. ✅ **Run ctest.c to measure pipe capacity** → 65,536 bytes (64KB)
2. ✅ **Add byte counting to sp1.sh** → 195,893 bytes total (~3x pipe buffer)

### Phase 2: Timing Analysis ✅ COMPLETE

3. ✅ **Add timestamps to trace execution** → cat exit=1, Node sets FIONBIO after sp2 exits
4. ✅ **Add sleep to sp2.sh** → confirms race condition; sleep fixes issue
5. ✅ **Strace analysis (macOS)** → confirmed `ioctl(1, FIONBIO, [1])` by Node, then EAGAIN by cat
6. ✅ **Force fd1 back to blocking** → confirmed O_NONBLOCK as root cause

### Phase 3: Node.js Behavior Deep Dive 🔄 PARTIAL

7. ✅ **Strace Test F on Linux** → confirmed exact mechanism; corrected earlier hypothesis
8. **Compare Node versions** — test v10.24.1 (works) vs v11.9.0 (fails) vs v18 (current, fails)
   - When did libuv start setting O_NONBLOCK on inherited pipe fds?
   - Is this related to PR #25769?
9. **Check if using `[process.stdin, process.stdout, process.stderr]` (explicit fds) instead of `"inherit"` makes a difference**
   - These should be equivalent, but may differ if libuv treats explicit fd passing differently

### Phase 4: Explore Solutions

10. **Test potential fixes in spawner.js**:
    - Option A: After spawning children, set fd 1 back to blocking mode (reliable, but requires native code or python one-liner in spawner)
    - Option B: Use `stdio: [process.stdin, "pipe", process.stderr]` + manually pipe child stdout. Creates a new file description for the child; O_NONBLOCK on the parent's OFD doesn't propagate.
    - Option C: Buffer all `console.log` output and flush AFTER all children exit. Prevents FIONBIO from being set while children are running.
    - Option D: Wrap the spawner in a PTY (`unbuffer`) — system-level fix, no spawner changes needed.
11. **Document workarounds** with pros/cons for the GitLab use case.

## How to Resume Investigation

### Files Created for Phase 2 Testing

All scripts created during Phase 2 live in the **`phase2-investigation/`** directory.

| File | Purpose |
|------|---------|
| `phase2-investigation/spawner_timed.js` | Instrumented spawner with timing logs to `/tmp/timing.log` |
| `phase2-investigation/sp1_timed.sh` | sp1.sh with timestamps and cat exit code logging |
| `phase2-investigation/sp2_timed.sh` | sp2.sh with timestamps |
| `phase2-investigation/spawner_sleep_sp2.js` | Uses `sp2_sleep.sh` (sleep 2 before exit) — Test B |
| `phase2-investigation/sp2_sleep.sh` | sp2 that sleeps 2 seconds before exiting |
| `phase2-investigation/sp1_blocking.sh` | sp1.sh that explicitly clears O_NONBLOCK before running cat — Test E |
| `phase2-investigation/spawner_blocking.js` | Spawner that uses `sp1_blocking.sh` — Test E |
| `phase2-investigation/spawner_early_log.js` | Spawner with console.log before spawn — Test F |
| `phase2-investigation/sp1_monitor.sh` | sp1.sh that monitors fd1 O_NONBLOCK flag at multiple points (not yet run) |

### Quick repro commands

```bash
# Failing scenario (379 lines, cat exit=1):
cd phase2-investigation
rm -f /tmp/timing.log /tmp/output_testF.log
bash -c "(node spawner_timed.js 1000 2>&1 | tee -a /tmp/output.log > /dev/null)"
echo "Lines: $(wc -l < /tmp/output.log)" && cat /tmp/timing.log

# Working scenario with sleep (1002 lines, cat exit=0):
rm -f /tmp/timing.log /tmp/output.log
bash -c "(node spawner_sleep_sp2.js 1000 2>&1 | tee -a /tmp/output.log > /dev/null)"
echo "Lines: $(wc -l < /tmp/output.log)" && cat /tmp/timing.log

# Test F with strace (shows FIONBIO + child setup clearing it):
rm -f /tmp/timing.log /tmp/strace_testF.log /tmp/output_testF.log
strace -f -e trace=write,ioctl,fcntl -s 64 -o /tmp/strace_testF.log \
  bash -c "(node spawner_early_log.js 1000 2>&1 | tee -a /tmp/output_testF.log > /dev/null)"
echo "Lines: $(wc -l < /tmp/output_testF.log)" && cat /tmp/timing.log
# Key events to grep for:
grep "FIONBIO\|F_SETFL\|EAGAIN" /tmp/strace_testF.log
```

### Phase 3 Quick Start

**Test 8**: Compare Node versions
```bash
# On this machine: node v18.18.2 (fails)
nvm use 10.24.1
bash -c "(node phase2-investigation/spawner_timed.js 1000 2>&1 | tee -a /tmp/output.log > /dev/null)"
# Does v10 fail? Does strace show FIONBIO?

nvm use 11.9.0
bash -c "(node phase2-investigation/spawner_timed.js 1000 2>&1 | tee -a /tmp/output.log > /dev/null)"
# Does v11 fail? This is where the regression is expected to have appeared.
```

**Test 9**: Try explicit fd passing instead of "inherit"
```bash
# Modify spawner.js: stdio: [process.stdin, process.stdout, process.stderr]
# instead of: stdio: "inherit"
# Does libuv's child setup still clear O_NONBLOCK? Does the failing case still fail?
```

## Results & Findings

### Test Results

#### Phase 1: Verify Pipe Buffer Behavior ✅

**Test 1: Pipe Buffer Capacity (ctest.c)**
- Pipe buffer capacity: **65,536 bytes (64 KB)**

**Test 2: sp1.sh Data Size Analysis**
- Total bytes written to file (then catted): **195,893 bytes**
- Bytes through line 377: ~73,832 bytes (where cropping occurs in our env)

#### Phase 2: Timing Analysis ✅

**Test 3: Timing of processes (spawner_timed.js)**

Failing scenario timing (Node v18.18.2):
```
sp2 spawned and exits immediately
Node sp2 'exit' event fires → Promise.race resolved
Node: "First child to exit: 0"  ← FIONBIO fires here
sp1 cat finished with exit code=1  ← EAGAIN
sp1 About to exit 62
Node sp1 'exit' event fired → process.exit(12)
```
Total time: ~54ms. cat exits with code 1.

**Test 4: Sleep in sp2 (spawner_sleep_sp2.js)**
```
sp1 cat finished with exit code=0  ← SUCCESS (no FIONBIO ever)
sp1 About to exit 62
Node sp1 'exit' event → process.exit(12)
sp2 exits (after 2 seconds) — AFTER node already exited
```
All 1002 lines preserved.

**Test 5: Strace analysis (strace5.log, macOS)**
- `ioctl(1, FIONBIO, [1])` — Node sets fd 1 to O_NONBLOCK during sp2's exit event handling
- `write(1, ..., 64821) = -1 EAGAIN` — cat gets EAGAIN when pipe is full
- `fcntl(1, F_GETFL) = 0x801 (O_WRONLY|O_NONBLOCK)` — confirmed at Node exit
- `fcntl(1, F_SETFL, O_WRONLY) = 0` — Node clears it at exit (too late)

**Test E: Force fd1 blocking (spawner_blocking.js + sp1_blocking.sh)**
- Explicitly clears O_NONBLOCK on fd 1 before `cat` runs
- All 1003 lines preserved, cat exit=0
- **CONFIRMS**: O_NONBLOCK is the root cause

#### Phase 3 (partial): Test F Strace on Linux ✅

**Strace of Test F (`spawner_early_log.js`, Linux, Node v18.18.2)**

Three questions answered:

**Q1 — Does pre-spawn console.log set O_NONBLOCK?**
YES. `ioctl(1, FIONBIO, [1])` fires (strace line 36), triggered by the pre-spawn `console.log("Starting spawner...")`.

**Q2 — Does cat ever get EAGAIN?**
NO. Zero occurrences of EAGAIN in the entire strace.

**Q3 — Does cat get partial writes?**
NO. Cat (pid 4932) writes the full 195,893 bytes in two complete, untruncated, blocking writes:
```
write(1, ..., 131072) → resumed = 131072   ← blocked, tee drained, write completed in full
write(1, ...,  64821) → resumed =  64821   ← blocked, tee drained, write completed in full
+++ exited with 0 +++
```

**Actual mechanism** (corrects earlier hypothesis):
1. Pre-spawn console.log → libuv fires `ioctl(1, FIONBIO, [1])` → O_NONBLOCK set
2. Node forks to spawn sp1 → libuv's child setup (between fork and exec) reads fd 1 flags, finds O_NONBLOCK, clears it with `fcntl(1, F_SETFL, O_WRONLY)` on the shared OFD
3. O_NONBLOCK is now cleared for ALL processes sharing the pipe (including Node parent)
4. libuv marks its stdout handle as "non-blocking" internally and never calls FIONBIO again
5. Second console.log (after sp2 exits) writes to fd 1 without re-issuing FIONBIO — pipe stays blocking at kernel level
6. cat runs on a blocking pipe → all writes succeed

**Corrected hypothesis**: The pipe being "empty" at spawn time had nothing to do with it. The fix works because libuv's child spawn code inadvertently restores blocking mode on the shared pipe, and libuv's one-shot FIONBIO logic prevents it from being re-set.

### Confirmed Root Cause

**Node.js libuv sets the stdout pipe to O_NONBLOCK the first time it writes to process.stdout asynchronously. This propagates to all child processes via the shared open file description. `cat` in sp1.sh gets `-1 EAGAIN` when it attempts a write at a moment when the pipe has zero bytes free, and exits with error, losing the remaining data.**

The failure requires two conditions to coincide:
1. **O_NONBLOCK is set** — triggered by Node writing to stdout from an async callback while children are running, AND no subsequent child spawn resets it before cat runs
2. **cat attempts a write when the pipe is completely full (0 bytes free)** — which happens because the echo loop has already partially filled the pipe before cat starts

### Rejected Hypotheses

- **EPIPE/pipe closed**: Ruled out — `--- I am done ---` still appears in output.log after cat dies, proving tee's read-end was open
- **tee's stdout pipe filling up**: Ruled out by Test C (tee stdout → /dev/null still shows same issue)
- **Data exceeding pipe buffer alone**: Necessary condition but not sufficient — actual failure is EAGAIN on non-blocking pipe
- **Test F works because pipe starts empty and tee drains fast enough**: Ruled out by strace — cat writes are fully blocking (no EAGAIN, no partial writes); the pipe was restored to blocking mode by libuv child setup before cat ever ran

### Recommended Solutions

*Leading candidates for Phase 4:*

1. **Buffer console.log, flush after all children exit** — prevents FIONBIO from ever being triggered while children are running. Most targeted fix.
2. **Use `stdio: "pipe"` + manual forwarding** — creates a new open file description for the child; O_NONBLOCK on the parent's OFD cannot propagate. More complex but robust.
3. **System-level `unbuffer`** — PTY wrapper; no spawner changes. Practical for GitLab runner configuration.
4. **Explicitly reset fd 1 to blocking after spawning** — fragile (requires knowing when libuv has finished setting O_NONBLOCK); not recommended.

## References

- [Node.js, stdout, and disappearing bytes](https://sxlijin.github.io/2024-10-09-node-stdout-disappearing-bytes) - Excellent article explaining pipe buffer limits and async stdout behavior
- [Node.js Child Process Documentation](https://nodejs.org/api/child_process.html)
- [Node.js PR #25769](https://github.com/nodejs/node/pull/25769) - Changed process.exit() to process.exitCode in module errors
- [Node.js v11.9.0 Changelog](https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V11.md#2019-01-30-version-1190-current-raspbe)
 [Node.js v11.9.0 Changelog](https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V11.md#2019-01-30-version-1190-current-targos)
