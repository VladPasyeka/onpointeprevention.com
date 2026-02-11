/**
 * OnPointe Prevention - Cloud Functions (Gen 2)
 *
 * MVP scope:
 * - PT code generation + dancer linking
 * - PT portal roster + dancer detail/check-ins
 * - PT availability CRUD + dancer read linked PT availability
 * - PT<->dancer messaging (threads + messages)
 * - Automated risk flags + PT alerts
 */

const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const COL = {
  USERS: "users",
  PT_CODES: "ptCodes",
  PT_LINKS: "ptLinks",
  PT_AVAILABILITY: "ptAvailability",
  THREADS: "threads",
  ALERTS: "alerts",
};

const ROLE = {
  PT: "pt",
  DANCER: "dancer",
};

async function requireAuth(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer (.+)$/);
  if (!m) throw new Error("Missing Authorization Bearer token");
  return admin.auth().verifyIdToken(m[1]);
}

function withCors(req, res) {
  const originHeader = req.headers.origin;
  const origin = originHeader === "null" ? "null" : originHeader || "*";

  const reqHeaders = req.headers["access-control-request-headers"];
  const reqMethod = req.headers["access-control-request-method"];

  const baseHeaders = ["Content-Type", "Authorization"];
  const requested = reqHeaders
    ? String(reqHeaders)
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean)
    : [];
  const allowHeaders = Array.from(new Set([...requested, ...baseHeaders])).join(", ");

  res.set("Access-Control-Allow-Origin", origin);
  res.set("Access-Control-Allow-Headers", allowHeaders);
  res.set(
    "Access-Control-Allow-Methods",
    reqMethod ? String(reqMethod) : "GET, POST, OPTIONS"
  );
  res.set("Access-Control-Max-Age", "3600");
  res.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

function makeCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function threadIdFor(ptUid, dancerUid) {
  return `${ptUid}__${dancerUid}`;
}

function parseISODate(iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function addDays(d, days) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function safeNum(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function computeLoad(entry) {
  return Math.round(safeNum(entry?.minutes, 0) * safeNum(entry?.rpe, 0));
}

function containsAny(text, keywords) {
  const hay = String(text || "").toLowerCase();
  return keywords.some((k) => hay.includes(k));
}

function tsToMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.seconds === "number") return v.seconds * 1000;
  return 0;
}

async function getUser(uid) {
  const snap = await db.doc(`${COL.USERS}/${uid}`).get();
  if (!snap.exists) return null;
  return { uid, ...(snap.data() || {}) };
}

async function getUserRole(uid) {
  const user = await getUser(uid);
  return user?.role || null;
}

async function getLinkedPtId(dancerId) {
  const user = await getUser(dancerId);
  return user?.linkedPtId || null;
}

async function isLinkedPt(ptId, dancerId) {
  const snap = await db.doc(`${COL.PT_LINKS}/${ptId}/dancers/${dancerId}`).get();
  return snap.exists;
}

async function fetchRecentCheckins(uid, entryDateISO) {
  const entryDate = parseISODate(entryDateISO) || new Date();
  const start = toISO(addDays(entryDate, -27));
  const end = toISO(entryDate);

  const snap = await db
    .collection(`${COL.USERS}/${uid}/checkins`)
    .where("date", ">=", start)
    .where("date", "<=", end)
    .get();

  return snap.docs.map((docSnap) => docSnap.data());
}

function computeAcwr(history, entryDateISO) {
  const entryDate = parseISODate(entryDateISO) || new Date();
  const start7 = toISO(addDays(entryDate, -6));
  const start28 = toISO(addDays(entryDate, -27));
  const end = toISO(entryDate);

  const inRange = (arr, start) =>
    arr.filter((e) => String(e.date) >= start && String(e.date) <= end);

  const last7 = inRange(history, start7);
  const last28 = inRange(history, start28);

  const total7 = last7.reduce((sum, e) => sum + computeLoad(e), 0);
  const total28 = last28.reduce((sum, e) => sum + computeLoad(e), 0);

  const acute = total7 / 7;
  const chronic = total28 / 28;
  const acwr = chronic >= 10 ? acute / chronic : null;

  return { acute, chronic, acwr };
}

