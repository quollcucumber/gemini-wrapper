const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { getFirestore } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase-admin/app");
const { GoogleGenerativeAI } = require("@google/generative-ai");

initializeApp();

const geminiApiKey = defineSecret("GEMINI_API_KEY");

// Rate limit: max requests per user per day
const DAILY_LIMIT = 100;

exports.chat = onCall(
  { secrets: [geminiApiKey], region: "us-central1" },
  async (request) => {
    // ── Auth check ──────────────────────────────────────────────────────────
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in to use this.");
    }

    const uid = request.auth.uid;
    const { sessionId, message } = request.data;

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      throw new HttpsError("invalid-argument", "Message must be a non-empty string.");
    }

    if (!sessionId || typeof sessionId !== "string") {
      throw new HttpsError("invalid-argument", "sessionId is required.");
    }

    // Sanitize: cap message length
    const safeMessage = message.trim().slice(0, 4000);

    const db = getFirestore();

    // ── Rate limiting ───────────────────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const rateRef = db.doc(`users/${uid}/rateLimit/${today}`);

    const rateSnap = await rateRef.get();
    const count = rateSnap.exists ? (rateSnap.data().count || 0) : 0;

    if (count >= DAILY_LIMIT) {
      throw new HttpsError("resource-exhausted", `Daily limit of ${DAILY_LIMIT} messages reached.`);
    }

    // Increment counter (create if first message today)
    await rateRef.set({ count: count + 1 }, { merge: true });

    // ── Load chat history from Firestore ────────────────────────────────────
    const msgsRef = db.collection(`users/${uid}/sessions/${sessionId}/messages`);
    const historySnap = await msgsRef.orderBy("createdAt", "asc").get();

    // Build Gemini history (exclude the latest user message — sent separately)
    const history = [];
    const docs = historySnap.docs;

    for (const docSnap of docs) {
      const data = docSnap.data();
      // Only include messages that have a createdAt (skip pending ones)
      if (!data.createdAt) continue;
      history.push({
        role: data.role === "model" ? "model" : "user",
        parts: [{ text: data.text }]
      });
    }

    // ── Call Gemini ─────────────────────────────────────────────────────────
    const genAI = new GoogleGenerativeAI(geminiApiKey.value());
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // Start chat with history (minus the current message which is already saved)
    // Remove the last entry if it's the user message we just saved
    const chatHistory = history.slice(0, -1);

    const chat = model.startChat({
      history: chatHistory,
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.7,
      },
    });

    let reply;
    try {
      const result = await chat.sendMessage(safeMessage);
      reply = result.response.text();
    } catch (err) {
      console.error("Gemini API error:", err);
      throw new HttpsError("internal", "Failed to get a response from Gemini.");
    }

    return { reply };
  }
);
