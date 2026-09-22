export type AdmissionRequest = {
  readonly key: string
  readonly model: string
  readonly session: string
  readonly team?: string
}

/** All three budgets are reserved synchronously, without intermediate permits. */
export class Admission {
  readonly #limits: { readonly model: number; readonly team: number }
  readonly #queue = new Map<string, AdmissionRequest>()
  readonly #active = new Map<string, AdmissionRequest>()

  constructor(limits = { model: 5, team: 4 }) {
    this.#limits = limits
  }

  enqueue(request: AdmissionRequest): void {
    this.#queue.set(request.key, request)
  }

  remove(key: string): void {
    this.#queue.delete(key)
  }

  release(key: string): void {
    this.#active.delete(key)
  }

  take(): readonly AdmissionRequest[] {
    const admitted: AdmissionRequest[] = []
    for (const request of this.#queue.values()) {
      if (!this.#eligible(request)) continue
      this.#queue.delete(request.key)
      this.#active.set(request.key, request)
      admitted.push(request)
    }
    return admitted
  }

  immediate(request: AdmissionRequest): boolean {
    if (!this.#eligible(request)) return false
    for (const queued of this.#queue.values()) {
      if (this.#eligible(queued) && (queued.model === request.model || queued.session === request.session ||
        (request.team !== undefined && queued.team === request.team))) return false
    }
    this.#active.set(request.key, request)
    return true
  }

  #eligible(request: AdmissionRequest): boolean {
    let models = 0
    let members = 0
    for (const active of this.#active.values()) {
      if (active.session === request.session) return false
      if (active.model === request.model) models += 1
      if (request.team !== undefined && active.team === request.team) members += 1
    }
    return models < this.#limits.model && members < this.#limits.team
  }
}