function evaluateFlags(entry, history) {
  const reasons = [];
  const notes = String(entry?.notes || "");
  const lcNotes = notes.toLowerCase();
  const fatigue = safeNum(entry?.fatigue, 0);
  const sore = safeNum(entry?.sore, 0);
  const pain = safeNum(entry?.pain || entry?.painScore || entry?.painIntensity, 0);
  const load = computeLoad(entry);

  const entryDate = entry?.date || toISO(new Date());
  const metrics = computeAcwr(history, entryDate);
  const acwr = metrics.acwr;

  const severeKeywords = [
    "chest pain",
    "faint",
    "fainted",
    "shortness of breath",
    "sob",
    "numbness",
    "weakness",
    "severe headache",
    "fracture",
    "broken",
  ];
  const orangeKeywords = [
    "sharp pain",
    "swelling",
    "tingling",
    "can't bear weight",
    "cannot bear weight",
  ];

  let severity = "green";

  if (containsAny(lcNotes, severeKeywords)) {
    severity = "red";
    reasons.push("Notes mention urgent symptoms");
  }
  if (pain >= 9) {
    severity = "red";
    reasons.push("Severe pain reported");
  }
  if (acwr !== null && acwr >= 1.8 && fatigue >= 8 && sore >= 8) {
    severity = "red";
    reasons.push("Extreme load spike with high fatigue/soreness");
  }

  if (severity !== "red") {
    if (
      (acwr !== null && acwr >= 1.5) ||
      (load > metrics.chronic * 1.5 && (fatigue >= 7 || sore >= 7))
    ) {
      severity = "orange";
      reasons.push("Large load spike");
    }
    if (containsAny(lcNotes, orangeKeywords)) {
      severity = "orange";
      reasons.push("Notes mention concerning symptoms");
    }
  }

  if (severity === "green") {
    if (acwr !== null && acwr >= 1.3) {
      severity = acwr >= 1.5 ? "orange" : "yellow";
      reasons.push(`ACWR ${acwr.toFixed(2)}`);
    }
    if (fatigue >= 7 || sore >= 7) {
      severity = "yellow";
      reasons.push("High fatigue or soreness");
    }
  }

  const score =
    severity === "red" ? 3 : severity === "orange" ? 2 : severity === "yellow" ? 1 : 0;

  return { severity, score, reasons, acwr, load };
}

async function ensureLinkedPairAndThread(uid, otherUid) {
  const role = await getUserRole(uid);
  if (!role) throw new Error("User role not set.");

  let ptUid = null;
  let dancerUid = null;

  if (role === ROLE.PT) {
    if (!(await isLinkedPt(uid, otherUid))) throw new Error("Not linked to that dancer.");
    ptUid = uid;
    dancerUid = otherUid;
  } else {
    const linkedPt = await getLinkedPtId(uid);
    if (!linkedPt || linkedPt !== otherUid) throw new Error("Not linked to that PT.");
    ptUid = otherUid;
    dancerUid = uid;
  }

  const tid = threadIdFor(ptUid, dancerUid);
  const threadRef = db.doc(`${COL.THREADS}/${tid}`);
  await threadRef.set(
    {
      participants: [ptUid, dancerUid],
      ptUid,
      dancerUid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return { role, ptUid, dancerUid, threadId: tid };
}

exports.generatePtCode = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const uid = token.uid;
    const role = await getUserRole(uid);
    if (role !== ROLE.PT) throw new Error("Only PT users can generate codes.");

    const existing = await db.collection(COL.PT_CODES).where("ptUid", "==", uid).get();
    const batch = db.batch();
    existing.forEach((d) => batch.delete(d.ref));

    const code = makeCode(6);
    batch.set(db.doc(`${COL.PT_CODES}/${code}`), {
      ptUid: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(addDays(new Date(), 2)),
    });

    await batch.commit();
    res.json({ code });
  } catch (e) {
    res.status(400).json({ error: e.message || "Failed" });
  }
});

