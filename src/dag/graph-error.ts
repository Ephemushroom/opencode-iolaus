export class DagValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DagValidationError"
  }
}
