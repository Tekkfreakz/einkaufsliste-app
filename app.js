const STORAGE_KEY = "shoppingListV2";
const SETTINGS_KEY = "shoppingListSettingsV2";
const LEGACY_KEY = "shoppingList";
const PEER_SCRIPT = "https://cdn.jsdelivr.net/npm/peerjs@1.5.2/dist/peerjs.min.js";

const CATEGORIES = new Set(["Sonstiges", "Obst & Gemüse", "Kühlregal", "Backwaren", "Getränke", "Vorrat", "Haushalt", "Drogerie"]);
const UNITS = new Set(["Stück", "Packung", "kg", "g", "l", "ml"]);
const currency = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const number = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });

const state = {
  items: [],
  filter: "all",
  editingId: null,
  settings: { budget: 0, theme: "system" },
  peer: null,
  connections: [],
  isHost: false,
  shareUrl: "",
  syncing: false,
  revision: Date.now()
};

const el = {};
let toastTimer;
let lastRemoved = null;

document.addEventListener("DOMContentLoaded", init);

function init() {
  cacheElements();
  state.settings = loadSettings();
  state.items = loadItems();
  applyTheme();
  bindEvents();
  render();
  registerServiceWorker();

  const peerId = new URLSearchParams(location.search).get("peer");
  if (peerId && isValidPeerId(peerId)) connectToHost(peerId);
}

function cacheElements() {
  [
    "listSubtitle", "connectionStatus", "connectionLabel", "themeButton", "openShareButton",
    "progressText", "progressPercent", "progressTrack", "progressBar", "cartTotal", "remainingTotal",
    "budgetInput", "budgetHint", "itemForm", "itemName", "quantityInput", "unitInput", "priceInput",
    "categoryInput", "itemDetails", "calculationPreview", "formError", "submitItemButton", "cancelEditButton",
    "itemCount", "itemList", "emptyState", "emptyTitle", "emptyText", "listFooter", "footerSummary",
    "clearCompletedButton", "shareDialog", "shareLoading", "shareReady", "shareError", "shareLink",
    "copyShareButton", "nativeShareButton", "disconnectButton", "confirmDialog", "confirmClearButton",
    "toast", "toastMessage", "toastAction", "itemTemplate"
  ].forEach((id) => { el[id] = document.getElementById(id); });
}

function bindEvents() {
  el.itemForm.addEventListener("submit", handleSubmit);
  el.cancelEditButton.addEventListener("click", resetComposer);
  [el.quantityInput, el.priceInput].forEach((input) => input.addEventListener("input", updateCalculationPreview));
  el.unitInput.addEventListener("change", updateCalculationPreview);
  el.budgetInput.addEventListener("input", updateBudget);
  el.themeButton.addEventListener("click", toggleTheme);
  el.openShareButton.addEventListener("click", openShareDialog);
  el.copyShareButton.addEventListener("click", copyShareLink);
  el.nativeShareButton.addEventListener("click", nativeShare);
  el.disconnectButton.addEventListener("click", disconnectPeers);
  el.clearCompletedButton.addEventListener("click", () => el.confirmDialog.showModal());
  el.confirmClearButton.addEventListener("click", clearCompleted);

  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((candidate) => candidate.setAttribute("aria-pressed", String(candidate === button)));
      renderList();
    });
  });
}

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    return {
      budget: clampNumber(parsed?.budget, 0, 1000000),
      theme: ["light", "dark", "system"].includes(parsed?.theme) ? parsed.theme : "system"
    };
  } catch {
    return { budget: 0, theme: "system" };
  }
}

function loadItems() {
  const current = safeParse(localStorage.getItem(STORAGE_KEY));
  if (Array.isArray(current)) return current.map(normalizeItem).filter(Boolean).slice(0, 1000);

  const legacy = safeParse(localStorage.getItem(LEGACY_KEY));
  if (!Array.isArray(legacy)) return [];
  const migrated = legacy.map((item) => normalizeItem({
    ...item,
    name: item.text,
    unit: "Stück",
    category: "Sonstiges"
  })).filter(Boolean).slice(0, 1000);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
  return migrated;
}