exports.linkWithPtCode = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const dancerUid = token.uid;

    const role = await getUserRole(dancerUid);
    if (role !== ROLE.DANCER) throw new Error("Only dancer users can link to a PT.");

    const code = String(req.query.code || req.body?.code || "").trim().toUpperCase();
    if (!code) throw new Error("Missing code");

    const codeRef = db.doc(`${COL.PT_CODES}/${code}`);
    const codeSnap = await codeRef.get();
    if (!codeSnap.exists) throw new Error("Invalid code");

    const codeData = codeSnap.data() || {};
    const expiresAt = codeData.expiresAt?.toDate?.() || null;
    if (expiresAt && expiresAt.getTime() < Date.now()) throw new Error("Code expired");

    const ptUid = codeData.ptUid;
    if (!ptUid) throw new Error("Invalid code");

    const threadId = threadIdFor(ptUid, dancerUid);

    const batch = db.batch();
    batch.set(
      db.doc(`${COL.USERS}/${dancerUid}`),
      { linkedPtId: ptUid, linkedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    batch.set(
      db.doc(`${COL.PT_LINKS}/${ptUid}/dancers/${dancerUid}`),
      { dancerUid, createdAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    batch.set(
      db.doc(`${COL.THREADS}/${threadId}`),
      {
        participants: [ptUid, dancerUid],
        ptUid,
        dancerUid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
        lastMessageText: "Linked in OnPointe.",
      },
      { merge: true }
    );

    await batch.commit();
    res.json({ ok: true, ptUid, threadId });
  } catch (e) {
    res.status(400).json({ error: e.message || "Failed" });
  }
});

exports.getMyPt = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const dancerUid = token.uid;

    const ptUid = await getLinkedPtId(dancerUid);
    if (!ptUid) return res.json({ pt: null });

    const pt = await getUser(ptUid);
    if (!pt) return res.json({ pt: { uid: ptUid } });

    res.json({
      pt: {
        uid: ptUid,
        name: pt.name || null,
        email: pt.email || null,
      },
    });
  } catch (e) {
    res.status(400).json({ error: e.message || "Failed" });
  }
});

exports.unlinkFromPt = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const dancerUid = token.uid;

    const ptUid = await getLinkedPtId(dancerUid);
    if (!ptUid) return res.json({ ok: true });

    const batch = db.batch();
    batch.set(
      db.doc(`${COL.USERS}/${dancerUid}`),
      { linkedPtId: admin.firestore.FieldValue.delete() },
      { merge: true }
    );
    batch.delete(db.doc(`${COL.PT_LINKS}/${ptUid}/dancers/${dancerUid}`));
    await batch.commit();

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || "Failed" });
  }
});

exports.getMyDancers = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const ptUid = token.uid;
    const role = await getUserRole(ptUid);
    if (role !== ROLE.PT) throw new Error("Only PT users can view roster.");

    const snap = await db.collection(`${COL.PT_LINKS}/${ptUid}/dancers`).get();
    const ids = snap.docs.map((docSnap) => docSnap.id);
    const users = await Promise.all(ids.map((id) => getUser(id)));

    const dancers = ids.map((dancerId, idx) => {
      const ud = users[idx] || {};
      return {
        dancerId,
        name: ud.name || null,
        email: ud.email || null,
        createdAt: snap.docs[idx].data()?.createdAt || null,
      };
    });

    res.json({ dancers });
  } catch (e) {
    res.status(400).json({ error: e.message || "Failed" });
  }
});

