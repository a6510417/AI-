#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { main } from '../../studio/src/project-service.mjs';

// Keep the legacy public API and its v1 creation default.
export * from '../../studio/src/project-service.mjs';

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main(process.argv.slice(2));
}