function normalizeItem(value) {
  if (!value || typeof value !== "object") return null;
  const name = String(value.name ?? "").trim().slice(0, 100);
  if (!name) return null;
  return {
    id: /^[a-zA-Z0-9_-]{1,80}$/.test(String(value.id)) ? String(value.id) : makeId(),
    name,
    quantity: clampNumber(value.quantity, 0.01, 100000),
    unit: UNITS.has(value.unit) ? value.unit : "Stück",
    unitPrice: clampNumber(value.unitPrice, 0, 1000000),
    category: CATEGORIES.has(value.category) ? value.category : "Sonstiges",
    completed: Boolean(value.completed),
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now()
  };
}

function safeParse(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function clampNumber(value, min, max) {
  const parsed = typeof value === "string" ? parseDecimal(value) : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min;
}

function parseDecimal(value) {
  const cleaned = String(value ?? "").trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  return Number.parseFloat(cleaned);
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `item_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function saveItems({ broadcast = true } = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items));
  state.revision = Date.now();
  if (broadcast) broadcastItems();
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function handleSubmit(event) {
  event.preventDefault();
  const name = el.itemName.value.trim();
  if (!name) return showFormError("Bitte gib einen Artikelnamen ein.");

  const quantity = parseDecimal(el.quantityInput.value);
  const price = el.priceInput.value.trim() ? parseDecimal(el.priceInput.value) : 0;
  if (!Number.isFinite(quantity) || quantity <= 0) return showFormError("Die Menge muss größer als 0 sein.");
  if (!Number.isFinite(price) || price < 0) return showFormError("Bitte gib einen gültigen Preis ein.");

  const item = normalizeItem({
    id: state.editingId ?? makeId(),
    name,
    quantity,
    unit: el.unitInput.value,
    unitPrice: price,
    category: el.categoryInput.value,
    completed: state.editingId ? state.items.find((candidate) => candidate.id === state.editingId)?.completed : false,
    createdAt: state.editingId ? state.items.find((candidate) => candidate.id === state.editingId)?.createdAt : Date.now()
  });
  if (!item) return showFormError("Der Artikel konnte nicht gespeichert werden.");

  if (state.editingId) {
    state.items = state.items.map((candidate) => candidate.id === state.editingId ? item : candidate);
    showToast("Artikel aktualisiert.");
  } else {
    state.items.push(item);
    showToast("Artikel hinzugefügt.");
  }

  saveItems();
  resetComposer();
  render();
  el.itemName.focus();
}

function showFormError(message) {
  el.formError.textContent = message;
  el.formError.classList.remove("hidden");
  el.itemName.focus();
}

function resetComposer() {
  state.editingId = null;
  el.itemForm.reset();
  el.quantityInput.value = "1";
  el.unitInput.value = "Stück";
  el.categoryInput.value = "Sonstiges";
  el.itemDetails.open = false;
  el.formError.classList.add("hidden");
  el.calculationPreview.textContent = "";
  el.cancelEditButton.classList.add("hidden");
  el.submitItemButton.querySelector("span").textContent = "Hinzufügen";
}

function editItem(id) {
  const item = state.items.find((candidate) => candidate.id === id);
  if (!item) return;
  state.editingId = id;
  el.itemName.value = item.name;
  el.quantityInput.value = String(item.quantity).replace(".", ",");
  el.unitInput.value = item.unit;
  el.priceInput.value = item.unitPrice ? item.unitPrice.toFixed(2).replace(".", ",") : "";
  el.categoryInput.value = item.category;
  el.itemDetails.open = true;
  el.cancelEditButton.classList.remove("hidden");
  el.submitItemButton.querySelector("span").textContent = "Speichern";
  updateCalculationPreview();
  document.querySelector(".composer-card").scrollIntoView({ behavior: "smooth", block: "center" });
  el.itemName.focus();
  el.itemName.select();
}

function toggleItem(id) {
  state.items = state.items.map((item) => item.id === id ? { ...item, completed: !item.completed } : item);
  saveItems();
  render();
}

function removeItem(id) {
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) return;
  lastRemoved = { items: [state.items[index]], index };
  state.items.splice(index, 1);
  saveItems();
  render();
  showToast("Artikel entfernt.", "Rückgängig", restoreRemoved);
}

function clearCompleted() {
  const removed = state.items.filter((item) => item.completed);
  if (!removed.length) return;
  lastRemoved = { items: removed, snapshot: [...state.items] };
  state.items = state.items.filter((item) => !item.completed);
  saveItems();
  render();
  showToast(`${removed.length} erledigte Artikel entfernt.`, "Rückgängig", restoreRemoved);
}

function restoreRemoved() {
  if (!lastRemoved) return;
  state.items = lastRemoved.snapshot ? lastRemoved.snapshot : [
    ...state.items.slice(0, lastRemoved.index),
    ...lastRemoved.items,
    ...state.items.slice(lastRemoved.index)
  ];
  lastRemoved = null;
  saveItems();
  render();
  showToast("Wiederhergestellt.");
}

function updateCalculationPreview() {
  const quantity = parseDecimal(el.quantityInput.value);
  const price = parseDecimal(el.priceInput.value);
  el.calculationPreview.textContent = Number.isFinite(quantity) && Number.isFinite(price) && quantity > 0 && price >= 0
    ? `${number.format(quantity)} ${el.unitInput.value} × ${currency.format(price)} = ${currency.format(quantity * price)}`
    : "";
}

function updateBudget() {
  const budget = el.budgetInput.value.trim() ? parseDecimal(el.budgetInput.value) : 0;
  state.settings.budget = Number.isFinite(budget) && budget >= 0 ? Math.min(budget, 1000000) : 0;
  saveSettings();
  renderSummary();
}

function render() {
  renderSummary();
  renderList();
}

function renderSummary() {
  const total = state.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const completedItems = state.items.filter((item) => item.completed);
  const completed = completedItems.length;
  const cartTotal = completedItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const remaining = total - cartTotal;
  const percent = state.items.length ? Math.round(completed / state.items.length * 100) : 0;

  el.progressText.textContent = state.items.length ? `${completed} von ${state.items.length} erledigt` : "Noch keine Artikel";
  el.progressPercent.textContent = `${percent}%`;
  el.progressTrack.setAttribute("aria-valuenow", String(percent));
  el.progressBar.style.width = `${percent}%`;
  el.cartTotal.textContent = currency.format(cartTotal);
  el.remainingTotal.textContent = currency.format(remaining);
  el.itemCount.textContent = String(state.items.length);
  el.listSubtitle.textContent = state.items.length ? `${state.items.length} Artikel · ${currency.format(total)}` : "Bereit für deinen Einkauf";

  if (document.activeElement !== el.budgetInput) el.budgetInput.value = state.settings.budget ? state.settings.budget.toFixed(2).replace(".", ",") : "";
  el.budgetHint.classList.remove("warning");
  if (!state.settings.budget) {
    el.budgetHint.textContent = "Kein Budget festgelegt";
  } else if (total > state.settings.budget) {
    el.budgetHint.textContent = `${currency.format(total - state.settings.budget)} über Budget`;
    el.budgetHint.classList.add("warning");
  } else {
    el.budgetHint.textContent = `${currency.format(state.settings.budget - total)} verfügbar`;
  }
}

function renderList() {
  const visible = state.items.filter((item) => state.filter === "all" || (state.filter === "done" ? item.completed : !item.completed));
  el.itemList.replaceChildren();

  visible.forEach((item) => {
    const fragment = el.itemTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".item-card");
    const check = fragment.querySelector(".check-button");
    const name = fragment.querySelector(".item-name");
    const meta = fragment.querySelector(".item-meta");
    const price = fragment.querySelector(".item-price");

    card.dataset.id = item.id;
    card.classList.toggle("completed", item.completed);
    check.setAttribute("aria-label", item.completed ? `${item.name} als offen markieren` : `${item.name} als erledigt markieren`);
    check.setAttribute("aria-pressed", String(item.completed));
    check.addEventListener("click", () => toggleItem(item.id));
    name.textContent = item.name;

    meta.append(createTag(`${number.format(item.quantity)} ${item.unit}`));
    if (item.category !== "Sonstiges") meta.append(createTag(item.category, "category-tag"));
    if (item.unitPrice > 0) meta.append(createTag(`${currency.format(item.unitPrice)} je Einheit`));

    const total = item.quantity * item.unitPrice;
    price.textContent = total ? currency.format(total) : "";
    fragment.querySelector(".edit-button").setAttribute("aria-label", `${item.name} bearbeiten`);
    fragment.querySelector(".delete-button").setAttribute("aria-label", `${item.name} löschen`);
    fragment.querySelector(".edit-button").addEventListener("click", () => editItem(item.id));
    fragment.querySelector(".delete-button").addEventListener("click", () => removeItem(item.id));
    el.itemList.append(fragment);
  });

  const isEmpty = visible.length === 0;
  el.itemList.classList.toggle("hidden", isEmpty);
  el.emptyState.classList.toggle("hidden", !isEmpty);
  if (isEmpty && state.items.length) {
    el.emptyTitle.textContent = "Hier ist gerade nichts";
    el.emptyText.textContent = state.filter === "done" ? "Noch kein Artikel ist erledigt." : state.filter === "open" ? "Alles erledigt – stark!" : "Füge oben einen Artikel hinzu.";
  } else {
    el.emptyTitle.textContent = "Deine Liste ist bereit";
    el.emptyText.textContent = "Füge oben deinen ersten Artikel hinzu.";
  }

  const completed = state.items.filter((item) => item.completed).length;
  el.listFooter.classList.toggle("hidden", state.items.length === 0);
  el.footerSummary.textContent = `${state.items.length - completed} offen · ${completed} erledigt`;
  el.clearCompletedButton.classList.toggle("hidden", completed === 0);
}

function createTag(text, extraClass = "") {
  const tag = document.createElement("span");
  tag.className = `meta-tag ${extraClass}`.trim();
  tag.textContent = text;
  return tag;
}

function applyTheme() {
  const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = state.settings.theme === "dark" || (state.settings.theme === "system" && systemDark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]').content = dark ? "#0e1320" : "#f5f6fa";
  el.themeButton.setAttribute("aria-label", dark ? "Helles Design einschalten" : "Dunkles Design einschalten");
}

function toggleTheme() {
  state.settings.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  saveSettings();
  applyTheme();
}

async function openShareDialog() {
  el.shareDialog.showModal();
  el.shareLoading.classList.remove("hidden");
  el.shareReady.classList.add("hidden");
  el.shareError.classList.add("hidden");
  el.disconnectButton.classList.toggle("hidden", !state.peer);
  try {
    await startHost();
    el.shareLink.value = state.shareUrl;
    el.shareLoading.classList.add("hidden");
    el.shareReady.classList.remove("hidden");
    el.nativeShareButton.classList.toggle("hidden", !navigator.share);
    el.disconnectButton.classList.remove("hidden");
  } catch (error) {
    el.shareLoading.classList.add("hidden");
    el.shareError.textContent = "Die Live-Verbindung konnte nicht gestartet werden. Prüfe deine Internetverbindung und versuche es erneut.";
    el.shareError.classList.remove("hidden");
    setConnectionStatus("offline", "Nur auf diesem Gerät");
    console.error("Peer-Verbindung fehlgeschlagen", error);
  }
}

async function ensurePeerLibrary() {
  if (globalThis.Peer) return;
  await new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${PEER_SCRIPT}"]`);
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = PEER_SCRIPT;
    script.crossOrigin = "anonymous";
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
}