exports.getDancerRecentCheckins = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const ptUid = token.uid;

    const role = await getUserRole(ptUid);
    if (role !== ROLE.PT) throw new Error("Only PT users can read dancer check-ins.");

    const dancerId = String(req.query.dancerId || "").trim();
    if (!dancerId) throw new Error("Missing dancerId");
    if (!(await isLinkedPt(ptUid, dancerId))) throw new Error("Not linked to this dancer.");

    const lim = Math.min(30, Math.max(1, Number(req.query.limit || 14)));
    const snap = await db
      .collection(`${COL.USERS}/${dancerId}/checkins`)
      .orderBy("date", "desc")
      .limit(lim)
      .get();

    const items = snap.docs.map((d) => d.data());
    res.json({ items });
  } catch (e) {
    res.status(400).json({ error: e.message || "Failed" });
  }
});

exports.setMyAvailability = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const ptUid = token.uid;
    const role = await getUserRole(ptUid);
    if (role !== ROLE.PT) throw new Error("Only PT users can set availability.");

    const { date, start, end, note } = req.body || {};
    const d = String(date || "").trim();
    const s = String(start || "").trim();
    const e = String(end || "").trim();
    if (!d || !s || !e) throw new Error("Missing date/start/end");

    const slotId = `${ptUid}__${d}__${s}-${e}`;
    await db.doc(`${COL.PT_AVAILABILITY}/${slotId}`).set(
      {
        slotId,
        ptUid,
        date: d,
        start: s,
        end: e,
        note: note ? String(note).slice(0, 80) : "",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    res.json({ ok: true, slotId });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed" });
  }
});

exports.getMyAvailability = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const ptUid = token.uid;
    const role = await getUserRole(ptUid);
    if (role !== ROLE.PT) throw new Error("Only PT users can read availability.");

    const start = String(req.query.start || toISO(new Date()));
    const end = String(req.query.end || toISO(addDays(new Date(), 14)));

    const snap = await db
      .collection(COL.PT_AVAILABILITY)
      .orderBy(admin.firestore.FieldPath.documentId())
      .startAt(`${ptUid}__${start}`)
      .endAt(`${ptUid}__${end}~`)
      .get();

    const slots = snap.docs.map((d) => d.data());
    res.json({ slots });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed" });
  }
});

exports.deleteMyAvailability = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const ptUid = token.uid;
    const role = await getUserRole(ptUid);
    if (role !== ROLE.PT) throw new Error("Only PT users can delete availability.");

    const slotId = String(req.query.slotId || req.body?.slotId || "").trim();
    if (!slotId) throw new Error("Missing slotId");

    const ref = db.doc(`${COL.PT_AVAILABILITY}/${slotId}`);
    const snap = await ref.get();
    if (!snap.exists) return res.json({ ok: true });

    const data = snap.data() || {};
    if (data.ptUid !== ptUid) throw new Error("Not your slot");

    await ref.delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed" });
  }
});

exports.getLinkedPtAvailability = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const dancerUid = token.uid;

    const ptUid = await getLinkedPtId(dancerUid);
    if (!ptUid) return res.json({ slots: [] });

    const start = String(req.query.start || toISO(new Date()));
    const end = String(req.query.end || toISO(addDays(new Date(), 14)));

    const snap = await db
      .collection(COL.PT_AVAILABILITY)
      .orderBy(admin.firestore.FieldPath.documentId())
      .startAt(`${ptUid}__${start}`)
      .endAt(`${ptUid}__${end}~`)
      .get();

    const slots = snap.docs.map((d) => d.data());
    res.json({ slots });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed" });
  }
});

exports.ensureThread = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const uid = token.uid;
    const otherUid = String(req.query.otherUid || req.body?.otherUid || "").trim();
    if (!otherUid) throw new Error("Missing otherUid");

    const result = await ensureLinkedPairAndThread(uid, otherUid);
    res.json({ threadId: result.threadId });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed" });
  }
});

