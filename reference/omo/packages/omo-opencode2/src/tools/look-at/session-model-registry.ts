/**
 * Tracks which model each session is currently running on.
 *
 * `ToolContext` carries no model, so a tool cannot ask the harness what the
 * caller is running. `session.hook("context")` does expose `model` alongside
 * `sessionID` and fires on every request, so the context composer feeds this
 * registry and `look_at` reads it at execute time.
 */
export interface SessionModelRegistry {
  /** Record the model for a session. Later requests overwrite earlier ones. */
  record(sessionID: string, model: string): void
  /** The last known model for a session, or undefined before its first request. */
  read(sessionID: string): string | undefined
  /** Drop a session's entry. */
  forget(sessionID: string): void
}

export function createSessionModelRegistry(): SessionModelRegistry {
  const models = new Map<string, string>()
  return {
    record(sessionID, model) {
      if (!sessionID || !model) return
      models.set(sessionID, model)
    },
    read(sessionID) {
      return models.get(sessionID)
    },
    forget(sessionID) {
      models.delete(sessionID)
    },
  }
}

/** Join a v2 model ref into the "<provider>/<model>" key the catalog uses. */
export function formatModelKey(model: { id: string; providerID: string } | undefined): string | undefined {
  if (!model?.providerID || !model.id) return undefined
  return `${model.providerID}/${model.id}`
}
