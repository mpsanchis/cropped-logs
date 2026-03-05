#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  int pipefd[2];
  printf("[INFO] Starting pipe fill test...\n");
  if (pipe(pipefd) == -1) {
    perror("pipe");
    exit(EXIT_FAILURE);
  }
  printf("[INFO] Pipe created.\n");

  // Set the write end of the pipe to non-blocking mode.
  int flags = fcntl(pipefd[1], F_GETFL, 0);
  if (flags == -1) {
    perror("fcntl(F_GETFL)");
    exit(EXIT_FAILURE);
  }
  if (fcntl(pipefd[1], F_SETFL, flags | O_NONBLOCK) == -1) {
    perror("fcntl(F_SETFL)");
    exit(EXIT_FAILURE);
  }
  printf("[INFO] Pipe write end set to non-blocking.\n");

  // Fill a buffer with data.
  char buffer[4096];
  memset(buffer, 'A', sizeof(buffer));
  printf("[INFO] Buffer initialized.\n");

  ssize_t total_written = 0;
  int write_count = 0;
  while (1) {
    ssize_t n = write(pipefd[1], buffer, sizeof(buffer));
    if (n == -1) {
      if (errno == EAGAIN) {
        printf("[INFO] EAGAIN encountered after writing %zd bytes in %d writes.\n", total_written, write_count);
        break;
      } else {
        perror("write");
        exit(EXIT_FAILURE);
      }
    }
    total_written += n;
    write_count++;
    printf("[DEBUG] Written %zd bytes so far...\n", total_written);
  }

  // Close both ends of the pipe.
  printf("[INFO] Closing pipe.\n");
  close(pipefd[0]);
  close(pipefd[1]);
  printf("[INFO] Done.\n");
  return 0;
}
