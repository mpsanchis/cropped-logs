import java.io.*;

public class Spawner {
    public static void main(String[] args) {
        try {
            // Command to execute the first bash script
            String[] command1 = {"bash", "sp1.sh", args[0]};
            // Command to execute the second bash script
            String[] command2 = {"bash", "sp2.sh"};

            // Create process builders for both commands
            ProcessBuilder processBuilder1 = new ProcessBuilder(command1);
            ProcessBuilder processBuilder2 = new ProcessBuilder(command2);

            // Inherit input, output, and error streams
            processBuilder1.inheritIO();
            processBuilder2.inheritIO();

            // Start both processes
            Process process1 = processBuilder1.start();
            Process process2 = processBuilder2.start();

            // Wait for both processes to complete
            int exitCode2 = process2.waitFor();
            int exitCode1 = process1.waitFor();

            if (exitCode2 == 0) {
              System.out.println("sp2 exited with code: " + exitCode2);
            } else { 
              System.exit(12);
            }
            if (exitCode1 == 0) {
              System.out.println("sp1 exited with code: " + exitCode1);
            } else { 
              System.exit(12);
            }

        } catch (IOException | InterruptedException e) {
            e.printStackTrace();
        }
    }
}
