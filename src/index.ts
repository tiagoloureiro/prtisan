#!/usr/bin/env bun
import { main } from "./cli.js";

try {
  const exitCode = await main();
  Bun.exit(exitCode);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  Bun.exit(1);
}
