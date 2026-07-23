#!/usr/bin/env bun
import { main } from "./cli.js";

try {
  const exitCode = await main();
  process.exit(exitCode);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
