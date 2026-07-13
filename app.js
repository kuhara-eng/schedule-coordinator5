/* =========================================================================
 * 日程調整ボード app.js
 *
 * ▼ 今回のリファクタリングの方針
 *   「ローカルモード」と「共有モード」を最初から最後まで完全に分離する。
 *   - Session   : URLを見て起動時に一度だけモードを確定する（唯一の判定役）
 *   - LocalStorageRepo : ローカルモード専用の永続化（localStorageのみ）
 *   - Cloud     : 共有モード専用の永続化（Supabase RPC + Realtime Broadcastのみ）
 *   - persist() : どちらを呼ぶかを振り分けるだけの薄いディスパッチャ
 *
 *   共有モードでは appState.meetings は常に「共有された1件」だけを保持し、
 *   localStorageの読み書きは一切行わない（要件①②③④⑤に対応）。
 *
 * ▼ 修正した既存バグ
 *   - persist() が存在しない関数 getStorageKey() を呼んでおり、保存のたびに
 *     例外が発生して処理が止まっていた（ローカル保存もクラウド保存も実質動作せず）。
 *   - loadAppState() が存在しない関数 readStoredJson() を呼んでいた。
 *   → どちらも今回の再設計で解消（LocalStorageRepo.readJson に統一）。
 *
 * ▼ 将来の拡張（管理者 / 参加者 / 閲覧専用モード）について
 *   Permissions というごく薄い判定オブジェクトを用意した。
 *   将来 Session に role ("admin" | "participant" | "viewer") を持たせ、
 *   Permissions内の各関数をroleで分岐させるだけで、UIや保存ロジックを
 *   ほとんど変えずに権限拡張できるようにしている。
 * ========================================================================= */

/* =========================================================================
 * 定数
 * ========================================================================= */
const STORAGE_KEY = "schedule-coordinator-v2";
const LEGACY_STORAGE_KEY = "schedule-coordinator-v1";
const START_HOUR = 9;
const END_HOUR = 18;
const SLOT_MINUTES = 30;

const MODE_LOCAL = "local";
const MODE_SHARE = "share";

const times = buildTimes();

/* =========================================================================
 * Session: ローカル/共有モードの判定と、共有IDの保持
 *
 * ▼ 変更点
 *   以前は shareId/accessToken が cloud オブジェクトの一部として散らばり、
 *   appState（データ）と混ざって扱われていた。
 *   ここでは「今どのモードで動いているか」を専任で管理する単一のオブジェクトに
 *   まとめ、他のどのコードもURLを直接パースしないようにした。
 * ========================================================================= */
const Session = createSession();

function createSession() {
  const params = new URLSearchParams(window.location.search);
  const shareId = params.get("board") || "";
  const accessToken = params.get("token") || "";
  const initialMode = shareId && accessToken ? MODE_SHARE : MODE_LOCAL;

  return {
    mode: initialMode,
    shareId,
    accessToken,

    isLocal() {
      return this.mode === MODE_LOCAL;
    },
    isShare() {
      return this.mode === MODE_SHARE;
    },

    // ローカルモード → 共有モードへの唯一の遷移経路。
    // 「共有リンクを作成」ボタンからのみ呼ばれる。
    upgradeToShare(shareId, accessToken) {
      this.mode = MODE_SHARE;
      this.shareId = shareId;
      this.accessToken = accessToken;
      const url = new URL(window.location.href);
      url.searchParams.set("board", shareId);
      url.searchParams.set("token", accessToken);
      window.history.replaceState(null, "", url.toString());
    },

    getShareUrl() {
      const url = new URL(window.location.href);
      url.searchParams.set("board", this.shareId);
      url.searchParams.set("token", this.accessToken);
      return url.toString();
    },
  };
}

/* =========================================================================
 * Permissions: 将来の役割ベース拡張のための判定レイヤー
 *
 * 現時点ではモードだけを見て判定しているが、将来的に
 *   Session.role = "admin" | "participant" | "viewer"
 * を追加した際は、ここの分岐を増やすだけで済むようにしてある。
 * 呼び出し側（イベントハンドラや描画）はPermissionsの結果だけを見ればよい。
 * ========================================================================= */
