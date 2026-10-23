(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const STORAGE_KEY = "talkeval-live-sessions-v1";
  const DELETION_KEY = "talkeval-session-deletions-v1";
  const MEDIA_DB = "talkeval-live-recordings-v1";
  const shared = window.TalkEvalShared;
  const state = {
    cases: [], selectedCase: null, points: [], session: null, timer: null,
    cameraStream: null, screenStream: null, audioContext: null, analyser: null,
    mediaRecorder: null, recordingChunks: [], recordingChunkCount: 0,
    recordingLocalWrites: Promise.resolve(),
    recordingLocalError: "", remoteSessions: [], replayUrl: null,
    speech: null, speechOn: false, lastSpeechAt: 0, lastUtteranceAt: 0,
    audioSamples: [], voiceBaseline: [], currentVolume: null, currentPitch: null,
    faceTask: null, poseTask: null, visionLoading: false, visualRaf: null,
    lastVisionAt: 0, previousWrists: null, visualSummary: [], visualWindow: [], analysisAudio: [], lastVisualArchiveAt: -1,
    speechWindowStart: null, speechWindowEnd: null, lastSegmentEnd: 0, lastAnalysisAudioAt: 0,
    ocrWorker: null, ocrLoading: null, ocrBusy: false, ocrTimer: null, lastOcrAt: 0,
    caseRequest: 0, lastWaveAt: 0, reportSession: null, stopping: false,
    cloudState: "loading", cloudError: "", cloudRefresh: null, historyEpoch: 0,
    pendingDraft: null, actionBusy: false, deleteTarget: null, syncingIds: new Set(), deletionFlush: null,
  };
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const elapsed = () => state.session ? Math.max(0, (Date.now() - state.session.startedAt) / 1000) : 0;
  const stamp = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  const readSessions = () => {
    try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); return Array.isArray(value) ? value.map(s=>s.cloudStoreVersion==='F11'?s:{...s,cloudStored:false,cloudVideoReady:false,cloudUploadAttempted:false}) : []; }
    catch { return []; }
  };
  function readDeletionJobs() {
    try {
      const value = JSON.parse(localStorage.getItem(DELETION_KEY) || "[]");
      return Array.isArray(value) ? value.filter(item => item && typeof item.id === "string") : [];
    } catch { return []; }
  }
  function saveDeletionJob(job) {
    const jobs = readDeletionJobs(), previous = jobs.find(item => item.id === job.id);
    Object.assign(job, { localDeleted: Boolean(previous?.localDeleted || job.localDeleted), cloudDeleted: Boolean(previous?.cloudDeleted || job.cloudDeleted) });
    localStorage.setItem(DELETION_KEY, JSON.stringify([job, ...jobs.filter(item => item.id !== job.id)]));
  }
  const deletionJob = id => readDeletionJobs().find(item => item.id === id);
  const pendingDeletionJobs = () => readDeletionJobs().filter(item => !item.localDeleted || !item.cloudDeleted);
  function deletionScope(session) {
    if (session.cloudDeletionConfirmed) return "local";
    if (session.cloudStored || session.cloudVideoReady || state.remoteSessions.some(item => item.id === session.id)) return "cloud";
    if (session.cloudUploadAttempted === false) return "local";
    return "unknown";
  }
  function allSavedSessions() {
    const local = new Map(readSessions().map((session) => [session.id, session]));
    const remote = new Map(state.remoteSessions.map((session) => [session.id, session]));
    const ids = new Set([...local.keys(), ...remote.keys()]);
    const removed = new Set(readDeletionJobs().filter(job => job.localDeleted).map(job => job.id));
    return [...ids].filter(id => !removed.has(id)).map((id) => {
      const device = local.get(id); const cloud = remote.get(id);
      if (device?.cloudDeletionConfirmed) return device;
      if (!cloud) return device;
      if (!device) return { ...cloud, cloudStored: true };
      return {
        ...device, ...cloud,
        videoId: cloud.cloudVideoReady ? cloud.videoId : (device.videoId || cloud.videoId),
        videoChunks: cloud.cloudVideoReady ? cloud.videoChunks : (device.videoChunks || cloud.videoChunks),
        cloudVideoReady: Boolean(cloud.cloudVideoReady), cloudStored: true,
        videoSaved: device.videoSaved ?? cloud.videoSaved,
        cloudUploadError: cloud.cloudVideoReady ? "" : (device.cloudUploadError || cloud.cloudUploadError || ""),
      };
    });
  }
  function openMediaDb() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) { reject(new Error("此浏览器不支持本机录像存储")); return; }
      const request = indexedDB.open(MEDIA_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("recordings")) request.result.createObjectStore("recordings");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开本机录像存储"));
    });
  }
  async function storeRecordingChunk(id, index, blob) {
    const db = await openMediaDb();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("recordings", "readwrite");
        transaction.objectStore("recordings").put(blob, `${id}:${String(index).padStart(8, "0")}`);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("保存录像失败"));
        transaction.onabort = () => reject(transaction.error || new Error("保存录像已中断"));
      });
    } finally { db.close(); }
  }
  async function loadRecordingParts(id, expectedChunks = 0) {
    const db = await openMediaDb();
    try {
      const result = await new Promise((resolve, reject) => {
        const store = db.transaction("recordings", "readonly").objectStore("recordings");
        const prefix = `${id}:`;
        const request = store.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || new Error("读取录像失败"));
      });
      if (!result.length) {
        const legacy = await new Promise((resolve, reject) => {
          const request = db.transaction("recordings", "readonly").objectStore("recordings").get(id);
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => reject(request.error || new Error("读取录像失败"));
        });
        return legacy ? [legacy] : [];
      }
      return result.slice(0, expectedChunks || result.length);
    } finally { db.close(); }
  }
  async function loadRecording(id, expectedChunks = 0) {
    const chunks = await loadRecordingParts(id, expectedChunks);
    return chunks.length ? new Blob(chunks, { type: chunks.find((chunk) => chunk.type)?.type || "video/webm" }) : null;
  }
  async function deleteRecording(id) {
    const db = await openMediaDb();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("recordings", "readwrite");
        const store = transaction.objectStore("recordings");
        store.delete(id);
        const request = store.openKeyCursor(IDBKeyRange.bound(`${id}:`, `${id}:\uffff`));
        request.onsuccess = () => { if (request.result) { store.delete(request.result.primaryKey); request.result.continue(); } };
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("清理录像失败"));
        transaction.onabort = () => reject(transaction.error || new Error("清理录像已中断"));
      });
    } finally { db.close(); }
  }
  function startVideoRecording(stream, sessionId) {
    if (!("MediaRecorder" in window)) throw new Error("此浏览器不支持现场录像");
    const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    state.recordingChunks = []; state.recordingChunkCount = 0;
    state.recordingLocalWrites = Promise.resolve();
    state.recordingLocalError = "";
    recorder.addEventListener("dataavailable", (event) => {
      if (!event.data?.size) return;
      const index = state.recordingChunkCount++;
      const chunk = event.data;
      state.recordingLocalWrites = state.recordingLocalWrites.then(() => storeRecordingChunk(sessionId, index, chunk)).catch((error) => { state.recordingLocalError = error.message || "本机录像保存失败"; });
    });
    recorder.start(5000);
    state.mediaRecorder = recorder;
    state.session.videoId = sessionId;
    state.session.videoMimeType = recorder.mimeType || mimeType || "video/webm";
  }
  async function finishVideoRecording() {
    const recorder = state.mediaRecorder;
    if (!recorder) return null;
    if (recorder.state !== "inactive") {
      await new Promise((resolve) => {
        recorder.addEventListener("stop", resolve, { once: true });
        recorder.stop();
      });
    }
    state.cameraStream?.getTracks().forEach(track => track.stop());
    await state.recordingLocalWrites;
    state.mediaRecorder = null;
    state.recordingChunks = [];
    if (!state.recordingChunkCount) throw new Error("录像文件为空");
    const localReady = !state.recordingLocalError;
    return { chunks: state.recordingChunkCount, localReady, cloudReady: false };
  }
  async function cloudFetch(path, options = {}) { return shared.request(path, options); }
  async function uploadCloudChunk(sessionId, index, blob) {
    const response = await cloudFetch(`/api/sessions/${encodeURIComponent(sessionId)}/chunks/${index}`, { method: "PUT", headers: { "Content-Type": blob.type || "video/webm" }, body: blob });
    return response.json();
  }
  async function saveCloudSession(session) {
    const publicRecord = { ...session, audio: session.audio || [], caseBundleVersion: 'F12', videoChunks: session.videoChunks || 0 };
    if (!session.videoSaved && !session.cloudVideoReady) {
      publicRecord.videoId = null;
      publicRecord.videoChunks = 0;
    }
    const response = await cloudFetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(publicRecord) });
    return response.json();
  }
  function persistSession(session) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([session, ...readSessions().filter(item => item.id !== session.id)]));
  }
  async function syncSavedSession(session) {
    if (!session || state.pendingDraft?.id === session.id) throw new Error("请先选择保存本场演讲。");
    if (session.cloudDeletionConfirmed || deletionJob(session.id)) throw new Error("此记录已申请删除，不能再次同步。");
    if (state.syncingIds.has(session.id) || state.deleteTarget?.id === session.id) throw new Error("本条记录正在处理，请稍候。");
    state.syncingIds.add(session.id);
    state.historyEpoch += 1;
    renderSessions();
    const updated = { ...session };
    const previouslyAttempted = needsCloudDelete(session);
    let confirmedChunk = false;
    try {
      // Check access without uploading, so an unavailable service leaves a purely local record.
      const availability = await (await cloudFetch("/api/sessions")).json();
      if (!Array.isArray(availability.sessions)) throw new Error("云端历史接口尚不可用，未上传本场记录。");
      let parts = [];
      if (session.videoId && session.videoSaved) {
        parts = await loadRecordingParts(session.videoId, session.videoChunks);
        if (!parts.length || (session.videoChunks && parts.length !== session.videoChunks)) throw new Error("本机录像分段不完整，未上传。请先下载可用录像。");
      }
      // Persist before the first write: a network failure can hide a server-side success.
      updated.cloudUploadAttempted = true;
      persistSession(updated);
      for (let index = 0; index < parts.length; index += 1) {
        setText("#coach-save-progress", `正在同步录像 ${index + 1} / ${parts.length}…`);
        await uploadCloudChunk(session.id, index, parts[index]);
        confirmedChunk = true;
      }
      if (parts.length) updated.videoChunks = parts.length;
      const result = await saveCloudSession(updated);
      if (result.session?.id !== session.id) throw new Error("后台未确认这条记录已保存。");
      const confirmed = await (await cloudFetch(`/api/sessions/${encodeURIComponent(session.id)}`)).json();
      if (confirmed.session?.id !== session.id || !confirmed.session.cloudStored || (session.videoSaved && !confirmed.session.cloudVideoReady)) throw new Error("共享后台尚未确认完整保存，请重试同步。");
      updated.cloudStored = true;
      updated.caseBundleVersion = 'F12';
      updated.cloudStoreVersion = 'F11';
      updated.cloudVideoReady = Boolean(result.session.cloudVideoReady);
      updated.cloudUploadError = session.videoSaved && !updated.cloudVideoReady ? "报告已保存，后台尚未确认录像完整。" : "";
      state.remoteSessions = [updated, ...state.remoteSessions.filter(item => item.id !== updated.id)];
      state.cloudState = "ready"; state.cloudError = "";
      setText("#cloud-session-status", `共享已确认 · ${state.remoteSessions.length} 场`);
      persistSession(updated);
      if (state.reportSession?.id === updated.id) {
        renderReplay(updated);
        setText('#shared-save-outcome',updated.cloudVideoReady?'已共享：其他账号可在历史复盘和案例投放中查看录像与转写。':'文字报告已共享并加入案例库；本场没有可播放的录像。');
      }
      return updated;
    } catch (error) {
      if (!previouslyAttempted && !confirmedChunk && (error.status === 401 || error.status === 403)) updated.cloudUploadAttempted = false;
      updated.cloudUploadError = error.message || "云端同步失败";
      try { persistSession(updated); } catch { /* Keep the already-saved record; surface the original failure. */ }
      if (state.reportSession?.id === updated.id) renderReplay(updated);
      throw error;
    } finally {
      state.syncingIds.delete(session.id); state.historyEpoch += 1;
      renderSessions(); renderMemory();
    }
  }
  async function refreshCloudSessions() {
    if (state.cloudRefresh) return state.cloudRefresh;
    state.cloudRefresh = (async () => {
    const epoch = state.historyEpoch;
    state.cloudState = "loading";
    setText("#cloud-session-status", "正在读取云端…");
    $("#coach-refresh-history").disabled = true;
    try {
      const response = await cloudFetch("/api/sessions");
      const result = await response.json();
      if (!Array.isArray(result.sessions)) throw new Error("云端返回的历史记录格式不完整，请检查后台服务。");
      if (epoch !== state.historyEpoch) {
        state.cloudState = state.cloudError ? "error" : "ready";
        setText("#cloud-session-status", state.cloudError ? "云端未连接 · 记录未读出" : `公开云端 · ${state.remoteSessions.length} 场`);
        return;
      }
      state.remoteSessions = result.sessions;
      state.cloudState = "ready"; state.cloudError = "";
      await retryPendingDeletions();
      setText("#cloud-session-status", `公开云端 · ${state.remoteSessions.length} 场`);
    } catch (error) {
      state.cloudState = "error"; state.cloudError = error.message;
      setText("#cloud-session-status", "云端未连接 · 记录未读出");
      console.warn("云端历史暂不可用：", error.message);
    }
    renderSessions(); renderMemory();
    })().finally(() => { state.cloudRefresh = null; $("#coach-refresh-history").disabled = false; });
    return state.cloudRefresh;
  }
  const setText = (id, text) => { const node = $(id); if (node) node.textContent = text; };

  function switchView(which) {
    const review = which === "review";
    $("#review-view").hidden = !review;
    $("#live-view").hidden = review;
    $("#review-tab").classList.toggle("active", review);
    $("#live-tab").classList.toggle("active", !review);
    $("#review-tab").setAttribute("aria-current", review ? "page" : "false");
    $("#live-tab").setAttribute("aria-current", review ? "false" : "page");
    $(".skip-link").href = review ? "#detail-column" : "#coach-topic";
    history.replaceState(null, "", review ? location.pathname + location.search : "#live");
    if (!review) $("#case-video")?.pause();
    if (!review) { renderMemory(); renderSessions(); }
  }

  function normalize(value) {
    return String(value || "").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  }
  function grams(value) {
    const text = normalize(value);
    const out = new Set();
    const latin = text.match(/[a-z0-9]{2,}/g) || [];
    latin.forEach((word) => out.add(word));
    const cjk = [...text].filter((char) => /[\u3400-\u9fff]/u.test(char));
    for (let i = 0; i < cjk.length - 1; i += 1) out.add(cjk[i] + cjk[i + 1]);
    if (out.size < 3) [...text].forEach((char) => out.add(char));
    return out;
  }
  function scorePoint(point, transcript) {
    const expected = point.features || grams(point.text);
    const heard = grams(transcript);
    if (!expected.size || !heard.size) return 0;
    let hits = 0;
    expected.forEach((gram) => { if (heard.has(gram)) hits += 1; });
    return hits / expected.size;
  }
  function textSimilarity(left, right) {
    const a = grams(left); const b = grams(right);
    if (!a.size || !b.size) return 0;
    let shared = 0; a.forEach((gram) => { if (b.has(gram)) shared += 1; });
    return shared / (a.size + b.size - shared);
  }
  function setPoints(items, { caseId = null, title = "" } = {}) {
    state.practiceMonitor=null;
    state.selectedCase = caseId;
    state.points = items.map((item, index) => ({
      id: item.beat_id || `point-${index + 1}`,
      text: String(item.target_meaning || item.text || "").trim(),
      claims: item.required_claims || item.claims || [],
      features: grams(item.target_meaning || item.text || ""),
      index,
      evidence: [],
      maxScore: 0,
      applause: [],
    })).filter((item) => item.text);
    if (title && !$("#coach-topic").value.trim()) $("#coach-topic").value = title;
    renderPoints(); renderMemory();
    setText("#coach-cue-title", state.points.length ? "重点清单已就绪" : "请添加核心观点");
    setText("#coach-cue-copy", state.points.length ? "开始后会根据转写寻找观点中的词汇线索；每条提醒都是待确认提示。" : "每行填写一个核心观点，或选择一个案例作为参考提纲。");
    updateStartAvailability();
  }

  async function loadCases() {
    try {
      const response = await fetch("./data/cases.json");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.cases = data.cases || [];
      const select = $("#coach-case");
      state.cases.forEach((item) => {
        const option = document.createElement("option");
        option.value = item.case_id; option.textContent = item.title || item.case_id;
        select.appendChild(option);
      });
    } catch (error) {
      setText("#coach-model-status", `案例提纲读取失败：${error.message}`);
    }
  }

  async function chooseCase(caseId) {
    if (state.session || state.pendingDraft || state.actionBusy) return;
    const requestId = ++state.caseRequest;
    if (caseId === "custom") {
      $("#coach-topic").value = "";
      $("#coach-outline").value = "";
      setPoints([]);
      return;
    }
    const meta = state.cases.find((item) => item.case_id === caseId);
    if (!meta) return;
    try {
      const response = await fetch(`./data/cases/${encodeURIComponent(caseId)}.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (requestId !== state.caseRequest || state.session || state.pendingDraft || state.actionBusy) return;
      const beats = data.intent_map?.beats || [];
      $("#coach-topic").value = data.intent_map?.title || meta.topic || meta.title || "";
      $("#coach-speaker").value = meta.speaker_id || "";
      $("#coach-outline").value = beats.map((beat) => beat.target_meaning).join("\n");
      setPoints(beats, { caseId, title: data.intent_map?.title || meta.title });
    } catch (error) {
      if (requestId !== state.caseRequest) return;
      setText("#coach-cue-copy", `无法加载参考提纲：${error.message}`);
    }
  }

  function updateStartAvailability() {
    $("#coach-start").disabled = !$("#coach-consent").checked || !state.points.length || Boolean(state.session || state.pendingDraft || state.actionBusy);
    const active = Boolean(state.session);
    ["#coach-case", "#coach-topic", "#coach-speaker", "#coach-language", "#coach-expression-goal", "#coach-outline", "#coach-consent"].forEach(id => { $(id).disabled = active || Boolean(state.pendingDraft) || state.actionBusy; });
    ["#coach-manual-text", "#coach-add-text", "#share-screen"].forEach(id => { $(id).disabled = !active || state.stopping; });
    setText("#coach-outline-count", `${state.points.length} 个重点`);
    const ready = Boolean(state.points.length && $("#coach-consent").checked);
    setText("#coach-ready-note", active ? "本场提纲已锁定，专心表达" : state.pendingDraft ? "请先保存或丢弃本场录制" : state.actionBusy ? "正在处理本场记录…" : ready ? "准备完成，可以开始演讲" : state.points.length ? "确认采集说明，即可开始" : "先写下本场核心观点");
    $(".setup-ready").classList.toggle("ready", ready);
    $("#live-view").classList.toggle("session-active", active);
    const step = active ? 1 : state.reportSession ? 2 : 0;
    ["prepare", "live", "report"].forEach((name, index) => {
      const node = $(`#studio-step-${name}`);
      node.classList.toggle("current", index === step);
      node.classList.toggle("done", index < step);
      if (index === step) node.setAttribute("aria-current", "step"); else node.removeAttribute("aria-current");
    });
  }

  function renderRoute(scores) {
    $("#coach-route").innerHTML = scores.length ? scores.map(({ point, score }) => `<article class="route-node ${score >= .34 ? "covered" : score >= .15 ? "partial" : "pending"}"><span>POINT ${String(point.index + 1).padStart(2, "0")}</span><p>${esc(point.text)}</p><small>${!state.session && !point.evidence.length ? "准备讲述" : score >= .34 ? "候选覆盖 · 需复核" : score >= .15 ? "已出现部分线索" : "等待对应表达"}</small></article>`).join("") : '<div class="route-empty">写下核心观点，生成你的演讲路线。</div>';
  }

  function drawAudioWave(samples) {
    const canvas = $("#coach-audio-wave");
    const context = canvas.getContext("2d");
    if (!context) return;
    const width = canvas.width, height = canvas.height;
    context.clearRect(0, 0, width, height);
    context.strokeStyle = samples ? "#ae95c7" : "#e2d7ed";
    context.lineWidth = 1.5;
    context.beginPath();
    for (let x = 0; x < width; x += 2) {
      const amplitude = samples ? samples[Math.floor(x / width * samples.length)] : 0;
      const y = height / 2 - Math.max(-1, Math.min(1, amplitude * 4)) * height * .44;
      if (x === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.stroke();
  }

  function transcriptText() {
    if (!state.session) return "";
    return state.session.segments.map((item) => item.text).join(" ");
  }

  function pointScores() {
    const text = transcriptText();
    return state.points.map((point) => {
      const score = scorePoint(point, text);
      point.maxScore = Math.max(point.maxScore, score);
      return { point, score };
    });
  }

  function renderPoints() {
    const host = $("#coach-beats-list");
    setText("#coach-beat-count", `${state.points.length} 个`);
    if (!state.points.length) {
      host.innerHTML = `<div class="points-empty"><div class="empty-route" aria-hidden="true"><i></i><span></span><i></i><span></span><i></i></div><b>让重点，有一条清晰的路线</b><p>在左侧写下核心观点，<br>或选择一个参考案例开始。</p></div>`;
      setText("#coach-progress-text", "0 / 0 个重点已检测到");
      setText("#coach-progress-fill", "");
      $("#coach-progress-fill").style.width = "0%";
      setText("#coach-active-index", "待开始");
      renderRoute([]);
      return;
    }
    const scores = state.session ? pointScores() : state.points.map((point) => ({ point, score: point.maxScore || 0 }));
    const confirmed = scores.filter(({ score }) => score >= 0.34).length;
    const hints = scores.filter(({ score }) => score >= 0.15).length;
    renderRoute(scores);
    setText("#coach-progress-text", `${confirmed} / ${state.points.length} 个重点出现较多词汇线索`);
    setText("#coach-active-index", state.session ? `已发现 ${hints} 条线索` : "待开始");
    $("#coach-progress-fill").style.width = `${Math.round((confirmed / state.points.length) * 100)}%`;
    host.innerHTML = scores.map(({ point, score }) => {
      const status = score >= 0.34 ? ["候选已覆盖", "covered"] : score >= 0.15 ? ["出现部分线索", "partial"] : ["尚未发现", "pending"];
      const evidence = point.evidence.slice(-2).map((entry) => `${stamp(entry.at)}「${esc(entry.text)}」`).join(" · ") || "等待口头证据";
      const lastVoice = point.evidence[point.evidence.length - 1]?.voice;
      const voiceCue = lastVoice ? ` · 句间隔 ${lastVoice.pause === null ? "—" : `${lastVoice.pause.toFixed(1)}秒`}，响度相对基线 ${lastVoice.volumeDelta === null ? "待测" : `${lastVoice.volumeDelta >= 0 ? "+" : ""}${lastVoice.volumeDelta.toFixed(1)}dB`}` : "";
      const applause = point.applause.map((item) => item.source === "demo" ? "模拟掌声" : "现场记录").join("、");
      return `<article class="coach-beat ${status[1]}"><div class="beat-status-row"><span class="beat-number">POINT ${String(point.index + 1).padStart(2, "0")}</span><span class="beat-status">${state.session || point.evidence.length ? `${status[0]} · ${Math.round(score * 100)}%` : "准备讲述"}</span></div><strong>${esc(point.text)}</strong><div class="beat-score" aria-hidden="true"><i style="width:${Math.round(score * 100)}%"></i></div><p>${evidence}${esc(voiceCue)}</p>${applause ? `<small class="reaction-note">${esc(applause)}</small>` : ""}${state.session && !state.stopping ? `<div class="beat-actions"><button type="button" data-react="${esc(point.id)}">＋ 记录掌声/反应</button></div>` : ""}</article>`;
    }).join("");
    host.querySelectorAll("[data-react]").forEach((button) => button.addEventListener("click", () => recordReaction(button.dataset.react)));
    updateCue(scores);
  }

  function updateCue(scores = pointScores()) {
    if (!state.points.length) return;
    const first = scores.find(({ score }) => score < 0.34);
    const candidateNow = scores.find(({ score }) => score >= 0.15 && score < 0.34);
    if (!state.session) return;
    if (!first) {
      setText("#coach-cue-title", "主要观点均出现较多线索");
      setText("#coach-cue-copy", "结束前可以用一句话总结核心结论，并留出停顿让听众消化。自动匹配仍需你确认意思是否准确。");
      return;
    }
    const position = first.point.index + 1;
    if (candidateNow && candidateNow.point.id === first.point.id) {
      setText("#coach-cue-title", `第 ${position} 个重点已有线索`);
      const lastVoice = first.point.evidence[first.point.evidence.length - 1]?.voice;
      const voiceAdvice = lastVoice?.volumeDelta !== null && lastVoice?.volumeDelta < -2 ? "这句音量低于本场基线，可在观点前停顿一下，再用更清楚的音量说结论。" : "可以在观点前停顿一下，再用一句简短结论明确说出。";
      setText("#coach-cue-copy", `考虑把观点“${first.point.text.slice(0, 45)}${first.point.text.length > 45 ? "…" : ""}”再明确说一次。${voiceAdvice}`);
    } else {
      setText("#coach-cue-title", `还需要再强调第 ${position} 个核心要点`);
      setText("#coach-cue-copy", `下一步可以直接说出：“${first.point.text.slice(0, 54)}${first.point.text.length > 54 ? "…" : ""}”。这是基于词汇重合的提醒，请按你的真实意思判断。`);
    }
    const history = historyForPoint(first.point);
    const slowHints = [];
    if (history.misses >= 2) slowHints.push(`历史练习中这个重点有 ${history.misses} 次未出现足够词汇线索，可提前安排一句明确总结`);
    if (history.observed > 0) slowHints.push(`历史有 ${history.observed} 次现场反应手动记录；讲完结论后可留出停顿观察听众`);
    if (slowHints.length) setText("#coach-cue-copy", `${slowHints.join("；")}。当前提示基于公开历史记录与词汇匹配，不代表因果或语义判定。`);
  }

  function getSpeakerId() { return $("#coach-speaker").value.trim().toLowerCase().replace(/\s+/g, "-") || "anonymous"; }
  function pointKey(point) { return normalize(point.text).slice(0, 90); }
  function historyForPoint(point) {
    const key = pointKey(point); const id = getSpeakerId();
    const matches = allSavedSessions().filter((session) => session.speakerId === id).flatMap((session) => (session.points || []).filter((item) => pointKey(item) === key));
    const misses = matches.filter((item) => item.score < 0.15).length;
    const applause = matches.flatMap((item) => item.applause || []);
    return { count: matches.length, misses, observed: applause.filter((x) => x.source === "observed").length, demo: applause.filter((x) => x.source === "demo").length };
  }

  function renderMemory() {
    const id = getSpeakerId();
    const sessions = allSavedSessions().filter((session) => session.speakerId === id);
    setText("#coach-memory-count", `${sessions.length} 次历史练习`);
    if (!sessions.length) {
      $("#coach-memory").innerHTML = state.cloudState === "error" ? '<p>云端历史暂未读出，暂时无法生成完整的个性化提醒。连接恢复后会重新汇总。</p>' : `<p>尚无此记忆 ID 的历史记录。录制结束并选择保存后，可以回看观点线索、声音趋势和人工标记的反应。</p>`;
      return;
    }
    const pace = sessions.map((item) => item.metrics?.pace).filter(Number.isFinite);
    const avgPace = pace.length ? Math.round(pace.reduce((a, b) => a + b, 0) / pace.length) : null;
    const recurring = new Map();
    sessions.forEach((session) => (session.points || []).forEach((point) => {
      const key = pointKey(point); const entry = recurring.get(key) || { text: point.text, miss: 0, applause: [] };
      if (point.score < 0.15) entry.miss += 1;
      entry.applause.push(...(point.applause || [])); recurring.set(key, entry);
    }));
    const repeated = [...recurring.values()].filter((item) => item.miss >= 2).sort((a, b) => b.miss - a.miss)[0];
    const reactions = sessions.flatMap((session) => (session.points || []).flatMap((point) => point.applause || []));
    const observed = reactions.filter((item) => item.source === "observed").length;
    const demo = reactions.filter((item) => item.source === "demo").length;
    const observedPoint = [...recurring.values()].filter((item) => item.applause.some((entry) => entry.source === "observed"))
      .sort((a, b) => b.applause.filter((entry) => entry.source === "observed").length - a.applause.filter((entry) => entry.source === "observed").length)[0];
    const notes = [];
    notes.push(`<p>历史 ${sessions.length} 场${avgPace ? `；近场平均语速约 ${avgPace} 字/分钟` : ""}。</p>`);
    if (repeated) notes.push(`<p class="memory-alert">反复遗漏提示：曾有 ${repeated.miss} 场未检测到“${esc(repeated.text.slice(0, 42))}${repeated.text.length > 42 ? "…" : ""}”的足够词汇线索。</p>`);
    if (observedPoint) notes.push(`<p>历史现场反应记录较多的重点：“${esc(observedPoint.text.slice(0, 42))}${observedPoint.text.length > 42 ? "…" : ""}”（${observedPoint.applause.filter((entry) => entry.source === "observed").length} 次手动观察）。这次讲完相近结论后可留出停顿观察听众；这是经验提示，不代表因果判断。</p>`);
    if (observed || demo) notes.push(`<p>观众反应标记：现场观察 ${observed} 次，模拟信号 ${demo} 次（分开统计，不视为自动识别掌声）。</p>`);
    if (avgPace) notes.push(`<p>本场可以先把主要观点写成一句短句，在观点后停顿，再补例子；对照历史语速观察节奏变化。</p>`);
    $("#coach-memory").innerHTML = notes.join("");
  }

  function snapshotMetrics() {
    const active = state.session?.segments || [];
    const windowSeconds = Math.min(30, Math.max(1, elapsed()));
    const cutoff = elapsed() - windowSeconds;
    const recent = active.filter((item) => item.at >= cutoff);
    const chars = recent.reduce((sum, item) => sum + wordUnits(item.text), 0);
    const pace = Math.round(chars * (60 / windowSeconds));
    const pitches = state.audioSamples.map((item) => item.pitch).filter((x) => x > 60 && x < 450);
    const pitch = pitches.length ? Math.round(pitches[pitches.length - 1]) : null;
    const baseline = state.voiceBaseline.length ? state.voiceBaseline.reduce((a, b) => a + b, 0) / state.voiceBaseline.length : null;
    return { pace: recent.length ? pace : 0, volume: state.currentVolume, volumeDelta: state.currentVolume !== null && baseline !== null ? state.currentVolume - baseline : null, pitch, pause: state.session?.segments.length ? Math.max(0, elapsed() - state.lastUtteranceAt) : null };
  }
  function wordUnits(text) {
    const cjk = (String(text).match(/[\u3400-\u9fff]/gu) || []).length;
    const latin = (String(text).match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
    return cjk + latin;
  }
  function updateMetrics() {
    if (!state.session) return;
    const metrics = snapshotMetrics();
    setText("#coach-pace", metrics.pace ? String(metrics.pace) : "0");
    const baseline = state.voiceBaseline.length ? state.voiceBaseline.reduce((a, b) => a + b, 0) / state.voiceBaseline.length : null;
    if (metrics.volume !== null) {
      const delta = baseline === null ? 0 : metrics.volume - baseline;
      setText("#coach-volume", `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} dB`);
      setText("#coach-volume-note", baseline === null ? "相对音量估计" : delta > 4 ? "高于本场说话基线" : delta < -4 ? "低于本场说话基线" : "接近本场说话基线");
    }
    setText("#coach-pitch", metrics.pitch ? `${metrics.pitch} Hz` : "—");
    setText("#coach-pause", metrics.pause === null ? "—" : `${metrics.pause.toFixed(1)} 秒`);
  }

  function estimatePitch(buffer, sampleRate) {
    let energy = 0;
    for (let i = 0; i < buffer.length; i += 1) energy += buffer[i] * buffer[i];
    if (energy / buffer.length < 0.000025) return null;
    const minLag = Math.max(2, Math.floor(sampleRate / 400));
    const maxLag = Math.min(Math.floor(sampleRate / 65), Math.floor(buffer.length / 2));
    let bestLag = -1; let best = 0;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let correlation = 0;
      for (let i = 0; i < buffer.length - lag; i += 2) correlation += buffer[i] * buffer[i + lag];
      if (correlation > best) { best = correlation; bestLag = lag; }
    }
    return bestLag > 0 ? sampleRate / bestLag : null;
  }

  function startAudioAnalysis(stream) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error("此浏览器不支持 Web Audio 音量分析");
    state.audioContext = new Context();
    const source = state.audioContext.createMediaStreamSource(stream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 4096; state.analyser.smoothingTimeConstant = 0.25;
    source.connect(state.analyser);
    const data = new Float32Array(state.analyser.fftSize);
    const tick = () => {
      if (!state.session || state.stopping || !state.analyser) return;
      state.analyser.getFloatTimeDomainData(data);
      let energy = 0; for (let i = 0; i < data.length; i += 1) energy += data[i] * data[i];
      const rms = Math.sqrt(energy / data.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -90;
      if (rms > 0.008) {
        state.currentVolume = db;
      } else if (state.lastUtteranceAt) {
        state.currentVolume = db;
      }
      const now = performance.now();
      if (now - state.lastAnalysisAudioAt >= 200) {
        const at = elapsed();
        if (rms > .008 && state.voiceBaseline.length < 40) state.voiceBaseline.push(db);
        const baseline = state.voiceBaseline.length ? state.voiceBaseline.reduce((sum, value) => sum + value, 0) / state.voiceBaseline.length : null;
        state.analysisAudio.push({ at, rms, volumeDelta: baseline === null ? null : db - baseline, baselineReady: state.voiceBaseline.length >= 20 });
        state.analysisAudio = state.analysisAudio.filter(sample => sample.at >= at - 120);
        state.lastAnalysisAudioAt = now;
      }
      if (now - state.lastWaveAt > 70) { drawAudioWave(data); state.lastWaveAt = now; }
      if (now - (state.lastPitchAt || 0) > 850) {
        const pitch = estimatePitch(data, state.audioContext.sampleRate);
        state.currentPitch = pitch;
        state.audioSamples.push({ at: elapsed(), rms, pitch });
        state.lastPitchAt = now;
      }
      updateMetrics();
      requestAnimationFrame(tick);
    };
    state.audioContext.resume().catch(() => {});
    requestAnimationFrame(tick);
  }

  function getSpeechRecognition() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }
  function startSpeechRecognition() {
    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      setText("#coach-speech-support", "此浏览器没有语音识别；请使用下方输入框记录语句。");
      return;
    }
    const recognition = new Recognition();
    state.speech = recognition;
    recognition.lang = $("#coach-language").value; recognition.continuous = true; recognition.interimResults = true; recognition.maxAlternatives = 1;
    recognition.onspeechstart = () => { if (state.session && !state.stopping) { state.speechWindowStart = elapsed(); state.speechWindowEnd = null; } };
    recognition.onspeechend = () => { if (state.session) state.speechWindowEnd = elapsed(); };
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const item = event.results[i]; const text = item[0]?.transcript?.trim();
        if (!text) continue;
        if (item.isFinal) addSegment(text, "browser-asr", item[0]?.confidence); else interim += text;
      }
      if (interim) setText("#coach-transcript", `${transcriptText()} ${interim}`.trim());
      state.speechOn = true;
    };
    recognition.onerror = (event) => {
      if (event.error !== "no-speech" && event.error !== "aborted") setText("#coach-speech-support", `语音识别状态：${event.error}；可手动输入。`);
    };
    recognition.onend = () => {
      state.speechWindowStart = null; state.speechWindowEnd = null;
      if (state.session && state.speechOn && !state.stopping) { try { recognition.start(); } catch { /* Restart may be rejected while already transitioning. */ } }
    };
    try {
      recognition.start();
      setText("#coach-speech-support", "语音识别已启动；结果可能由浏览器语音服务处理。");
    } catch {
      setText("#coach-speech-support", "语音识别未启动；可手动输入语句。");
    }
  }

  function addSegment(text, source = "manual", asrConfidence = null) {
    const clean = String(text || "").trim();
    if (!clean || !state.session || state.stopping) return;
    const at = elapsed(), metrics = snapshotMetrics();
    const start = state.speechWindowStart === null ? null : Math.max(state.lastSegmentEnd, state.speechWindowStart);
    const end = Math.min(at, state.speechWindowEnd ?? at);
    const timed = source === "browser-asr" && start !== null && end > start && at - end < 3;
    const segment = { at: Number(at.toFixed(2)), text: clean, source, voice: metrics, visual: currentVisualCue(),
      time_span: timed ? [Number(start.toFixed(2)), Number(end.toFixed(2))] : null,
      timingQuality: timed ? "browser-estimate" : source === "manual" ? "manual" : "unknown",
      asrConfidence: Number.isFinite(asrConfidence) && asrConfidence > 0 ? asrConfidence : null,
      pointMatch: TalkEvalFit.matchPoint(state.points, clean) };
    const fit = TalkEvalFit.forLive(state.session, segment, state.visualWindow, state.analysisAudio);
    segment.contextFitIndex = state.session.contextFits.length;
    state.session.segments.push(segment); state.session.contextFits.push(fit);
    if (source === "browser-asr") { state.lastSegmentEnd = end; state.speechWindowStart = state.speechWindowEnd === null ? end : null; state.speechWindowEnd = null; }
    state.lastUtteranceAt = at; state.lastSpeechAt = at;
    const scores = pointScores();
    scores.forEach(({ point }) => {
      const segmentScore = scorePoint(point, clean);
      if (segmentScore >= 0.12) point.evidence.push({ at: segment.at, text: clean, score: Number(segmentScore.toFixed(3)), visual: segment.visual, voice: metrics, contextStatus: fit.status });
    });
    state.session.timeline.push({ at: segment.at, type: "speech", text: clean, activePoint: segment.pointMatch.pointId, scores: scores.map(({ point, score }) => ({ id: point.id, score: Number(score.toFixed(3)) })), voice: metrics, visual: segment.visual });
    $("#coach-context-fit").innerHTML = TalkEvalFit.card(fit, { compact: true, seekAttribute: null });
    setText("#visual-point-note", segment.pointMatch.reliable ? `当前语句对应：${segment.pointMatch.pointText}` : "当前语句尚未明确对应提纲；先依据这句话复核表情与动作。");
    updateTranscript(); renderPoints(); updateMetrics();
  }

  function updateTranscript() {
    const segments = state.session?.segments || [];
    const last = segments.slice(-5).map((item) => `${stamp(item.at)} ${item.text}`).join("\n");
    setText("#coach-transcript", last || "等待语音识别…");
    setText("#coach-transcript-count", `${segments.length} 句`);
  }

  function currentVisualCue() {
    const sample = state.visualWindow[state.visualWindow.length - 1];
    return sample ? { at: sample.timestamp, face: sample.faceText, gesture: sample.gestureText } : { face: "未检测", gesture: "未检测" };
  }

  function setVisualStatus(text, cue = null) {
    setText("#visual-status", text);
    if (cue) setText("#visual-now", cue);
  }

  async function loadVision() {
    if (state.faceTask && state.poseTask) { runVisionLoop(); return; }
    if (state.visionLoading) return;
    state.visionLoading = true;
    setText("#coach-model-status", "正在加载本地视觉模型（首次加载会下载模型文件）…");
    try {
      const vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm");
      const files = await vision.FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
      const faceModel = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
      const poseModel = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
      state.faceTask = await vision.FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: faceModel, delegate: "CPU" }, runningMode: "IMAGE", numFaces: 1, outputFaceBlendshapes: true });
      state.poseTask = await vision.PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: poseModel, delegate: "CPU" }, runningMode: "IMAGE", numPoses: 1 });
      setText("#coach-model-status", "视觉模型已就绪；逐帧定位人物，漏检时重新检测人物和头部区域。");
      setVisualStatus("视觉观察中", "等待有效人脸与身体关键点。分数表示可见动作强度，不代表情绪或得当程度。");
      runVisionLoop();
    } catch (error) {
      setText("#coach-model-status", `视觉模型未能加载：${error.message}；本场仍可用语音和手动转写。`);
      setVisualStatus("模型不可用", "无法取得视觉模型；请确保网络允许加载 MediaPipe CDN 和模型文件。摄像头画面仍只显示在本机浏览器。");
    } finally { state.visionLoading = false; }
  }

  // Independent images prevent stale tracking across subject movement and camera changes.
  function detectLiveFrame(video) {
    const width = video.videoWidth, height = video.videoHeight;
    const canvas = state.visionCropCanvas || (state.visionCropCanvas = document.createElement("canvas"));
    const crop = box => {
      const [x0, y0, x1, y1] = box.map(value => Math.max(0, Math.min(1, value)));
      canvas.width = Math.max(1, Math.round((x1 - x0) * width));
      canvas.height = Math.max(1, Math.round((y1 - y0) * height));
      canvas.getContext("2d").drawImage(video, x0 * width, y0 * height, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      return { image: canvas, box: [x0, y0, x1, y1] };
    };
    const plausible = points => {
      if (!points?.length) return false;
      const [nose, left, right, lh, rh] = [0, 11, 12, 23, 24].map(index => points[index]);
      const shoulder = Math.hypot((left.x - right.x) * width, (left.y - right.y) * height);
      if (shoulder < 8 || Math.min(left.visibility, right.visibility) < .5) return false;
      if (nose.visibility >= .5 && ((left.y + right.y) / 2 - nose.y) * height < shoulder * .08) return false;
      return !(Math.min(lh.visibility, rh.visibility) >= .5 && ((lh.y + rh.y - left.y - right.y) / 2) * height < shoulder * .5);
    };
    let pose = state.poseTask.detect(video), faceView = "full_frame";
    if (!plausible(pose.landmarks?.[0])) {
      pose = { landmarks: [] };
      for (const box of [[.2, 0, .8, 1], [0, 0, .55, 1], [.45, 0, 1, 1]]) {
        const patch = crop(box), result = state.poseTask.detect(patch.image);
        const [x0, y0, x1, y1] = patch.box;
        const points = result.landmarks?.[0]?.map(point => ({ ...point, x: x0 + point.x * (x1 - x0), y: y0 + point.y * (y1 - y0) }));
        if (plausible(points)) { pose = { landmarks: [points] }; break; }
      }
    }
    let face = state.faceTask.detect(video);
    const points = pose.landmarks?.[0];
    if (points && points[0].visibility >= .5) {
      const nose = points[0], shoulder = Math.hypot((points[11].x - points[12].x) * width, (points[11].y - points[12].y) * height);
      const mesh = face.faceLandmarks?.[0];
      if (mesh && Math.hypot((mesh[1].x - nose.x) * width, (mesh[1].y - nose.y) * height) > shoulder) face = { faceLandmarks: [], faceBlendshapes: [] };
      if (!face.faceLandmarks?.length) {
        for (const scale of [.8, 1.3]) {
          const cw = Math.max(40, shoulder * scale), ch = Math.max(48, shoulder * scale * 1.3);
          const patch = crop([nose.x - cw / width / 2, nose.y - ch / height * .45, nose.x + cw / width / 2, nose.y + ch / height * .55]);
          const candidate = state.faceTask.detect(patch.image);
          if (candidate.faceLandmarks?.length) { face = candidate; faceView = "person_head_crop"; break; }
        }
      }
    }
    return { face, pose, faceView };
  }

  function runVisionLoop() {
    if (state.visualRaf) cancelAnimationFrame(state.visualRaf);
    const video = $("#coach-video"), canvas = $("#coach-overlay"), context = canvas.getContext("2d");
    const visible = point => point && point.visibility >= .5 && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
    const loop = () => {
      if (!state.session || state.stopping || !state.faceTask || !state.poseTask) return;
      if (video.readyState >= 2 && performance.now() - state.lastVisionAt >= 200) {
        state.lastVisionAt = performance.now();
        try {
          const at = elapsed();
          const { face, pose, faceView } = detectLiveFrame(video);
          const categories = face.faceBlendshapes?.[0]?.categories || [];
          const coefficients = Object.fromEntries(categories.map(item => [item.categoryName, Number(item.score.toFixed(4))]));
          const get = name => coefficients[name] ?? 0;
          const smile = (get("mouthSmileLeft") + get("mouthSmileRight")) / 2;
          const brow = Math.max(get("browInnerUp"), get("browOuterUpLeft"), get("browOuterUpRight")), jaw = get("jawOpen");
          const faceVisible = Boolean(face.faceLandmarks?.length);
          const faceCue = !faceVisible ? "该帧人脸模型暂无结果" : smile > .5 ? "观察到嘴角上提" : brow > .52 ? "观察到眉部上提" : jaw > .58 ? "观察到张口动作" : "面部可见，动作变化较小";
          const landmarks = pose.landmarks?.[0] || [], ls = landmarks[11], rs = landmarks[12];
          // Measure in body coordinates and reset on occlusion, large scale changes or sampling gaps.
          const aspect = (video.videoWidth || 640) / (video.videoHeight || 360);
          const shoulderWidth = visible(ls) && visible(rs) ? Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y) : 0;
          const center = shoulderWidth >= .02 ? { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 } : null;
          const previous = state.previousWrists, dt = previous ? at - previous.at : 0;
          const comparable = center && previous && dt > 0 && dt <= .8 && shoulderWidth / previous.width > .7 && shoulderWidth / previous.width < 1.4 && previous.center && Math.hypot((center.x - previous.center.x) * aspect, center.y - previous.center.y) <= Math.max(shoulderWidth, previous.width);
          const hands = {}, positions = {};
          for (const [side, index] of [["left", 15], ["right", 16]]) {
            const wrist = landmarks[index];
            if (!visible(wrist)) { hands[side] = { visible: false, movement: "not_comparable" }; positions[side] = null; continue; }
            const position = center ? { x: (wrist.x - center.x) * aspect / shoulderWidth, y: (wrist.y - center.y) / shoulderWidth } : null;
            positions[side] = position;
            const speed = comparable && position && previous[side] ? Math.hypot(position.x - previous[side].x, position.y - previous[side].y) / dt : null;
            const dx = comparable && position && previous[side] ? position.x - previous[side].x : null;
            const dy = comparable && position && previous[side] ? position.y - previous[side].y : null;
            const direction = dx === null ? null : Math.abs(dx) > Math.abs(dy) ? Math.abs(position.x) > Math.abs(previous[side].x) ? "outward" : "inward" : dy < 0 ? "upward" : "downward";
            hands[side] = { comparison_interval_seconds: comparable ? dt : null, motion_direction: direction, visible: true, visibility: Number(wrist.visibility.toFixed(3)), movement: speed === null ? "not_comparable" : speed >= TalkEvalFit.CONFIG.motionSpeed ? "clear_motion" : "small_motion", body_xy: position ? [Number(position.x.toFixed(4)), Number(position.y.toFixed(4))] : null, position: position ? position.y < 0 ? "above_shoulder" : position.y < 1.8 ? "torso_level" : "below_waist" : null, speed_body_per_second: speed === null ? null : Number(speed.toFixed(4)) };
          }
          state.previousWrists = center ? { at, center, width: shoulderWidth, ...positions } : null;
          const validHands = Object.values(hands).filter(hand => hand.movement !== "not_comparable");
          const gestureCue = validHands.some(hand => hand.movement === "clear_motion") ? "观察到相对身体的手部变化" : validHands.length ? "可见手部变化较小" : "手部或肩部关键点尚未连续检出，原因未确认";
          const sample = { timestamp: Number(at.toFixed(3)), face: { visible: faceVisible, view: faceView, detector_status: faceVisible ? "detected" : "not_detected_unknown_cause", blendshape_scores: coefficients }, pose: { hands }, faceText: faceCue, gestureText: gestureCue };
          state.visualWindow.push(sample); state.visualWindow = state.visualWindow.filter(item => item.timestamp >= at - 120);
          if (at - state.lastVisualArchiveAt >= 1) {
            // Retain all returned coefficients as a compact vector; names are stored once per session.
            const names = state.session.visualSampling.coefficient_names || Object.keys(coefficients);
            if (names.length) state.session.visualSampling.coefficient_names = names;
            state.visualSummary.push({ timestamp: sample.timestamp, face: { visible: faceVisible, blendshape_values: names.map(name => coefficients[name] ?? null) }, pose: sample.pose });
            state.lastVisualArchiveAt = at;
          }
          setVisualStatus("观察中 · 逐句复核", `${faceCue}；${gestureCue}。`);
          if (Math.round(at) % 5 === 0) {
            const lastVisual = [...state.session.timeline].reverse().find(item => item.type === "visual");
            if (!lastVisual || at - lastVisual.at > 4) state.session.timeline.push({ at: sample.timestamp, type: "visual", visual: currentVisualCue() });
          }
          canvas.width = video.videoWidth || 640; canvas.height = video.videoHeight || 360;
          context.clearRect(0, 0, canvas.width, canvas.height); context.fillStyle = "rgba(91,210,192,.85)";
          landmarks.forEach((point, index) => {
            if ([11, 12, 13, 14, 15, 16, 23, 24].includes(index) && visible(point)) {
              context.beginPath(); context.arc(point.x * canvas.width, point.y * canvas.height, index === 15 || index === 16 ? 7 : 4, 0, Math.PI * 2); context.fill();
            }
          });
        } catch (error) { state.previousWrists = null; setVisualStatus("视觉分析暂不可用", error.message); }
      }
      state.visualRaf = requestAnimationFrame(loop);
    };
    state.visualRaf = requestAnimationFrame(loop);
  }

  async function shareScreen() {
    if (!state.session) { setText("#screen-status", "请先开始演讲"); return; }
    if (state.screenStream) { stopScreen(); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { setText("#screen-status", "浏览器不支持屏幕共享"); return; }
    try {
      state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
      $("#screen-video").srcObject = state.screenStream;
      $("#screen-placeholder").hidden = true;
      $("#share-screen span").textContent = "停止共享 PPT";
      setText("#screen-status", "正在读取");
      state.screenStream.getVideoTracks()[0].addEventListener("ended", stopScreen);
      if (!state.ocrWorker) loadOcrWorker().catch((error) => setText("#screen-status", `OCR 无法加载：${error.message}`));
      state.ocrTimer = setInterval(() => runOcr().catch((error) => setText("#screen-status", `识别失败：${error.message}`)), 12000);
      runOcr().catch(() => {});
    } catch (error) { setText("#screen-status", error.name === "NotAllowedError" ? "未授权屏幕共享" : `共享失败：${error.message}`); }
  }
  function stopScreen() {
    if (state.ocrTimer) clearInterval(state.ocrTimer); state.ocrTimer = null;
    state.screenStream?.getTracks().forEach((track) => track.stop()); state.screenStream = null;
    $("#screen-video").srcObject = null; setText("#screen-status", "未共享");
    $("#screen-placeholder").hidden = false;
    $("#share-screen span").textContent = "共享 PPT 窗口";
  }
  async function loadOcrWorker() {
    if (state.ocrWorker) return state.ocrWorker;
    if (state.ocrLoading) return state.ocrLoading;
    setText("#screen-status", "正在加载 OCR 文字识别…");
    state.ocrLoading = (async () => {
      const tesseract = await import("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js");
      state.ocrWorker = await tesseract.createWorker(["chi_sim", "eng"]);
      setText("#screen-status", "OCR 已就绪");
      return state.ocrWorker;
    })();
    try { return await state.ocrLoading; }
    finally { state.ocrLoading = null; }
  }
  function slideFit(text, point) {
    if (!point || !text) return null;
    const slides = grams(text); const target = point.features;
    let matched = 0; target.forEach((part) => { if (slides.has(part)) matched += 1; });
    return target.size ? matched / target.size : 0;
  }
  async function runOcr() {
    if (!state.screenStream || state.ocrBusy || !$("#screen-video").videoWidth) return;
    state.ocrBusy = true;
    try {
      if (!state.ocrWorker) await loadOcrWorker();
      const video = $("#screen-video"); const canvas = document.createElement("canvas");
      const ratio = Math.min(1, 1280 / video.videoWidth); canvas.width = Math.round(video.videoWidth * ratio); canvas.height = Math.round(video.videoHeight * ratio);
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      const result = await state.ocrWorker.recognize(canvas);
      const text = (result.data.text || "").replace(/\s+/g, " ").trim();
      const scores = pointScores(); const active = scores.find(({ score }) => score < .34)?.point;
      const fit = slideFit(text, active);
      const prior = state.session.slides[state.session.slides.length - 1];
      const changed = Boolean(text) && (!prior || textSimilarity(text, prior.text) < .72);
      const pageNo = prior ? prior.pageNo + (changed ? 1 : 0) : (text ? 1 : 0);
      const event = { at: Number(elapsed().toFixed(1)), text: text.slice(0, 1000), pointId: active?.id || null, lexicalFit: fit === null ? null : Number(fit.toFixed(3)), changed, pageNo };
      state.session.timeline.push({ ...event, type: "slide" }); state.session.slides.push(event);
      setText("#screen-slide-label", `${changed ? `检测到页面变化 · 第 ${pageNo} 页` : `第 ${pageNo || "?"} 页文字抽样`} · ${stamp(event.at)}`);
      setText("#screen-current-text", text || "未识别出文字；此页可能以图像或图表为主。");
      setText("#screen-match-note", fit === null ? "等待当前核心观点。OCR 仅抽取文字，不判断内容是否真正支持观点。" : `与下一待讲重点的词汇重合约 ${Math.round(fit * 100)}%；这不是语义判定。`);
      setText("#screen-status", "已读取一帧");
      $("#screen-history").insertAdjacentHTML("afterbegin", `<div class="screen-history-item"><b>${stamp(event.at)}${changed ? ` · 第${pageNo}页变化` : ""}</b><span>${esc(text.slice(0, 115) || "未识别到文字")}</span></div>`);
      $("#screen-history").querySelectorAll(".screen-history-item").forEach((node, index) => { if (index > 4) node.remove(); });
    } finally { state.ocrBusy = false; }
  }

  function recordReaction(pointId) {
    if (!state.session) return;
    const point = state.points.find((item) => item.id === pointId);
    if (!point) return;
    const source = $("#coach-reaction-mode").value;
    const event = { at: Number(elapsed().toFixed(1)), source };
    point.applause.push(event);
    state.session.timeline.push({ ...event, type: "reaction", pointId, pointText: point.text });
    renderPoints(); renderMemory();
  }

  async function startSession() {
    if (!$("#coach-consent").checked || !state.points.length || state.session || state.pendingDraft || state.actionBusy) return;
    state.points = state.points.map((point) => ({ ...point, evidence: [], maxScore: 0, applause: [] }));
    state.audioSamples = []; state.voiceBaseline = []; state.visualSummary = []; state.previousWrists = null;
    state.visualWindow = []; state.analysisAudio = []; state.lastVisualArchiveAt = -1;
    state.speechWindowStart = null; state.speechWindowEnd = null; state.lastSegmentEnd = 0; state.lastAnalysisAudioAt = 0;
    state.lastUtteranceAt = 0; state.currentVolume = null; state.currentPitch = null;
    $("#coach-context-fit").innerHTML = '<p class="fit-empty">等待本场第一段语句与画面证据。</p>';
    setText("#visual-point-note", "结合当前语句、表达目标与可见画面复核。");
    const topic = $("#coach-topic").value.trim() || "未命名演讲";
    const sessionId = `live-${crypto.randomUUID()}`;
    shared.ownerKey(sessionId,true);
    state.session = { id: sessionId, language: $("#coach-language").value.slice(0,2), topic, caseId: state.selectedCase, speakerId: getSpeakerId(), startedAt: Date.now(), endedAt: null, segments: [], timeline: [], slides: [], points: [], metrics: {}, report: "", expressionGoal: $("#coach-expression-goal").value, contextFits: [], contextFitVersion: TalkEvalFit.VERSION, visualSampling: { analysis_target_interval_seconds: .2, archive_target_interval_seconds: 1, retention: "whole_session_compact_samples_and_all_segment_verdicts", timing: "browser_estimate" } };
    state.reportSession = null;
    updateStartAvailability();
    $("#coach-manual-text").disabled = true; $("#coach-add-text").disabled = true; $("#share-screen").disabled = true;
    $("#coach-report").hidden = true;
    $("#screen-history").innerHTML = "";
    $("#screen-video").srcObject = null;
    setText("#coach-status", "正在申请摄像头和麦克风…");
    try {
      state.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 540 } }, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
      $("#coach-video").srcObject = state.cameraStream;
      state.session.startedAt = Date.now();
      startVideoRecording(state.cameraStream, sessionId);
      $("#coach-camera-placeholder").hidden = true;
      setText("#coach-camera-mode", "正在录制 · 结束后选择是否保存");
      setText("#coach-wave-state", "实时麦克风采样");
      startAudioAnalysis(state.cameraStream);
      setText("#coach-status", "演讲进行中"); $("#coach-led").classList.add("active");
      $("#coach-start").disabled = true; $("#coach-stop").disabled = false;
      state.speechOn = true; startSpeechRecognition(); loadVision();
      state.timer = setInterval(() => { setText("#coach-timer", stamp(elapsed())); updateMetrics(); }, 500);
      $("#coach-manual-text").value = "";
      updateTranscript(); updateStartAvailability();
      renderPoints(); renderMemory();
    } catch (error) {
      state.cameraStream?.getTracks().forEach(track => track.stop()); state.cameraStream = null;
      $("#coach-video").srcObject = null; $("#coach-camera-placeholder").hidden = false;
      if (state.audioContext) { await state.audioContext.close().catch(() => {}); state.audioContext = null; }
      state.analyser = null;
      state.session = null; setText("#coach-status", `无法开始：${error.message}`);
      setText("#coach-camera-mode", "摄像头尚未开启"); setText("#coach-wave-state", "等待麦克风");
      drawAudioWave(); updateStartAvailability();
    }
  }

  function makeReport(session) {
    const minutes = Math.max(0.1, (session.endedAt - session.startedAt) / 60000);
    const chars = session.segments.reduce((sum, item) => sum + wordUnits(item.text), 0);
    const scores = session.points.map((point) => ({ ...point, score: scorePoint(point, session.segments.map((item) => item.text).join(" ")) }));
    const full = scores.filter((point) => point.score >= .34).length;
    const partial = scores.filter((point) => point.score >= .15 && point.score < .34).length;
    const missing = scores.filter((point) => point.score < .15).length;
    const pace = Math.round(chars / minutes);
    const audio = session.audio || [];
    const pitches = audio.map((item) => item.pitch).filter((item) => item > 60 && item < 450);
    const pitchRange = pitches.length ? `${Math.round(Math.min(...pitches))}–${Math.round(Math.max(...pitches))} Hz` : "样本不足";
    const volume = audio.filter((item) => item.rms > .008).map((item) => item.rms);
    const volumeRange = volume.length ? `${Math.min(...volume).toFixed(3)}–${Math.max(...volume).toFixed(3)} RMS` : "样本不足";
    const slides = session.slides || [];
    const visual = session.visual || [];
    const reactions = scores.flatMap((point) => point.applause || []);
    const observed = reactions.filter((item) => item.source === "observed").length;
    const demo = reactions.filter((item) => item.source === "demo").length;
    const lines = [
      `《${session.topic}》现场演讲复盘`,
      `时间：${new Date(session.startedAt).toLocaleString("zh-CN")}；时长约 ${Math.round(minutes * 10) / 10} 分钟；记忆 ID：${session.speakerId}`,
      "",
      `一、观点推进：本次共 ${session.points.length} 个核心观点。词汇线索较多 ${full} 个，出现部分线索 ${partial} 个，未发现足够词汇线索 ${missing} 个。该结果来自提纲与转写的词汇重合，不能单独证明语义已经传达。`,
      ...scores.map((point, index) => `  ${index + 1}. ${point.score >= .34 ? "候选覆盖" : point.score >= .15 ? "部分线索" : "需复核/补充"}（${Math.round(point.score * 100)}%）：${point.text}${point.evidence?.length ? `；证据：${point.evidence.slice(-3).map((entry) => `“${entry.text}”`).join("、")}${point.evidence[point.evidence.length - 1].visual ? `；相邻动作线索：${point.evidence[point.evidence.length - 1].visual.face}，${point.evidence[point.evidence.length - 1].visual.gesture}` : ""}${Number.isFinite(point.evidence[point.evidence.length - 1].voice?.volumeDelta) ? `；该句响度相对基线 ${point.evidence[point.evidence.length - 1].voice.volumeDelta.toFixed(1)} dB` : ""}` : "；未记录到对应转写证据"}`),
      "",
      `二、声音节奏：估算语速约 ${pace} 字/分钟；采集的音高大致 ${pitchRange}；音量 RMS 范围 ${volumeRange}。观点卡片会附上对应句子的相对响度和句间隔，供检查重点是否通过声音突出。声音强弱与音高为浏览器实时音频抽样，不等同于专业声学测量；停顿以转写片段间隔粗略估计。`,
      `三、表情与动作语境适配：表达目标为“${TalkEvalFit.GOALS[session.expressionGoal] || "随内容观察"}”。保留 ${visual.length} 条全场精简视觉抽样与 ${(session.contextFits || []).length} 条逐句复核结果。以下为规则候选，需结合录像复核；缺失画面和不可靠时间对应不强行打分。`,
      ...(session.contextFits || []).map(fit => `  ${TalkEvalFit.summaryText(fit)}`),
      `四、PPT 配合：读取到 ${slides.length} 次 OCR 抽样，约检测到 ${slides.filter((slide) => slide.changed).length} 次页面变化。${slides.length ? slides.filter((slide) => slide.changed).map((slide) => `第${slide.pageNo}页约在 ${stamp(slide.at)} 切换（与下一待讲重点词汇重合 ${slide.lexicalFit === null ? "未比较" : `${Math.round(slide.lexicalFit * 100)}%`}）`).join("；") : "本场未共享投影。"}抽帧间隔约 12 秒，因此切换时刻只是近似位置；文字重合不能判断图表含义、切换是否恰当或页面是否真正支持观点。`,
      `五、观众反应：现场观察标记 ${observed} 次；模拟标记 ${demo} 次。两类均为演讲者手动记录，并非自动掌声识别。`,
      "",
      `建议：${missing ? `下次把未发现足够线索的第 ${scores.findIndex((point) => point.score < .15) + 1} 个观点改写成一句易复述的结论，并在演讲提纲中安排明确强调。` : "主要观点均出现较多词汇线索；可以复听关键观点段，确认意思、例子与总结一致。"}${slides.length ? " PPT 节奏与观点对应仍需结合录像逐段确认。" : " 若要检查 PPT 配合，可在演讲期间共享幻灯片窗口。"}`,
      "",
      "数据范围：录制结束后由演讲者选择保存或丢弃；仅选择保存时才向公开云端上传录像（含人脸和声音）、转写及报告。同步是否成功以历史列表状态为准。浏览器语音识别可能使用在线服务。",
    ];
    return { text: lines.join("\n"), scores, pace, pitchRange, volumeRange, observed, demo };
  }

  function setChoiceBusy(busy) {
    state.actionBusy = busy;
    document.querySelectorAll("[data-draft-action], #coach-delete-confirm, #coach-delete-cancel, #coach-delete-local").forEach(button => { button.disabled = busy; });
    updateStartAvailability();
  }
  function showDraftChoice() {
    if (!state.pendingDraft || state.actionBusy) return;
    const draft = state.pendingDraft;
    setText("#coach-save-summary", `《${draft.topic}》 · ${stamp((draft.endedAt - draft.startedAt) / 1000)} · ${(draft.segments || []).length} 条转写`);
    setText("#coach-save-progress", draft.videoSaved ? "录像和报告暂存在本设备，尚未上传，也未加入历史。" : `本场录像未完整保存：${draft.videoError || "无可用录像"}。可以保存文字报告，或丢弃本场。`);
    if (!$("#coach-save-dialog").open) $("#coach-save-dialog").showModal();
  }
  function clearReport(id) {
    if (state.reportSession?.id !== id) return;
    $("#coach-replay-video")?.pause();
    if (state.replayUrl) URL.revokeObjectURL(state.replayUrl);
    state.replayUrl = null; state.reportSession = null;
    $("#coach-replay-detail").innerHTML = ""; $("#coach-report-text").value = "";
    $("#coach-report").hidden = true;
    if (!state.session) {
      $("#coach-context-fit").innerHTML = '<p class="fit-empty">等待下一场演讲的语句与画面证据。</p>';
      setText("#visual-point-note", "本场复盘已关闭。");
    }
  }
  async function stopSession() {
    if (!state.session || state.stopping) return;
    state.stopping = true; $("#coach-stop").disabled = true; updateStartAvailability();
    state.session.endedAt = Date.now();
    setText("#coach-status", "正在结束录制…"); state.speechOn = false;
    try { state.speech?.stop(); } catch { /* Already stopped. */ }
    state.speech = null;
    if (state.timer) clearInterval(state.timer); state.timer = null;
    if (state.visualRaf) cancelAnimationFrame(state.visualRaf); state.visualRaf = null;
    stopScreen();
    let recordingResult = null;
    let videoError = "";
    try { recordingResult = await finishVideoRecording(); }
    catch (error) { videoError = error.message || "录像保存失败"; }
    state.cameraStream?.getTracks().forEach(track => track.stop()); state.cameraStream = null;
    $("#coach-video").srcObject = null; $("#coach-camera-placeholder").hidden = false;
    if (state.audioContext) { await state.audioContext.close().catch(() => {}); state.audioContext = null; }
    state.session.points = state.points.map(point => ({ id: point.id, text: point.text, claims: point.claims || [], score: scorePoint(point, transcriptText()), evidence: point.evidence, applause: point.applause }));
    state.session.audio = state.audioSamples; state.session.visual = state.visualSummary;
    const summary = makeReport(state.session);
    const draft = { ...state.session, report: summary.text,
      videoSaved: Boolean(recordingResult?.localReady), videoChunks: recordingResult?.chunks || state.recordingChunkCount,
      videoError: videoError || state.recordingLocalError, cloudVideoReady: false, cloudStored: false, cloudUploadAttempted: false,
      metrics: { pace: summary.pace, pitchRange: summary.pitchRange, volumeRange: summary.volumeRange } };
    state.pendingDraft = draft;
    state.session = null; state.audioSamples = []; state.voiceBaseline = []; state.visualSummary = []; state.previousWrists = null;
    state.stopping = false; state.analyser = null; state.visualWindow = []; state.analysisAudio = [];
    drawAudioWave(); setText("#coach-camera-mode", "摄像头已关闭"); setText("#coach-wave-state", "本场采集已结束");
    setText("#coach-status", "录制结束 · 待选择保存"); $("#coach-led").classList.remove("active");
    $("#coach-report").hidden = false; $("#coach-report-text").value = summary.text;
    $("#coach-draft-banner").hidden = false;
    renderReplay(draft); renderPoints(); updateStartAvailability();
    setText("#coach-cue-title", "本场录制已结束"); setText("#coach-cue-copy", "先回看本场表现，再选择保存或丢弃。选择保存后才会上传至公开云端。");
    showDraftChoice();
  }
  async function saveDraft() {
    if (!state.pendingDraft || state.actionBusy) return;
    const draft = state.pendingDraft;
    setChoiceBusy(true);
    const notice=text=>{let box=$("#shared-save-outcome");if(!box){box=document.createElement('p');box.id='shared-save-outcome';box.className='history-feedback shared-save-outcome';box.setAttribute('role','status');$("#coach-report").prepend(box);}box.textContent=text;setText('#coach-history-feedback',text);};
    try {
      // A failed local write leaves the draft available. No upload has happened yet.
    const saved = { ...draft, caseBundleVersion: 'F12', saveDecision: "saved", savedAt: Date.now() };
      persistSession(saved);
      state.pendingDraft = null; $("#coach-draft-banner").hidden = true;
      setText("#coach-save-progress", "已保存在本机，正在同步到公开云端…");
      $("#coach-report").hidden = false; $("#coach-report-text").value = saved.report;
      renderReplay(saved); renderSessions(); renderMemory();
      notice("已保存本机并加入本机案例，正在上传到共享案例库…");
      try {
        const synced = await syncSavedSession(saved);
        notice(synced.cloudVideoReady ? "已共享：其他账号可在历史复盘和案例投放中查看录像与转写。" : "文字报告已共享并加入案例库；本场没有可播放的录像。");
        setText("#coach-status", synced.cloudVideoReady ? "录像与报告已同步云端" : "报告已同步云端");
        setText("#coach-cue-title", synced.cloudVideoReady ? "本场演讲已保存" : "本场报告已保存");
        setText("#coach-cue-copy", synced.cloudVideoReady ? "录像、报告与时间线已保存到公开云端，其他设备可查看。" : (synced.cloudUploadError || "文字报告已同步；本场没有完整的可用录像。"));
      } catch (error) {
        notice(`仅保存在本机，其他账号暂时看不到：${error.message} 可在下方“重试公开同步”。`);
        setText("#coach-status", "已保存本机 · 云端同步未完成");
        setText("#coach-cue-title", "本机记录已保留");
        setText("#coach-cue-copy", `云端同步未完成：${error.message}。可在复盘中重试同步或下载备份。`);
      }
      $("#coach-save-dialog").close();
      $("#coach-report").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      setText("#coach-save-progress", `尚未保存：${error.message}。本场仍待选择，可下载备份后重试或丢弃。`);
      if (!$("#coach-save-dialog").open) $("#coach-save-dialog").showModal();
    } finally { setChoiceBusy(false); }
  }
  async function discardDraft() {
    if (!state.pendingDraft || state.actionBusy) return;
    const draft = state.pendingDraft;
    setChoiceBusy(true);
    try {
      await deleteRecording(draft.videoId || draft.id);
      clearReport(draft.id);
      state.pendingDraft = null; $("#coach-draft-banner").hidden = true;
      $("#coach-save-dialog").close();
      state.points = state.points.map(point => ({ ...point, evidence: [], maxScore: 0, applause: [] }));
      updateTranscript();
      $("#screen-history").innerHTML = "";
      $("#coach-manual-text").value = "";
      setVisualStatus("等待下一场演讲", "本场观察已丢弃。");
      renderPoints(); renderSessions(); renderMemory();
      setText("#coach-status", "本场已丢弃"); setText("#coach-cue-title", "准备下一次表达");
      setText("#coach-cue-copy", "本场临时录像和报告已丢弃，没有加入历史，也没有上传到云端。");
    } catch (error) {
      setText("#coach-save-progress", `暂未清理成功：${error.message}。请重试丢弃。`);
      if (!$("#coach-save-dialog").open) $("#coach-save-dialog").showModal();
    } finally { setChoiceBusy(false); }
  }
  function needsCloudDelete(session) { return deletionScope(session) !== "local"; }
  async function deleteFromCloud(id) {
    const response = await cloudFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (response.status !== 204) {
      let result;
      try { result = await response.json(); } catch { throw new Error("后台没有返回可确认的删除结果，云端记录仍待核实。"); }
      if (result.deleted !== true || result.id !== id) throw new Error("后台尚未确认这条记录及录像已完整删除。");
    }
  }
  async function removeLocalSession(job) {
    await deleteRecording(job.videoId || job.id);
    if (job.videoId && job.videoId !== job.id) await deleteRecording(job.id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(readSessions().filter(item => item.id !== job.id)));
    job.localDeleted = true; job.localError = "";
    saveDeletionJob(job);
    state.remoteSessions = state.remoteSessions.filter(item => item.id !== job.id);
    clearReport(job.id);
  }
  function requestDelete(session) {
    if (state.actionBusy || state.deletionFlush || state.syncingIds.has(session.id)) return;
    state.deleteTarget = session;
    const scope = deletionScope(session);
    const offline = scope !== "local" && state.cloudState === "error";
    setText("#coach-delete-title", `删除《${session.topic}》？`);
    setText("#coach-delete-description", scope === "local"
      ? "这条记录只需清理本机。将删除本设备的录像、报告和分析数据，不需要连接云端。删除后无法恢复。"
      : offline
        ? "目前连接不到云端。确认后将删除本机录像与报告，并保留云端待删请求；本机删除无法恢复，其他设备上的云端副本可能仍可见。"
      : scope === "cloud"
        ? "这条记录已在云端确认。完整删除需要后台确认；如果暂时无法连接，可先删除本机副本，并保留云端待删请求。"
        : "这条旧记录的云端保存状态未确认。可以尝试完整删除；也可以先删除本机副本，并保留云端待删请求。");
    setText("#coach-delete-confirm", scope === "local" ? "删除本机录像与报告" : offline ? "先删除本机，云端待删" : "删除云端与本机");
    $("#coach-delete-confirm").dataset.deferCloud = String(offline);
    setText("#coach-delete-local", offline ? "仍尝试完整删除" : "先删除本机，云端待删");
    $("#coach-delete-local").dataset.deferCloud = String(!offline);
    $("#coach-delete-local").hidden = scope === "local";
    $("#coach-delete-local-note").hidden = scope === "local";
    setText("#coach-delete-status", "");
    $("#coach-delete-dialog").showModal();
  }
  async function confirmDelete(deferCloud = false) {
    const session = state.deleteTarget;
    if (!session || state.actionBusy || state.deletionFlush || state.syncingIds.has(session.id)) return;
    setChoiceBusy(true); state.historyEpoch += 1;
    let job = deletionJob(session.id);
    try {
      const cloudRequired = needsCloudDelete(session);
      if (cloudRequired && !deferCloud && !job?.cloudDeleted) {
        setText("#coach-delete-status", "正在请求删除云端录像与报告…");
        await deleteFromCloud(session.id);
        session.cloudDeletionConfirmed = true; session.cloudStored = false; session.cloudVideoReady = false;
        persistSession(session);
      }
      // Persist explicit deletion intent before removing data; refresh cannot resurrect the record.
      job = { id: session.id, videoId: session.videoId || session.id, topic: session.topic || "未命名演讲",
        requestedAt: job?.requestedAt || Date.now(), localDeleted: job?.localDeleted || false,
        cloudDeleted: !cloudRequired || session.cloudDeletionConfirmed || job?.cloudDeleted || false,
        cloudRequired, lastError: "", localError: "" };
      saveDeletionJob(job);
      setText("#coach-delete-status", "正在清理本机录像与报告…");
      await removeLocalSession(job);
      state.deleteTarget = null; $("#coach-delete-dialog").close();
      setText("#coach-history-feedback", job.cloudDeleted
        ? cloudRequired ? "云端及本机的录像与复盘已删除。" : "本机录像与复盘已删除。"
        : "本机录像与复盘已删除，云端删除待完成。其他设备上的云端副本可能仍可见；连接恢复后会重试。");
    } catch (error) {
      if (job && !job.localDeleted) { job.localError = error.message; try { saveDeletionJob(job); } catch { /* Preserve the original error. */ } }
      setText("#coach-delete-status", session.cloudDeletionConfirmed
        ? `云端已删除，本机清理未完成：${error.message}`
        : `未完成全部删除：${error.message}${needsCloudDelete(session) ? " 可选择下方“先删除本机，云端待删”。" : ""}`);
    } finally {
      state.historyEpoch += 1; setChoiceBusy(false); renderSessions(); renderMemory();
    }
  }
  async function retryPendingDeletions() {
    if (state.deletionFlush) return state.deletionFlush;
    if (state.actionBusy || state.deleteTarget || !pendingDeletionJobs().length) return;
    state.deletionFlush = (async () => {
      for (const saved of pendingDeletionJobs()) {
        if (state.syncingIds.has(saved.id)) continue;
        const job = { ...saved }; state.historyEpoch += 1;
        if (!job.localDeleted) {
          try { await removeLocalSession(job); }
          catch (error) { job.localError = error.message; saveDeletionJob(job); continue; }
        }
        if (!job.cloudDeleted) {
          try { await deleteFromCloud(job.id); job.cloudDeleted = true; job.completedAt = Date.now(); job.lastError = ""; }
          catch (error) { job.lastError = error.message; }
          saveDeletionJob(job);
          if (job.cloudDeleted) state.remoteSessions = state.remoteSessions.filter(item => item.id !== job.id);
        }
        state.historyEpoch += 1;
      }
    })().finally(() => { state.deletionFlush = null; renderSessions(); renderMemory(); });
    renderSessions();
    return state.deletionFlush;
  }
  function renderPendingDeletions() {
    const host = $("#pending-deletions");
    const jobs = pendingDeletionJobs();
    if (!host) return;
    host.hidden = !jobs.length;
    host.innerHTML = jobs.length ? `<div class="pending-delete-heading"><b>待完成的删除 · ${jobs.length} 条</b><button type="button" data-retry-deletions class="secondary-button" ${state.deletionFlush || state.actionBusy ? "disabled" : ""}>${state.deletionFlush ? "正在重试…" : "重试待删请求"}</button></div><p>本机与云端分别显示状态。云端未确认前，其他设备可能仍可见；请保留此浏览器的数据，以便恢复连接后继续处理。</p>${jobs.map(job => `<div class="pending-delete-item"><b>${esc(job.topic)}</b><span>${job.localDeleted ? "本机已删除" : "本机清理待完成"} · ${job.cloudDeleted ? "云端已完成" : "云端待删除"}</span>${job.localError || job.lastError ? `<small>${esc(job.localError || job.lastError)}</small>` : ""}</div>`).join("")}` : "";
  }

  function renderReplay(session) {
    state.reportSession = session;
    const seconds = Math.max(0, ((session.endedAt || session.startedAt) - session.startedAt) / 1000);
    const points = session.points || [];
    const timeline = session.timeline || [];
    $("#coach-report-overview").innerHTML = `<div><span>本场时长</span><strong>${stamp(seconds)}</strong></div><div><span>较多词汇线索</span><strong>${points.filter(point => point.score >= .34).length}<small> / ${points.length} 个观点</small></strong></div><div><span>记录表达</span><strong>${(session.segments || []).length}<small> 句</small></strong></div><div><span>PPT 文字抽样</span><strong>${(session.slides || []).length}<small> 次</small></strong></div>`;
    const content = points.map((point, index) => `<article class="replay-point"><b>${index + 1}. ${esc(point.text)}</b><span>${point.score >= .34 ? "候选覆盖" : point.score >= .15 ? "部分线索" : "需复核"} · ${Math.round(point.score * 100)}%</span><p>${(point.evidence || []).slice(-3).map((entry) => `${stamp(entry.at)}「${esc(entry.text)}」`).join("；") || "无转写证据"}</p></article>`).join("");
    const fits = Array.isArray(session.contextFits) ? session.contextFits.filter(fit => fit && typeof fit === "object") : [];
    const fitSummary = Object.entries(TalkEvalFit.LABELS).map(([key, label]) => `<span class="fit-badge ${key}">${label} ${fits.filter(fit => fit.status === key).length}</span>`).join("");
    const fitReview = `<section class="session-fit-review"><div class="coach-panel-head"><div><p class="eyebrow">EXPRESSION IN CONTEXT</p><h3>表情与动作，服务于这句话了吗？</h3></div></div><div class="fit-summary-strip">${fitSummary}</div><p class="quiet-copy">${fits.length ? `共 ${fits.length} 条语句；下方显示最近 ${Math.min(30, fits.length)} 条，完整结果保存在导出的本场 JSON 与文字报告中。` : "这条旧记录没有语境适配证据，新录制将逐句保留。"}</p><div class="session-fit-list">${fits.slice(-30).map(fit => TalkEvalFit.card(fit, { compact: true, seekAttribute: "data-session-fit-seek" })).join("")}</div></section>`;
    const events = timeline.slice(-60).map((item) => `<div class="replay-event"><time>${stamp(item.at)}</time><span>${item.type === "speech" ? `语音：${esc(item.text)}` : item.type === "slide" ? `PPT OCR：${esc(item.text || "无文字")}` : item.type === "reaction" ? `${item.source === "demo" ? "模拟" : "现场观察"}反应：${esc(item.pointText || "观点")}` : `视觉：${esc(item.visual?.face || "")}；${esc(item.visual?.gesture || "")}`}</span></div>`).join("");
    $("#coach-replay-detail").innerHTML = `<section class="recording-replay"><div class="coach-panel-head"><div><p class="eyebrow">SESSION VIDEO</p><h3>演讲录像</h3></div><div class="report-actions"><button id="coach-sync-session" class="secondary-button" ${state.pendingDraft?.id !== session.id && !session.cloudDeletionConfirmed && (!session.cloudStored || (session.videoSaved && !session.cloudVideoReady)) ? "" : "hidden"}>重试公开同步</button><button id="coach-download-video" class="secondary-button">下载录像</button></div></div><video id="coach-replay-video" controls playsinline preload="metadata" hidden></video><p id="coach-replay-video-note" class="quiet-copy" hidden></p></section><div class="replay-grid"><div><h3>观点证据</h3>${content || "无观点"}</div><div><h3>时间线</h3><div class="replay-events">${events || "无事件"}</div></div></div>${fitReview}`;
    const video = $("#coach-replay-video");
    if(state.pendingDraft?.id!==session.id && session.cloudStored && !session.cloudDeletionConfirmed && session.caseBundleVersion!=='F12' && shared.canManage(session.id) && readSessions().some(s=>s.id===session.id)){
      $('#coach-sync-session').hidden=false;$('#coach-sync-session').textContent='补同步配套资料';
    }
    if(state.pendingDraft?.id!==session.id){const launch=document.createElement('button');launch.id='coach-launch-saved';launch.className='primary-button';launch.textContent='投放本场与配套资料 ↗';launch.addEventListener('click',()=>shared.open(session.id));$('#coach-replay-detail .report-actions').prepend(launch);}
    const note = $("#coach-replay-video-note");
    const downloadButton = $("#coach-download-video");
    if (state.replayUrl) URL.revokeObjectURL(state.replayUrl);
    state.replayUrl = null; video.removeAttribute("src"); video.load();
    video.hidden = !session.videoId; note.hidden = !session.videoId;
    downloadButton.disabled = !session.videoId;
    if (!session.videoId) { note.hidden = false; note.textContent = "此历史记录没有录像，文字报告仍可查看。"; return; }
    if (session.cloudVideoReady) {
      video.hidden = false; note.hidden = false;
      video.src = shared.url(`/api/sessions/${encodeURIComponent(session.id)}/video`);
      note.textContent = "录像已存入公开云端，其他设备可直接播放。";
      return;
    }
    note.textContent = "正在读取本机录像…";
    loadRecording(session.videoId, session.videoChunks).then((blob) => {
      if (state.reportSession?.id !== session.id) return;
      if (!blob) { note.textContent = "此设备上找不到录像文件；录像不会随文字报告自动同步。"; return; }
      state.replayUrl = URL.createObjectURL(blob); video.src = state.replayUrl;
      note.textContent = `${state.pendingDraft?.id === session.id ? "本场暂存，尚未选择保存" : "录像已保存在本机浏览器"} · ${Math.round(blob.size / 1024 / 1024)} MB${session.videoError ? ` · 录像可能不完整：${session.videoError}` : ""}${session.cloudUploadError ? ` · 云端同步失败：${session.cloudUploadError}` : ""}`;
    }).catch((error) => { if (state.reportSession?.id === session.id) note.textContent = `读取录像失败：${error.message}`; });
  }
  function renderSessions() {
    renderPendingDeletions();
    const pendingButton=$('#coach-sync-pending');if(pendingButton)pendingButton.disabled=Boolean(state.bulkSync || state.actionBusy || state.session) || !readSessions().some(s=>(!s.cloudStored || s.caseBundleVersion!=='F12')&&!deletionJob(s.id));
    shared.publish(allSavedSessions(),{state:state.cloudState,error:state.cloudError});
    const sessions = allSavedSessions().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, 100);
    setText("#saved-session-count", state.cloudState === "error" ? `${sessions.length} 场缓存` : `${sessions.length} 场`);
    const host = $("#saved-session-list");
    const notice = state.cloudState === "error" ? `<div class="history-connection-note" role="status"><b>暂时无法读取云端历史</b><p>${esc(state.cloudError)}当前仅显示此设备可读取的缓存，不能据此判断云端没有记录。</p></div>` : "";
    if (!sessions.length) { host.innerHTML = notice || `<p class="quiet-copy">${state.cloudState === "loading" ? "正在读取公开云端历史记录…" : "暂无公开演讲复盘。完成演讲并同步成功后，各设备均可查看。"}</p>`; return; }
    host.innerHTML = notice + sessions.map((session) => `<div class="saved-session-row"><button class="saved-session" type="button" data-session="${esc(session.id)}"><span><b>${esc(session.topic)}</b><small>${new Date(session.startedAt).toLocaleString("zh-CN")} · ${esc(session.speakerId)}${session.cloudDeletionConfirmed ? " · 云端已删除，本机待清理" : session.cloudVideoReady && session.cloudStored ? " · 录像与报告已存云端" : session.cloudStored ? " · 报告已存云端，录像待同步" : " · 本机缓存，尚未云端确认"}</small></span><span>查看复盘 ↗</span></button><button class="session-launch" type="button" data-launch-session="${esc(session.id)}">加入投放 ↗</button><button class="session-delete" type="button" ${!shared.canManage(session.id) && session.cloudStored ? "hidden" : ""} data-delete-session="${esc(session.id)}" aria-label="删除演讲：${esc(session.topic)}" ${state.syncingIds.has(session.id) || state.actionBusy || state.deletionFlush ? "disabled" : ""}>删除</button></div>`).join("");
    host.querySelectorAll('[data-launch-session]').forEach(button=>button.addEventListener('click',()=>shared.open(button.dataset.launchSession)));
    host.querySelectorAll("[data-delete-session]").forEach(button => button.addEventListener("click", () => {
      const session = sessions.find(item => item.id === button.dataset.deleteSession);
      if (session) requestDelete(session);
    }));
    host.querySelectorAll("[data-session]").forEach((button) => button.addEventListener("click", () => {
      const session = sessions.find((item) => item.id === button.dataset.session); if (!session) return;
      $("#coach-report").hidden = false; $("#coach-report-text").value = session.report || "此旧记录没有报告正文。"; renderReplay(session);
      updateStartAvailability();
      $("#coach-report").scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function downloadSessionVideo(session) {
    if (!session?.videoId) return;
    const blob = session.cloudVideoReady
      ? await (await cloudFetch(`/api/sessions/${encodeURIComponent(session.id)}/video`)).blob()
      : await loadRecording(session.videoId, session.videoChunks);
    if (!blob) { setText("#coach-replay-video-note", "此设备上找不到录像文件。"); return; }
    const extension = blob.type.includes("mp4") ? "mp4" : "webm";
    const safeTopic = String(session.topic || "speech").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 48);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `talkeval-${safeTopic}.${extension}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function currentReportSession() {
    if (state.reportSession) return state.reportSession;
    const report = $("#coach-report-text").value;
    const sessions = allSavedSessions();
    return sessions.find((item) => item.report === report) || sessions[0];
  }

  $("#review-tab").addEventListener("click", () => switchView("review"));
  $("#live-tab").addEventListener("click", () => switchView("live"));
  $("#coach-case").addEventListener("change", (event) => chooseCase(event.target.value));
  $("#coach-outline").addEventListener("input", (event) => {
    if (state.session || state.pendingDraft || state.actionBusy) return;
    state.practiceMonitor=null;
    state.caseRequest += 1;
    $("#coach-case").value = "custom";
    setPoints(event.target.value.split(/\n+/).map((text) => ({ text })));
  });
  $("#coach-topic").addEventListener("input", updateStartAvailability);
  $("#coach-speaker").addEventListener("input", renderMemory);
  $("#coach-consent").addEventListener("change", updateStartAvailability);
  $("#coach-refresh-history").addEventListener("click", refreshCloudSessions);
  $("#coach-start").addEventListener("click", startSession);
  $("#coach-stop").addEventListener("click", stopSession);
  $("#share-screen").addEventListener("click", shareScreen);
  $("#coach-add-text").addEventListener("click", () => {
    const input = $("#coach-manual-text"); addSegment(input.value, "manual"); input.value = ""; input.focus();
  });
  $("#coach-manual-text").addEventListener("keydown", (event) => { if (event.key === "Enter") $("#coach-add-text").click(); });
  $("#coach-copy-report").addEventListener("click", () => navigator.clipboard?.writeText($("#coach-report-text").value).then(() => setText("#coach-cue-copy", "报告已复制。")).catch(() => {}));
  $("#coach-download-report").addEventListener("click", () => download("talkeval-live-report.txt", $("#coach-report-text").value, "text/plain;charset=utf-8"));
  $("#coach-replay-detail").addEventListener("click", (event) => {
    const seek = event.target.closest("[data-session-fit-seek]");
    if (seek) {
      const video = $("#coach-replay-video"), seconds = Number(seek.dataset.sessionFitSeek);
      if (video?.src && Number.isFinite(seconds)) { video.currentTime = seconds; video.play().catch(() => {}); video.scrollIntoView({ behavior: "smooth", block: "center" }); }
      else setText("#coach-replay-video-note", "这条记录暂时没有可播放录像，语句与时间证据仍可查看。");
    }
    if (event.target.closest("#coach-download-video")) downloadSessionVideo(currentReportSession()).catch((error) => setText("#coach-replay-video-note", `下载失败：${error.message}`));
    if (event.target.closest("#coach-sync-session")) {
      const button = event.target.closest("#coach-sync-session");
      const session = readSessions().find(s=>s.id===currentReportSession()?.id) || currentReportSession();
      button.disabled = true; button.textContent = "正在上传…";
      syncSavedSession(session).then(updated => setText("#coach-cue-copy", updated.cloudVideoReady ? "录像和报告已同步到公开云端，其他设备现在可以查看。" : "报告已同步到公开云端；录像状态请查看复盘说明。"))
        .catch((error) => { button.disabled = false; button.textContent = "重试公开同步"; setText("#coach-replay-video-note", `同步失败：${error.message}`); });
    }
  });
  $("#coach-download-json").addEventListener("click", () => {
    const session = currentReportSession();
    if (session) download("talkeval-live-session.json", JSON.stringify(session, null, 2), "application/json;charset=utf-8");
  });

  $("#coach-focus").addEventListener("click", event => {
    const active = $("#live-view").classList.toggle("studio-focus");
    event.currentTarget.setAttribute("aria-pressed", String(active));
    event.currentTarget.querySelector("span").textContent = active ? "退出专注模式" : "演讲专注模式";
  });
  const studioTabs = [...document.querySelectorAll("[data-studio-tab]")];
  studioTabs.forEach((button, index) => {
    button.addEventListener("click", () => {
      studioTabs.forEach(tab => { tab.setAttribute("aria-selected", String(tab === button)); tab.tabIndex = tab === button ? 0 : -1; });
      document.querySelectorAll("[data-studio-panel]").forEach(panel => { panel.hidden = panel.dataset.studioPanel !== button.dataset.studioTab; });
    });
    button.addEventListener("keydown", event => {
      const next = event.key === "ArrowRight" ? (index + 1) % studioTabs.length : event.key === "ArrowLeft" ? (index - 1 + studioTabs.length) % studioTabs.length : event.key === "Home" ? 0 : event.key === "End" ? studioTabs.length - 1 : null;
      if (next !== null) { event.preventDefault(); studioTabs[next].click(); studioTabs[next].focus(); }
    });
    button.tabIndex = index ? -1 : 0;
  });

  document.querySelectorAll("[data-draft-action]").forEach(button => button.addEventListener("click", () => {
    const action = button.dataset.draftAction;
    if (action === "save") saveDraft();
    else if (action === "discard") discardDraft();
    else if (action === "choose") showDraftChoice();
    else if (!state.actionBusy) { $("#coach-save-dialog").close(); $("#coach-report").scrollIntoView({ behavior: "smooth", block: "start" }); }
  }));
  $("#coach-save-dialog").addEventListener("cancel", event => { if (state.actionBusy) event.preventDefault(); });
  $("#coach-delete-dialog").addEventListener("cancel", event => { if (state.actionBusy) event.preventDefault(); else state.deleteTarget = null; });
  $("#coach-delete-cancel").addEventListener("click", () => { if (!state.actionBusy) { state.deleteTarget = null; $("#coach-delete-dialog").close(); } });
  $("#coach-delete-confirm").addEventListener("click", event => confirmDelete(event.currentTarget.dataset.deferCloud === "true"));
  $("#coach-delete-local").addEventListener("click", event => confirmDelete(event.currentTarget.dataset.deferCloud === "true"));
  $("#pending-deletions").addEventListener("click", event => {
    if (event.target.closest("[data-retry-deletions]")) retryPendingDeletions().catch(error => setText("#coach-history-feedback", `待删请求未完成：${error.message}`));
  });
  window.addEventListener("online", () => { if (pendingDeletionJobs().length) refreshCloudSessions(); });
  window.addEventListener("storage", event => {
    if ([STORAGE_KEY, DELETION_KEY].includes(event.key)) {
      state.historyEpoch += 1;
      const job = state.reportSession && deletionJob(state.reportSession.id);
      if (job?.localDeleted) clearReport(job.id);
      renderSessions(); renderMemory();
    }
  });
  window.addEventListener("beforeunload", event => {
    if (state.session || state.pendingDraft || state.actionBusy || state.syncingIds.size) { event.preventDefault(); event.returnValue = ""; }
  });
  const syncPending=document.createElement('button');syncPending.id='coach-sync-pending';syncPending.className='history-refresh';syncPending.textContent='同步本机历史';$('#coach-refresh-history').after(syncPending);
  syncPending.addEventListener('click',async()=>{
    if(state.bulkSync || state.actionBusy || state.session)return;
    state.bulkSync=true;syncPending.disabled=true;
    const pending=readSessions().filter(s=>(!s.cloudStored || s.caseBundleVersion!=='F12')&&!deletionJob(s.id));let done=0;
    try{for(const item of pending){setText('#coach-history-feedback',`正在同步本机历史 ${done+1}/${pending.length}…`);await syncSavedSession({...item,saveDecision:'saved'});done++;}setText('#coach-history-feedback',`已将 ${done} 场本机历史同步到共享案例库。`);}
    catch(error){setText('#coach-history-feedback',`已同步 ${done}/${pending.length} 场，其余仍保留在本机：${error.message}`);}
    finally{state.bulkSync=false;renderSessions();}
  });
  function rehearseSaved(id){
    if(state.session || state.pendingDraft || state.actionBusy)throw Error('请先结束并处理当前演讲，再载入这场提纲。');
    const session=allSavedSessions().find(s=>s.id===id);if(!session)throw Error('这场记录尚未同步到此设备。');
    state.caseRequest++;$('#coach-case').value='custom';state.selectedCase='custom';
    $('#coach-topic').value=session.topic || '';$('#coach-speaker').value=session.speakerId || '';
    const language=session.language || session.monitorF8?.language || 'zh';
    const option=[...$('#coach-language').options].find(o=>o.value.startsWith(language));if(option)$('#coach-language').value=option.value;
    $('#coach-expression-goal').value=session.expressionGoal || '';
    $('#coach-outline').value=(session.points||[]).map(p=>p.text).join('\n');
    setPoints((session.points||[]).map(p=>({beat_id:p.id,text:p.text,claims:p.claims})));
    state.practiceMonitor=session.monitorF8 ? structuredClone(session.monitorF8) : null;
    if(Number.isFinite(session.monitorF8?.limit))$('#camera-time-limit').value=String(session.monitorF8.limit/60);
    $('#coach-consent').checked=false;updateStartAvailability();switchView('live');
    setText('#coach-history-feedback','已载入本场提纲和限时。确认采集后开始新的一场；新语音与画面将重新分析。');
    $('#live-view').scrollIntoView({block:'start'});
  }
  shared.bind({sessions:allSavedSessions,recording:s=>loadRecording(s.videoId || s.id,s.videoChunks),refresh:refreshCloudSessions,rehearse:rehearseSaved});
  window.addEventListener('focus',()=>{if(!state.actionBusy)refreshCloudSessions();});
  setInterval(()=>{if(!document.hidden && !state.actionBusy)refreshCloudSessions();},30000);
  window.TalkEvalLaunch?.mountCamera({ getState: () => state, getRecords: allSavedSessions, elapsed, wordUnits });
  loadCases().then(renderSessions);
  refreshCloudSessions();
  updateStartAvailability();
  renderPoints(); drawAudioWave();
  renderMemory();
  if (location.hash === "#live") switchView("live");
})();
