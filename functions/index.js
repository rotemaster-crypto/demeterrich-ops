/**
 * Cloud Functions สำหรับเชื่อมต่อ Facebook Messenger
 * - messengerWebhook: รับข้อความเข้าจากลูกค้า (Facebook เรียกเข้ามาเอง) → บันทึกลง Firestore
 * - sendReply: ส่งข้อความออกไปหาลูกค้า (แอดมินกดปุ่ม "ส่ง" ในหน้า inbox.html เท่านั้น — ไม่มีการส่งอัตโนมัติ)
 *
 * โหมดทำงาน: semi-auto with one-tap approval ตามที่ตกลงกันไว้ — ไม่มีฟังก์ชันไหนส่งข้อความหาลูกค้าเองโดยไม่มีคนกด
 */

const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: "asia-southeast1" });

// ตั้งค่าด้วย: firebase functions:secrets:set FB_VERIFY_TOKEN
//              firebase functions:secrets:set FB_PAGE_ACCESS_TOKEN
const FB_VERIFY_TOKEN = defineSecret("FB_VERIFY_TOKEN");
const FB_PAGE_ACCESS_TOKEN = defineSecret("FB_PAGE_ACCESS_TOKEN");

async function isTeamMember(email) {
  if (!email) return false;
  const doc = await db.collection("teamMembers").doc(email).get();
  return doc.exists;
}

// ============================================================
// 1) Webhook รับข้อความจาก Facebook
// ============================================================
exports.messengerWebhook = onRequest(
  { secrets: [FB_VERIFY_TOKEN], cors: false },
  async (req, res) => {
    // --- GET: Facebook ใช้ตอนตั้งค่า Webhook ครั้งแรกใน Meta App Dashboard ---
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === FB_VERIFY_TOKEN.value()) {
        res.status(200).send(challenge);
      } else {
        res.sendStatus(403);
      }
      return;
    }

    // --- POST: ข้อความ/อีเวนต์เข้าจริง ---
    if (req.method === "POST") {
      const body = req.body;
      if (body.object !== "page") {
        res.sendStatus(404);
        return;
      }
      try {
        for (const entry of body.entry || []) {
          for (const event of entry.messaging || []) {
            const psid = event.sender?.id;
            if (!psid) continue;

            if (event.message && event.message.text) {
              await saveIncomingMessage(psid, event.message.text, event.timestamp);
            }
            // event.message.is_echo = true คือข้อความที่ Page ส่งเอง (เช่นจาก sendReply) — ไม่ต้องบันทึกซ้ำ
          }
        }
        res.sendStatus(200);
      } catch (err) {
        console.error("messengerWebhook error:", err);
        res.sendStatus(500);
      }
      return;
    }

    res.sendStatus(405);
  }
);

async function saveIncomingMessage(psid, text, timestamp) {
  const convRef = db.collection("conversations").doc(psid);
  await convRef.set(
    {
      lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
      lastMessageText: text,
      status: "needs_reply",
    },
    { merge: true }
  );
  await convRef.collection("messages").add({
    direction: "in",
    text,
    fbTimestamp: timestamp || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ============================================================
// 2) ส่งข้อความออก — เรียกจากหน้า inbox.html เมื่อแอดมินกด "ส่ง" เท่านั้น
// ============================================================
exports.sendReply = onCall(
  { secrets: [FB_PAGE_ACCESS_TOKEN] },
  async (request) => {
    const email = request.auth?.token?.email;
    if (!(await isTeamMember(email))) {
      throw new HttpsError("permission-denied", "บัญชีนี้ไม่มีสิทธิ์ส่งข้อความ");
    }

    const { psid, text } = request.data || {};
    if (!psid || !text || typeof text !== "string" || !text.trim()) {
      throw new HttpsError("invalid-argument", "ต้องระบุ psid และข้อความ");
    }

    const fbRes = await fetch(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(FB_PAGE_ACCESS_TOKEN.value())}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: psid },
          message: { text: text.trim() },
          messaging_type: "RESPONSE",
        }),
      }
    );
    const fbData = await fbRes.json();
    if (!fbRes.ok) {
      console.error("Facebook Send API error:", fbData);
      throw new HttpsError("internal", "ส่งข้อความไม่สำเร็จ: " + (fbData?.error?.message || "unknown error"));
    }

    const convRef = db.collection("conversations").doc(psid);
    await convRef.collection("messages").add({
      direction: "out",
      text: text.trim(),
      sentBy: email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await convRef.set(
      { status: "replied", lastReplyAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    return { success: true };
  }
);