async function startHost() {
  if (state.peer?.open && state.shareUrl) return;
  setConnectionStatus("connecting", "Verbindung wird vorbereitet");
  await ensurePeerLibrary();
  state.isHost = true;
  state.peer = await createPeer();
  state.peer.on("connection", (connection) => registerConnection(connection));
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("peer", state.peer.id);
  state.shareUrl = url.toString();
  setConnectionStatus("online", state.connections.length ? `Live mit ${state.connections.length}` : "Bereit zum Teilen");
}

async function connectToHost(peerId) {
  setConnectionStatus("connecting", "Verbindung wird hergestellt");
  try {
    await ensurePeerLibrary();
    state.isHost = false;
    state.peer = await createPeer();
    registerConnection(state.peer.connect(peerId, { reliable: true }));
  } catch (error) {
    console.error("Verbindung zum Host fehlgeschlagen", error);
    setConnectionStatus("offline", "Verbindung fehlgeschlagen");
    showToast("Live-Verbindung fehlgeschlagen.");
  }
}

function createPeer() {
  return new Promise((resolve, reject) => {
    const peer = new globalThis.Peer(undefined, {
      config: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] },
      debug: 0
    });
    const timeout = setTimeout(() => reject(new Error("Peer timeout")), 12000);
    peer.once("open", () => { clearTimeout(timeout); resolve(peer); });
    peer.once("error", (error) => { clearTimeout(timeout); reject(error); });
    peer.on("disconnected", () => setConnectionStatus("connecting", "Verbindung unterbrochen"));
  });
}

