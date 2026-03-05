#! /bin/bash

TIMING_LOG="/tmp/timing.log"
echo "$(date +%s%3N) [sp1] START (pid=$$)" >> $TIMING_LOG

PRINT_LINE="[INFO] Downloading from xyz-platform: https://xyz-platform.maven.pkg.mycompany.io/org/springframework/data/build/spring-data-parent/2.1.6.RELEASE/spring-data-parent-2.1.6.RELEASE.pom"
PRINT_FILE="print_log.txt"
rm -f print_log.txt
for (( c=1; c<=$1; c++ ))
do
    echo "Printing $c $PRINT_LINE" >> $PRINT_FILE
done

# Check if fd 1 is O_NONBLOCK before fix
python3 -c "import fcntl,os; fd=1; flags=fcntl.fcntl(fd,fcntl.F_GETFL); print('fd1 O_NONBLOCK BEFORE fix:', bool(flags & os.O_NONBLOCK))" >> $TIMING_LOG 2>&1

# FIX: Set fd 1 back to blocking mode (clear O_NONBLOCK)
python3 -c "import fcntl,os; fcntl.fcntl(1, fcntl.F_SETFL, fcntl.fcntl(1, fcntl.F_GETFL) & ~os.O_NONBLOCK)"

# Check again
python3 -c "import fcntl,os; fd=1; flags=fcntl.fcntl(fd,fcntl.F_GETFL); print('fd1 O_NONBLOCK AFTER fix:', bool(flags & os.O_NONBLOCK))" >> $TIMING_LOG 2>&1

echo "$(date +%s%3N) [sp1] Starting cat ($(wc -c < $PRINT_FILE) bytes)" >> $TIMING_LOG
cat $PRINT_FILE
CAT_EXIT=$?
echo "$(date +%s%3N) [sp1] cat finished with exit code=$CAT_EXIT" >> $TIMING_LOG

echo "--- I am done ---"
echo "$(date +%s%3N) [sp1] About to exit 62" >> $TIMING_LOG
exit 62
