#! /bin/bash

PRINT_LINE="[INFO] Downloading from xyz-platform: https://xyz-platform.maven.pkg.mycompany.io/org/springframework/data/build/spring-data-parent/2.1.6.RELEASE/spring-data-parent-2.1.6.RELEASE.pom"
PRINT_FILE="print_log.txt"
rm -f print_log.txt
for (( c=1; c<=$1; c++ ))
do
    echo "Printing $c $PRINT_LINE" >> $PRINT_FILE
done
cat $PRINT_FILE
echo "--- I am done ---"
exit 62