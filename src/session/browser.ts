import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

export async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      await exec(`open "${url}"`);
    } else if (platform === "win32") {
      await exec(`start "" "${url}"`);
    } else {
      await exec(`xdg-open "${url}"`);
    }
  } catch {
    // non-fatal: user can open manually
    console.log(`[open-krode] Open browser at: ${url}`);
  }
}
