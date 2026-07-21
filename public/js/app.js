// ระบบกลาง: init Firebase + auth guard ที่ทุกหน้า (ยกเว้น login.html) ต้อง import
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signOut,
  signInWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  getDoc,
  query,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDocs, getDoc, query, orderBy, serverTimestamp,
  signInWithEmailAndPassword, signOut,
};

/**
 * เรียกฟังก์ชันนี้ที่ทุกหน้าที่ต้อง login ก่อนใช้
 * ถ้ายังไม่ login → เด้งไป login.html
 * ถ้า login แล้วแต่ Firestore rules ปฏิเสธ (ไม่ใช่ทีม) → แสดงข้อความและไม่โหลดข้อมูล
 */
export function requireAuth(onReady) {
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      window.location.href = "login.html";
      return;
    }
    const el = document.getElementById("current-user-email");
    if (el) el.textContent = user.email;
    onReady(user);
  });
}

export function wireLogoutButton() {
  const btn = document.getElementById("logout-btn");
  if (btn) {
    btn.addEventListener("click", async () => {
      await signOut(auth);
      window.location.href = "login.html";
    });
  }
}

/** แสดงข้อความ error แบบอ่านง่ายเมื่อ Firestore ปฏิเสธสิทธิ์ */
export function explainFirestoreError(err, targetElId) {
  const el = document.getElementById(targetElId);
  if (!el) return;
  if (err && err.code === "permission-denied") {
    el.textContent = "บัญชีนี้ยังไม่ได้รับสิทธิ์เข้าระบบ — แจ้งแอดมินให้เพิ่มอีเมลนี้ใน teamMembers ผ่าน Firebase Console";
  } else {
    el.textContent = "เกิดข้อผิดพลาด: " + (err?.message || String(err));
  }
  el.hidden = false;
}
