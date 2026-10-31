// prisma's pg adapter and amqplib both report a refused connect with nothing useful in the message
// (empty for an AggregateError, a bare "Invalid `prisma.$queryRaw()` invocation:" from prisma),
// so the code has to go in the log line too
export function errorReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const message = error.message.replace(/\s+/g, ' ').trim();
  const code = (error as { code?: unknown }).code;
  if (code === undefined || message.includes(String(code))) {
    return message || error.name;
  }

  return message ? `${message} (${code})` : String(code);
}
