# original
export PATH=$PATH:$PWD
rm -r output.log
# 2>&1: This redirects the stderr (file descriptor 2) to the same location as stdout (file descriptor 1). 
# Essentially, it means "send stderr to the same place as stdout."
sh -c "(bash step_script 2>&1 $1 $2 | tee -a output.log)"

# omitting shell detection -> also fails
# export PATH=$PATH:$PWD
# rm -r output.log
# sh -c "(bash step_script 2>&1 | tee -a output.log)"

# omitting logging with tee -> this works!
# export PATH=$PATH:$PWD
# rm -r output.log
# sh -c "(bash step_script 2>&1)"