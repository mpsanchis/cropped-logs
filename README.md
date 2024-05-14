# cropped-logs

## Goal

Understand why GitLab crops some outputs. We don't see the Nx errors because 

## Commands

### Getting started

If you want to test Java, compile your Java code with:
```sh
javac Spawner.java
```

### Scripts that fail

#### Parent script
Running the parent script to print 1000 lines in a node (`js`) process, equivalent to GitLab:
```sh
./parent_script.sh js 1000
```

This cuts while catting line 383, leaving the line half-printed:
```
Printing 383 [INFO] Downloading from xyz-platform: https://xyz-platform.maven.pkg.sehlat.io/org/springframewor
```

#### Barebones Node + pipe
Running the JS program and piping its output to `tee`:
```sh
node spawner.js 1000 | tee output.log
```
or to `cat`:
```sh
node spawner.js 1000 | cat
```

Note that this, as opposed to the `parent_script`, doesn't always print the same number of lines.

### Scripts that work

#### Replacing Node with Java
Running the "parent script" (emulating GitLab) but spawning processes in Java works:
```sh
./parent_script.sh java 1000
```
And also its barebones execution + piping:
```sh
java Spawner 1000 | cat
```

Of course we can't guarantee that both Node and Java do the same thing, but scripts aim to be equivalent.

#### Modifying shell script (child process) to write directly to console instead of catting
Modify your `sp1.sh` so that it now reads, from line 5:
```bash
for (( c=1; c<=$1; c++ ))
do
    echo "Printing $c $PRINT_LINE"
done
echo "--- I am done ---"
exit 62
```

Then both:
* `node spawner.js 3000 | cat`
* `./parent_script.sh js 1000`

work OK.

#### Modify your JS code so that it awaits the processes as they are created

Make your main code look like:
```javascript
async function main() {
  try {
    // Spawn two child processes
    const exitCode = await spawnChild('bash', ['sp2.sh']);
    const exitCode2 = await spawnChild('bash', ['sp1.sh', `${process.argv[2]}`]);
    console.log(`exit code was ${exitCode}`);
    console.log(`exit code 2 was ${exitCode2}`);
} catch (error) {
    console.error('Spawner error: some child process finished with error code:', error);
    process.exit(1);
  }
}
```

Then verify that both the pipe and the parent script work:
* `node spawner.js 1000 | cat`
* `./parent_script.sh js 1000`

#### Running the scripts with "unbuffer"

Either run the node command with unbuffer:
```js
unbuffer node spawner.js 1000 | cat
```

Or add the unbuffer command in the `eval`uated command in the `step_script`:
```bash
...

: | eval $'unbuffer $SPAWNER $2'
```

Both solutions work. Notes about this approach:
* `unbuffer` is not available in native MacOS. It was installed through `brew install expect`.
* General recommended approach is to use Linux's `stdbuf`, such as in [this](asd) stackoverflow question: `stdbuf -i0 -o0 -e0 command`