function registerConnection(connection) {
  if (!connection) return;
  state.connections.push(connection);
  connection.on("open", () => {
    setConnectionStatus("online", `Live mit ${state.connections.filter((candidate) => candidate.open).length}`);
    if (state.isHost) sendSnapshot(connection);
    else connection.send({ type: "request-sync" });
    showToast("Live-Verbindung hergestellt.");
  });
  connection.on("data", (message) => handlePeerMessage(message, connection));
  connection.on("close", () => {
    state.connections = state.connections.filter((candidate) => candidate !== connection);
    setConnectionStatus(state.peer ? "online" : "offline", state.peer ? (state.isHost ? "Bereit zum Teilen" : "Verbindung getrennt") : "Nur auf diesem Gerät");
  });
  connection.on("error", () => showToast("Fehler in der Live-Verbindung."));
}

function handlePeerMessage(message, source) {
  if (!message || typeof message !== "object") return;
  if (message.type === "request-sync" && state.isHost) return sendSnapshot(source);
  if (message.type !== "snapshot" || !Array.isArray(message.items)) return;

  const incoming = message.items.map(normalizeItem).filter(Boolean).slice(0, 1000);
  if (incoming.length !== message.items.length) return;
  state.items = incoming;
  saveItems({ broadcast: false });
  render();
  if (state.isHost) broadcastItems(source);
}

