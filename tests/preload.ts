import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(tmpdir(), "prtisan-tests", String(process.pid));
Bun.env.XDG_STATE_HOME ||= join(root, "state");
Bun.env.XDG_DATA_HOME ||= join(root, "data");
