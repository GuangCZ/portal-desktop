// Ported from BeingDesktop 0.8.26 test/desktop-console-integration.cjs on 2026-09-16.
//
// That file is not a node:test suite: it is a standalone script whose first statement
// is `if (process.platform !== 'win32') throw new Error(...)`. It drives a real
// PowerShell host through DesktopConsole, starts detached descendants with
// Start-Process, and verifies Windows job-object cleanup with Get-Process. None of
// its four checks can run under vitest on this platform, and none can be reduced to
// an in-process assertion without deleting what they verify, so each is recorded as a
// skipped case naming the check it stands for. Run the original script on Windows:
//   node test/desktop-console-integration.cjs
import { describe, it } from "vitest";

describe("desktop console Windows integration (BeingDesktop test/desktop-console-integration.cjs)", () => {
  it.skip("UTF-8 stdout/stderr, cwd, exit code, and secret-free environment", () => {});
  it.skip("Stop terminates the owned Windows process tree and preserves an independent job", () => {});
  it.skip("Natural shell exit cleans up inherited descendants", () => {});
  it.skip("High-volume output is bounded and retains valid Unicode at the tail", () => {});
});
