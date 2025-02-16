const logger = {
  success: (message: string) => {
    console.log("\x1b[32m%s\x1b[0m", message);
  },
  error: (message: string) => {
    console.log("\x1b[31m%s\x1b[0m", message);
  },
  warning: (message: string) => {
    console.log("\x1b[33m%s\x1b[0m", message);
  },
  info: (message: string) => {
    console.log("\x1b[36m%s\x1b[0m", message);
  },
  debug: (message: string) => {
    console.log("\x1b[35m%s\x1b[0m", message);
  },
};

export default logger;
