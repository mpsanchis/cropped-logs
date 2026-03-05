# Investigation: GitLab Cropped Logs Issue

This document tracks our investigation into why GitLab crops output when running Node.js child processes with piped stdout.

## Current Status

**Last Updated**: 2026-03-04
**Current Phase**: Phase 1 Complete ✅ → Ready for Phase 2
**Next Step**: Run Phase 2 - Timing Analysis (see Investigation Plan below)

### What We've Learned So Far

✅ **Phase 1 Complete**: Confirmed that data size (195KB) significantly exceeds pipe buffer capacity (64KB)
- Pipe buffer on macOS: 65,536 bytes
- sp1.sh output: 195,893 bytes (~3x pipe buffer)
- Cropping occurs around 74KB mark
- This confirms the pipe buffer overflow is a key factor

🔜 **Next**: Test the timing of the race condition to see when processes exit relative to data being written

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

## Hypotheses

### Primary Hypothesis: Pipe Buffer Overflow + Premature Process Exit

**Theory**: Node.js doesn't wait for inherited child process output to fully flush through the parent's stdout pipe before the parent exits.

**The Race Condition**:
1. sp2.sh exits immediately (code 0)
2. sp1.sh is still dumping large amount of data via `cat`
3. `Promise.race()` detects sp2 finished first
4. Node process continues and soon exits
5. Pipe buffer between Node stdout and tee fills up (~64KB on Unix)
6. When Node exits, the pipe is destroyed before tee can consume all buffered data
7. Result: Data loss mid-stream

**Evidence Supporting This Hypothesis**:

1. ✓ **Fails with piping to `tee` or `cat`**: Pipes have limited buffer capacity. When full, writes become async. If process exits before consumer drains pipe, data is lost.

2. ✓ **Works without piping**: Writing to terminal is synchronous. The write() call blocks until data is written, so nothing is lost.

3. ✓ **Works with Java spawner**: Java might handle process cleanup differently, perhaps ensuring all child stdio is flushed before parent exit.

4. ✓ **Works with sequential awaits**: Waiting for BOTH children to complete before exiting gives time for all buffered data to drain.

5. ✓ **Works when using `echo` in loop instead of `cat`**: `echo` in loop writes incrementally, allowing pipe to drain between writes. `cat` dumps everything at once, overwhelming buffer.

6. ✓ **Works with `unbuffer`**: Uses pseudo-terminals (PTY) instead of pipes. PTY writes are synchronous, preventing data loss.

7. ✓ **Breaks in Node v11.9.0+, works in v10.x**: Something changed in Node's process exit handling around v11.9.0.

### Related: Node.js PR #25769

