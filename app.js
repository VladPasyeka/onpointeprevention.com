import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  getDocs,
} from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBmgTapl6qs29Cdr_WlNOKTq_yttO9kqW8",
  authDomain: "on-pointe-prevention.firebaseapp.com",
  projectId: "on-pointe-prevention",
  storageBucket: "on-pointe-prevention.firebasestorage.app",
  messagingSenderId: "235349964683",
  appId: "1:235349964683:web:0b1a3b3e494bd86fc0a18e",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const ROLE = {
  PT: "pt",
  DANCER: "dancer",
};

const START_SCREEN_BY_ROLE = {
  pt: "pt",
  dancer: "check",
};

const ALLOWED_SCREENS_BY_ROLE = {
  pt: ["pt", "avail", "msg", "res"],
  dancer: ["check", "msg", "res"],
};

const COLLECTIONS = {
  USERS: "users",
  CHECKINS: "checkins",
  THREADS: "threads",
  ALERTS: "alerts",
};

const state = {
  user: null,
  role: null,
  activeThreadId: null,
  threads: [],
  dancerDirectory: {},
  isSending: false,
  unsubscribeChat: null,
  unsubscribeAlerts: null,
};

const screens = ["auth", "role", "check", "pt", "avail", "msg", "res"];

const FN_BASE =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:5001/on-pointe-prevention/us-central1"
    : "https://us-central1-on-pointe-prevention.cloudfunctions.net";

function $(id) {
  return document.getElementById(id);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function computeLoad(entry) {
  return Math.round((Number(entry?.minutes) || 0) * (Number(entry?.rpe) || 0));
}

const RED_FLAG_KEYWORD_PATTERNS = [
  /chest\s*pain/i,
  /\bcp\b/i,
  /\bpressure\b/i,
  /\btightness\b/i,
  /\bpalpitations?\b/i,
  /heart\s*racing/i,
  /shortness\s+of\s+breath/i,
  /\bsob\b/i,
  /\bfaint/i,
  /\bsyncope\b/i,
  /\bnumbness\b/i,
  /\btingling\b/i,
  /saddle\s+anesthesia/i,
  /\bbowel\b/i,
  /\bbladder\b/i,
  /severe\s+headache/i,
  /\bvision\b/i,
];

function normalizeNotes(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function notesContainUrgentSymptoms(entry) {
  const notes = normalizeNotes(entry?.notes);
  return RED_FLAG_KEYWORD_PATTERNS.some((pattern) => pattern.test(notes));
}

function computeSeverityFromEntry(entry) {
  if (notesContainUrgentSymptoms(entry)) return "red";

  const riskSeverity = String(entry?.risk?.severity || "").toLowerCase();
  if (["green", "yellow", "orange", "red"].includes(riskSeverity)) return riskSeverity;

  return "green";
}

function getRiskReasonText(entry, severity) {
  const reasons = Array.isArray(entry?.risk?.reasons)
    ? entry.risk.reasons.filter(Boolean).join(", ").trim()
    : "";

  if (reasons) return reasons;
  if (severity === "red") return "Notes mention urgent symptoms";
  return "No active risk flags";
}

function timestampToMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  return 0;
}

function stopListener(unsubscribe) {
  if (typeof unsubscribe === "function") unsubscribe();
  return null;
}

function formatDateTime(ms) {
  return new Date(ms || 0).toLocaleString();
}

function displayNameFor(uid) {
  const entry = state.dancerDirectory?.[uid] || null;
  if (entry?.name) return entry.name;
  if (entry?.email) return entry.email;
  return "Dancer";
}

function setNavVisible(visible) {
  $("tabs").classList.toggle("hidden", !visible);
}

function showScreen(screenId) {
  screens.forEach((id) => $(id).classList.add("hidden"));
  $(screenId).classList.remove("hidden");
  document.body.classList.toggle("auth-mode", screenId === "auth");

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("on", tab.dataset.s === screenId);
  });
}

function canOpenScreen(screenId) {
  return Boolean(state.role && ALLOWED_SCREENS_BY_ROLE[state.role]?.includes(screenId));
}

function applyRoleUi(role) {
  state.role = role;
  setNavVisible(Boolean(role));

  document.querySelectorAll(".tab").forEach((tab) => {
    const roles = tab.dataset.r.split(",");
    tab.classList.toggle("hidden", !roles.includes(role));
  });

  $("aform").classList.toggle("hidden", role !== ROLE.PT);
}