function sendSnapshot(connection) {
  if (connection?.open) connection.send({ type: "snapshot", version: 2, revision: state.revision, items: state.items });
}

function broadcastItems(exclude = null) {
  state.connections.forEach((connection) => {
    if (connection !== exclude) sendSnapshot(connection);
  });
}

function disconnectPeers() {
  state.connections.forEach((connection) => connection.close());
  state.connections = [];
  state.peer?.destroy();
  state.peer = null;
  state.isHost = false;
  state.shareUrl = "";
  setConnectionStatus("offline", "Nur auf diesem Gerät");
  el.shareDialog.close();
  showToast("Live-Verbindung getrennt.");
}

function isValidPeerId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function setConnectionStatus(status, label) {
  el.connectionStatus.dataset.state = status;
  el.connectionLabel.textContent = label;
}

async function copyShareLink() {
  try {
    await navigator.clipboard.writeText(state.shareUrl);
    showToast("Einladungslink kopiert.");
  } catch {
    el.shareLink.select();
    showToast("Markiere und kopiere den Link.");
  }
}

async function nativeShare() {
  if (!navigator.share || !state.shareUrl) return;
  try {
    await navigator.share({ title: "Gemeinsame Einkaufsliste", text: "Öffne unsere gemeinsame Einkaufsliste:", url: state.shareUrl });
  } catch (error) {
    if (error?.name !== "AbortError") showToast("Der Link konnte nicht gesendet werden.");
  }
}

function showToast(message, actionLabel = "", action = null) {
  clearTimeout(toastTimer);
  el.toastMessage.textContent = message;
  el.toastAction.classList.toggle("hidden", !actionLabel);
  el.toastAction.textContent = actionLabel;
  el.toastAction.onclick = action ? () => { action(); el.toast.classList.add("hidden"); } : null;
  el.toast.classList.remove("hidden");
  toastTimer = setTimeout(() => el.toast.classList.add("hidden"), action ? 6000 : 3000);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Offline-Modus konnte nicht aktiviert werden", error));
  }
}
