# DemeterRich Ops

ระบบเครื่องมือภายในทีม สำหรับสนับสนุนการขายสินค้าทุกแบรนด์ของ DemeterRich (เริ่มจาก MAXIMUS) — ออกแบบให้ **ไม่ผูกกับสินค้าเดียว** เพื่อรองรับสินค้าตัวถัดๆ ไปโดยไม่ต้องสร้างระบบใหม่ทุกครั้ง

ไม่ใช่ Commerce Hub ตัวเต็ม — เป็นชุดเครื่องมือเบาๆ ที่แก้ปัญหาจริงของทีมตอนนี้ (ติดตามออเดอร์/CPA, เช็กคำต้องห้าม, คลังสคริปต์แชท, ปฏิทินคอนเทนต์) โดยออกแบบโครงสร้างข้อมูลให้ย้าย/เชื่อมเข้า Commerce Hub ได้ในอนาคตถ้าต้องการ

---

## Sites ที่ deploy อยู่ตอนนี้ (multi-site hosting)

| Site | URL | เข้าถึงได้โดยใคร |
|---|---|---|
| `ops` (target: `demeterrich-ops`) | https://demeterrich-ops.web.app | ทีมเท่านั้น (login) — เครื่องมือใน README นี้ทั้งหมด |
| `salepage` (target: `maximus-salepage`) | https://maximus-salepage.web.app | สาธารณะ — หน้าขาย MAXIMUS ไม่มี login |
| Cloudflare Worker | https://maximus-messenger-webhook.demeterrich.workers.dev | สาธารณะ — Facebook เรียกเข้ามาเท่านั้น (ไม่มีหน้าเว็บให้คนดู) |

Sale page อยู่ในโฟลเดอร์ `salepage-public/` แยกจาก `public/` (ops tool) โดยเจตนา เพราะเป็นคนละกลุ่มผู้ใช้ (ลูกค้า vs ทีม) — deploy แยกกันได้ด้วย `firebase deploy --only hosting:salepage` หรือ `--only hosting:ops`

**อัปเดต sale page:** แก้ไฟล์ต้นทางที่ `project maximus/salepage/index.html` ก่อน แล้วค่อย copy มาที่ `salepage-public/index.html` ในนี้ (ยังไม่ได้เชื่อมอัตโนมัติ — สองที่นี้อาจไม่ตรงกันถ้าลืม sync)

---

## Facebook Messenger — สถาปัตยกรรม (semi-auto with one-tap approval)

```
Facebook Messenger → Cloudflare Worker (รับข้อความ, สาธารณะ) → Firestore
                                                                    ↓
                                                          inbox.html (ทีมดูและกดส่ง)
                                                                    ↓
                                          Cloud Function "sendReply" (ต้อง login + กดปุ่มเท่านั้น) → Facebook Send API
```

**ทำไมรับข้อความผ่าน Cloudflare Worker ไม่ใช่ Cloud Functions โดยตรง:** ลองแล้วพบว่า Google Cloud project นี้มีการบล็อกการเข้าถึงแบบสาธารณะ (public/unauthenticated) ที่ระดับสูงกว่า project settings เอง (คาดว่าเป็น security perimeter ระดับองค์กร) ทำให้ Cloud Run/Functions เรียกจากภายนอกโดยไม่ auth ไม่ได้เลยแม้ตั้งค่า public access ถูกต้องแล้ว — Cloudflare Workers ไม่มีข้อจำกัดนี้ จึงใช้เป็นตัวรับแทน แล้วเขียนต่อเข้า Firestore โดยตรงผ่าน REST API (ยืนยันตัวตนด้วย Google Service Account เฉพาะที่สร้างไว้ให้ `messenger-webhook-writer@demeterrich-ops.iam.gserviceaccount.com` สิทธิ์แค่ `roles/datastore.user` เท่านั้น)

**หลักการสำคัญ:** ไม่มีจุดไหนในระบบที่ส่งข้อความหาลูกค้าอัตโนมัติเลย — Worker แค่ "รับเข้า" ส่วน "ส่งออก" ต้องผ่าน `sendReply` ที่ต้อง login และกดปุ่มใน `inbox.html` เท่านั้นเสมอ (semi-auto with one-tap approval ตามที่ตกลงกันไว้)

### ไฟล์ที่เกี่ยวข้อง
- `cf-worker/worker.js` — Cloudflare Worker (รับ webhook)
- `functions/index.js` — Cloud Function `sendReply` (ส่งข้อความ, auth-gated)
- `public/inbox.html` — หน้าดูบทสนทนา + สคริปต์แนะนำ + ปุ่มส่ง

### Meta App Setup Checklist (ต้องทำเองทั้งหมด — ผูกกับบัญชี Facebook ของคุณ)

