import { describe, expect, test } from "bun:test"

import { checkMonitorCommandPermission } from "./permission"

describe("checkMonitorCommandPermission", () => {
  describe("#given the feature is disabled", () => {
    describe("#when a command is checked", () => {
      test("#then it is refused regardless of the allowlist", () => {
        const result = checkMonitorCommandPermission("npm run dev", { enabled: false, allowed_commands: ["npm"] })

        expect(result.allowed).toBe(false)
        expect(result.via).toBe("feature-disabled")
      })
    })
  })

  describe("#given no allowed_commands is configured", () => {
    describe("#when any command is checked", () => {
      test("#then it fails closed rather than defaulting to allow", () => {
        const result = checkMonitorCommandPermission("echo hi", { enabled: true })

        expect(result.allowed).toBe(false)
        expect(result.via).toBe("allowlist-unset")
      })

      test("#then the refusal names the config key so the user can fix it", () => {
        const result = checkMonitorCommandPermission("echo hi", { enabled: true, allowed_commands: [] })

        expect(result.reason).toContain("monitor.allowed_commands")
      })
    })
  })

  describe("#given an allowlist", () => {
    describe("#when the program is listed", () => {
      test("#then the command is allowed", () => {
        const result = checkMonitorCommandPermission("npm run dev", { enabled: true, allowed_commands: ["npm", "tail"] })

        expect(result.allowed).toBe(true)
        expect(result.via).toBe("allowlist")
      })
    })

    describe("#when the program is not listed", () => {
      test("#then the command is refused and the allowlist is reported", () => {
        const result = checkMonitorCommandPermission("curl http://x", { enabled: true, allowed_commands: ["npm"] })

        expect(result.allowed).toBe(false)
        expect(result.reason).toContain("npm")
      })
    })

    describe("#when an allowed program is followed by a shell operator", () => {
      test("#then only the first token is matched, so the allowlist is not bypassed by argument smuggling", () => {
        // The allowlist matches argv[0]; the process is spawned from the same
        // argv, so there is no shell to interpret the rest as a second command.
        const result = checkMonitorCommandPermission("npm; curl evil.example", {
          enabled: true,
          allowed_commands: ["curl"],
        })

        expect(result.allowed).toBe(false)
      })
    })

    describe("#when the command is quoted", () => {
      test("#then the quoted program name is extracted", () => {
        const result = checkMonitorCommandPermission('"my prog" --flag', { enabled: true, allowed_commands: ["my prog"] })

        expect(result.allowed).toBe(true)
      })
    })

    describe("#when the command is empty", () => {
      test("#then it is refused", () => {
        const result = checkMonitorCommandPermission("   ", { enabled: true, allowed_commands: ["npm"] })

        expect(result.allowed).toBe(false)
      })
    })
  })
})
