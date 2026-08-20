import { GoogleGenerativeAI } from "@google/generative-ai";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

// ── Firebase Admin init (runs once per cold start) ───────────────────────────
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Vercel env vars can't contain newlines — stored as base64
      privateKey: Buffer.from(process.env.FIREBASE_PRIVATE_KEY_B64, "base64").toString("utf8"),
    }),
  });
}

const db   = getFirestore();
const auth = getAuth();

const DAILY_LIMIT = 100;

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── Verify Firebase ID token ────────────────────────────────────────────────
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!idToken) {
    return res.status(401).json({ error: "Missing auth token" });
  }

  let uid;
  try {
    const decoded = await auth.verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return res.status(401).json({ error: "Invalid auth token" });
  }

  // ── Validate body ───────────────────────────────────────────────────────────
  const { sessionId, message } = req.body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }

  const safeMessage = message.trim().slice(0, 4000);

  // ── Rate limiting ───────────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const rateRef = db.doc(`users/${uid}/rateLimit/${today}`);
  const rateSnap = await rateRef.get();
  const count = rateSnap.exists ? (rateSnap.data().count || 0) : 0;

  if (count >= DAILY_LIMIT) {
    return res.status(429).json({ error: `Daily limit of ${DAILY_LIMIT} messages reached.` });
  }

  await rateRef.set({ count: count + 1 }, { merge: true });

  // ── Load chat history from Firestore ────────────────────────────────────────
  const msgsRef = db.collection(`users/${uid}/sessions/${sessionId}/messages`);
  const historySnap = await msgsRef.orderBy("createdAt", "asc").get();

  const history = [];
  for (const docSnap of historySnap.docs) {
    const data = docSnap.data();
    if (!data.createdAt) continue;
    history.push({
      role: data.role === "model" ? "model" : "user",
      parts: [{ text: data.text }],
    });
  }

  // Remove the last entry — it's the user message we just saved from the frontend
  const chatHistory = history.slice(0, -1);

  // ── Call Gemini ─────────────────────────────────────────────────────────────
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });

  const chat = model.startChat({
    history: chatHistory,
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 0.7,
    },
  });

  try {
    const result = await chat.sendMessage(safeMessage);
    const reply = result.response.text();
    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Gemini error:", err);
    return res.status(500).json({ error: "Failed to get a response from Gemini." });
  }
}