const Permissions = {
  // 打ち合わせの追加・削除ができるか
  // 共有モードは常に「共有された1件だけ」を保つ仕様のため不可。
  canManageMeetings() {
    return Session.isLocal();
    // 将来: return Session.isLocal() || Session.role === "admin";
  },

  // 候補日・参加者・可否入力など、打ち合わせの中身を編集できるか
  canEditContent() {
    return true;
    // 将来: return Session.role !== "viewer";
  },
};

/* =========================================================================
 * LocalStorageRepo: ローカルモード専用の永続化
 *
 * ▼ 変更点
 *   共有モードからは絶対に呼ばれない（呼び出し箇所は persist() と init() の
 *   ローカル分岐のみ）。以前存在した「共有データをlocalStorageにも書き込む」
 *   処理は完全に削除した。
 * ========================================================================= */
const LocalStorageRepo = {
  load() {
    const storedV2 = this.readJson(STORAGE_KEY);
    if (storedV2?.meetings?.length) return normalizeAppState(storedV2);

    const legacy = this.readJson(LEGACY_STORAGE_KEY);
    if (legacy && Array.isArray(legacy.dates) && Array.isArray(legacy.participants)) {
      const meeting = normalizeMeeting({ id: crypto.randomUUID(), ...legacy });
      return { activeMeetingId: meeting.id, meetings: [meeting] };
    }

    const meeting = createMeeting("新しい打ち合わせ");
    return { activeMeetingId: meeting.id, meetings: [meeting] };
  },

  save(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  },

  readJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
};

/* =========================================================================
 * Cloud: 共有モード専用の永続化（Supabase RPC + Realtime Broadcast）
 *
 * ▼ 変更点
 *   - localStorageへの参照を完全に排除。
 *   - 「設定確認」「読み込み」「保存」「購読」をそれぞれ独立したメソッドにし、
 *     呼び出し側（loadSharedBoard, createShareLinkなど）が流れを追いやすくした。
 *   - RPCの成功/失敗を { ok, ... } の形で返し、呼び出し側でUI表示を組み立てる
 *     責務分離にした（以前はCloud側でDOMを直接触っていた）。
 * ========================================================================= */
const Cloud = {
  client: null,
  channel: null,
  configured: false,
  applyingRemote: false,
  ignoreNextRealtime: false,
  saveTimer: null,

  configure() {
    const config = window.SCHEDULE_SUPABASE_CONFIG || {};
    this.configured = Boolean(config.url && config.anonKey && window.supabase?.createClient);
    if (this.configured && !this.client) {
      this.client = window.supabase.createClient(config.url, config.anonKey);
    }
    return this.configured;
  },

  async load(shareId, accessToken) {
    if (!this.client) return { ok: false, reason: "not-configured" };
    const { data, error } = await this.client.rpc("get_schedule_board", {
      p_share_id: shareId,
      p_access_token: accessToken,
    });
    if (error) return { ok: false, reason: "error", error };
    if (!data?.meetings?.length) return { ok: false, reason: "not-found" };
    return { ok: true, data };
  },

  async save(shareId, accessToken, payload, { notify = true } = {}) {
    if (!this.client) return { ok: false, reason: "not-configured" };
    const { error } = await this.client.rpc("save_schedule_board", {
      p_share_id: shareId,
      p_access_token: accessToken,
      p_data: payload,
    });
    if (error) return { ok: false, reason: "error", error };

    if (notify && this.channel) {
      this.ignoreNextRealtime = true;
      await this.channel.send({
        type: "broadcast",
        event: "board_updated",
        payload: { updatedAt: new Date().toISOString() },
      });
    }
    return { ok: true };
  },

  // 250msデバウンスして保存する。呼ぶたびに最新のappStateを渡してもらう
  // （buildPayloadをクロージャで持たせず、保存直前に呼び出す形にして
  //   常に最新の状態を送るようにした）。
  scheduleSave(shareId, accessToken, buildPayload, onResult) {
    if (!this.client || this.applyingRemote) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      const result = await this.save(shareId, accessToken, buildPayload());
      onResult?.(result);
    }, 250);
  },

  subscribe(shareId, accessToken, onRemoteChange) {
    if (!this.client) return;
    this.unsubscribe();
    this.channel = this.client
      .channel(`schedule-board:${shareId}:${accessToken}`, { config: { broadcast: { self: true } } })
      .on("broadcast", { event: "board_updated" }, async () => {
        if (this.ignoreNextRealtime) {
          this.ignoreNextRealtime = false;
          return;
        }
        await onRemoteChange();
      })
      .subscribe();
  },

  unsubscribe() {
    if (this.channel) {
      this.client?.removeChannel(this.channel);
      this.channel = null;
    }
  },
};

