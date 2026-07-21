/**
 * Cloudflare Worker — รับ webhook จาก Facebook Messenger (สาธารณะ ไม่มีข้อจำกัดแบบ VPC-SC ของ GCP)
 * แล้วเขียนข้อความเข้า Firestore โดยตรงผ่าน REST API (ยืนยันตัวตนด้วย Google Service Account)
 *
 * Secrets ที่ต้องตั้งใน Cloudflare (wrangler secret put <name>):
 *   FB_VERIFY_TOKEN        - ต้องตรงกับที่ตั้งใน Meta App webhook config
 *   GCP_CLIENT_EMAIL       - จาก service account key JSON
 *   GCP_PRIVATE_KEY        - จาก service account key JSON (private_key field)
 *   GCP_PROJECT_ID         - "demeterrich-ops"
 *
 * หมายเหตุ: ไม่มีการส่งข้อความอัตโนมัติที่นี่เลย — แค่ "รับเข้า" เท่านั้น
 * การส่งออกยังคงต้องผ่าน Cloud Function "sendReply" ที่ต้องมีคนกดปุ่มใน inbox.html เสมอ
 */

// ---------- Google Service Account → OAuth2 access token ----------

function base64url(input) {
  let base64;
  if (typeof input === "string") {
    base64 = btoa(input);
  } else {
    const bytes = new Uint8Array(input);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    base64 = btoa(binary);
  }
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getGoogleAccessToken(env) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: env.GCP_CLIENT_EMAIL.trim(),
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const unsigned = base64url(JSON.stringify(header)) + "." + base64url(JSON.stringify(claims));

  const privateKeyPem = env.GCP_PRIVATE_KEY.replace(/\\n/g, "\n");
  const keyData = pemToArrayBuffer(privateKeyPem);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );
  const jwt = unsigned + "." + base64url(signature);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) {
    throw new Error("ขอ Google access token ไม่สำเร็จ: " + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

// ---------- Firestore REST helpers ----------

function fsValue(v) {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") return { integerValue: String(v) };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  return { stringValue: String(v) };
}

async function firestoreWrite(env, accessToken, path, fields, merge = false) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${env.GCP_PROJECT_ID.trim()}/databases/(default)/documents/${path}` +
    (merge ? "?" + Object.keys(fields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&") : "");
  const body = { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fsValue(v)])) };
  const res = await fetch(url, {
    method: merge ? "PATCH" : "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firestore write ล้มเหลว (${path}): ${errText}`);
  }
  return res.json();
}

async function firestoreAddToCollection(env, accessToken, collectionPath, fields) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.GCP_PROJECT_ID.trim()}/databases/(default)/documents/${collectionPath}`;
  const body = { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fsValue(v)])) };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firestore add ล้มเหลว (${collectionPath}): ${errText}`);
  }
  return res.json();
}

async function saveIncomingMessage(env, accessToken, psid, text) {
  const nowIso = new Date().toISOString();
  await firestoreWrite(
    env,
    accessToken,
    `conversations/${psid}`,
    { lastMessageAt: new Date(), lastMessageText: text, status: "needs_reply" },
    true
  );
  await firestoreAddToCollection(env, accessToken, `conversations/${psid}/messages`, {
    direction: "in",
    text,
    createdAt: new Date(),
  });
}

// ---------- Worker entry ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === (env.FB_VERIFY_TOKEN || "").trim()) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
      if (body.object !== "page") {
        return new Response("Not Found", { status: 404 });
      }
      try {
        const accessToken = await getGoogleAccessToken(env);
        for (const entry of body.entry || []) {
          for (const event of entry.messaging || []) {
            const psid = event.sender?.id;
            if (!psid) continue;
            if (event.message?.text && !event.message.is_echo) {
              await saveIncomingMessage(env, accessToken, psid, event.message.text);
            }
          }
        }
        return new Response("OK", { status: 200 });
      } catch (err) {
        console.error(err);
        return new Response("Internal Error: " + err.message, { status: 500 });
      }
    }

    return new Response("Method Not Allowed", { status: 405 });
  },
};
