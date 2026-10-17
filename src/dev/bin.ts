#!/usr/bin/env node
/* eslint-disable no-console */
import { runCli } from './cli.js';

runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
