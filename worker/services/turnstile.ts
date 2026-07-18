import type { AppContext } from "../types";

export async function verifyTurnstile(c: AppContext, token: string | undefined) {
  if (!c.env.TURNSTILE_SECRET_KEY) {
    const hostname = new URL(c.req.url).hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") return { ok: true } as const;
    return { ok: false, status: 503 as const, error: "Registration protection is not configured" };
  }
  if (!token || token.length > 2048) {
    return { ok: false, status: 400 as const, error: "Complete the human verification first" };
  }

  const form = new FormData();
  form.set("secret", c.env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  const ip = c.req.header("CF-Connecting-IP");
  if (ip) form.set("remoteip", ip);

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const result = await response.json<{ success: boolean; hostname?: string }>();
    if (result.success && (!c.env.RP_ID || result.hostname === c.env.RP_ID)) return { ok: true } as const;
  } catch (error) {
    console.error("Turnstile verification failed", error);
  }
  return { ok: false, status: 400 as const, error: "Human verification failed. Please retry." };
}