exports.getMyThreads = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const uid = token.uid;
    const role = await getUserRole(uid);
    if (!role) throw new Error("Role not set.");

    let pairs = [];
    if (role === ROLE.PT) {
      const rosterSnap = await db.collection(`${COL.PT_LINKS}/${uid}/dancers`).get();
      pairs = rosterSnap.docs.map((d) => ({ ptUid: uid, dancerUid: d.id }));
    } else {
      const linkedPtId = await getLinkedPtId(uid);
      pairs = linkedPtId ? [{ ptUid: linkedPtId, dancerUid: uid }] : [];
    }

    const threads = await Promise.all(
      pairs.map(async (pair) => {
        const threadId = threadIdFor(pair.ptUid, pair.dancerUid);
        const threadRef = db.doc(`${COL.THREADS}/${threadId}`);
        const threadSnap = await threadRef.get();
        const peerUid = role === ROLE.PT ? pair.dancerUid : pair.ptUid;
        const peer = await getUser(peerUid);

        if (!threadSnap.exists) {
          await threadRef.set(
            {
              participants: [pair.ptUid, pair.dancerUid],
              ptUid: pair.ptUid,
              dancerUid: pair.dancerUid,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        const data = threadSnap.exists ? threadSnap.data() || {} : {};
        const msgSnap = await threadRef
          .collection("messages")
          .orderBy("createdAt", "desc")
          .limit(40)
          .get();

        let unreadCount = 0;
        msgSnap.forEach((docSnap) => {
          const msg = docSnap.data() || {};
          if (msg.senderUid !== uid && !msg.readBy?.[uid]) unreadCount += 1;
        });

        return {
          threadId,
          peerUid,
          peerName: peer?.name || peer?.email || peerUid,
          peerEmail: peer?.email || null,
          lastMessageText: data.lastMessageText || null,
          lastMessageAt: tsToMillis(data.lastMessageAt),
          unreadCount,
        };
      })
    );

    threads.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    res.json({ threads });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed" });
  }
});

exports.sendMessage = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const uid = token.uid;

    const { threadId, text } = req.body || {};
    const tid = String(threadId || "").trim();
    const msg = String(text || "").trim();
    if (!tid || !msg) throw new Error("Missing threadId/text");
    if (msg.length > 600) throw new Error("Message too long");

    const threadRef = db.doc(`${COL.THREADS}/${tid}`);
    const threadSnap = await threadRef.get();
    if (!threadSnap.exists) throw new Error("Thread not found");
    const t = threadSnap.data() || {};
    if (!Array.isArray(t.participants) || !t.participants.includes(uid)) throw new Error("Not a participant");

    const msgRef = threadRef.collection("messages").doc();
    await msgRef.set({
      senderUid: uid,
      text: msg,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      readBy: { [uid]: true },
    });

    await threadRef.set(
      {
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
        lastMessageText: msg.slice(0, 80),
        lastMessageSenderUid: uid,
      },
      { merge: true }
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed" });
  }
});

exports.markThreadRead = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const uid = token.uid;

    const tid = String(req.query.threadId || req.body?.threadId || "").trim();
    if (!tid) throw new Error("Missing threadId");

    const threadRef = db.doc(`${COL.THREADS}/${tid}`);
    const threadSnap = await threadRef.get();
    if (!threadSnap.exists) return res.json({ ok: true });

    const t = threadSnap.data() || {};
    if (!Array.isArray(t.participants) || !t.participants.includes(uid)) throw new Error("Not a participant");

    const snap = await threadRef.collection("messages").orderBy("createdAt", "desc").limit(60).get();
    const batch = db.batch();
    snap.forEach((d) => {
      batch.set(d.ref, { readBy: { [uid]: true } }, { merge: true });
    });
    await batch.commit();

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed" });
  }
});

exports.markAlertReviewed = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const ptUid = token.uid;
    const role = await getUserRole(ptUid);
    if (role !== ROLE.PT) throw new Error("Only PT users can review alerts.");

    const alertId = String(req.query.alertId || req.body?.alertId || "").trim();
    if (!alertId) throw new Error("Missing alertId");

    await db.doc(`${COL.ALERTS}/${ptUid}/items/${alertId}`).set(
      {
        reviewed: true,
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed" });
  }
});