- [ ] สร้างเพจ Facebook สำหรับ MAXIMUS (Phase 4 — ยังไม่ได้เริ่ม ณ ตอนเขียนเอกสารนี้)
- [ ] ไปที่ [developers.facebook.com](https://developers.facebook.com) → My Apps → Create App → เลือกประเภท "Business"
- [ ] เพิ่ม Product "Messenger" เข้า App
- [ ] ในหน้า Messenger Settings → Access Tokens → เลือกเพจ MAXIMUS → Generate Token → คัดลอก **Page Access Token**
- [ ] ตั้งค่า Webhook: Callback URL = `https://maximus-messenger-webhook.demeterrich.workers.dev/` (ของจริงที่ deploy ไว้แล้ว), Verify Token = ค่าเดียวกับที่ตั้งไว้ในระบบ (ขอจาก Claude ถ้าจำไม่ได้ — เก็บเป็น Cloudflare secret ไม่โชว์ในโค้ด)
- [ ] เลือก Subscribe to: `messages`
- [ ] เอา Page Access Token ที่ได้ ไปอัปเดตใน Firebase Functions secret: `firebase functions:secrets:set FB_PAGE_ACCESS_TOKEN` (แล้ว redeploy `sendReply`)

พอครบทุกข้อ ทดสอบได้จริงโดยส่งข้อความไปที่เพจ MAXIMUS แล้วเช็กที่ `inbox.html`

---

## สิ่งที่มีให้ตอนนี้

| หน้า | ทำอะไร |
|---|---|
| `orders.html` | บันทึกออเดอร์ + log ค่าแอดรายวัน → คำนวณ CPA จริงเทียบเพดานอัตโนมัติ |
| `content.html` | ติ๊กสถานะโพสต์ตามปฏิทิน 30 วัน + เช็กว่าครบ 12 โพสต์บังคับก่อนยิงแอดหรือยัง |
| `chat-reference.html` | ค้นหาสคริปต์ตอบแชท/ข้อโต้แย้งแบบเรียลไทม์ |
| `compliance-check.html` | เช็กคำต้องห้ามในร่างข้อความก่อนโพสต์ |

ข้อมูลอ้างอิงทั้งหมด (สคริปต์, กฎ compliance, ปฏิทิน) ดึงมาจากเอกสารที่ทำไว้แล้วใน `project maximus/` — ถ้าแก้เอกสารต้นทาง ต้องกลับมาแก้ไฟล์ `public/data/*.js` ในนี้ด้วย (ยังไม่ได้เชื่อมอัตโนมัติ)

---

## สถาปัตยกรรม

- **Firebase Hosting** — เสิร์ฟไฟล์ static ทั้งหมดใน `public/`
- **Firestore** — เก็บข้อมูล (orders, adSpend, contentCalendar, products, offers)
- **Firebase Auth** — login ด้วยอีเมล/รหัสผ่าน เฉพาะคนที่แอดมินเพิ่มสิทธิ์ให้เท่านั้น
- ไม่มี build step, ไม่มี npm/node ต้องติดตั้ง — ไฟล์ HTML/JS ธรรมดา โหลด Firebase SDK ผ่าน CDN

---

## Setup ครั้งแรก (ทำโดย Roger — ผมทำแทนไม่ได้เพราะต้อง login จริง)

### 1. สร้าง Firebase Project
1. ไปที่ [console.firebase.google.com](https://console.firebase.google.com) → สร้างโปรเจกต์ใหม่
2. เปิดใช้งาน **Firestore Database** (โหมด production)
3. เปิดใช้งาน **Authentication** → เลือก Sign-in method: Email/Password
4. เปิดใช้งาน **Hosting**
5. ไปที่ Project Settings → Your apps → เพิ่มเว็บแอป → คัดลอกอ็อบเจกต์ `firebaseConfig`

### 2. ใส่ค่า config
- วางค่าจากข้อ 1.5 ลงใน `public/js/firebase-config.js` (แทนที่ `REPLACE_ME` ทั้งหมด)
- แก้ `.firebaserc` ใส่ Project ID จริงแทน `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID`
- **ค่า `firebaseConfig` ไม่ใช่ความลับ** — Firebase ออกแบบมาให้ API key ฝั่งเว็บเปิดเผยได้ ความปลอดภัยจริงอยู่ที่ `firestore.rules` (คุมว่าใครอ่าน/เขียนข้อมูลได้) ไม่ใช่การซ่อนค่านี้ — commit ขึ้น GitHub ได้ตามปกติ

### 3. เพิ่มทีมที่มีสิทธิ์เข้าระบบ
1. Firebase Console → Authentication → Users → Add user (ใส่อีเมล+รหัสผ่านให้ทีมแต่ละคน)
2. Firebase Console → Firestore Database → สร้าง collection ชื่อ `teamMembers`
3. เพิ่ม document ใหม่ **ตั้งชื่อ Document ID เป็นอีเมลของคนนั้นเป๊ะๆ** (เช่น `admin@demeterrich.com`) เนื้อหาข้างในใส่อะไรก็ได้ (เช่น field `role: "admin"`) — แค่มี document อยู่ก็พอ ระบบเช็กจากการมีอยู่ของ doc นี้เท่านั้น

*(ทำไมต้องทำผ่าน Console ไม่ทำในเว็บ: กันไม่ให้ใครก็ตามที่ login เข้ามาแล้วเพิ่มสิทธิ์ให้ตัวเองได้)*

### 4. ติดตั้งเครื่องมือ deploy (ทำครั้งเดียว)
```bash
npm install -g firebase-tools
firebase login
```

### 5. Deploy
```bash
cd demeterrich-ops
firebase deploy
```
เสร็จแล้วจะได้ URL แบบ `https://<project-id>.web.app` — แชร์ URL นี้ให้ทีมใช้งาน

### ⚠️ ทดสอบก่อน deploy — ห้ามเปิดไฟล์ตรงๆ (ต่างจาก salepage/index.html)
หน้าเว็บในระบบนี้ใช้ ES modules (`import`) เพื่อโหลด Firebase SDK ซึ่ง**เบราว์เซอร์บล็อกการรันจากไฟล์ที่เปิดตรงๆ แบบ `file://` ด้วยเหตุผลด้าน CORS** — ดับเบิลคลิกเปิดไฟล์ตรงๆ แบบที่ทำกับ sale page จะไม่ทำงาน (หน้าจอจะว่างเปล่า)

ต้องรันผ่านเซิร์ฟเวอร์เสมอ ทดสอบก่อน deploy จริงได้ด้วย:
```bash
firebase emulators:start --only hosting
```
แล้วเปิด `http://localhost:5000` แทน — หรือจะ `firebase deploy` ขึ้นจริงเลยแล้วทดสอบบน URL จริงก็ได้เช่นกัน

---

## วิธีเพิ่มสินค้าใหม่ในอนาคต

ระบบออกแบบให้ collection `orders`, `offers`, `adSpend` ผูกกับ `productId` อยู่แล้ว (ไม่ hardcode ว่าเป็น MAXIMUS) แต่หน้า `content.html` และ `chat-reference.html` ตอนนี้ยัง seed ข้อมูลเฉพาะ MAXIMUS อยู่ ขั้นตอนเพิ่มสินค้าใหม่:

1. **orders.html** — ใช้ได้ทันทีไม่ต้องแก้โค้ด กด "ตั้งค่าเริ่มต้น" หรือเพิ่ม product/offer ใหม่ผ่าน Firestore Console ได้เลย
2. **content.html** — สร้างไฟล์ `public/data/content-calendar-<ชื่อสินค้า>.js` ตามรูปแบบไฟล์เดิม แล้วแก้ `content.html` ให้เลือก dataset ตามสินค้า (ตอนนี้ยัง fix เป็น MAXIMUS ผ่านตัวแปร `PRODUCT_KEY`)
3. **chat-reference.html** — เพิ่มสคริปต์ใหม่ต่อท้าย `public/data/chat-scripts.js` หรือแยกไฟล์ใหม่ตามสินค้า
4. **compliance-check.html** — เพิ่มกฎเฉพาะสินค้าใหม่ต่อท้าย `public/data/banned-terms.js`

---

## ความสัมพันธ์กับ `project maximus/`

โฟลเดอร์ `project maximus/` (เอกสาร Markdown ทั้งหมด) คือ **แหล่งความจริงเดียว (source of truth)** สำหรับกลยุทธ์/ราคา/กฎ compliance — repo นี้เป็นแค่ **ชั้นเครื่องมือที่เอาข้อมูลจากที่นั่นมาทำให้ใช้งานง่ายขึ้น** ถ้าตัวเลข/กฎเปลี่ยนที่เอกสารต้นทาง ต้องอัปเดตไฟล์ seed data ในนี้ด้วยมือ (ยังไม่ได้เชื่อมอัตโนมัติ — เป็นเรื่องที่พอมีเวลาค่อยทำ)

## Manual fallback

ถ้าระบบนี้ล่ม/เข้าไม่ได้ ทุกอย่างยังทำด้วยมือได้ตามเดิม: ทะเบียนออเดอร์ = Google Sheet, สคริปต์แชท = เปิดไฟล์ `sales/*.md` ตรงๆ, เช็กคำต้องห้าม = เทียบกับตารางใน `compliance/approved-claims.md` เอง — ระบบนี้คือตัวช่วยให้เร็วขึ้น ไม่ใช่จุดเดียวที่พังแล้วธุรกิจหยุด
