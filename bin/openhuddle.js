#!/usr/bin/env node
import { main } from '../src/client/cli.js';

main(process.argv.slice(2)).then(
  (code) => {
    if (typeof code === 'number') process.exitCode = code;
  },
  (err) => {
    console.error(`openhuddle: ${err?.message || err}`);
    process.exitCode = 1;
  },
);