exports.seedDemoData = onRequest(async (req, res) => {
  if (withCors(req, res)) return;
  try {
    const token = await requireAuth(req);
    const ptUid = token.uid;
    const role = await getUserRole(ptUid);
    if (role !== ROLE.PT) throw new Error("Only PT users can seed demo data.");

    const demoDancerId = `demo-dancer-${ptUid.slice(0, 6)}`;
    const threadId = threadIdFor(ptUid, demoDancerId);

    const batch = db.batch();
    batch.set(
      db.doc(`${COL.USERS}/${demoDancerId}`),
      {
        role: ROLE.DANCER,
        name: "Demo Dancer",
        email: "demo-dancer@onpointe.local",
        linkedPtId: ptUid,
      },
      { merge: true }
    );
    batch.set(
      db.doc(`${COL.PT_LINKS}/${ptUid}/dancers/${demoDancerId}`),
      { dancerUid: demoDancerId, createdAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    batch.set(
      db.doc(`${COL.THREADS}/${threadId}`),
      {
        participants: [ptUid, demoDancerId],
        ptUid,
        dancerUid: demoDancerId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
        lastMessageText: "Welcome to OnPointe.",
      },
      { merge: true }
    );

    batch.set(
      db.doc(`${COL.USERS}/${demoDancerId}/checkins/${toISO(new Date())}`),
      {
        date: toISO(new Date()),
        minutes: 90,
        rpe: 7,
        fatigue: 6,
        sore: 5,
        sleep: 7.5,
        notes: "Slight tightness after rehearsal.",
      },
      { merge: true }
    );

    await batch.commit();

    const msgRef = db.collection(`${COL.THREADS}/${threadId}/messages`);
    await msgRef.add({
      senderUid: demoDancerId,
      text: "Hi! I just logged my check-in.",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      readBy: { [demoDancerId]: true },
    });
    await msgRef.add({
      senderUid: ptUid,
      text: "Great. Keep today low intensity and prioritize sleep.",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      readBy: { [ptUid]: true },
    });

    res.json({ ok: true, demoDancerId, threadId });
  } catch (err) {
    res.status(400).json({ error: err.message || "Failed" });
  }
});

exports.onCheckinWrite = onDocumentWritten(
  {
    document: `${COL.USERS}/{uid}/checkins/{checkinId}`,
    region: "us-central1",
  },
  async (event) => {
    const change = event.data;
    if (!change?.after?.exists) return null;

    const entry = change.after.data() || {};
    const uid = event.params.uid;
    const entryId = event.params.checkinId;

    const history = await fetchRecentCheckins(uid, entry?.date || entryId);
    const combined = history.filter((e) => e?.date !== entry?.date).concat([entry]);
    const result = evaluateFlags(entry, combined);

    await change.after.ref.set(
      {
        risk: {
          severity: result.severity,
          reasons: result.reasons,
          score: result.score,
          acwr: result.acwr || null,
          load: result.load,
        },
      },
      { merge: true }
    );

    const ptId = await getLinkedPtId(uid);
    if (!ptId || result.severity === "green") return null;

    const alertRef = db.doc(`${COL.ALERTS}/${ptId}/items/${entryId}`);
    const alertSnap = await alertRef.get();
    const existing = alertSnap.exists ? alertSnap.data() || {} : {};

    const snapshot = {
      date: entry?.date || null,
      minutes: entry?.minutes ?? null,
      rpe: entry?.rpe ?? null,
      load: result.load,
      fatigue: entry?.fatigue ?? null,
      sore: entry?.sore ?? null,
      sleep: entry?.sleep ?? null,
      notes: entry?.notes || "",
      acwr: result.acwr || null,
    };

    await alertRef.set(
      {
        dancerUid: uid,
        entryId,
        createdAt: existing.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        severity: result.severity,
        reasons: result.reasons,
        snapshot,
        reviewed: existing.reviewed || false,
        reviewedAt: existing.reviewedAt || null,
      },
      { merge: true }
    );

    return null;
  }
);
