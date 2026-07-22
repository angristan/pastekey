export {};

const runtime = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
const origin = (runtime.process?.env?.SMOKE_ORIGIN ?? "https://paste.stanislas.cloud").replace(/\/$/, "");

const health = await fetch(`${origin}/api/health`);
assert(health.ok, `health returned ${health.status}`);
assert((await health.json() as { ok?: boolean }).ok === true, "health body is invalid");

const root = await fetch(`${origin}/`);
assert(root.ok, `root returned ${root.status}`);
const html = await root.text();
assert(html.includes("<title>Pastekey — Private, encrypted sharing</title>"), "root metadata is missing");
assert(root.headers.get("content-security-policy")?.includes("frame-ancestors 'none'") === true, "CSP is missing");

const share = await fetch(`${origin}/s/smoke-share-0000000001`);
assert(share.ok, `edge-served share shell returned ${share.status}`);
assert(share.headers.get("content-type")?.includes("text/html") === true, "edge-served share is not HTML");
assert(share.headers.get("x-robots-tag") === "noindex, nofollow, noarchive", "direct share indexing policy is missing");

const image = await fetch(`${origin}/og-image.png`);
assert(image.ok && image.headers.get("content-type") === "image/png", "social preview image is unavailable");

const config = await fetch(`${origin}/api/config`);
assert(config.ok, `config returned ${config.status}`);
const configBody = await config.json() as { limits?: { maxFileBytes?: number } };
assert(Number.isSafeInteger(configBody.limits?.maxFileBytes), "config limits are invalid");

console.log(`Pastekey smoke checks passed for ${origin}`);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