/* =========================================================================
 * アプリ状態
 * ========================================================================= */
let appState = { activeMeetingId: "", meetings: [] };
let state = null;
let selectedParticipantId = null;
let activeView = "input";
let dragState = null;

/* =========================================================================
 * DOM参照（index.html / styles.cssは変更していないため、要素・IDは従来通り）
 * ========================================================================= */
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

/* =========================================================================
 * 初期化
 *
 * ▼ 変更点（重要）
 *   共有モードのときは LocalStorageRepo に一切触れずに起動する。
 *   まず空のプレースホルダーで描画し、その後Supabaseから届いたデータで
 *   appStateを丸ごと置き換える、という一方向の流れにした。
 *   これにより「前に開いていた別会議のデータが一瞬でも表示される」
 *   経路自体を無くしている。
 * ========================================================================= */
async function init() {
  setDefaultDate();
  Cloud.configure();

  if (Session.isShare()) {
    // 共有モード: localStorageは読まない。Supabaseから届くまでは空の器。
    appState = createEmptyMeetingState();
  } else {
    // ローカルモード: 従来通りlocalStorageから読み込む。
    appState = LocalStorageRepo.load();
  }

  syncActiveMeeting();
  selectedParticipantId = state.participants[0]?.id || null;

  bindEvents();
  render();

  if (Session.isShare()) {
    await initShareSession();
  }
}

function createEmptyMeetingState() {
  const meeting = createMeeting("");
  return { activeMeetingId: meeting.id, meetings: [meeting] };
}

async function initShareSession() {
  if (!Cloud.configured) {
    renderCloudStatus("Supabase未設定のため共有データを利用できません。config.js を確認してください。");
    return;
  }
  await loadSharedBoard();
  Cloud.subscribe(Session.shareId, Session.accessToken, () => loadSharedBoard());
}

async function loadSharedBoard() {
  renderCloudStatus("共有データを読み込み中...");
  const result = await Cloud.load(Session.shareId, Session.accessToken);

  if (!result.ok) {
    if (result.reason === "not-found") {
      renderCloudStatus("共有データがまだありません。入力を始めると新しく保存されます。");
    } else {
      console.error(result.error);
      renderCloudStatus("共有データの読み込みに失敗しました。URLまたはSupabase設定を確認してください。");
    }
    return;
  }

  applyRemoteAppState(result.data);
}

// Supabaseから届いたデータで appState を丸ごと置き換える。
// 共有モードでは常に「1件だけ」を保持する不変条件をここで強制する。
function applyRemoteAppState(data) {
  Cloud.applyingRemote = true;

  const normalized = normalizeAppState(data);
  const meeting = normalized.meetings[0];
  appState = { activeMeetingId: meeting.id, meetings: [meeting] };

  syncActiveMeeting();
  if (!state.participants.some((person) => person.id === selectedParticipantId)) {
    selectedParticipantId = state.participants[0]?.id || null;
  }

  Cloud.applyingRemote = false;
  render();
}

