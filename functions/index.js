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

// ตั้งค่าด้วย: firebase functions:secrets:set <ชื่อ>
const FB_VERIFY_TOKEN = defineSecret("FB_VERIFY_TOKEN");
const FB_PAGE_ACCESS_TOKEN = defineSecret("FB_PAGE_ACCESS_TOKEN"); // ใช้ส่งข้อความ (Messenger) + โพสต์ (pages_manage_posts)
const FB_PAGE_ID = defineSecret("FB_PAGE_ID");
const FB_AD_ACCOUNT_ID = defineSecret("FB_AD_ACCOUNT_ID"); // รูปแบบ "act_1234567890" (มี act_ นำหน้า)
const FB_MARKETING_ACCESS_TOKEN = defineSecret("FB_MARKETING_ACCESS_TOKEN"); // token ที่มีสิทธิ์ ads_read (อาจเป็นตัวเดียวกับ Page token ถ้าสิทธิ์ครอบคลุม)

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

// ============================================================
// 3) โพสต์คอนเทนต์ไปเพจ Facebook — เรียกจาก content.html เมื่อแอดมินกด "โพสต์" เท่านั้น
//    ไม่มีการโพสต์อัตโนมัติ ต้องมีคนกดยืนยันทุกครั้งเหมือน sendReply
// ============================================================
exports.postToFacebook = onCall(
  { secrets: [FB_PAGE_ACCESS_TOKEN, FB_PAGE_ID] },
  async (request) => {
    const email = request.auth?.token?.email;
    if (!(await isTeamMember(email))) {
      throw new HttpsError("permission-denied", "บัญชีนี้ไม่มีสิทธิ์โพสต์");
    }

    const { message, imageUrl, calendarKey } = request.data || {};
    if (!message || typeof message !== "string" || !message.trim()) {
      throw new HttpsError("invalid-argument", "ต้องระบุข้อความที่จะโพสต์");
    }

    const pageId = FB_PAGE_ID.value();
    const endpoint = imageUrl
      ? `https://graph.facebook.com/v21.0/${pageId}/photos`
      : `https://graph.facebook.com/v21.0/${pageId}/feed`;
    const payload = imageUrl
      ? { url: imageUrl, caption: message.trim() }
      : { message: message.trim() };

    const fbRes = await fetch(
      `${endpoint}?access_token=${encodeURIComponent(FB_PAGE_ACCESS_TOKEN.value())}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    const fbData = await fbRes.json();
    if (!fbRes.ok) {
      console.error("Facebook post error:", fbData);
      throw new HttpsError("internal", "โพสต์ไม่สำเร็จ: " + (fbData?.error?.message || "unknown error"));
    }

    if (calendarKey) {
      await db.collection("contentCalendar").doc(calendarKey).set(
        {
          posted: true,
          postedAt: admin.firestore.FieldValue.serverTimestamp(),
          postedBy: email,
          fbPostId: fbData.id || fbData.post_id || null,
        },
        { merge: true }
      );
    }

    return { success: true, fbPostId: fbData.id || fbData.post_id || null };
  }
);

// ============================================================
// 4) ดึงค่าแอดจาก Facebook Marketing API — เรียกจาก orders.html เมื่อแอดมินกด "ซิงก์ค่าแอด"
//    ดึงมาแล้วบันทึกทับ (upsert) ตามวันที่ ไม่สร้างซ้ำถ้าซิงก์หลายรอบ
// ============================================================
exports.syncAdSpend = onCall(
  { secrets: [FB_MARKETING_ACCESS_TOKEN, FB_AD_ACCOUNT_ID] },
  async (request) => {
    const email = request.auth?.token?.email;
    if (!(await isTeamMember(email))) {
      throw new HttpsError("permission-denied", "บัญชีนี้ไม่มีสิทธิ์ซิงก์ข้อมูล");
    }

    const daysBack = Math.min(Number(request.data?.daysBack) || 7, 30);
    const until = new Date();
    const since = new Date(until.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 10);

    const adAccountId = FB_AD_ACCOUNT_ID.value();
    const url =
      `https://graph.facebook.com/v21.0/${adAccountId}/insights` +
      `?fields=spend,date_start` +
      `&time_range=${encodeURIComponent(JSON.stringify({ since: fmt(since), until: fmt(until) }))}` +
      `&time_increment=1` +
      `&access_token=${encodeURIComponent(FB_MARKETING_ACCESS_TOKEN.value())}`;

    const fbRes = await fetch(url);
    const fbData = await fbRes.json();
    if (!fbRes.ok) {
      console.error("Facebook insights error:", fbData);
      throw new HttpsError("internal", "ดึงค่าแอดไม่สำเร็จ: " + (fbData?.error?.message || "unknown error"));
    }

    let synced = 0;
    for (const row of fbData.data || []) {
      const docId = `fbsync_${row.date_start}`;
      await db.collection("adSpend").doc(docId).set(
        {
          date: row.date_start,
          amount: Number(row.spend || 0),
          source: "facebook_auto_sync",
          syncedAt: admin.firestore.FieldValue.serverTimestamp(),
          syncedBy: email,
        },
        { merge: true }
      );
      synced++;
    }

    return { success: true, daysSynced: synced };
  }
);
