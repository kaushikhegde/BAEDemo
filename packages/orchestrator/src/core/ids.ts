import { randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

/** Next human identifier for a company, e.g. SCY-7. */
export function nextIdentifier(prefix: string, count: number): string {
  return `${prefix}-${count + 1}`;
}