/* =========================================================================
 * イベントバインド
 * ========================================================================= */
function bindEvents() {
  els.createShareBtn.addEventListener("click", createShareLink);
  els.copyShareBtn.addEventListener("click", copyShareLink);

  els.addMeetingBtn.addEventListener("click", () => {
    if (!Permissions.canManageMeetings()) return;
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
    if (!Permissions.canEditContent()) return;
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
    if (!Permissions.canEditContent()) return;
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
    if (!Permissions.canEditContent()) return;
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
    if (!Permissions.canEditContent()) return;
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

/* =========================================================================
 * 永続化ディスパッチャ
 *
 * ▼ 変更点（本リファクタリングの核）
 *   以前はここで localStorage.setItem(getStorageKey(), ...) を無条件に呼び、
 *   その後に共有保存を試みていた（しかも前者が存在しない関数のせいで
 *   例外になり、共有保存にすら到達していなかった）。
 *   今は「今のセッションがローカルか共有か」で完全に分岐し、
 *   両方が同時に呼ばれることは構造上あり得ない。
 * ========================================================================= */
function persist() {
  if (Session.isShare()) {
    Cloud.scheduleSave(Session.shareId, Session.accessToken, createSharedPayload, handleCloudSaveResult);
  } else {
    LocalStorageRepo.save(appState);
  }
}

function handleCloudSaveResult(result) {
  if (!result.ok) {
    console.error(result.error);
    renderCloudStatus("共有データの保存に失敗しました。URLまたはSupabase設定を確認してください。");
  }
}

/* =========================================================================
 * 共有リンクの作成・コピー
 *
 * ▼ 変更点
 *   「共有リンクを作成」は、ローカルモード→共有モードへの唯一の遷移経路。
 *   遷移した瞬間に appState を「今アクティブな打ち合わせ1件だけ」に
 *   絞り込み、以後このタブは共有モードとして振る舞う
 *   （それ以降 persist() は二度とlocalStorageを使わない）。
 * ========================================================================= */
async function createShareLink() {
  if (Session.isShare()) return; // 既に共有中は何もしない

  if (!Cloud.configured && !Cloud.configure()) {
    alert("config.js にSupabaseのURLとanon keyを設定してください。");
    return;
  }

  const shareId = createShareId();
  const accessToken = createAccessToken();

  // 共有モードへ移行: 他の打ち合わせは同伴させず、今の1件だけを共有する。
  const meeting = normalizeMeeting(state);
  appState = { activeMeetingId: meeting.id, meetings: [meeting] };
  Session.upgradeToShare(shareId, accessToken);
  syncActiveMeeting();

  renderCloudStatus("共有リンクを作成しています...");
  const result = await Cloud.save(shareId, accessToken, createSharedPayload(), { notify: false });
  if (!result.ok) {
    console.error(result.error);
    renderCloudStatus("共有データの保存に失敗しました。");
    return;
  }

  Cloud.subscribe(shareId, accessToken, () => loadSharedBoard());
  render(); // 打ち合わせ切り替えUIを共有モード仕様（追加不可・1件のみ）に更新
  renderCloudStatus();
}

async function copyShareLink() {
  if (!Session.isShare()) return;
  const link = Session.getShareUrl();
  try {
    await navigator.clipboard.writeText(link);
    renderCloudStatus("共有リンクをコピーしました。");
  } catch {
    prompt("このリンクを共有してください", link);
  }
}

/* =========================================================================
 * 描画
 * ========================================================================= */
function render() {
  syncActiveMeeting();
  ensureAvailabilityShape();
  els.meetingTitle.value = state.title;
  renderCloudStatus();
  renderModeUI();
  renderMeetingTabs();
  renderDateCount();
  renderParticipants();
  renderInputGrid();
  renderSummary();
  renderEmptyState();
}

function renderCloudStatus(message) {
  if (message) {
    els.cloudStatus.textContent = message;
  } else if (Session.isShare() && !Cloud.configured) {
    els.cloudStatus.textContent = "Supabase未設定のため共有データを利用できません。config.js を確認してください。";
  } else if (Session.isShare()) {
    els.cloudStatus.textContent = `リアルタイム共有中: ${Session.shareId}`;
  } else if (Cloud.configured) {
    els.cloudStatus.textContent = "Supabase設定済み。現在はローカル保存です。";
  } else {
    els.cloudStatus.textContent = "Supabase未設定。現在はローカル保存です。";
  }
  els.createShareBtn.disabled = Session.isShare() || !Cloud.configured;
  els.copyShareBtn.disabled = !Session.isShare();
}

// 共有モードでは「打ち合わせを追加」できないようにする（appState.meetingsは常に1件）。
function renderModeUI() {
  const sharing = Session.isShare();
  els.addMeetingBtn.disabled = sharing || !Permissions.canManageMeetings();
  els.addMeetingBtn.title = sharing ? "共有モードでは打ち合わせを追加できません（共有中の1件のみになります）" : "";
}

/* =========================================================================
 * 打ち合わせ（Meeting）タブ
 * ========================================================================= */
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
    deleteButton.disabled = appState.meetings.length === 1 || !Permissions.canManageMeetings();
    deleteButton.addEventListener("click", () => deleteMeeting(meeting.id));

    tab.append(switchButton, deleteButton);
    els.meetingTabs.append(tab);
  });
}

