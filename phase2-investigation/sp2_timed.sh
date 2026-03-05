#! /bin/bash

TIMING_LOG="/tmp/timing.log"
echo "$(date +%s%3N) [sp2] START (pid=$$)" >> $TIMING_LOG
echo "$(date +%s%3N) [sp2] About to exit 0" >> $TIMING_LOG

exit 0
