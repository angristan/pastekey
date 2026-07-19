export function jsonBody(value: unknown): Pick<RequestInit, "body"> {
  return { body: JSON.stringify(value) };
}