function deleteMeeting(meetingId) {
  if (!Permissions.canManageMeetings()) return;
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

/* =========================================================================
 * 参加者・可否入力
 * ========================================================================= */
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
      if (!Permissions.canEditContent()) return;
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
      if (!Permissions.canEditContent()) return;
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
        if (!Permissions.canEditContent()) return;
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
  if (!Permissions.canEditContent()) return;
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

/* =========================================================================
 * 集計
 * ========================================================================= */
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

/* =========================================================================
 * グリッド共通部品
 * ========================================================================= */
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
    if (!Permissions.canEditContent()) return;
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
  if (!Permissions.canEditContent()) return;
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

/* =========================================================================
 * 状態の正規化・共有ペイロード生成・打ち合わせ操作
 * ========================================================================= */
function normalizeAppState(value) {
  const meetings = value.meetings.map(normalizeMeeting);
  const activeMeetingId = meetings.some((meeting) => meeting.id === value.activeMeetingId)
    ? value.activeMeetingId
    : meetings[0].id;
  return { activeMeetingId, meetings };
}

// 共有モード保存用のペイロード。常に「今アクティブな1件だけ」を送る
// （appState.meetingsが共有モードでは既に1件のみである前提だが、
//   念のためstateから作り直して不変条件を保証する）。
function createSharedPayload() {
  const meeting = normalizeMeeting(state);
  return { activeMeetingId: meeting.id, meetings: [meeting] };
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

/* =========================================================================
 * 日付ユーティリティ
 * ========================================================================= */
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

/* =========================================================================
 * 共有ID/トークン生成
 * ========================================================================= */
function createShareId() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(12)));
}

function createAccessToken() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* =========================================================================
 * 入出力（JSON/CSV）
 * ========================================================================= */
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
      let nextState;
      if (imported?.meetings?.length) {
        nextState = normalizeAppState(imported);
      } else if (Array.isArray(imported.dates) && Array.isArray(imported.participants)) {
        const meeting = normalizeMeeting({ id: crypto.randomUUID(), ...imported });
        nextState = { activeMeetingId: meeting.id, meetings: [meeting] };
      } else {
        throw new Error("Invalid data");
      }

      // 共有モードでは appState.meetings を常に1件に保つ不変条件を、
      // インポート経路でも必ず守る。
      if (Session.isShare()) {
        const meeting = nextState.meetings[0];
        nextState = { activeMeetingId: meeting.id, meetings: [meeting] };
      }

      appState = nextState;
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

/* =========================================================================
 * 汎用ユーティリティ
 * ========================================================================= */
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return entities[char];
  });
}
