import { main } from "./seed.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`seed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
