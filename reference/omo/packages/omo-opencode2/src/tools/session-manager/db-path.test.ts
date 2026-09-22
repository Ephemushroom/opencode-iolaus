import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { resolveStorePath } from "./db-path"

describe("resolveStorePath", () => {
  describe("#given OMO_OPENCODE2_DB is set", () => {
    describe("#when the override path exists", () => {
      test("#then it wins over every other candidate", () => {
        const result = resolveStorePath({
          env: { OMO_OPENCODE2_DB: "/custom/store.db", XDG_DATA_HOME: "/xdg" },
          home: "/home/user",
          platform: "linux",
          exists: () => true,
        })

        expect(result.found).toBe(true)
        if (!result.found) return
        expect(result.path).toBe("/custom/store.db")
        expect(result.source).toBe("override")
      })
    })

    describe("#when the override path does not exist", () => {
      test("#then it falls through to the next candidate", () => {
        const xdgPath = join("/xdg", "opencode", "opencode.db")
        const result = resolveStorePath({
          env: { OMO_OPENCODE2_DB: "/missing/store.db", XDG_DATA_HOME: "/xdg" },
          home: "/home/user",
          platform: "linux",
          exists: (path) => path === xdgPath,
        })

        expect(result.found).toBe(true)
        if (!result.found) return
        expect(result.source).toBe("xdg")
      })
    })
  })

  describe("#given only XDG_DATA_HOME is set", () => {
    describe("#when the store exists under it", () => {
      test("#then it resolves to XDG_DATA_HOME/opencode/opencode.db", () => {
        const expected = join("/xdg", "opencode", "opencode.db")
        const result = resolveStorePath({
          env: { XDG_DATA_HOME: "/xdg" },
          home: "/home/user",
          platform: "linux",
          exists: (path) => path === expected,
        })

        expect(result.found).toBe(true)
        if (!result.found) return
        expect(result.path).toBe(expected)
        expect(result.source).toBe("xdg")
      })
    })
  })

  describe("#given no XDG override", () => {
    describe("#when the store sits in the home data dir", () => {
      test("#then it resolves under ~/.local/share", () => {
        const expected = join("/home/user", ".local", "share", "opencode", "opencode.db")
        const result = resolveStorePath({
          env: {},
          home: "/home/user",
          platform: "linux",
          exists: (path) => path === expected,
        })

        expect(result.found).toBe(true)
        if (!result.found) return
        expect(result.source).toBe("home")
      })
    })
  })

  describe("#given win32 with LOCALAPPDATA", () => {
    describe("#when only the LOCALAPPDATA copy exists", () => {
      test("#then it resolves there", () => {
        const expected = join("C:/Users/x/AppData/Local", "opencode", "opencode.db")
        const result = resolveStorePath({
          env: { LOCALAPPDATA: "C:/Users/x/AppData/Local" },
          home: "C:/Users/x",
          platform: "win32",
          exists: (path) => path === expected,
        })

        expect(result.found).toBe(true)
        if (!result.found) return
        expect(result.source).toBe("localappdata")
      })
    })

    describe("#when the platform is not win32", () => {
      test("#then LOCALAPPDATA is not consulted", () => {
        const localAppData = join("C:/Users/x/AppData/Local", "opencode", "opencode.db")
        const result = resolveStorePath({
          env: { LOCALAPPDATA: "C:/Users/x/AppData/Local" },
          home: "/home/user",
          platform: "linux",
          exists: (path) => path === localAppData,
        })

        expect(result.found).toBe(false)
      })
    })
  })

  describe("#given no store anywhere", () => {
    describe("#when resolution runs", () => {
      test("#then it reports not found without throwing and lists what it checked", () => {
        const result = resolveStorePath({
          env: { OMO_OPENCODE2_DB: "/a.db", XDG_DATA_HOME: "/xdg" },
          home: "/home/user",
          platform: "linux",
          exists: () => false,
        })

        expect(result.found).toBe(false)
        if (result.found) return
        expect(result.checked).toContain("/a.db")
        expect(result.checked).toContain(join("/xdg", "opencode", "opencode.db"))
        expect(result.checked).toContain(join("/home/user", ".local", "share", "opencode", "opencode.db"))
      })
    })
  })
})
