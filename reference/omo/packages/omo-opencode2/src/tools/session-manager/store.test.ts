import { afterAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SessionStore } from "./store"

// DDL copied from a real opencode2 store on 0.0.0-next-17444 so the readers are
// pinned against the actual column set, not an idealized one.
const SESSION_DDL = `CREATE TABLE session_v2 (
  id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text,
  fork_session_id text, fork_boundary text, slug text NOT NULL, directory text NOT NULL,
  path text, title text, version text NOT NULL, share_url text,
  summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text,
  metadata text, cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL,
  tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL,
  revert text, permission text, agent text, model text,
  time_created integer NOT NULL, time_updated integer NOT NULL,
  time_compacting integer, time_archived integer, time_suspended integer
)`

const MESSAGE_DDL = `CREATE TABLE session_message (
  id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
)`

const root = mkdtempSync(join(tmpdir(), "oc2-store-test-"))
const dbPath = join(root, "fixture.db")

function seed(): void {
  const db = new Database(dbPath, { create: true })
  db.run(SESSION_DDL)
  db.run(MESSAGE_DDL)

  const insertSession = db.prepare(
    "INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, agent, model, cost, tokens_input, tokens_output, time_created, time_updated) VALUES (?, 'prj', ?, ?, ?, ?, 'v', ?, ?, ?, ?, ?, ?, ?)",
  )
  insertSession.run("ses_main", null, "kind-knight", "/work/proj", "Main session", "sisyphus", "zhipuai/glm-4.7", 0.5, 100, 20, 1000, 3000)
  insertSession.run("ses_old", null, "old-star", "/work/proj", null, "sisyphus", null, 0.1, 10, 2, 500, 900)
  insertSession.run("ses_child", "ses_main", "child-moon", "/work/proj", null, "explore", null, 0.2, 30, 5, 1100, 1200)
  insertSession.run("ses_other", null, "other-tree", "/work/elsewhere", null, "sisyphus", null, 0.3, 40, 6, 1300, 1400)

  const insertMessage = db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  insertMessage.run("msg_1", "ses_main", "user", 1, 1000, 1000, JSON.stringify({ time: { created: 1000 }, text: "please fix the parser bug", files: [] }))
  insertMessage.run(
    "msg_2",
    "ses_main",
    "assistant",
    2,
    1100,
    1100,
    JSON.stringify({
      time: { created: 1100, completed: 1150 },
      agent: "sisyphus",
      model: { id: "glm-4.7", providerID: "zhipuai" },
      content: [
        { type: "reasoning", text: "secret reasoning about the parser" },
        { type: "text", text: "I fixed the parser bug" },
      ],
      finish: "stop",
      cost: 0.5,
      tokens: { input: 100, output: 20, reasoning: 7 },
    }),
  )
  insertMessage.run("msg_3", "ses_old", "user", 1, 500, 500, JSON.stringify({ time: { created: 500 }, text: "unrelated question", files: [] }))
  db.close()
}

seed()
const store = new SessionStore(dbPath)

afterAll(() => {
  store.close()
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  } catch (error) {
    // Windows can hold the SQLite file handle past close(). The OS reclaims its
    // own temp dir, so a failed unlink must not fail the suite.
    console.warn(`[session-store.test] could not remove ${root}: ${String(error)}`)
  }
})

describe("SessionStore.listSessions", () => {
  describe("#given sessions in two directories", () => {
    describe("#when a directory filter is supplied", () => {
      test("#then only that project's sessions come back", () => {
        const rows = store.listSessions({ directory: "/work/proj", limit: 50 })

        expect(rows.map((row) => row.id).sort()).toEqual(["ses_main", "ses_old"])
      })
    })
  })

  describe("#given a child session exists", () => {
    describe("#when includeChildren is not set", () => {
      test("#then child sessions are excluded", () => {
        const rows = store.listSessions({ directory: "/work/proj", limit: 50 })

        expect(rows.some((row) => row.id === "ses_child")).toBe(false)
      })
    })

    describe("#when includeChildren is set", () => {
      test("#then the child session is included", () => {
        const rows = store.listSessions({ directory: "/work/proj", includeChildren: true, limit: 50 })

        expect(rows.some((row) => row.id === "ses_child")).toBe(true)
      })
    })
  })

  describe("#given sessions with different update times", () => {
    describe("#when listing", () => {
      test("#then the most recently updated comes first", () => {
        const rows = store.listSessions({ directory: "/work/proj", limit: 50 })

        expect(rows[0]?.id).toBe("ses_main")
      })
    })

    describe("#when a limit is supplied", () => {
      test("#then the result is bounded", () => {
        const rows = store.listSessions({ directory: "/work/proj", limit: 1 })

        expect(rows).toHaveLength(1)
      })
    })
  })

  describe("#given the store holds forward-slash paths and the caller passes a Windows path", () => {
    describe("#when the separators and casing differ", () => {
      test("#then the directory still matches", () => {
        const rows = store.listSessions({ directory: "\\WORK\\Proj", limit: 50 })

        expect(rows.map((row) => row.id).sort()).toEqual(["ses_main", "ses_old"])
      })
    })

    describe("#when the caller passes a trailing slash", () => {
      test("#then the directory still matches", () => {
        const rows = store.listSessions({ directory: "/work/proj/", limit: 50 })

        expect(rows.map((row) => row.id).sort()).toEqual(["ses_main", "ses_old"])
      })
    })
  })

  describe("#given a date window", () => {
    describe("#when fromDate excludes the older session", () => {
      test("#then only the newer session is returned", () => {
        const rows = store.listSessions({ directory: "/work/proj", fromDate: 900, limit: 50 })

        expect(rows.map((row) => row.id)).toEqual(["ses_main"])
      })
    })
  })
})

