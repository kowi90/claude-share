import os from "node:os";

import linux from "./linux";
import type { PlatformOps } from "./types";

// Claude Code on Windows keeps its credentials in the same plain file as on
// Linux (%USERPROFILE%\.claude\.credentials.json), so only the naming differs.
const win32: PlatformOps = {
  ...linux,

  async getSystemName(): Promise<string> {
    return process.env["COMPUTERNAME"] || os.hostname();
  },
};

export default win32;