function navigate(screenId) {
  const safeScreen = canOpenScreen(screenId)
    ? screenId
    : START_SCREEN_BY_ROLE[state.role];

  showScreen(safeScreen);

  if (safeScreen === "msg") refreshThreads();
  if (safeScreen === "avail") refreshAvailability();
  if (safeScreen === "check") refreshLoads();
  if (safeScreen === "pt") refreshRoster();
}

async function callFn(path, method = "GET", body = null, queryObject = null) {
  if (!auth.currentUser) throw new Error("Not logged in");

  const token = await auth.currentUser.getIdToken();
  let url = `${FN_BASE}/${path}`;

  if (queryObject) {
    const params = new URLSearchParams();
    Object.entries(queryObject).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    });

    const query = params.toString();
    if (query) {
      url += (url.includes("?") ? "&" : "?") + query;
    }
  }

  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Failed (${response.status})`);
  }
  return data;
}

function resetSignedOutUi() {
  state.user = null;
  state.role = null;
  state.activeThreadId = null;
  state.threads = [];
  state.unsubscribeChat = stopListener(state.unsubscribeChat);
  state.unsubscribeAlerts = stopListener(state.unsubscribeAlerts);

  $("out").classList.add("hidden");
  setNavVisible(false);
  showScreen("auth");
}

async function bootstrapRoleData() {
  if (state.role === ROLE.PT) {
    refreshRoster();
    subscribeAlerts();
  } else {
    state.unsubscribeAlerts = stopListener(state.unsubscribeAlerts);
  }

  refreshAvailability();
  refreshThreads();
  refreshLoads();
}

async function refreshLoads() {
  if (state.role !== ROLE.DANCER || !state.user) return;

  try {
    const snap = await getDocs(
      query(
        collection(db, COLLECTIONS.USERS, state.user.uid, COLLECTIONS.CHECKINS),
        orderBy("date", "desc"),
        limit(7)
      )
    );

    if (snap.empty) {
      $("loads").innerHTML = '<div class="muted">No check-ins yet.</div>';
      return;
    }

    $("loads").innerHTML = snap.docs
      .map((docSnap) => {
        const item = docSnap.data();
        const severity = computeSeverityFromEntry(item);
        const load = item?.risk?.load ?? computeLoad(item);
        const reasons = getRiskReasonText(item, severity);
        const riskLine = severity === "green" ? "No active risk flags" : reasons;

        return `
          <div class="row">
            <div>
              <strong>${escapeHtml(item.date)} &middot; Load ${load}</strong>
              <div class="muted">${escapeHtml(riskLine)}</div>
            </div>
            <div class="sev ${severity}">${severity.toUpperCase()}</div>
          </div>
        `;
      })
      .join("");
  } catch (error) {
    $("loads").innerHTML = `<div class="muted">${escapeHtml(error.message)}</div>`;
  }
}

async function refreshRoster() {
  if (state.role !== ROLE.PT) return;

  $("rmsg").textContent = "";
  $("roster").innerHTML = "";

  try {
    const response = await callFn("getMyDancers");
    const dancers = Array.isArray(response.dancers) ? response.dancers : [];

    if (!dancers.length) {
      $("rmsg").textContent = "No dancers linked yet.";
      return;
    }

    dancers.forEach((dancer) => {
      if (!dancer?.dancerId) return;
      state.dancerDirectory[dancer.dancerId] = {
        name: dancer.name || null,
        email: dancer.email || null,
      };
    });

    $("roster").innerHTML = dancers
      .map((dancer) => {
        const label = displayNameFor(dancer.dancerId);
        const sub = dancer.email || "Linked dancer";

        return `
          <div class="row">
            <div>
              <strong>${escapeHtml(label)}</strong>
              <div class="muted">${escapeHtml(sub)}</div>
            </div>
            <button class="pill" type="button" data-dancer-id="${escapeHtml(dancer.dancerId)}">Open</button>
          </div>
        `;
      })
      .join("");

    $("roster").querySelectorAll("[data-dancer-id]").forEach((button) => {
      button.addEventListener("click", () => openDancerDetail(button.dataset.dancerId));
    });
  } catch (error) {
    $("rmsg").textContent = error.message;
  }
}

async function openDancerDetail(dancerId) {
  const label = displayNameFor(dancerId);
  $("dt").textContent = label;
  $("ds").textContent = `Loading ${label}...`;

  try {
    const response = await callFn("getDancerRecentCheckins", "GET", null, {
      dancerId,
      limit: 14,
    });

    const items = Array.isArray(response.items) ? response.items : [];

    if (!items.length) {
      $("ds").textContent = `No check-ins yet for ${label}.`;
      $("detail").innerHTML = '<div class="muted">No entries.</div>';
      return;
    }

    $("ds").textContent = `Recent check-ins and risk for ${label}.`;

    $("detail").innerHTML = items
      .map((item) => {
        const severity = computeSeverityFromEntry(item);
        const load = item?.risk?.load ?? computeLoad(item);
        const riskReason = getRiskReasonText(item, severity);
        const acwr = item?.risk?.acwr
          ? `ACWR ${Number(item.risk.acwr).toFixed(2)}`
          : "";

        return `
          <div class="row">
            <div>
              <strong>
                ${escapeHtml(item.date)} &middot; ${Number(item.minutes || 0)} min &middot; RPE ${Number(item.rpe || 0)} &middot; Load ${load}
              </strong>
              <div class="muted">${escapeHtml(riskReason)}</div>
              <div class="muted">${escapeHtml((item.notes || "").slice(0, 100))}</div>
              <div class="muted">${acwr}</div>
            </div>
            <div class="sev ${severity}">${severity.toUpperCase()}</div>
          </div>
        `;
      })
      .join("");
  } catch (error) {
    $("ds").textContent = error.message || "Failed";
  }
}

async function refreshAvailability() {
  if (!state.role) return;

  $("amsg").textContent = "";
  $("alist").innerHTML = "";

  try {
    const response =
      state.role === ROLE.PT
        ? await callFn("getMyAvailability")
        : await callFn("getLinkedPtAvailability");

    const slots = Array.isArray(response.slots) ? response.slots : [];

    $("asub").textContent =
      state.role === ROLE.PT ? "Your upcoming slots" : "Your PT's upcoming slots";

    if (!slots.length) {
      $("alist").innerHTML = '<div class="muted">No slots yet.</div>';
      return;
    }

    slots.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

    $("alist").innerHTML = slots
      .map((slot) => `
        <div class="row">
          <div>
            <strong>${escapeHtml(slot.date)} &middot; ${escapeHtml(slot.start)}-${escapeHtml(slot.end)}</strong>
            <div class="muted">${escapeHtml(slot.note || "")}</div>
          </div>
          ${
            state.role === ROLE.PT
              ? `<button class="pill" type="button" data-del-slot-id="${escapeHtml(slot.slotId)}">Delete</button>`
              : ""
          }
        </div>
      `)
      .join("");

    $("alist").querySelectorAll("[data-del-slot-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await callFn("deleteMyAvailability", "POST", {
            slotId: button.dataset.delSlotId,
          });
          refreshAvailability();
        } catch (error) {
          $("amsg").textContent = error.message;
        }
      });
    });
  } catch (error) {
    $("amsg").textContent = error.message;
  }
}

async function refreshThreads() {
  if (!state.user || !state.role) return;

  $("threads").innerHTML = "";
  $("tmsg").textContent = "";

  try {
    const response = await callFn("getMyThreads");
    const threads = Array.isArray(response.threads) ? response.threads : [];

    state.threads = threads;

    if (!threads.length) {
      $("tmsg").textContent =
        state.role === ROLE.DANCER
          ? "No thread yet. Ask your PT for a link code."
          : "No linked dancers yet.";
      closeThread();
      return;
    }

    $("threads").innerHTML = threads
      .map((thread) => {
        const fallbackLabel =
          state.role === ROLE.PT ? displayNameFor(thread.peerUid) : "PT";
        const label =
          thread.peerName && thread.peerName !== thread.peerUid
            ? thread.peerName
            : fallbackLabel;

        return `
          <div class="thread ${state.activeThreadId === thread.threadId ? "on" : ""}" data-thread-id="${escapeHtml(thread.threadId)}">
            <div class="row row-head">
              <strong>${escapeHtml(label)}</strong>
              ${thread.unreadCount ? `<span class="sev orange">${thread.unreadCount} new</span>` : ""}
            </div>
            <div class="muted">${escapeHtml(thread.lastMessageText || "No messages yet")}</div>
            <div class="muted">${escapeHtml(formatDateTime(thread.lastMessageAt))}</div>
          </div>
        `;
      })
      .join("");

    $("threads").querySelectorAll("[data-thread-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const thread = state.threads.find((t) => t.threadId === el.dataset.threadId);
        const fallbackLabel =
          state.role === ROLE.PT ? displayNameFor(thread?.peerUid) : "PT";
        const label =
          thread?.peerName && thread.peerName !== thread.peerUid
            ? thread.peerName
            : fallbackLabel;
        openThread(el.dataset.threadId, label || "Chat");
      });
    });

    if (!state.activeThreadId && threads[0]) {
      const first = threads[0];
      const fallbackLabel =
        state.role === ROLE.PT ? displayNameFor(first.peerUid) : "PT";
      const label =
        first.peerName && first.peerName !== first.peerUid
          ? first.peerName
          : fallbackLabel;
      openThread(first.threadId, label || "Chat");
    }
  } catch (error) {
    $("tmsg").textContent = error.message;
  }
}

function closeThread() {
  state.activeThreadId = null;
  state.unsubscribeChat = stopListener(state.unsubscribeChat);
  $("chatB").classList.add("hidden");
  $("chatE").classList.remove("hidden");
  $("chat").innerHTML = "";
  $("ct").textContent = "Select a conversation";
}

async function openThread(threadId, title) {
  state.activeThreadId = threadId;
  state.unsubscribeChat = stopListener(state.unsubscribeChat);

  $("ct").textContent = title;
  $("chatB").classList.remove("hidden");
  $("chatE").classList.add("hidden");

  document.querySelectorAll(".thread").forEach((threadEl) => {
    threadEl.classList.toggle("on", threadEl.dataset.threadId === threadId);
  });

  const threadQuery = query(
    collection(db, COLLECTIONS.THREADS, threadId, "messages"),
    orderBy("createdAt", "asc"),
    limit(120)
  );

  state.unsubscribeChat = onSnapshot(threadQuery, (snapshot) => {
    $("chat").innerHTML = snapshot.docs
      .map((docSnap) => {
        const message = docSnap.data();
        const mine = message.senderUid === state.user.uid;

        return `
          <div class="bubble ${mine ? "me" : ""}">
            <div>${escapeHtml(message.text || "")}</div>
            <div class="ts">${escapeHtml(formatDateTime(timestampToMillis(message.createdAt)))}</div>
          </div>
        `;
      })
      .join("");

    $("chat").scrollTop = $("chat").scrollHeight;
  });

  try {
    await callFn("markThreadRead", "POST", { threadId });
    refreshThreads();
  } catch (_error) {
    // no-op
  }
}

async function sendMessage() {
  const text = $("txt").value.trim();
  if (!text || !state.activeThreadId || state.isSending) return;

  state.isSending = true;
  $("send").disabled = true;

  try {
    await callFn("sendMessage", "POST", {
      threadId: state.activeThreadId,
      text,
    });

    $("txt").value = "";
    refreshThreads();
  } catch (error) {
    $("tmsg").textContent = error.message;
  } finally {
    state.isSending = false;
    $("send").disabled = false;
  }
}

function subscribeAlerts() {
  state.unsubscribeAlerts = stopListener(state.unsubscribeAlerts);

  const alertsQuery = query(
    collection(db, COLLECTIONS.ALERTS, state.user.uid, "items"),
    orderBy("createdAt", "desc"),
    limit(20)
  );

  state.unsubscribeAlerts = onSnapshot(alertsQuery, (snapshot) => {
    const items = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

    if (!items.length) {
      $("alerts").innerHTML = '<div class="muted">No alerts yet.</div>';
      return;
    }

    $("alerts").innerHTML = items
      .map((alert) => {
        const label = displayNameFor(alert.dancerUid);
        const reviewed = Boolean(alert.reviewed);
        const load = alert.snapshot?.load ?? "--";
        const alertDate = alert.snapshot?.date || alert.id;
        const severity = alert.severity || "orange";

        return `
          <div class="alertRow">
            <div class="alertContent">
              <strong>
                ${escapeHtml(label)} &middot; ${escapeHtml(alertDate)} &middot; Load ${escapeHtml(load)}
              </strong>
              <div class="muted">${escapeHtml((alert.reasons || []).join(", "))}</div>
            </div>
            <div class="alertActions">
              <span class="sev badge ${escapeHtml(severity)}">${escapeHtml(severity.toUpperCase())}</span>
              <button class="pill" type="button" data-view-dancer-id="${escapeHtml(alert.dancerUid)}">View</button>
              <button class="pill" type="button" data-review-alert-id="${escapeHtml(alert.id)}" ${reviewed ? "disabled" : ""}>
                ${reviewed ? "Reviewed" : "Mark reviewed"}
              </button>
            </div>
          </div>
        `;
      })
      .join("");

    $("alerts").querySelectorAll("[data-view-dancer-id]").forEach((button) => {
      button.addEventListener("click", () => {
        navigate("pt");
        openDancerDetail(button.dataset.viewDancerId);
      });
    });

    $("alerts").querySelectorAll("[data-review-alert-id]").forEach((button) => {
      button.addEventListener("click", () =>
        callFn("markAlertReviewed", "POST", {
          alertId: button.dataset.reviewAlertId,
        }).catch(() => {})
      );
    });
  });
}

$("in").addEventListener("click", async () => {
  try {
    $("am").textContent = "";
    await signInWithEmailAndPassword(auth, $("em").value.trim(), $("pw").value);
  } catch (error) {
    $("am").textContent = error.message;
  }
});

$("up").addEventListener("click", async () => {
  try {
    $("am").textContent = "";
    await createUserWithEmailAndPassword(auth, $("em").value.trim(), $("pw").value);
  } catch (error) {
    $("am").textContent = error.message;
  }
});

$("out").addEventListener("click", () => signOut(auth));

$("saveRole").addEventListener("click", async () => {
  try {
    $("rm").textContent = "";
    const role = $("rv").value;

    await setDoc(
      doc(db, COLLECTIONS.USERS, auth.currentUser.uid),
      {
        role,
        name: $("nm").value.trim() || null,
        email: auth.currentUser.email || null,
      },
      { merge: true }
    );

    applyRoleUi(role);
    navigate(START_SCREEN_BY_ROLE[role]);
    bootstrapRoleData();
  } catch (error) {
    $("rm").textContent = error.message;
  }
});

$("saveC").addEventListener("click", async () => {
  try {
    $("cmg").textContent = "";

    const entry = {
      date: $("cd").value || todayIso(),
      minutes: Number($("cm").value) || 0,
      rpe: Number($("cr").value) || 0,
      fatigue: Number($("cf").value) || 0,
      sore: Number($("cs").value) || 0,
      sleep: Number($("csl").value) || 0,
      notes: $("cn").value.trim(),
    };

    await setDoc(
      doc(db, COLLECTIONS.USERS, auth.currentUser.uid, COLLECTIONS.CHECKINS, entry.date),
      entry,
      { merge: true }
    );

    refreshLoads();
  } catch (error) {
    $("cmg").textContent = error.message;
  }
});

$("gen").addEventListener("click", async () => {
  try {
    $("plm").textContent = "";
    const response = await callFn("generatePtCode", "POST", {});
    $("code").textContent = response.code || "--";
  } catch (error) {
    $("plm").textContent = error.message;
  }
});

$("seed").addEventListener("click", async () => {
  try {
    $("plm").textContent = "";
    const response = await callFn("seedDemoData", "POST", {});
    $("plm").textContent = "Seeded demo dancer.";
    refreshRoster();
    refreshThreads();
  } catch (error) {
    $("plm").textContent = error.message;
  }
});

$("rr").addEventListener("click", refreshRoster);

$("addA").addEventListener("click", async () => {
  try {
    $("amsg").textContent = "";

    await callFn("setMyAvailability", "POST", {
      date: $("ad").value || todayIso(),
      start: $("ast").value.trim(),
      end: $("ae").value.trim(),
      note: $("an").value.trim(),
    });

    refreshAvailability();
  } catch (error) {
    $("amsg").textContent = error.message;
  }
});

$("send").addEventListener("click", sendMessage);

$("txt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => navigate(tab.dataset.s));
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    resetSignedOutUi();
    return;
  }

  state.user = user;
  $("out").classList.remove("hidden");
  $("cd").value = todayIso();
  $("ad").value = todayIso();

  let role = null;
  try {
    const userDoc = await getDoc(doc(db, COLLECTIONS.USERS, user.uid));
    role = userDoc.exists() ? userDoc.data().role : null;
  } catch (_error) {
    role = null;
  }

  if (!role) {
    applyRoleUi(null);
    showScreen("role");
    return;
  }

  applyRoleUi(role);
  navigate(START_SCREEN_BY_ROLE[role]);
  bootstrapRoleData();
});