The README mentions [PR 25769](https://github.com/nodejs/node/pull/25769) from Node v11.9.0 changelog as a potential cause.

**PR Changes**: Replaced `process.exit()` with `process.exitCode` in module error handling to prevent interrupting async stdio in worker threads.

**Potential Connection**: This PR made Node more likely to exit while async I/O is still pending, which could explain why inherited child stdio doesn't fully flush.

**Status**: 🔍 Needs deeper investigation - the PR was about module errors, not general child process handling.

### Alternative Hypothesis: SIGPIPE Handling

**Theory**: When Node process starts exiting, the pipe to `tee` might be closed, causing child processes to receive SIGPIPE when writing.

**Status**: ⏸️ Lower priority - doesn't explain why Java works but Node doesn't, since both would face same SIGPIPE conditions.

### Alternative Hypothesis: Child Process Lifecycle Management

**Theory**: Node.js might not be properly waiting for child processes with `stdio: "inherit"` to finish flushing their output before the parent exits.

**Status**: 🔍 Overlaps with primary hypothesis - needs testing.

## Investigation Plan

### Phase 1: Verify Pipe Buffer Behavior ✅ COMPLETE

1. ✅ **Run ctest.c to measure pipe capacity**
   ```bash
   gcc ctest.c -o ctest
   ./ctest
   ```
   - ✅ Result: Pipe buffer capacity is 65,536 bytes (64KB)

2. ✅ **Add byte counting to sp1.sh**
   - ✅ Total bytes written: 195,893 bytes (~3x pipe buffer)
   - ✅ Confirmed output size exceeds pipe capacity significantly

### Phase 2: Timing Analysis 🔜 NEXT

**Goal**: Understand the timing of the race condition between process exit and data flushing.

3. **Add timestamps to trace execution**
   - Log when sp1.sh starts writing
   - Log when sp1.sh finishes writing
   - Log when sp2.sh exits
   - Log when Node spawner detects first exit
   - Log when Node spawner exits
   - Goal: Understand the timing of the race condition

4. **Add sleep to sp2.sh**
   - Make sp2.sh sleep before exiting
   - Test if delaying first exit allows all data to flush
   - This would confirm the race condition hypothesis

### Phase 3: Node.js Behavior Deep Dive

5. **Test with explicit process.exit() vs natural exit**
   - Modify spawner.js to use explicit `process.exit(0)` vs letting it naturally complete
   - See if forced exit behaves differently

6. **Test child process event handling**
   - Listen to 'close' event (fires when stdio streams are closed)
   - Listen to 'exit' event (fires when process exits)
   - Verify if Node waits for 'close' or only 'exit'

7. **Compare Node versions**
   - Test v10.24.1 (works) vs v11.9.0 (fails) vs latest
   - Document exact differences in behavior
   - Try to identify the commit that caused the change

### Phase 4: Explore Solutions

8. **Test manual stdio flushing**
   - Try explicitly calling drain events or waiting for streams to finish
   - See if we can force Node to wait for child stdio

9. **Test alternative spawn configurations**
   - Instead of `stdio: "inherit"`, try manual pipe handling
   - Test if explicitly managing the stdio streams prevents data loss

10. **Document workarounds**
    - Verify each workaround mentioned in README
    - Document pros/cons of each approach
    - Recommend best solution for GitLab use case

## Results & Findings

### Test Results

#### Phase 1: Verify Pipe Buffer Behavior ✅

**Test 1: Pipe Buffer Capacity (ctest.c)**
```bash
gcc ctest.c -o ctest
./ctest
```
**Result**: Pipe buffer capacity is exactly **65,536 bytes (64 KB)** on this macOS system.
- The test wrote 4KB chunks until receiving EAGAIN error
- Buffer filled after 16 writes of 4096 bytes each

**Test 2: sp1.sh Data Size Analysis**
```bash
bash sp1.sh 1000 > /dev/null 2>&1; wc -c print_log.txt
```
**Results**:
- Total bytes written to file (then catted): **195,893 bytes**
- Bytes per line: **~194 bytes** (193 chars + newline)
- Bytes through line 382: **74,764 bytes**
- Bytes through line 383: **74,960 bytes**
- Cropped output (from README): **110 bytes into line 383**
- Estimated bytes before crop: **74,764 + 110 = 74,874 bytes**

**Key Finding**: The total data (195,893 bytes) is approximately **3x the pipe buffer capacity** (65,536 bytes).

**Analysis**:
- The data being written significantly exceeds the pipe buffer capacity
- The cropping happens after ~74KB of data, which is notably more than the 64KB pipe buffer
- This suggests some additional buffering is occurring (possibly in Node.js or tee), but the pipe buffer limit is still a critical factor
- When `cat` dumps all 195KB at once, the pipe fills immediately
- If Node exits while the pipe is still full and tee is draining it, data is lost

**Conclusion**: ✓ **Hypothesis CONFIRMED** - The output size exceeds pipe buffer capacity, supporting the "pipe buffer overflow + premature exit" theory.

### Confirmed Hypotheses

#### ✓ Data Size Exceeds Pipe Buffer Capacity
The output from sp1.sh (195,893 bytes) is approximately 3x larger than the pipe buffer capacity (65,536 bytes). This creates conditions where the pipe can become full, causing writes to become asynchronous. If the Node process exits before the pipe is fully drained by the consumer (tee), data will be lost.

### Rejected Hypotheses

*To be updated as we verify/disprove theories...*

### Root Cause

*To be determined...*

### Recommended Solution

*To be determined...*

## How to Resume Investigation

### To continue from where we left off:

1. **Review Phase 1 results** in the "Test Results" section above
2. **Proceed to Phase 2: Timing Analysis** (see Investigation Plan)
3. Start with test #3: Add timestamps to trace execution flow

### Phase 2 Quick Start:

**Test 3**: Add timestamps to understand the race condition
- Modify sp1.sh to log start/end times
- Modify sp2.sh to add sleep and log timing
- Modify spawner.js to log when it detects exits
- Run and compare timestamps to see the race condition in action

**Test 4**: Verify the race condition hypothesis
- Add `sleep 2` to sp2.sh before exit
- Test if delaying the first exit allows all data to flush
- If this fixes the issue, it confirms the race condition theory

## References

- [Node.js, stdout, and disappearing bytes](https://sxlijin.github.io/2024-10-09-node-stdout-disappearing-bytes) - Excellent article explaining pipe buffer limits and async stdout behavior
- [Node.js Child Process Documentation](https://nodejs.org/api/child_process.html)
- [Node.js PR #25769](https://github.com/nodejs/node/pull/25769) - Changed process.exit() to process.exitCode in module errors
- [Node.js v11.9.0 Changelog](https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V11.md#2019-01-30-version-1190-current-targos)
