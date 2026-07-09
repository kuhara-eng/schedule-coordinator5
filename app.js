const STORAGE_KEY = "schedule-coordinator-v2";
const LEGACY_STORAGE_KEY = "schedule-coordinator-v1";
const START_HOUR = 9;
const END_HOUR = 18;
const SLOT_MINUTES = 30;

const times = buildTimes();
let appState = loadAppState();
let state = getActiveMeeting();
let selectedParticipantId = state.participants[0]?.id || null;
let activeView = "input";
let ignoreNextRealtime = false;
let dragState = null;
let cloud = {
  client: null,
  shareId: getShareIdFromUrl(),
  accessToken: getAccessTokenFromUrl(),
  channel: null,
  applyingRemote: false,
  saveTimer: null,
  configured: false,
};

const els = {
  meetingTabs: document.querySelector("#meetingTabs"),
  addMeetingBtn: document.querySelector("#addMeetingBtn"),
  cloudStatus: document.querySelector("#cloudStatus"),
  createShareBtn: document.querySelector("#createShareBtn"),
  copyShareBtn: document.querySelector("#copyShareBtn"),
  meetingTitle: document.querySelector("#meetingTitle"),
  dateInput: document.querySelector("#dateInput"),
  rangeStartInput: document.querySelector("#rangeStartInput"),
  rangeEndInput: document.querySelector("#rangeEndInput"),
  excludeWeekends: document.querySelector("#excludeWeekends"),
  addDateBtn: document.querySelector("#addDateBtn"),
  addDateRangeBtn: document.querySelector("#addDateRangeBtn"),
  dateCount: document.querySelector("#dateCount"),
  resetBtn: document.querySelector("#resetBtn"),
  participantForm: document.querySelector("#participantForm"),
  participantName: document.querySelector("#participantName"),
  participantList: document.querySelector("#participantList"),
  participantCount: document.querySelector("#participantCount"),
  availabilityGrid: document.querySelector("#availabilityGrid"),
  summaryGrid: document.querySelector("#summaryGrid"),
  bestSlots: document.querySelector("#bestSlots"),
  inputView: document.querySelector("#inputView"),
  summaryView: document.querySelector("#summaryView"),
  emptyState: document.querySelector("#emptyState"),
  inputTab: document.querySelector("#inputTab"),
  summaryTab: document.querySelector("#summaryTab"),
  currentParticipantTitle: document.querySelector("#currentParticipantTitle"),
  fillAvailableBtn: document.querySelector("#fillAvailableBtn"),
  exportJsonBtn: document.querySelector("#exportJsonBtn"),
  exportCsvBtn: document.querySelector("#exportCsvBtn"),
  importJsonInput: document.querySelector("#importJsonInput"),
};

init();

async function init() {
  setDefaultDate();
  syncActiveMeeting();
  bindEvents();
  render();
  await initCloudSync();
}

function bindEvents() {
  els.createShareBtn.addEventListener("click", createShareLink);
  els.copyShareBtn.addEventListener("click", copyShareLink);

  els.addMeetingBtn.addEventListener("click", () => {
    const meeting = createMeeting("新しい打ち合わせ");
    appState.meetings.push(meeting);
    appState.activeMeetingId = meeting.id;
    selectedParticipantId = null;
    activeView = "input";
    syncActiveMeeting();
    persist();
    render();
    els.meetingTitle.focus();
    els.meetingTitle.select();
  });

  els.meetingTitle.addEventListener("input", () => {
    state.title = els.meetingTitle.value;
    persist();
    renderMeetingTabs();
  });

  els.addDateBtn.addEventListener("click", () => addDates([els.dateInput.value]));
  els.addDateRangeBtn.addEventListener("click", () => {
    const dates = buildDateRange(els.rangeStartInput.value, els.rangeEndInput.value, els.excludeWeekends.checked);
    addDates(dates);
  });

  els.resetBtn.addEventListener("click", () => {
    if (!confirm("この打ち合わせの入力内容をすべて消去しますか？")) return;
    const replacement = createMeeting(state.title || "新しい打ち合わせ");
    replacement.id = state.id;
    const index = appState.meetings.findIndex((meeting) => meeting.id === state.id);
    appState.meetings[index] = replacement;
    syncActiveMeeting();
    selectedParticipantId = null;
    persist();
    render();
  });

  els.participantForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = els.participantName.value.trim();
    if (!name) return;
    const participant = { id: crypto.randomUUID(), name };
    state.participants.push(participant);
    state.availability[participant.id] = {};
    selectedParticipantId = participant.id;
    els.participantName.value = "";
    ensureAvailabilityShape();
    persist();
    render();
  });

  els.inputTab.addEventListener("click", () => switchView("input"));
  els.summaryTab.addEventListener("click", () => switchView("summary"));

  els.fillAvailableBtn.addEventListener("click", () => {
    if (!selectedParticipantId) return;
    state.dates.forEach((date) => {
      times.forEach((time) => setAvailability(selectedParticipantId, date, time, true));
    });
    persist();
    renderInputGrid();
    renderSummary();
  });

  document.addEventListener("pointerup", finishDragFill);
  document.addEventListener("pointercancel", finishDragFill);

  els.exportJsonBtn.addEventListener("click", exportJson);
  els.exportCsvBtn.addEventListener("click", exportCsv);
  els.importJsonInput.addEventListener("change", importJson);
}

