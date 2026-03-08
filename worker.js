const CF_MODEL = '@cf/meta/llama-3.1-8b-instruct';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* ── Extract user email from Cloudflare Access JWT ── */
async function getUserEmail(request) {
  // Cloudflare Access injects this header after successful login
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return null;

  try {
    // JWT payload is the middle part, base64 encoded
    const payload = jwt.split('.')[1];
    // Fix base64url padding
    const padded  = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(padded));
    return decoded.email || null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const headers = { 'Content-Type': 'application/json', ...CORS };

    /* ── Auth: get user from Cloudflare Access JWT ── */
    const userEmail = await getUserEmail(request);
    if (!userEmail) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized. Please sign in.' }),
        { status: 401, headers }
      );
    }

    /* ── Parse body ── */
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body.' }),
        { status: 400, headers }
      );
    }

    const { action, messages, key, value } = body;

    /* ── Prefix all KV keys with user email for data isolation ── */
    const userKey = (k) => `user:${userEmail}:${k}`;

    /* ══════════ KV OPERATIONS ══════════ */
    if (action === 'kv:get') {
      if (!env.KV) return new Response(JSON.stringify({ error: 'KV binding not configured.' }), { status: 500, headers });
      try {
        const val = await env.KV.get(userKey(key));
        return new Response(JSON.stringify({ value: val }), { status: 200, headers });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'KV get failed.', detail: err.message }), { status: 502, headers });
      }
    }

    if (action === 'kv:set') {
      if (!env.KV) return new Response(JSON.stringify({ error: 'KV binding not configured.' }), { status: 500, headers });
      try {
        await env.KV.put(userKey(key), typeof value === 'string' ? value : JSON.stringify(value));
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'KV set failed.', detail: err.message }), { status: 502, headers });
      }
    }

    if (action === 'kv:delete') {
      if (!env.KV) return new Response(JSON.stringify({ error: 'KV binding not configured.' }), { status: 500, headers });
      try {
        await env.KV.delete(userKey(key));
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'KV delete failed.', detail: err.message }), { status: 502, headers });
      }
    }

    /* ══════════ USER INFO ══════════ */
    if (action === 'whoami') {
      return new Response(JSON.stringify({ email: userEmail }), { status: 200, headers });
    }

    /* ══════════ AI OPERATIONS ══════════ */
    if (!action || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Body must include action and messages[].' }),
        { status: 422, headers }
      );
    }

    if (!env.AI) {
      return new Response(
        JSON.stringify({ error: 'Workers AI binding not configured.' }),
        { status: 500, headers }
      );
    }

    try {
      const response = await env.AI.run(CF_MODEL, { messages });
      const content  = response?.response ?? '';
      return new Response(JSON.stringify({ content }), { status: 200, headers });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Workers AI error.', detail: err.message }),
        { status: 502, headers }
      );
    }
  },
};