describe("SessionStore.getSession", () => {
  describe("#given an existing session id", () => {
    describe("#when fetched", () => {
      test("#then the row maps snake_case columns onto camelCase fields", () => {
        const row = store.getSession("ses_main")

        expect(row?.title).toBe("Main session")
        expect(row?.tokensInput).toBe(100)
        expect(row?.timeUpdated).toBe(3000)
        expect(row?.parentID).toBeNull()
      })
    })
  })

  describe("#given an unknown session id", () => {
    describe("#when fetched", () => {
      test("#then it returns undefined rather than throwing", () => {
        expect(store.getSession("ses_missing")).toBeUndefined()
      })
    })
  })
})

describe("SessionStore.readMessages", () => {
  describe("#given a session with messages", () => {
    describe("#when read", () => {
      test("#then messages arrive in seq order, already parsed", () => {
        const rows = store.readMessages("ses_main", 50)

        expect(rows.map((row) => row.seq)).toEqual([1, 2])
        expect(rows[0]?.message.kind).toBe("user")
        expect(rows[1]?.message.kind).toBe("assistant")
      })
    })

    describe("#when a limit is supplied", () => {
      test("#then the result is bounded", () => {
        expect(store.readMessages("ses_main", 1)).toHaveLength(1)
      })
    })
  })
})

describe("SessionStore.countMessages", () => {
  describe("#given a session with two messages", () => {
    describe("#when counted", () => {
      test("#then it reports two", () => {
        expect(store.countMessages("ses_main")).toBe(2)
      })
    })
  })
})

describe("SessionStore.searchMessages", () => {
  const base = { caseSensitive: false, limit: 20, maxSessions: 50, excerptRadius: 10 }

  describe("#given a query matching one project", () => {
    describe("#when scoped by directory", () => {
      test("#then only that project's messages match", () => {
        const hits = store.searchMessages({ ...base, query: "parser", directory: "/work/proj" })

        expect(hits.length).toBeGreaterThan(0)
        expect(hits.every((hit) => hit.sessionID !== "ses_other")).toBe(true)
      })
    })
  })

  describe("#given assistant reasoning containing the query", () => {
    describe("#when searching", () => {
      test("#then reasoning is not searched, so only the visible answer matches", () => {
        const hits = store.searchMessages({ ...base, query: "secret reasoning", directory: "/work/proj" })

        expect(hits).toHaveLength(0)
      })
    })
  })

  describe("#given a case difference", () => {
    describe("#when caseSensitive is false", () => {
      test("#then the match still lands", () => {
        const hits = store.searchMessages({ ...base, query: "PARSER", directory: "/work/proj" })

        expect(hits.length).toBeGreaterThan(0)
      })
    })

    describe("#when caseSensitive is true", () => {
      test("#then the mismatched case does not match", () => {
        const hits = store.searchMessages({ ...base, query: "PARSER", caseSensitive: true, directory: "/work/proj" })

        expect(hits).toHaveLength(0)
      })
    })
  })

  describe("#given a limit", () => {
    describe("#when more messages match than the limit", () => {
      test("#then the hit list is bounded", () => {
        const hits = store.searchMessages({ ...base, query: "e", limit: 1, directory: "/work/proj" })

        expect(hits).toHaveLength(1)
      })
    })
  })

  describe("#given a single session scope", () => {
    describe("#when sessionID is supplied", () => {
      test("#then only that session is scanned", () => {
        const hits = store.searchMessages({ ...base, query: "unrelated", sessionID: "ses_old" })

        expect(hits).toHaveLength(1)
        expect(hits[0]?.sessionID).toBe("ses_old")
      })
    })
  })

  describe("#given a match further into the message than the excerpt radius", () => {
    describe("#when excerpting", () => {
      test("#then the excerpt is elided on the left and keeps the match", () => {
        const hits = store.searchMessages({ ...base, query: "parser", directory: "/work/proj", excerptRadius: 4 })

        expect(hits[0]?.excerpt.startsWith("...")).toBe(true)
        expect(hits[0]?.excerpt).toContain("parser")
      })
    })
  })

  describe("#given a match at the very start of the message", () => {
    describe("#when excerpting", () => {
      test("#then there is no leading ellipsis", () => {
        const hits = store.searchMessages({ ...base, query: "please", directory: "/work/proj" })

        expect(hits[0]?.excerpt.startsWith("...")).toBe(false)
      })
    })
  })
})