function switchView(view) {
  activeView = view;
  els.inputTab.classList.toggle("active", view === "input");
  els.summaryTab.classList.toggle("active", view === "summary");
  els.inputView.classList.toggle("hidden", view !== "input");
  els.summaryView.classList.toggle("hidden", view !== "summary");
}

function render() {
  syncActiveMeeting();
  ensureAvailabilityShape();
  els.meetingTitle.value = state.title;
  renderCloudStatus();
  renderMeetingTabs();
  renderDateCount();
  renderParticipants();
  renderInputGrid();
  renderSummary();
  renderEmptyState();
}

function renderCloudStatus(message) {
  const configMessage = cloud.configured ? "Supabase設定済み" : "Supabase未設定";
  if (message) {
    els.cloudStatus.textContent = message;
  } else if (isShareUrlComplete()) {
    els.cloudStatus.textContent = `リアルタイム共有中: ${cloud.shareId}`;
  } else if (cloud.shareId || cloud.accessToken) {
    els.cloudStatus.textContent = `${configMessage}。共有URLにboardとtokenの両方が必要です。`;
  } else {
    els.cloudStatus.textContent = `${configMessage}。現在はローカル保存です。`;
  }
  els.createShareBtn.disabled = !cloud.configured;
  els.copyShareBtn.disabled = !cloud.configured || !isShareUrlComplete();
}

async function initCloudSync() {
  const config = window.SCHEDULE_SUPABASE_CONFIG || {};
  cloud.configured = Boolean(config.url && config.anonKey && window.supabase?.createClient);
  renderCloudStatus();
  if (!cloud.configured || !isShareUrlComplete()) return;

  cloud.client = window.supabase.createClient(config.url, config.anonKey);
  await loadSharedBoard();
  subscribeSharedBoard();
}

async function createShareLink() {
  if (!cloud.configured) {
    alert("config.js にSupabaseのURLとanon keyを設定してください。");
    return;
  }
  if (!cloud.client) {
    const config = window.SCHEDULE_SUPABASE_CONFIG || {};
    cloud.client = window.supabase.createClient(config.url, config.anonKey);
  }
  cloud.shareId ||= createShareId();
  cloud.accessToken ||= createAccessToken();
  setShareCredentialsInUrl(cloud.shareId, cloud.accessToken);
  renderCloudStatus("共有リンクを作成しています...");
  await saveSharedBoardNow({ notify: false });
  subscribeSharedBoard();
  renderCloudStatus();
}

async function copyShareLink() {
  const link = getShareUrl();
  try {
    await navigator.clipboard.writeText(link);
    renderCloudStatus("共有リンクをコピーしました。");
  } catch {
    prompt("このリンクを共有してください", link);
  }
}

async function loadSharedBoard() {
  if (!isShareUrlComplete()) return;
  renderCloudStatus("共有データを読み込み中...");
  const { data, error } = await cloud.client.rpc("get_schedule_board", {
    p_share_id: cloud.shareId,
    p_access_token: cloud.accessToken,
  });

  if (error) {
    console.error(error);
    renderCloudStatus("共有データの読み込みに失敗しました。URLまたはSupabase設定を確認してください。");
    return;
  }

  if (data?.meetings?.length) {
    applyLoadedState(data);
    return;
  }

  renderCloudStatus("共有データが見つかりません。URLのboardとtokenを確認してください。");
}

