// Logs only a timestamp, context label, and error message/stack — never the request
// body or headers, so secrets (passwords, session tokens) can't end up in logs by accident.
export function logError(context: string, error: unknown) {
  const detail = error instanceof Error ? (error.stack || error.message) : String(error)
  console.error(`[${new Date().toISOString()}] ${context}:`, detail)
}
