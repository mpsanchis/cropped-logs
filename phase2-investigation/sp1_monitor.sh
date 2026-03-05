#! /bin/bash

TIMING_LOG="/tmp/timing.log"
PRINT_LINE="[INFO] Downloading from xyz-platform: https://xyz-platform.maven.pkg.mycompany.io/org/springframework/data/build/spring-data-parent/2.1.6.RELEASE/spring-data-parent-2.1.6.RELEASE.pom"
PRINT_FILE="print_log.txt"
rm -f print_log.txt

# Check O_NONBLOCK state at start
python3 -c "import fcntl,os; fd=1; f=fcntl.fcntl(fd,fcntl.F_GETFL); print(f'START: fd1 flags=0x{f:x} O_NONBLOCK={bool(f & os.O_NONBLOCK)}')" >> $TIMING_LOG 2>&1

for (( c=1; c<=$1; c++ ))
do
    echo "Printing $c $PRINT_LINE" >> $PRINT_FILE
    # Check at intervals: 50, 100, 200, 500, 1000
    if [[ $c == 50 || $c == 100 || $c == 200 || $c == 500 || $c == 1000 ]]; then
        python3 -c "import fcntl,os; fd=1; f=fcntl.fcntl(fd,fcntl.F_GETFL); print(f'ITER $c: fd1 flags=0x{f:x} O_NONBLOCK={bool(f & os.O_NONBLOCK)}')" >> $TIMING_LOG 2>&1
    fi
done

python3 -c "import fcntl,os; fd=1; f=fcntl.fcntl(fd,fcntl.F_GETFL); print(f'BEFORE_CAT: fd1 flags=0x{f:x} O_NONBLOCK={bool(f & os.O_NONBLOCK)}')" >> $TIMING_LOG 2>&1

cat $PRINT_FILE
CAT_EXIT=$?
echo "$(date +%s%3N) [sp1] cat exit=$CAT_EXIT" >> $TIMING_LOG

echo "--- I am done ---"
exit 62