function applyLoadedState(nextState) {
  cloud.applyingRemote = true;
  mergeSharedPayload(nextState);
  syncActiveMeeting();
  if (!state.participants.some((person) => person.id === selectedParticipantId)) {
    selectedParticipantId = state.participants[0]?.id || null;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
  cloud.applyingRemote = false;
  render();
}

function subscribeSharedBoard() {
  if (!cloud.client || !isShareUrlComplete()) return;
  if (cloud.channel) cloud.client.removeChannel(cloud.channel);

  cloud.channel = cloud.client
    .channel(getRealtimeChannelName(), { config: { broadcast: { self: true } } })
    .on("broadcast", { event: "board_updated" }, async () => {
      if (ignoreNextRealtime) {
        ignoreNextRealtime = false;
        return;
      }
      await loadSharedBoard();
    })
    .subscribe();
}

function scheduleCloudSave() {
  if (!cloud.client || !isShareUrlComplete() || cloud.applyingRemote) return;
  clearTimeout(cloud.saveTimer);
  cloud.saveTimer = setTimeout(() => saveSharedBoardNow(), 250);
}

async function saveSharedBoardNow(options = {}) {
  if (!cloud.client || !isShareUrlComplete()) return;
  const { notify = true } = options;

  const { error } = await cloud.client.rpc("save_schedule_board", {
    p_share_id: cloud.shareId,
    p_access_token: cloud.accessToken,
    p_data: createSharedPayload(),
  });

  if (error) {
    ignoreNextRealtime = false;
    console.error(error);
    renderCloudStatus("共有データの保存に失敗しました。URLまたはSupabase設定を確認してください。");
    return;
  }

  if (notify && cloud.channel) {
    ignoreNextRealtime = true;
    await cloud.channel.send({
      type: "broadcast",
      event: "board_updated",
      payload: { updatedAt: new Date().toISOString() },
    });
  }
}

function renderMeetingTabs() {
  els.meetingTabs.innerHTML = "";
  appState.meetings.forEach((meeting) => {
    const tab = document.createElement("div");
    tab.className = `meeting-tab${meeting.id === appState.activeMeetingId ? " active" : ""}`;

    const switchButton = document.createElement("button");
    switchButton.type = "button";
    switchButton.className = "meeting-tab-name";
    switchButton.textContent = meeting.title.trim() || "無題の打ち合わせ";
    switchButton.addEventListener("click", () => {
      appState.activeMeetingId = meeting.id;
      selectedParticipantId = meeting.participants[0]?.id || null;
      syncActiveMeeting();
      persist();
      render();
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "meeting-tab-delete";
    deleteButton.textContent = "×";
    deleteButton.setAttribute("aria-label", `${switchButton.textContent}を削除`);
    deleteButton.disabled = appState.meetings.length === 1;
    deleteButton.addEventListener("click", () => deleteMeeting(meeting.id));

    tab.append(switchButton, deleteButton);
    els.meetingTabs.append(tab);
  });
}

function deleteMeeting(meetingId) {
  if (appState.meetings.length === 1) return;
  const meeting = appState.meetings.find((candidate) => candidate.id === meetingId);
  const title = meeting?.title.trim() || "無題の打ち合わせ";
  if (!confirm(`${title}を削除しますか？`)) return;
  appState.meetings = appState.meetings.filter((candidate) => candidate.id !== meetingId);
  if (appState.activeMeetingId === meetingId) appState.activeMeetingId = appState.meetings[0].id;
  syncActiveMeeting();
  selectedParticipantId = state.participants[0]?.id || null;
  persist();
  render();
}

function renderDateCount() {
  els.dateCount.textContent = `候補日 ${state.dates.length}日`;
}

function renderEmptyState() {
  const isEmpty = state.dates.length === 0 || state.participants.length === 0;
  els.emptyState.style.display = isEmpty ? "grid" : "none";
  els.inputView.classList.toggle("hidden", isEmpty || activeView !== "input");
  els.summaryView.classList.toggle("hidden", isEmpty || activeView !== "summary");
}

function renderParticipants() {
  els.participantCount.textContent = `${state.participants.length}人`;
  els.participantList.innerHTML = "";

  if (!state.participants.some((person) => person.id === selectedParticipantId)) {
    selectedParticipantId = state.participants[0]?.id || null;
  }

  state.participants.forEach((person) => {
    const item = document.createElement("div");
    item.className = `participant-item${person.id === selectedParticipantId ? " active" : ""}`;

    const nameInput = document.createElement("input");
    nameInput.className = "participant-name";
    nameInput.value = person.name;
    nameInput.addEventListener("focus", () => {
      selectedParticipantId = person.id;
      item.classList.add("active");
    });
    nameInput.addEventListener("input", () => {
      person.name = nameInput.value;
      persist();
      renderSummary();
    });

    const actions = document.createElement("div");
    actions.className = "participant-actions";

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.textContent = "入力";
    selectButton.addEventListener("click", () => {
      selectedParticipantId = person.id;
      switchView("input");
      render();
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.textContent = "削除";
    deleteButton.addEventListener("click", () => {
      state.participants = state.participants.filter((candidate) => candidate.id !== person.id);
      delete state.availability[person.id];
      if (selectedParticipantId === person.id) selectedParticipantId = state.participants[0]?.id || null;
      persist();
      render();
    });

    actions.append(selectButton, deleteButton);
    item.append(nameInput, actions);
    els.participantList.append(item);
  });
}

function renderInputGrid() {
  const person = state.participants.find((candidate) => candidate.id === selectedParticipantId);
  els.currentParticipantTitle.textContent = person ? `${person.name || "無名"}さんの入力` : "入力する参加者";
  els.availabilityGrid.innerHTML = "";
  if (!person || state.dates.length === 0) return;

  const grid = createGridElement();
  grid.append(createCornerCell());
  state.dates.forEach((date) => grid.append(createDateHeader(date)));

  times.forEach((time) => {
    grid.append(createTimeCell(time));
    state.dates.forEach((date) => {
      const button = document.createElement("button");
      const available = getAvailability(person.id, date, time);
      button.type = "button";
      button.className = `grid-cell availability-cell${available ? " available" : ""}`;
      button.textContent = available ? "可" : "不可";
      button.addEventListener("pointerdown", (event) => startDragFill(event, button, person.id, date, time));
      button.addEventListener("pointerenter", () => continueDragFill(button, person.id, date, time));
      button.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        const next = !getAvailability(person.id, date, time);
        applyAvailabilityToButton(button, person.id, date, time, next);
        persist();
        renderSummary();
      });
      grid.append(button);
    });
  });

  els.availabilityGrid.append(grid);
}

function startDragFill(event, button, participantId, date, time) {
  if (event.button !== 0) return;
  event.preventDefault();
  const value = !getAvailability(participantId, date, time);
  dragState = { participantId, value, changed: false };
  applyAvailabilityToButton(button, participantId, date, time, value);
}

function continueDragFill(button, participantId, date, time) {
  if (!dragState || dragState.participantId !== participantId) return;
  applyAvailabilityToButton(button, participantId, date, time, dragState.value);
}

function finishDragFill() {
  if (!dragState) return;
  persist();
  renderSummary();
  dragState = null;
}

function applyAvailabilityToButton(button, participantId, date, time, value) {
  if (getAvailability(participantId, date, time) === value) return;
  setAvailability(participantId, date, time, value);
  button.classList.toggle("available", value);
  button.textContent = value ? "可" : "不可";
  if (dragState) dragState.changed = true;
}

function renderSummary() {
  els.summaryGrid.innerHTML = "";
  els.bestSlots.innerHTML = "";
  if (state.dates.length === 0 || state.participants.length === 0) return;

  const summaries = [];
  const grid = createGridElement();
  grid.append(createCornerCell());
  state.dates.forEach((date) => grid.append(createDateHeader(date)));

  times.forEach((time) => {
    grid.append(createTimeCell(time));
    state.dates.forEach((date) => {
      const availablePeople = state.participants.filter((person) => getAvailability(person.id, date, time));
      summaries.push({ date, time, people: availablePeople });
      const cell = document.createElement("div");
      const count = availablePeople.length;
      const all = count === state.participants.length;
      const some = count > 0;
      cell.className = `grid-cell summary-cell${all ? " best" : some ? " good" : ""}`;
      cell.title = availablePeople.map((person) => person.name).join(", ") || "該当者なし";
      cell.textContent = `${count}/${state.participants.length}`;
      grid.append(cell);
    });
  });

  renderBestSlots(summaries);
  els.summaryGrid.append(grid);
}

function renderBestSlots(summaries) {
  const ranked = summaries
    .filter((slot) => slot.people.length > 0)
    .sort((a, b) => b.people.length - a.people.length || a.date.localeCompare(b.date) || a.time.localeCompare(b.time))
    .slice(0, 5);

  if (ranked.length === 0) {
    const empty = document.createElement("div");
    empty.className = "best-slot";
    empty.textContent = "可の時間がまだありません。";
    els.bestSlots.append(empty);
    return;
  }

  ranked.forEach((slot) => {
    const item = document.createElement("div");
    item.className = "best-slot";
    const names = slot.people.map((person) => person.name || "無名").join(", ");
    item.innerHTML = `<strong>${formatDate(slot.date)} ${slot.time}</strong><span>${slot.people.length}/${state.participants.length}人: ${escapeHtml(names)}</span>`;
    els.bestSlots.append(item);
  });
}

function createGridElement() {
  const grid = document.createElement("div");
  grid.className = "schedule-grid";
  grid.style.gridTemplateColumns = `82px repeat(${state.dates.length}, minmax(142px, 1fr))`;
  return grid;
}

function createCornerCell() {
  const cell = document.createElement("div");
  cell.className = "time-cell";
  cell.textContent = "時間";
  return cell;
}

function createTimeCell(time) {
  const cell = document.createElement("div");
  cell.className = "time-cell";
  cell.textContent = time;
  return cell;
}

function createDateHeader(date) {
  const template = document.querySelector("#dateHeaderTemplate");
  const header = template.content.firstElementChild.cloneNode(true);
  header.querySelector("span").textContent = formatDate(date);
  header.querySelector("button").addEventListener("click", () => {
    state.dates = state.dates.filter((candidate) => candidate !== date);
    state.participants.forEach((person) => {
      delete state.availability[person.id]?.[date];
    });
    persist();
    render();
  });
  return header;
}

function buildTimes() {
  const slots = [];
  for (let minutes = START_HOUR * 60; minutes < END_HOUR * 60; minutes += SLOT_MINUTES) {
    const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
    const minute = String(minutes % 60).padStart(2, "0");
    slots.push(`${hour}:${minute}`);
  }
  return slots;
}

function addDates(dates) {
  const validDates = dates.filter(Boolean);
  if (validDates.length === 0) return;
  const before = state.dates.length;
  state.dates = Array.from(new Set([...state.dates, ...validDates])).sort();
  if (state.dates.length === before) return;
  ensureAvailabilityShape();
  persist();
  render();
}

function buildDateRange(startDate, endDate, excludeWeekends) {
  if (!startDate || !endDate) return [];
  const start = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);
  if (start > end) return [];

  const dates = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.getDay();
    if (!excludeWeekends || (day !== 0 && day !== 6)) dates.push(formatInputDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function ensureAvailabilityShape() {
  state.participants.forEach((person) => {
    state.availability[person.id] ||= {};
    state.dates.forEach((date) => {
      state.availability[person.id][date] ||= {};
      times.forEach((time) => {
        state.availability[person.id][date][time] ??= false;
      });
    });
  });
}

function getAvailability(participantId, date, time) {
  return Boolean(state.availability[participantId]?.[date]?.[time]);
}

function setAvailability(participantId, date, time, value) {
  state.availability[participantId] ||= {};
  state.availability[participantId][date] ||= {};
  state.availability[participantId][date][time] = value;
}

function loadAppState() {
  const storedV2 = readStoredJson(STORAGE_KEY);
  if (storedV2?.meetings?.length) return normalizeAppState(storedV2);

  const legacy = readStoredJson(LEGACY_STORAGE_KEY);
  if (legacy && Array.isArray(legacy.dates) && Array.isArray(legacy.participants)) {
    const meeting = normalizeMeeting({ id: crypto.randomUUID(), ...legacy });
    return { activeMeetingId: meeting.id, meetings: [meeting] };
  }

  const meeting = createMeeting("新しい打ち合わせ");
  return { activeMeetingId: meeting.id, meetings: [meeting] };
}

function readStoredJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

function normalizeAppState(value) {
  const meetings = value.meetings.map(normalizeMeeting);
  const activeMeetingId = meetings.some((meeting) => meeting.id === value.activeMeetingId) ? value.activeMeetingId : meetings[0].id;
  return { activeMeetingId, meetings };
}

function createSharedPayload() {
  const meeting = normalizeMeeting(state);
  return {
    activeMeetingId: meeting.id,
    meetings: [meeting],
  };
}

function mergeSharedPayload(value) {
  const sharedState = normalizeAppState(value);
  const sharedMeeting = sharedState.meetings[0];
  const existingIndex = appState.meetings.findIndex((meeting) => meeting.id === sharedMeeting.id);
  if (existingIndex >= 0) {
    appState.meetings[existingIndex] = sharedMeeting;
  } else {
    appState.meetings.push(sharedMeeting);
  }
  appState.activeMeetingId = sharedMeeting.id;
}

function normalizeMeeting(value) {
  return {
    id: value.id || crypto.randomUUID(),
    title: value.title || "",
    dates: Array.isArray(value.dates) ? value.dates : [],
    participants: Array.isArray(value.participants) ? value.participants : [],
    availability: value.availability && typeof value.availability === "object" ? value.availability : {},
  };
}

function createMeeting(title = "") {
  return { id: crypto.randomUUID(), title, dates: [], participants: [], availability: {} };
}

function getActiveMeeting() {
  return appState.meetings.find((meeting) => meeting.id === appState.activeMeetingId) || appState.meetings[0];
}

function syncActiveMeeting() {
  if (!appState.meetings.length) {
    const meeting = createMeeting("新しい打ち合わせ");
    appState.meetings.push(meeting);
    appState.activeMeetingId = meeting.id;
  }
  state = getActiveMeeting();
  appState.activeMeetingId = state.id;
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
  scheduleCloudSave();
}

function setDefaultDate() {
  const value = formatInputDate(new Date());
  els.dateInput.value = value;
  els.rangeStartInput.value = value;
  els.rangeEndInput.value = value;
}

function formatDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function parseLocalDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatInputDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getShareIdFromUrl() {
  return new URLSearchParams(window.location.search).get("board") || "";
}

function getAccessTokenFromUrl() {
  return new URLSearchParams(window.location.search).get("token") || "";
}

function isShareUrlComplete() {
  return Boolean(cloud.shareId && cloud.accessToken);
}

function setShareCredentialsInUrl(shareId, accessToken) {
  const url = new URL(window.location.href);
  url.searchParams.set("board", shareId);
  url.searchParams.set("token", accessToken);
  window.history.replaceState(null, "", url.toString());
}

function getShareUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("board", cloud.shareId);
  url.searchParams.set("token", cloud.accessToken);
  return url.toString();
}

function getRealtimeChannelName() {
  return `schedule-board:${cloud.shareId}:${cloud.accessToken}`;
}

function createShareId() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(12)));
}

function createAccessToken() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exportJson() {
  downloadFile(`${fileBaseName()}_all.json`, JSON.stringify(appState, null, 2), "application/json");
}

function exportCsv() {
  const rows = [["打ち合わせ名", "日付", "時間", "可の人数", "総人数", "可の参加者"]];
  state.dates.forEach((date) => {
    times.forEach((time) => {
      const people = state.participants.filter((person) => getAvailability(person.id, date, time));
      rows.push([state.title || "無題の打ち合わせ", formatDate(date), time, people.length, state.participants.length, people.map((person) => person.name).join(" / ")]);
    });
  });
  const csv = `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  downloadFile(`${fileBaseName()}.csv`, csv, "text/csv;charset=utf-8");
}

function importJson(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const imported = JSON.parse(reader.result);
      if (imported?.meetings?.length) {
        appState = normalizeAppState(imported);
      } else if (Array.isArray(imported.dates) && Array.isArray(imported.participants)) {
        const meeting = normalizeMeeting({ id: crypto.randomUUID(), ...imported });
        appState = { activeMeetingId: meeting.id, meetings: [meeting] };
      } else {
        throw new Error("Invalid data");
      }
      syncActiveMeeting();
      selectedParticipantId = state.participants[0]?.id || null;
      ensureAvailabilityShape();
      persist();
      render();
    } catch {
      alert("読み込めないJSONファイルです。");
    } finally {
      event.target.value = "";
    }
  });
  reader.readAsText(file);
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function fileBaseName() {
  const name = state.title.trim() || "schedule";
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return entities[char];
  });
}
