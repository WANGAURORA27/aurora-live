'use strict';
/* ============================================================
 * LiveBridge 同声传译 · 前端核心（v2）
 * 设计（对标讯飞听见 / Google 口译模式 / 微软翻译官）：
 *  - 连续收音 + 静音检测成段，边讲边传（分段并行）
 *  - 句子级流水线：识别句 → 流式翻译 → 到句即播，不等整段讲完
 *  - 播报同时继续收音 = “同声”体验；原文/译文按句成卡对照
 * ============================================================ */
(() => {
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const on = (el, ev, fn) => el && el.addEventListener(ev, fn);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);           // 避免源码转义问题
let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
let _lastErrToast = 0;
function errToast(msg) {   // 错误提示节流：最多 6 秒一条，避免刷屏
  const now = Date.now();
  if (now - _lastErrToast < 6000) return;
  _lastErrToast = now;
  toast(msg, 4200);
}
/* 限流/故障守卫：连续失败后自动进入“降级模式”，减少请求量、恢复后自动退出 */
const Guard = {
  chatFails: 0,
  sttFails: 0,
  chatLast: 0,
  sttLast: 0,
  reset() { this.chatFails = 0; this.sttFails = 0; },
  mark(kind) {   // 记一次失败
    if (kind === 'chat') { this.chatFails++; this.chatLast = Date.now(); }
    else { this.sttFails++; this.sttLast = Date.now(); }
  },
  ok(kind) { if (kind === 'chat') this.chatFails = 0; else this.sttFails = 0; },
  degraded(kind) {   // 30 秒内同类失败 ≥2 次 → 降级
    const last = kind === 'chat' ? this.chatLast : this.sttLast;
    const fails = kind === 'chat' ? this.chatFails : this.sttFails;
    return fails >= 2 && Date.now() - last < 30000;
  },
  isBusyError(e) { return /429|503|too busy|rate limit|rate limiting|system is too busy/i.test(e && e.message ? e.message : String(e)); },
};
function noteChatErr(e) { Guard.mark('chat'); if (Guard.isBusyError(e)) return; }
function noteSttErr(e) { Guard.mark('stt'); if (Guard.isBusyError(e)) return; }

/* ---------- 语言库 ---------- */
const LANGS = [
  ['zh', '中文', 'zh-CN', '🇨🇳'], ['en', 'English', 'en-US', '🇺🇸'], ['ja', '日本語', 'ja-JP', '🇯🇵'],
  ['ko', '한국어', 'ko-KR', '🇰🇷'], ['fr', 'Français', 'fr-FR', '🇫🇷'], ['de', 'Deutsch', 'de-DE', '🇩🇪'],
  ['es', 'Español', 'es-ES', '🇪🇸'], ['ru', 'Русский', 'ru-RU', '🇷🇺'], ['pt', 'Português', 'pt-BR', '🇵🇹'],
  ['it', 'Italiano', 'it-IT', '🇮🇹'], ['ar', 'العربية', 'ar-SA', '🇸🇦'], ['hi', 'हिन्दी', 'hi-IN', '🇮🇳'],
  ['nl', 'Nederlands', 'nl-NL', '🇳🇱'], ['pl', 'Polski', 'pl-PL', '🇵🇱'], ['tr', 'Türkçe', 'tr-TR', '🇹🇷'],
  ['vi', 'Tiếng Việt', 'vi-VN', '🇻🇳'], ['th', 'ไทย', 'th-TH', '🇹🇭'], ['id', 'Bahasa Indonesia', 'id-ID', '🇮🇩'],
  ['sv', 'Svenska', 'sv-SE', '🇸🇪'], ['cs', 'Čeština', 'cs-CZ', '🇨🇿'], ['uk', 'Українська', 'uk-UA', '🇺🇦'],
  ['el', 'Ελληνικά', 'el-GR', '🇬🇷'], ['he', 'עברית', 'he-IL', '🇮🇱'], ['ms', 'Bahasa Melayu', 'ms-MY', '🇲🇾'],
  ['fi', 'Suomi', 'fi-FI', '🇫🇮'], ['hu', 'Magyar', 'hu-HU', '🇭🇺'], ['ro', 'Română', 'ro-RO', '🇷🇴'],
  ['da', 'Dansk', 'da-DK', '🇩🇰'], ['no', 'Norsk', 'no-NO', '🇳🇴'], ['bg', 'Български', 'bg-BG', '🇧🇬'],
];
const L = (code) => LANGS.find((x) => x[0] === code) || [code, code, code, '🏷'];
// whisper 返回的检测语言名 → 语言码
const DETECT = {
  chinese: 'zh', mandarin: 'zh', english: 'en', japanese: 'ja', korean: 'ko', french: 'fr',
  german: 'de', spanish: 'es', russian: 'ru', portuguese: 'pt', italian: 'it', arabic: 'ar',
  hindi: 'hi', dutch: 'nl', polish: 'pl', turkish: 'tr', vietnamese: 'vi', thai: 'th',
  indonesian: 'id', swedish: 'sv', czech: 'cs', ukrainian: 'uk', greek: 'el', hebrew: 'he',
  malay: 'ms', finnish: 'fi', hungarian: 'hu', romanian: 'ro', danish: 'da', norwegian: 'no',
  bulgarian: 'bg',
};
const detectToCode = (s) => {
  if (!s) return null;
  const k = String(s).toLowerCase().trim();
  return DETECT[k] || (LANGS.some((l) => l[0] === k) ? k : null);
};

/* ---------- 提供商标识 ---------- */
const PROVIDERS = {
  openai:      { base: 'https://api.openai.com/v1', chat: 'gpt-4o-mini', stt: 'whisper-1', tts: 'tts-1', note: '' },
  deepseek:    { base: 'https://api.deepseek.com', chat: 'deepseek-chat', stt: '', tts: '', note: 'DeepSeek 无语音识别/合成，需配合浏览器引擎或另配语音服务' },
  siliconflow: { base: 'https://api.siliconflow.cn/v1', chat: 'deepseek-ai/DeepSeek-V3', stt: 'FunAudioLLM/SenseVoiceSmall', tts: '', note: 'TTS 未内置，可用浏览器合成' },
  groq:        { base: 'https://api.groq.com/openai/v1', chat: 'llama-3.3-70b-versatile', stt: 'whisper-large-v3', tts: '', note: 'Groq 无 TTS，可用浏览器合成' },
  moonshot:    { base: 'https://api.moonshot.cn/v1', chat: 'moonshot-v1-8k', stt: '', tts: '', note: '' },
  minimax:     { base: 'https://api.minimax.chat/v1', chat: 'MiniMax-Text-01', stt: '', tts: '', note: '' },
};

/* ---------- 设置存储 ---------- */
const KEY = 'livebridge-settings-v1';
const DEFAULTS = {
  provider: '', profile: '', base: '', key: '', chatModel: '', sttModel: '', ttsModel: '', ttsVoice: 'nova',
  sttEngine: 'auto', ttsEngine: 'auto', voiceOn: false, rate: 1.0, monitor: false, preview: true, topFeed: true,
  clean: true, ctx: true, paraMode: true, displayStyle: 'dual', liveModel: 'zai-org/GLM-4.5-Air',   // 默认双语分屏 + 快速草稿模型
  glossary: '',   // 自定义术语，每行一条：英文=中文
  domain: 'auto', ctxRounds: 5, notes: '', refineGpt: true,   // 领域风格 / 记忆轮数 / 额外要求 / 定稿用精修模型
  voiceBoost: false,   // 浏览器语音增强（降噪+自动增益）：默认关——浏览器降噪/AGC 是给通话调的，会吃掉 ASR 需要的辅音/齿音细节，识别反而更差
  tailMs: 600, maxSegMs: 12000, sense: 5,
  mode: 'oneway', src: 'en', targets: ['zh'], speakLang: 'zh',   // 默认：英译中
  A: 'zh', B: 'en', who: 'auto',
};
let S = { ...DEFAULTS };
try { S = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || '{}')) }; } catch {}
if (!S._v2) { S.preview = false; S.topFeed = true; S._v2 = 1; }   // v2：隐藏实时识别字幕、新译文置顶
if (!S._v3) { S.preview = true; S._v3 = 1; }   // v3：默认开启“实时中文草稿”（边说边修，可关闭）
if (!S._v5) { S.voiceOn = false; S._v5 = 1; }   // v5：默认不朗读译文（需要时可再开启）
if (!S._v6 && (S.liveModel === undefined || S.liveModel === '')) { S.liveModel = 'Qwen/Qwen2.5-7B-Instruct'; S._v6 = 1; }   // v6：实时草稿用轻量小模型提速
if (!S._v7) { S.liveModel = 'Pro/Qwen/Qwen2.5-7B-Instruct'; S._v7 = 1; }   // v7：实时草稿改用付费专线小模型（不排队，首字更快）
if (!S._v8) { S.tailMs = Math.min(S.tailMs || 600, 500); S.maxSegMs = Math.min(S.maxSegMs || 8000, 6000); S._v8 = 1; }   // v8：成段更快
if (!S._v9) { S.liveModel = 'Qwen/Qwen3.5-4B'; S._v9 = 1; }   // v9：草稿改用 4B（首字更快）
if (!S._v10) { S.liveModel = 'zai-org/GLM-4.5-Air'; S._v10 = 1; }   // v10：4B 会返回空/丢否定词 → 换成 GLM-4.5-Air
if (!S._v11) { S.maxSegMs = 3000; S._v11 = 1; }   // v11：单段 6s→3s，避开上游识别偶发 10~20s 卡顿
if (!S._v12) { S.maxSegMs = 5000; S.tailMs = 600; S._v12 = 1; }   // v12：真实场景实测——整段比碎片准，段长回到 5s
if (!S._v13) { S.displayStyle = 'dual'; S.paraMode = true; S._v13 = 1; }
if (!S._v14) { S.maxSegMs = Math.max(S.maxSegMs || 5000, 12000); S._v14 = 1; }   // v14：分段上限提到 12s（长音频识别更准）   // v13：固定双语分屏（隐藏其它模式）
if (!S._v15) { S.voiceBoost = false; S._v15 = 1; try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }   // v15：默认关闭浏览器降噪/自动增益（对 ASR 有害）
if (!S._v16) { S.maxSegMs = 5000; S.tailMs = 500; S.preview = true; S._v16 = 1; try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }   // v16：提速——单段上限 12s→5s、静音成段 900→500ms、重开实时草稿
if (!S.targets.includes(S.speakLang)) S.speakLang = S.targets[0] || 'en';
const saveS = () => localStorage.setItem(KEY, JSON.stringify(S));
const serverCfg = { mock: false, envConfigured: false, baseUrl: '', chatModel: '', sttModel: '', ttsModel: '', ttsVoice: 'nova', profiles: [] };
let _profilesKey = '';   // 下拉选项缓存标记
const apiSettings = () => ({
  profile: S.profile || '',
  baseUrl: S.base, apiKey: S.key, chatModel: S.chatModel, sttModel: S.sttModel,
  ttsModel: S.ttsModel, ttsVoice: S.ttsVoice,
});

/* ---------- 全局状态 ---------- */
const State = {
  running: false,
  epoch: 0,          // 会话纪元：stop/start 都会自增，作废旧会话的异步回调
  segSeq: 0,         // 句子序号（播报顺序）
  segCount: 0,
  latSamples: [],
  lastSentence: null,
};
const activeProfileHasKey = () => {
  if (!S.profile) return false;
  const pf = (serverCfg.profiles || []).find((x) => x.code === S.profile);
  return !!(pf && pf.hasKey);
};
const needCloudConfigured = () => !!(S.key || activeProfileHasKey() || serverCfg.envConfigured || serverCfg.mock);
const nativeSupported = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);
// 识别“权威引擎”：'realtime'=云端流式逐字（豆包级）；'cloud'=停顿成段后整段上传；'native'=浏览器流式
function pickAuthorEngine() {
  if (S.sttEngine === 'native') return 'native';
  if (S.sttEngine === 'cloud') return 'cloud';
  if (S.sttEngine === 'realtime') return 'realtime';
  // auto：优先云端实时流式（支持 WebSocket 时），否则回退整段上传
  return needCloudConfigured() ? ('WebSocket' in window ? 'realtime' : 'cloud') : 'native';
}

/* ================= 1. 麦克风采集 + 语音活动检测（VAD） ================= */
/* 采集 + VAD；产出统一为 WAV（大多数云端 ASR 兼容性最好，避免 webm 不被支持） */
class Capture {
  reset() {
    this.stream = null; this.ctx = null; this.analyser = null; this.src = null;
    this.proc = null; this.sink = null;
    this.recording = false;
    this.timer = null; this.noise = 0.012;
    this.voiced = 0; this.silent = 0; this.forceStopAt = 0;
    this.monitorBus = null;
    // 注意：onLevel / onSegment / onSnapshot 是“接线”，由 Controller 赋值；这里不清空，
    // 否则自动恢复（重新 start）后回调丢失 → 麦克风连上却不出字
    this.needRec = true;   // 云端权威识别才需要采集音频
    this.snapMode = false; // 说话中定时上传“已录前缀”→ 增量识别出草稿
    this.snapBusy = false;
    this.snapEvery = 450;    // 快照间隔 ms（限流时会被放大）
    this.lastSnapAt = 0;
    this.pcmBuf = [];        // 单声道 Float32 滚动缓冲
    this.sr = 48000;
    this.segStart = 0;
    this.recT0 = 0;
    this.PRE_ROLL = 0;       // 预滚采样数（约 1.2s）
    this.realtimeMode = false;   // 实时流式：边录边推 PCM，不做本地 VAD 成段
    this.streamResampler = null;
  }
  threshold() {
    const base = 0.030 - (S.sense - 1) * 0.0024;      // 灵敏度 1..10
    return Math.max(this.noise * 2.4, base, 0.006);
  }
  async start() {
    await this.releaseAll();   // 先彻底释放上一次的麦克风/音频上下文（否则会出现“再点一次就掉了”）
    this.reset();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('当前浏览器不支持麦克风采集（需 HTTPS 或 localhost）');
    }
    // ① 先在用户手势里创建并唤醒 AudioContext（Safari 必须如此，否则后续被挂起 → 麦克风“没声音”）
    const AC = window.AudioContext || window.webkitAudioContext;
    try {
      if (!this.ctx || this.ctx.state === 'closed') this.ctx = new AC();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
    } catch {}
    // ② 取流：带重试（刚停止后设备可能还没释放完，会短暂 NotReadableError）
    this.stream = await this.acquireStream(3);
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = new AC();
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch {} }
    State.micGranted = true;                     // 记住已授权，之后不再反复提示
    try { localStorage.setItem('lb_mic_granted', '1'); } catch {}
    this.sr = this.ctx.sampleRate || 48000;
    this.PRE_ROLL = Math.round(1.2 * this.sr);
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.src.connect(this.analyser);
    // 采集 PCM（用 ScriptProcessor，兼容所有主流浏览器）→ 编码成 WAV 上传
    this.proc = this.ctx.createScriptProcessor(2048, 1, 1);
    this.proc.onaudioprocess = (e) => {
      if (!this.needRec || !this.ctx || this.ctx.state !== 'running') return;
      const d = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < d.length; i++) this.pcmBuf.push(d[i]);
    };
    this.src.connect(this.proc);
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.proc.connect(this.sink);
    this.sink.connect(this.ctx.destination);
    this.audioBuf = new Uint8Array(this.analyser.fftSize);
    this.timer = setInterval(() => this.tick(), 60);
  }
  async acquireStream(attempts = 3) {   // 取麦克风：失败自动重试（设备占用/刚释放时最常见）
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const boost = S.voiceBoost === true;    // 默认关：浏览器降噪/AGC 会给 ASR 造成频谱伪影、吃掉辅音/齿音细节 → 识别更差；用户可在设置里手动开回
        const gum = navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: boost, autoGainControl: boost },
        });
        return await Promise.race([
          gum,
          new Promise((_, rej) => setTimeout(() => rej(new Error('等待麦克风授权超时(20秒)：请点浏览器地址栏的麦克风图标选「允许」，或在系统设置→隐私与安全性→麦克风 里允许浏览器')), 20000)),
        ]);
      } catch (e) {
        lastErr = e;
        const em = String((e && e.name) || '') + ' ' + String((e && e.message) || '');
        const retryable = /NotReadableError|TrackStartError|AbortError|Could not start audio source|timeout|超时|占用|busy/i.test(em);
        if (i >= attempts - 1 || !retryable) break;
        await sleep(400 * (i + 1));
      }
    }
    throw lastErr || new Error('麦克风启动失败');
  }
  async releaseAll() {   // 彻底释放：轨道/节点/音频上下文
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.finishRec(); } catch {}
    for (const k of ['sink', 'proc', 'monitorBus', 'src']) {
      const o = this[k];
      if (o) { try { o.disconnect(); } catch {} this[k] = null; }
    }
    if (this.stream) { try { this.stream.getTracks().forEach((t) => t.stop()); } catch {} this.stream = null; }
    if (this.ctx) { try { await this.ctx.close(); } catch {} this.ctx = null; }
  }
  async stop() { await this.releaseAll(); }
  enableMonitor(on) {
    if (!this.ctx || !this.src) return;
    if (on && !this.monitorBus) {
      this.monitorBus = this.ctx.createGain();
      this.monitorBus.gain.value = 0.10;
      this.src.connect(this.monitorBus);
      this.monitorBus.connect(this.ctx.destination);
    } else if (!on && this.monitorBus) {
      try { this.monitorBus.disconnect(); } catch {}
      this.monitorBus = null;
    }
  }
  rms() {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.audioBuf);
    let sum = 0;
    for (let i = 0; i < this.audioBuf.length; i++) {
      const v = (this.audioBuf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this.audioBuf.length);
  }
  startRec() {
    if (this.recording) return;
    // 预滚：把触发说话前 ~1.2s 也算进去，避免丢掉开口第一个音
    this.segStart = Math.max(0, this.pcmBuf.length - this.PRE_ROLL);
    this.recT0 = performance.now();
    this.lastSnapAt = this.recT0 - 100;   // 首帧提前到开口后 ~0.5s
    this.recording = true;
    this.silent = 0;
    this.forceStopAt = this.recT0 + S.maxSegMs;
  }
  finishRec() {
    if (!this.recording) { this.snapBusy = false; return; }
    this.recording = false;
    this.snapBusy = false;
    const dur = Math.round(performance.now() - this.recT0);
    const seg = this.pcmBuf.slice(this.segStart);
    if (this.pcmBuf.length > this.PRE_ROLL) this.pcmBuf.splice(0, this.pcmBuf.length - this.PRE_ROLL);   // 保留预滚长度作为下句前导
    if (seg.length > this.sr * 0.3 && State.running && this.needRec && this.onSegment) {
      this.onSegment(wavBlob(to16k(seg, this.sr), 16000), dur);
    }
  }
  snapshotNow() {
    if (!this.recording || !this.needRec) return;
    this.snapBusy = true;
    this.lastSnapAt = performance.now();
    const seg = this.pcmBuf.slice(this.segStart);
    const done = () => { this.snapBusy = false; };
    try {
      const pr = this.onSnapshot ? this.onSnapshot(wavBlob(to16k(seg, this.sr), 16000)) : null;
      if (pr && typeof pr.finally === 'function') pr.finally(done); else done();
    } catch { done(); }
  }
  tick() {
    // 轨道被浏览器回收（切后台/休眠/设备插拔）→ 触发自动恢复，无需刷新页面
    if (this.stream) {
      const tr = this.stream.getAudioTracks();
      if (!tr.length || tr.every((t) => t.readyState !== 'live')) {
        const now = Date.now();
        if (now - (this._deadAt || 0) > 2000) {
          this._deadAt = now;
          if (window.Controller && Controller.healMic) Controller.healMic('track-ended');
        }
      }
    } else if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});   // 上下文被挂起（Safari 切后台）→ 直接唤醒
    }
    if (!this.analyser) return;
    const r = this.rms();
    this.noise = this.noise * 0.998 + Math.min(r, this.noise) * 0.002;   // 噪声底自适应
    if (this.onLevel) this.onLevel(r);
    // 实时流式模式：边录边把 PCM 降采样到 16k 推给实时识别（不做本地 VAD 成段）
    if (this.realtimeMode) {
      if (!this.streamResampler) this.streamResampler = makeStreamResampler(this.sr || 48000);
      if (this.onPcm && this.pcmBuf.length) {
        const out = this.streamResampler.push(this.pcmBuf.splice(0));
        if (out.length) this.onPcm(out);
      }
      return;
    }
    const hit = r > this.threshold();
    if (hit) { this.voiced += 1; this.silent = 0; }
    else { this.voiced = 0; this.silent += 1; }
    // 空闲时限制 PCM 缓冲增长（只保留预滚）
    if (!this.recording && this.pcmBuf.length > this.PRE_ROLL * 2) {
      this.pcmBuf.splice(0, this.pcmBuf.length - this.PRE_ROLL);
    }
    if (this.recording) {
      if (performance.now() >= this.forceStopAt) {           // 超长强制成段，随即续录
        this.finishRec();
        setTimeout(() => { if (State.running && this.stream) this.startRec(); }, 160);
      } else if (this.silent * 60 >= S.tailMs) {             // 静音足够长 → 成段
        this.finishRec();
      } else if (this.snapMode && !this.snapBusy && performance.now() - this.lastSnapAt >= this.snapEvery) {
        this.snapshotNow();                                    // 边说边识别 → 草稿
      }
    } else if (State.running && this.stream && this.needRec && this.voiced * 60 >= 260) {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      this.startRec();
    }
  }
}
/* 48k/44.1k 等 → 16kHz（整数倍盒式低通+抽点抗混叠，非整数倍线性插值）；16k 原样返回 */
function to16k(floats, sr) {
  if (!sr || sr === 16000) return floats;
  const ratio = sr / 16000, outLen = Math.max(1, Math.round(floats.length / ratio));
  const out = new Float32Array(outLen), r = Math.round(ratio);
  if (r >= 2 && Math.abs(r - ratio) < 0.001) {
    for (let i = 0; i < outLen; i++) { let acc = 0; const s = i * r; for (let j = 0; j < r; j++) acc += floats[s + j] || 0; out[i] = acc / r; }
  } else {
    for (let i = 0; i < outLen; i++) { const p = i * ratio, i0 = Math.floor(p), f = p - i0, a = floats[i0] || 0, b = floats[i0 + 1] !== undefined ? floats[i0 + 1] : a; out[i] = a + (b - a) * f; }
  }
  return out;
}
/* Float32 单声道 PCM → 16-bit WAV Blob */
function wavBlob(floats, sampleRate) {
  const n = floats.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  let o = 0;
  const wstr = (s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); o += s.length; };
  wstr('RIFF'); v.setUint32(o, 36 + n * 2, true); o += 4;
  wstr('WAVE'); wstr('fmt '); v.setUint32(o, 16, true); o += 4;
  v.setUint16(o, 1, true); o += 2; v.setUint16(o, 1, true); o += 2;
  v.setUint32(o, sampleRate, true); o += 4; v.setUint32(o, sampleRate * 2, true); o += 4;
  v.setUint16(o, 2, true); o += 2; v.setUint16(o, 16, true); o += 2;
  wstr('data'); v.setUint32(o, n * 2, true); o += 4;
  for (let i = 0; i < n; i++) {
    let s = floats[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    o += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/* 云端：整段上传 OpenAI 兼容 /audio/transcriptions。双人对话依赖其返回的检测语言来决定“谁在说话”。 */
async function sttRequest(blob, langHint, isFinal) {
  const params = new URLSearchParams();
  const as = apiSettings();
  if (as.sttModel) params.set('model', as.sttModel);
  if (langHint) params.set('language', langHint);
  const headers = { 'Content-Type': blob.type || 'audio/webm' };
  if (S.profile) headers['X-Profile'] = S.profile;
  if (as.baseUrl) headers['X-AI-Base-Url'] = as.baseUrl;
  if (as.apiKey) headers['X-AI-Key'] = as.apiKey;
  if (isFinal) headers['X-Lb-Final'] = '1';   // 权威分段（定稿用）→ 服务端双引擎交叉识别取优
  const res = await fetch('/api/stt?' + params.toString(), { method: 'POST', headers, body: blob });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(j.error || ('语音识别 HTTP ' + res.status));
    noteSttErr(err);
    throw err;
  }
  Guard.ok('stt');
  return { text: (j.text || '').trim(), language: detectToCode(j.language), mock: !!j.mock };
}
/* 流式降采样器：任意采样率 → 16kHz，维护 carry，逐块线性插值输出 */
function makeStreamResampler(fromRate) {
  const ratio = (fromRate || 48000) / 16000;
  let carry = new Float32Array(0);
  let pos = 0;
  return {
    push(chunk) {
      const src = new Float32Array(carry.length + chunk.length);
      src.set(carry, 0); src.set(chunk, carry.length);
      const out = [];
      while (pos + ratio <= src.length) {
        const i = Math.floor(pos), f = pos - i;
        const a = src[i] || 0;
        const b = src[i + 1] !== undefined ? src[i + 1] : a;
        out.push(a + (b - a) * f);
        pos += ratio;
      }
      const keep = Math.floor(pos);
      carry = src.slice(keep);
      pos -= keep;
      return Float32Array.from(out);
    },
  };
}
/* 云端实时流式识别：WebSocket 边录边识别，逐词返回部分结果（对标豆包/讯飞） */
class SttRealtime {
  constructor(cb) { this.cb = cb; this.ws = null; this.lang = 'en'; this.acc = ''; this.itemId = null; this.gotMsg = false; }
  start(lang) {
    this.lang = lang || 'en'; this.acc = '';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try { ws = new WebSocket(proto + '//' + location.host + '/api/stt-ws'); } catch (e) { return; }
    this.ws = ws;
    ws.onopen = () => {
      console.log('[RT] WS已连接');
      try { ws.send(JSON.stringify({ type: 'session.update', session: { input_audio_format: 'pcm', input_sample_rate: 16000, language: this.lang, turn_detection: { type: 'server_vad', silence_duration_ms: 400 } } })); } catch (e) { console.log('[RT] session.update 发送失败', e); }
    };
    ws.onmessage = (ev) => {
      this.gotMsg = true;
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      console.log('[RT] 收到:', m.type, (m.type && m.type.indexOf('transcription') >= 0) ? JSON.stringify(m).slice(0, 180) : '');
      if (m.type === 'conversation.item.input_audio_transcription.text') {
        if (this.itemId && m.item_id !== this.itemId) this.acc = '';
        this.itemId = m.item_id;
        const text = ((m.text || '') + (m.stash || '')).trim();
        if (text && text !== this.acc) { this.acc = text; this.cb({ type: 'interim', text }); }
      } else if (m.type === 'conversation.item.input_audio_transcription.completed') {
        const t = (m.transcript || this.acc || '').trim();
        if (t) this.cb({ type: 'final', text: t, lang: m.language || this.lang });
        this.acc = '';
      }
    };
    ws.onerror = () => { console.log('[RT] WS错误'); toast('❌ 实时流式连接失败', 4000); if (!this.gotMsg && this.cb) this.cb({ type: 'error' }); };
    ws.onclose = (ev) => { console.log('[RT] WS关闭 code=', ev.code); if (!this.gotMsg && this.cb) this.cb({ type: 'error' }); };
  }
  send(pcm16) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const n = pcm16.length;
    this._sent = (this._sent || 0) + 1;
    if (this._sent <= 3) console.log('[RT] 发送音频', n, '采样, readyState=', this.ws.readyState);
    const int16 = new Int16Array(n);
    for (let i = 0; i < n; i++) { const s = pcm16[i] < -1 ? -1 : pcm16[i] > 1 ? 1 : pcm16[i]; int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF; }
    const bytes = new Uint8Array(int16.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    try { this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(bin) })); } catch (e) {}
  }
  stop() { try { if (this.ws) this.ws.close(); } catch (e) {} this.ws = null; }
}
class SttCloud {
  constructor(cb) { this.cb = cb; }
  async segment(blob) {
    if (!State.running) return;
    const t0 = performance.now();
    const duo = S.mode === 'duo';
    const hint = duo
      ? (S.who !== 'auto' ? (S.who === 'A' ? S.A : S.B) : null)
      : (S.src || null);
    const attempt = async () => {
      const r = await sttRequest(blob, hint, true);   // 段落级识别：走双引擎择优
      if (!State.running || !r.text) return;
      let lang = null;
      if (duo) lang = (S.who !== 'auto') ? (S.who === 'A' ? S.A : S.B) : r.language;
      else lang = r.language || S.src;
      this.cb({ text: r.text, lang, t0, mock: r.mock });
    };
    try {
      await attempt();
    } catch (e) {
      if (!State.running) return;
      if (Guard.isBusyError(e)) {           // 限流/繁忙：稍等重试一次，不切引擎
        if (State.running && this._retrying) return;
        this._retrying = true;
        await sleep(2000);
        this._retrying = false;
        if (!State.running) return;
        try { await attempt(); return; } catch (e2) {
          if (!State.running) return;
          errToast('语音识别繁忙，本句跳过：' + e2.message);
          return;
        }
      }
      if (S.sttEngine === 'auto' && !/401|403|404|405/i.test(e.message || '')) {
        Controller.fallbackToNative('云端语音识别不可用：' + e.message);
      } else {
        errToast('语音识别失败：' + e.message + (S.sttEngine === 'auto' ? '（检查识别模型名/权限）' : ''));
      }
    }
  }
}
/* 浏览器引擎：Web Speech API 流式（Chrome/Edge），免密钥、零延迟；无自动语言检测 */
class SttNative {
  constructor(cb, opts) {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) throw new Error('此浏览器不支持 Web Speech API（请用 Chrome/Edge 或改用云端识别）');
    opts = opts || {};
    this.Ctor = Ctor;
    this.cb = cb;
    this.commit = opts.commit !== false;   // false = 预览专用：只上报局部字幕，不产出权威句子
    this.rec = null;
    this.assembler = this.commit ? new SentenceAssembler(cb) : null;
  }
  currentLang() { return (S.mode === 'duo') ? (S.who === 'B' ? S.B : S.A) : S.src; }
  start() {
    if (this.rec) { try { this.rec.onend = null; this.rec.abort && this.rec.abort(); } catch {} this.rec = null; }
    const rec = new this.Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = L(this.currentLang())[2] || 'zh-CN';
    rec.onresult = (ev) => {
      if (!State.running) return;
      let interim = '', finals = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const rr = ev.results[i];
        if (rr.isFinal) finals += rr[0].transcript; else interim += rr[0].transcript;
      }
      if (finals && this.commit && this.assembler) this.assembler.push(finals);
      if (interim) Controller.onInterim(interim);
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        if (Controller && Controller.markSttSrc) Controller.markSttSrc('⚡不可用（未授权）');
        toast('语音识别权限被拒（' + ev.error + '），请在浏览器中允许', 6000);
      } else if (ev.error === 'aborted' || ev.error === 'no-speech') { /* ignore */ }
      else {
        console.warn('[ASR]', ev.error);
        if (Controller && Controller.markSttSrc && /network|service-not-allowed|language-not-supported/i.test(ev.error)) {
          Controller.markSttSrc('⚡不可用（' + ev.error + '）→ 已改用云识别');
        }
      }
    };
    rec.onend = () => {
      if (State.running && this.rec === rec) {
        try { rec.start(); } catch {}
      }
    };
    try { rec.start(); } catch (e) { toast('识别引擎启动失败：' + e.message); }
    this.rec = rec;
  }
  stop() {
    if (this.assembler) this.assembler.flush();
    const rec = this.rec;
    this.rec = null;
    if (rec) { try { rec.onend = null; rec.stop(); } catch {} }
  }
}
/* 把零碎识别结果按标点组装成完整句子；停顿 1.5s 兜底成句 */
class SentenceAssembler {
  constructor(cb) { this.cb = cb; this.pending = ''; this.flushTimer = null; }
  push(text) {
    this.pending += text;
    this.emitComplete();
    this.armFlush();
  }
  emitComplete() {
    const parts = this.pending.split(/(?<=[。！？!?；;…])/);
    if (parts.length > 1) {
      const done = parts.slice(0, -1);
      this.pending = parts[parts.length - 1];
      for (const s of done) { const t = s.trim(); if (t.length > 1) this.cb({ text: t, lang: null, native: true }); }
    }
    if (this.pending.length > 180) this.flush();
  }
  armFlush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 1100);
  }
  flush() {
    clearTimeout(this.flushTimer);
    const t = this.pending.trim();
    this.pending = '';
    if (t.length > 1) this.cb({ text: t, lang: null, native: true });
  }
}

/* ================= 3. 翻译（SSE 流式，OpenAI 兼容） ================= */
async function translateStream(text, sourceLang, targetLang, epoch, onDelta, outerSignal, ctxMsgs, modelOverride, draftStyle) {
  // 超时保护：上游卡住时（实测偶发 10~20s）必须能中断，否则整条翻译流水线会永久停摆
  const ctl = new AbortController();
  const timeoutMs = draftStyle ? 20000 : 45000;
  const killTimer = setTimeout(() => { try { ctl.abort(); } catch {} }, timeoutMs);
  if (outerSignal) {
    if (outerSignal.aborted) { clearTimeout(killTimer); throw new Error('会话已结束'); }
    outerSignal.addEventListener('abort', () => { try { ctl.abort(); } catch {} }, { once: true });
  }
  const signal = ctl.signal;   // 之后的代码沿用 signal
  const settings = apiSettings();
  if (modelOverride) settings.chatModel = modelOverride;   // 实时草稿用更快的小模型
  const body = {
    text, sourceLang: sourceLang || '',
    sourceName: L(sourceLang || '')[1] || '原文', targetName: L(targetLang)[1],
    style: draftStyle ? 'draft' : 'interp', settings,
  };
  if (ctxMsgs && ctxMsgs.length) body.context = ctxMsgs;   // ③ 历史对话上下文
  if (S.glossary) body.glossary = String(S.glossary).split('\n').map((s) => s.trim()).filter(Boolean);   // 自定义术语
  if (S.domain && S.domain !== 'auto') body.domain = S.domain;   // 领域风格提示
  if (S.notes) body.notes = String(S.notes).slice(0, 300);       // 额外要求
  const res = await fetch('/api/translate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal,
  });
  if (signal && signal.aborted) throw new Error('aborted');
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const err = new Error(j.error || ('翻译 HTTP ' + res.status));
    noteChatErr(err);
    throw err;
  }
  if (epoch !== State.epoch) throw new Error('会话已结束');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', out = '';
  for (;;) {
    let chunk;
    try { chunk = await reader.read(); }
    catch (e) { if (signal && signal.aborted) throw new Error('aborted'); throw e; }
    const { done, value } = chunk;
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf(NL)) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      let j;
      try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (epoch !== State.epoch) throw new Error('会话已结束');
      if (typeof j.d === 'string') { out += j.d; onDelta && onDelta(out); }
      else if (typeof j.text === 'string') { out = j.text; onDelta && onDelta(out); }
      else if (j.error) throw new Error(j.error);
    }
  }
  clearTimeout(killTimer);
  Guard.ok('chat');
  return out;
}

/* 定稿精修：把「原文 + 草稿译文」交给精修模型（可走独立供应商，如 GPT） */
async function refineTranslate(src, draft, sourceLang, targetLang) {
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch {} }, 60000);   // 精修在后台跑，给足 60s
  try {
    const body = {
      task: 'refine', text: src, draft: draft || '',
      sourceLang: sourceLang || '', targetName: L(targetLang)[1],
      settings: apiSettings(),
    };
    if (S.glossary) body.glossary = String(S.glossary).split('\n').map((s) => s.trim()).filter(Boolean);
    if (S.domain && S.domain !== 'auto') body.domain = S.domain;
    const res = await fetch('/api/translate?final=1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || ('精修 HTTP ' + res.status));
    return String(j.text || '').trim();
  } finally { clearTimeout(timer); }
}
/* 背景语音过滤：源语言是英文、识别结果却是中文 → 说明是旁人在说中文，丢弃；反之亦然 */
function langMismatch(text, srcLang) {
  const t = String(text || '');
  const cjk = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  if (!t.trim()) return true;
  if (srcLang === 'en') return cjk >= 4 && cjk > latin * 0.5;
  if (srcLang === 'zh') return latin >= 12 && latin > cjk * 2;
  return false;
}
/* 去重工具①：把“已定稿部分”和“实时部分”的重叠前缀剥掉（两路识别拼接防重复） */
function stripOverlap(committed, live) {
  // 强去重：在“新文本”里找“已定稿文本末尾的最长片段”，命中则把它之前的内容全部裁掉
  // （能处理“同一段被重复提交/快照从段首重来”这类情况，而不只是前缀对齐）
  if (!committed || !live) return live || '';
  const tail = committed.slice(-240);
  const maxLen = Math.min(tail.length, live.length, 160);
  for (let len = maxLen; len >= 12; len--) {
    const needle = tail.slice(tail.length - len);
    const idx = live.indexOf(needle);
    if (idx >= 0) {
      const cut = live.slice(idx + len).replace(/^[\s,，.。、;；:：]+/, '');
      return cut;
    }
  }
  // 兜底：若新文本整体包含在已定稿文本中（完全重复）→ 视为无新内容
  if (live.length >= 20 && committed.includes(live.slice(0, Math.min(40, live.length)))) return '';
  return live;
}
/* 滚动窗口：超长时按“句末标点”对齐截取，避免从半句中间开始显示 */
function tailWindow(t, max) {
  const s = String(t || '');
  if (s.length <= max) return s;
  let cut = s.length - max;
  const rest = s.slice(cut);
  const m = rest.match(/[.。！？!?;；]\s*/);
  if (m && m.index >= 0) cut += m.index + m[0].length;
  return s.slice(cut);
}
/* 去重工具②：清理“同一段里把某个短语说了两遍”（ASR 在长音频上偶发的重复循环） */
function dedupeRepeatPhrases(text, minLen) {
  let t = String(text || '');
  const floor = Math.max(8, minLen || 24);
  // 快速预检：没有重复片段就直接返回（保证正常渲染零开销）
  const seen = new Set();
  let dup = false;
  for (let i = 0; i + floor <= t.length; i++) {
    const g = t.slice(i, i + floor);
    if (seen.has(g)) { dup = true; break; }
    seen.add(g);
  }
  if (!dup) return t;
  for (let pass = 0; pass < 4; pass++) {
    let removed = false;
    const maxLen = Math.min(160, Math.floor(t.length / 2));
    outer:
    for (let len = maxLen; len >= floor; len -= 4) {
      for (let i = 0; i + len <= t.length; i++) {
        const sub = t.slice(i, i + len);
        const j = t.indexOf(sub, i + len);
        if (j > i + 8) {   // 非紧邻的重复 → 删掉第二次出现
          t = (t.slice(0, j) + t.slice(j + len)).replace(/\s{2,}/g, ' ');
          removed = true;
          break outer;
        }
      }
    }
    if (!removed) break;
  }
  return t.replace(/\s{2,}/g, ' ').trim();
}
/* 去重工具③：近似句/子句去重（ASR 常把同一句复述一遍，但用词略有不同） */
function _tokens(s) {
  const t = String(s).toLowerCase();
  if (/[\u4e00-\u9fa5]/.test(t)) {
    const chips = t.replace(/[^\u4e00-\u9fa5]/g, '');
    const g = new Set();
    for (let i = 0; i + 2 <= chips.length; i++) g.add(chips.slice(i, i + 2));   // 中文用双字组
    return g;
  }
  return new Set(t.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1));
}
function _similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of b) if (a.has(x)) inter += 1;
  return inter / Math.min(a.size, b.size);   // 包含度：短句被长句覆盖即视为重复
}
function dedupeSimilarClauses(text) {
  const raw = String(text || '');
  if (raw.length < 40) return raw;
  const parts = raw.split(/(?<=[.!?。！？;；])\s*/).filter((s) => s.trim());
  if (parts.length < 2) return raw;
  const seenToks = [];
  const outParts = [];
  for (const part of parts) {
    const frags = part.split(/(?<=[,，、])\s*/).filter((s) => s.trim());
    const outs = [];
    for (const f of frags) {
      const toks = _tokens(f);
      let dup = false;
      if (toks.size >= 4) {
        for (const k of seenToks.slice(-6)) {
          if (_similarity(k, toks) >= 0.72) { dup = true; break; }
        }
      }
      if (dup) continue;
      if (toks.size >= 4) seenToks.push(toks);
      outs.push(f.trim());
    }
    if (outs.length) outParts.push(outs.join(' '));
  }
  return outParts.join(' ');
}
/* 去重工具④：压掉模型偶发的重复循环 */
function tidyTranslation(t) {
  if (!t) return t;
  let s = String(t);
  s = s.replace(/(\S{1,10})(?:[\s]+\1){2,}/g, '$1');
  s = s.replace(/([\u4e00-\u9fa5]{1,6})\1{3,}/g, '$1');
  s = dedupeSimilarClauses(dedupeRepeatPhrases(s, 12));   // 中文里重复/近似重复的短语也压掉
  s = s.replace(/…{1,}|\.{3,}/g, '').replace(/[，、]{2,}/g, '，').replace(/\s{2,}/g, ' ').trim();   // 清掉模型打的省略号
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}
/* ---------- 段落模式（有道翻译官式）：一段一段出，边说边显示双语 ---------- */
const Para = {
  active: false,
  segments: [],
  origLang: 'en', trLang: 'zh', tr: '', src: '', _live: '', _seg: '',
  _enFinal: '', _zhFinal: '', _lastPartial: '', currentTr: '', _dualEn: null, _dualZh: null,
  _enParts: [], _zhParts: [], _lastCommittedEn: '', _lastCommittedZh: '',   // 已定稿文本（用于跨段去重）
  seq: 0, lastSegAt: 0, timer: null,
  el: null, origEl: null, trEl: null, statEl: null, langEl: null,
  _busy: false, _requestText: '', _translatedText: '', _transSrc: '', _transOut: '', _pendingDelta: '',
  init() {
    this.el = $('#paraPanel');
    if (this.el) {
      this.origEl = this.el.querySelector('.para-orig');
      this.trEl = this.el.querySelector('.para-tr');
      this.statEl = this.el.querySelector('.para-stat');
      this.langEl = this.el.querySelector('.para-lang');
    }
    this._ensureDualEls();
  },
  _ensureDualEls() {
    const eb = $('#dualEn'), zb = $('#dualZh');
    if (eb && (!this._dualEn || !this._dualEn.isConnected)) {
      this._dualEn = document.createElement('p');
      this._dualEn.className = 'dual-line live';
      eb.appendChild(this._dualEn);
    }
    if (zb && (!this._dualZh || !this._dualZh.isConnected)) {
      this._dualZh = document.createElement('p');
      this._dualZh.className = 'dual-line zh live';
      zb.appendChild(this._dualZh);
    }
  },
  _renderDualEn() {
    const live = stripOverlap(this._enFinal || '', this._lastPartial || '');
    const shown = dedupeSimilarClauses(dedupeRepeatPhrases((this._enFinal ? this._enFinal + ' ' : '') + live, 24), 24);   // 兜底清理
    if (this._dualEn) this._dualEn.textContent = tailWindow(shown, 4000);
    this._scrollDual();
  },
  _renderDualZh() {
    const live = stripOverlap(this._zhFinal || '', this.currentTr || '');
    const shown = dedupeSimilarClauses(dedupeRepeatPhrases((this._zhFinal ? this._zhFinal + ' ' : '') + (live || '…'), 12));
    if (this._dualZh) this._dualZh.textContent = tailWindow(shown, 3000);
    this._scrollDual();
  },
  canUse() { return S.paraMode && S.mode === 'oneway'; },
  reset() {
    this.active = false; this.segments = []; this.tr = ''; this.src = ''; this._live = ''; this._seg = '';
    this._lastPartial = ''; this.currentTr = '';
    this._transSrc = ''; this._transOut = ''; this._pendingDelta = '';
    if (this._dualEn && this._dualEn.isConnected) { try { this._dualEn.remove(); } catch {} }
    if (this._dualZh && this._dualZh.isConnected) { try { this._dualZh.remove(); } catch {} }
    this._dualEn = null; this._dualZh = null;   // 保留 _enFinal/_zhFinal 历史
    clearTimeout(this.timer);
    this._busy = false; this._requestText = ''; this._translatedText = '';
    if (this.el) this.el.hidden = true;
  },
  clearAll() {   // 仅在“清空”时调用：连历史一起清
    this._enParts = []; this._zhParts = []; this._lastCommittedEn = ''; this._lastCommittedZh = '';
    this._enFinal = ''; this._zhFinal = ''; this._lastPartial = ''; this.currentTr = '';
    this._transSrc = ''; this._transOut = ''; this._pendingDelta = '';
    this._dualEn = null; this._dualZh = null;
  },
  _scrollDual() {
    if (S.displayStyle !== 'dual') return;
    const en = $('#dualEn'), zh = $('#dualZh');
    if (en && en.parentElement) en.parentElement.scrollTop = en.parentElement.scrollHeight;
    if (zh && zh.parentElement) zh.parentElement.scrollTop = zh.parentElement.scrollHeight;
  },
  begin(origLang) {
    this.origLang = origLang;
    this.trLang = S.speakLang || origLang;
    this.segments = []; this.tr = ''; this.src = ''; this._live = ''; this._seg = '';
    this._transSrc = ''; this._transOut = ''; this._pendingDelta = '';
    this._snapFull = '';
    this.lastSegAt = performance.now();
    this._busy = false; this._requestText = ''; this._translatedText = '';
    this.active = true;
    if (S.displayStyle === 'dual') {
      // 分屏：英文/中文持续累积进两个大区（不换行，逐词增长）
      if (this.el) this.el.hidden = true;
      this._ensureDualEls();
      this._lastPartial = ''; this.currentTr = '';
      this.origEl = null; this.trEl = null; this.statEl = null; this.langEl = null;
      this._renderDualEn(); this._renderDualZh();
    } else {
      if (this.el) {
        this.el.hidden = false;
        this.el.classList.remove('speaking');
        if (this.langEl) this.langEl.textContent = L(origLang)[1] + ' → ' + L(this.trLang)[1];
        if (this.statEl) this.statEl.textContent = '聆听中…（停顿约 1.8 秒定稿）';
      }
      this.origEl = this.el ? this.el.querySelector('.para-orig') : null;
      this.trEl = this.el ? this.el.querySelector('.para-tr') : null;
      if (this.origEl) this.origEl.textContent = '';
      if (this.trEl) { this.trEl.classList.add('thinking'); this.trEl.textContent = '…'; }
    }
  },
  _syncText() {   // 以“更长、更完整”者作为统一文本源，显示与翻译都用它
    const seg = this._seg || '';
    const live = this._live || '';
    this.src = (seg.length >= live.length ? seg : live);
    if (this.origEl) this.origEl.textContent = this.src;
    this._scrollDual();
  },
  renderOrig() { this._syncText(); },
  appendSeg(text) {
    if (!this.active) return;
    text = dedupeSimilarClauses(dedupeRepeatPhrases(text, 24));   // 权威句同样清理
    this.segments.push(text);
    this._seg = this.segments.join(' ');
    this.lastSegAt = performance.now();
    if (S.displayStyle === 'dual') {
      if (this._seg.length >= (this._lastPartial || '').length) this._lastPartial = this._seg;
      this._renderDualEn();
      this.schedule();
      return;
    }
    this._syncText();
    this.schedule();
  },
  setOrigLive(text) {   // 快照/局部识别 → 原文实时刷新（草稿，与权威句自动取更完整者）
    if (!this.active) return;
    const raw = String(text || '').trim();
    // 稳定性守门：云端快照应“在上一版基础上继续变长”；若开头被大幅改写，多为 ASR 复读/幻觉 → 丢弃
    const prevSnap = this._snapFull || '';
    if (prevSnap && raw.length > 0 && !raw.startsWith(prevSnap)) {
      let cp = 0;
      const lim = Math.min(prevSnap.length, raw.length);
      while (cp < lim && prevSnap[cp] === raw[cp]) cp += 1;
      if (cp < Math.min(24, Math.floor(prevSnap.length * 0.4))) return;   // 开头不一致 → 判定不可靠
    }
    this._snapFull = raw;
    text = dedupeSimilarClauses(dedupeRepeatPhrases(raw, 24));   // 段内重复/近似重复清理（ASR 偶发复读）
    this._live = text;
    if (S.displayStyle === 'dual') {
      const n = String(text || '').trim();
      if (!this._lastPartial || n.length >= this._lastPartial.length) this._lastPartial = n;   // 只变长，防闪烁
      this._renderDualEn();
      this.schedule();
      return;
    }
    this._syncText();
    this.schedule();
  },
  currentText() {   // 草稿翻译的输入：当前这一段（长度由“自动定稿”保证不超上限）
    const t = (S.displayStyle === 'dual' ? this._lastPartial : this.src) || '';
    return t.length > 360 ? t.slice(-360) : t;
  },
  schedule() {
    clearTimeout(this.timer);
    // 段落过长（连续讲话不换气）→ 自动定稿换段：保证草稿翻译始终覆盖整段且不拖慢
    const cur = (S.displayStyle === 'dual' ? this._lastPartial : this.src) || '';
    if (S.displayStyle === 'dual' && !this._autoCommitting && cur.length > 320) {
      this._autoCommitting = true;
      const epoch = State.epoch;
      this.commit()
        .then(() => { if (State.running && State.epoch === epoch) this.begin(this.origLang); })
        .catch(() => {})
        .then(() => { this._autoCommitting = false; });
      return;
    }
    this.timer = setTimeout(() => this.request(), 30);
  },
  request() {   // 整段翻译（草稿），带“只变长不闪回”的显示保护
    const src = this.currentText();
    if (!this.active) return;
    if (src.length < 3) { this._requestText = ''; return; }
    this._requestText = src;
    if (this._busy) return;
    this._run();
  },
  async _run() {   // 整段草稿翻译：流式更新，避免显示突然变短
    if (this._busy) return;
    this._busy = true;
    this._busySince = performance.now();
    try {
      while (this.active && State.running) {
        const src = this._requestText;
        if (!src || src.length < 3) break;
        const isDual = S.displayStyle === 'dual';
        const prevLen = ((isDual ? this.currentTr : this.tr) || '').length;
        let shownLen = prevLen;
        const render = (t) => {
          const s = tidyTranslation(t);
          if (!s) return;
          shownLen = s.length;
          if (isDual) { this.currentTr = s; this._renderDualZh(); }
          else if (this.trEl) { this.trEl.classList.remove('thinking'); this.trEl.textContent = s; this._scrollDual(); }
        };
        const ctxTail = S.ctx ? CtxMem.tail(CtxMem.key(this.origLang, this.trLang), 2) : [];   // 草稿带最近 1 轮上文
        let out = '';
        try {
          out = await translateStream(src, this.origLang, this.trLang, State.epoch, (p) => {
            if (State.running && this.active && p && p.length >= prevLen) render(p);   // 只要比已显示的更长就马上更新
          }, undefined, ctxTail.length ? ctxTail : undefined, S.liveModel);
        } catch (e) { console.warn('[草稿翻译失败]', e.message); }
        if (!tidyTranslation(out)) {   // 草稿模型返回空/空白 → 用主模型兜底重试一次
          try { out = await translateStream(src, this.origLang, this.trLang, State.epoch, null, undefined, undefined, undefined, false); }
          catch (e2) { console.warn('[兜底翻译失败]', e2.message); }
        }
        if (out) render(out);
        if (out) this.tr = tidyTranslation(out);
        this._translatedText = src;
        if (!this.active) break;
        if (src === this._requestText) break;
      }
    } finally {
      this._busy = false;
      this._busySince = 0;
    }
  },
  async refineLast(orig) {   // 定稿精修：默认走独立精修模型（如 GPT），失败则保留草稿
    if (!S.liveModel || !S.refineGpt) return;   // 未启用草稿或关闭精修时不跑
    const epoch = State.epoch;
    try {
      const draft = (S.displayStyle === 'dual'
        ? (this._zhParts[this._zhParts.length - 1] || '')
        : (this.tr || ''));
      const better = await refineTranslate(orig, draft, this.origLang, this.trLang);
      if (!better || State.epoch !== epoch) return;
      if (S.displayStyle === 'dual') {
        const i = this._zhParts.length - 1;
        if (i >= 0) { this._zhParts[i] = better; this._zhFinal = this._zhParts.join(' '); this._renderDualZh(); }
      }
    } catch (e) { /* 精修失败：保留草稿译文 */ }
  },
  async commit() {   // 停顿定稿：等翻译收尾后成段落卡片 + （可选）播报一次
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.timer);
    const deadline = performance.now() + 1600;
    while (this._busy && performance.now() < deadline) await sleep(80);
    let tr = ((S.displayStyle === 'dual' ? (this.currentTr || this.tr) : this.tr) || '').replace(/…$/,'').trim();
    let orig = (S.displayStyle === 'dual'
      ? (this._lastPartial || this.src || this._seg || '')
      : (this.src || this._seg || this._translatedText || '')).trim();
    const rawOrig = orig;
    orig = stripOverlap(this._lastCommittedEn || '', orig);   // 去掉与已定稿内容重复的部分
    tr = stripOverlap(this._lastCommittedZh || '', tr);       // 译文同样去重（防“中文跟着重复”）
    if (orig) this._lastCommittedEn = ((this._lastCommittedEn || '') + ' ' + orig).slice(-400);
    if (tr) this._lastCommittedZh = ((this._lastCommittedZh || '') + ' ' + tr).slice(-400);
    // 整段重复（去掉后没有新内容）→ 不入库，避免原文/译文成倍膨胀
    if (!orig && rawOrig.length > 12) {
      this._lastPartial = ''; this.currentTr = '';
      this._renderDualEn(); this._renderDualZh();
      if (State.running) this.begin(this.origLang);
      return;
    }
    if (S.displayStyle === 'dual') {
      if (orig) this._enParts.push(orig);
      if (tr) this._zhParts.push(tr);
      this._enFinal = this._enParts.join(' ');
      this._zhFinal = this._zhParts.join(' ');
      this._lastPartial = ''; this.currentTr = '';
      this._renderDualEn(); this._renderDualZh();
      State.segCount++;
      $('#statSegs').textContent = State.segCount;
      if (orig) this.refineLast(orig);   // 草稿先出，随即用大模型把这一段精修一遍
    } else if (orig) {
      appendParagraph(orig, tr, this.origLang, this.trLang, this.seq++);
      if (tr && S.voiceOn) {
        Controller.speaker.push(tr, this.trLang, {
          seq: ++State.segSeq, rowEl: null,
          onStart: () => { if (this.el) this.el.classList.add('speaking'); },
          onEnd: () => { if (this.el) this.el.classList.remove('speaking'); },
        });
      }
      State.segCount++;
      $('#statSegs').textContent = State.segCount;
    }
    this.segments = []; this.tr = ''; this.src = ''; this._live = ''; this._seg = '';
    this._lastPartial = ''; this.currentTr = '';
    this._transSrc = ''; this._transOut = ''; this._pendingDelta = '';
    if (this.el) { this.el.hidden = true; }
  },
};
/* ---------- ① 识别文本清洗 + ③ 上下文记忆 ---------- */
async function callClean(text, sourceLang) {
  if (Guard.degraded('chat')) return null;   // 限流中：跳过清洗，直接用原文翻译
  const res = await fetch('/api/translate?final=1', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, task: 'clean', sourceLang: sourceLang || '', settings: apiSettings() }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(j.error || ('清洗 HTTP ' + res.status));
    noteChatErr(err);
    throw err;
  }
  Guard.ok('chat');
  const out = String(j.text || '').trim();
  return out || null;
}
const CtxMem = {
  map: new Map(),
  clear() { this.map.clear(); },
  key(o, t) { return o + '>' + t; },
  get(key) { return this.map.get(key) || []; },
  depth() { return Math.max(2, Math.min(12, Number(S.ctxRounds || 5))) * 2; },   // 记忆轮数→消息条数
  tail(key, n) { const a = this.map.get(key) || []; return a.slice(-Math.max(0, Number(n) || 0)); },
  push(key, orig, out) {
    const a = this.map.get(key) || [];
    a.push({ role: 'user', content: String(orig).slice(0, 500) });
    a.push({ role: 'assistant', content: String(out).slice(0, 500) });
    const cap = this.depth();
    if (a.length > cap) a.splice(0, a.length - cap);   // 保留最近 N 轮（默认 5 轮）
    this.map.set(key, a);
  },
};

/* ================= 4. 播报队列（单任务泵，按句序播放，先备好再出声） ================= */
class Speaker {
  constructor() {
    this.queue = [];
    this.cache = new Map();
    this.audio = null;
    this.epoch = 0;
    this._alive = false;
    this._task = null;
    this._gen = 0;
  }
  cacheKey(text, lang) { return lang + '|' + text.slice(0, 60); }
  async cloudFetch(text, lang) {
    const res = await fetch('/api/speech', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang, voice: S.ttsVoice, settings: apiSettings() }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const err = new Error(j.error || ('TTS HTTP ' + res.status));
      err.noCloud = /NO_CLOUD_TTS/i.test(j.error || '');
      throw err;
    }
    return URL.createObjectURL(await res.blob());
  }
  push(text, lang, opts) {
    if (!text || !State.running || State.epoch !== this.epoch) return;
    const item = { text, lang, seq: opts.seq || 0, ready: false, failed: false, useWeb: false, url: null, rowEl: opts.rowEl, onStart: opts.onStart, onEnd: opts.onEnd };
    this.queue.push(item);
    this.queue.sort((a, b) => (a.seq || 1e9) - (b.seq || 1e9));  // 严格按句子先后播
    this.prepare(item);
    this._alive = true;
    this._kick();
  }
  async prepare(item) {
    try {
      if (S.ttsEngine !== 'web') {
        try {
          const ck = this.cacheKey(item.text, item.lang);
          if (this.cache.has(ck)) item.url = this.cache.get(ck);
          else {
            const url = await this.cloudFetch(item.text, item.lang);
            if (State.epoch !== this.epoch || !State.running) return;
            item.url = url;
            this.cache.set(ck, url);
            if (this.cache.size > 80) {
              const k = this.cache.keys().next().value;
              const old = this.cache.get(k);
              this.cache.delete(k);
              URL.revokeObjectURL(old);
            }
          }
        } catch (e) {
          if (e.noCloud || S.ttsEngine === 'auto') item.useWeb = true;
          else item.failed = true;
        }
      } else item.useWeb = true;
      item.ready = true;
    } catch { item.failed = true; }
  }
  _kick() {
    if (!this._task) {
      this._task = this._loop().catch(() => {}).finally(() => { this._task = null; });
    }
  }
  async _loop() {
    while (this._alive && State.running) {
      const head = this.queue[0];
      if (!head) { await sleep(90); continue; }
      if (head.failed) { this.queue.shift(); continue; }
      if (!head.ready) { await sleep(70); continue; }
      this.queue.shift();
      if (head.onStart) head.onStart(head);
      try {
        if (head.useWeb) await this.playWeb(head);
        else if (head.url) await this.playUrl(head);
      } catch {}
      if (head.onEnd) head.onEnd(head);
    }
  }
  playUrl(head) {
    return new Promise((resolve) => {
      const gen = this._gen;
      const a = new Audio();
      this.audio = a;
      const fin = (ok) => {
        clearInterval(iv);
        if (this.audio === a) this.audio = null;
        resolve(ok);
      };
      a.onended = () => fin(true);
      a.onerror = () => fin(false);
      a.src = head.url;
      const iv = setInterval(() => {
        if (this._gen !== gen || !State.running || !this._alive) { try { a.pause(); } catch {} fin(false); }
      }, 150);
      a.play().catch(() => fin(false));
    });
  }
  playWeb(head) {
    return new Promise((resolve) => {
      const gen = this._gen;
      const u = new SpeechSynthesisUtterance(head.text);
      u.lang = L(head.lang)[2] || head.lang;
      u.rate = S.rate;
      const v = voices().find((x) => x.lang.toLowerCase().startsWith((L(head.lang)[2] || 'en').slice(0, 2)) && x.localService);
      if (v) u.voice = v;
      u.onend = () => resolve(true);
      u.onerror = () => resolve(false);
      speechSynthesis.speak(u);
      const iv = setInterval(() => {
        if (this._gen !== gen || !State.running || !this._alive) {
          try { speechSynthesis.cancel(); } catch {}
          resolve(false);
        }
      }, 150);
    });
  }
  interrupt(text, lang, rowEl) {   // 立即重播（打断排队）
    this.stop();
    this._gen++; this._alive = true;
    const item = { text, lang, ready: false, failed: false, useWeb: false, url: null, rowEl };
    this.queue = [item];
    this.prepare(item);
    this._kick();
  }
  stop() {
    this._alive = false;
    this._gen++;
    if (this.audio) { try { this.audio.pause(); } catch {} this.audio = null; }
    try { speechSynthesis.cancel(); } catch {}
    this.queue = [];
  }
  prime() { this.epoch = State.epoch; this.stop(); }
}
let _voices = [];
const voices = () => {
  if (!_voices.length && window.speechSynthesis) _voices = speechSynthesis.getVoices();
  return _voices;
};
if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => { _voices = speechSynthesis.getVoices(); };

/* ================= 4.5 实时修订草稿（边说边出·随语音修正） ================= */
/* 目标效果（对标 Google/讯飞口译模式）：
   说话过程中，中文译文草稿立即出现、随语音识别结果不断自我修正、越说越长；
   整句说完（停顿成段）后由权威引擎定稿，草稿原位消失、正式句子卡片落定。 */
const Preview = {
  timer: null,
  ctrl: null,
  _clearT: null,
  lastText: '',
  debounceMs: 260,          // 局部字幕停 260ms 就开始翻，尽量跟嘴
  targetLang() {
    if (S.mode === 'oneway') return S.speakLang;
    if (S.who === 'A') return S.B;
    if (S.who === 'B') return S.A;
    return null;                       // 双向自动辨向时方向未定，暂不预览译文
  },
  sourceLang() { return S.mode === 'oneway' ? S.src : (S.who === 'B' ? S.B : S.A); },
  show(orig) {
    if (!State.running || !S.preview) return;
    if (Guard.degraded('chat')) return;   // 限流中暂停草稿翻译，只保留识别原文滚动
    const tgt = this.targetLang();
    const text = String(orig || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (this._clearT) { clearTimeout(this._clearT); this._clearT = null; }
    const el = $('#livePreview');
    if (!tgt) return;                    // 方向未定：不抢译（原文字幕仍正常）
    if (text.length < 2) {               // 瞬时空白：等 800ms 仍无字再收起草稿，避免闪烁
      if (!this._clearT) this._clearT = setTimeout(() => { this._clearT = null; this.clearText(); }, 800);
      return;
    }
    if (el && el.hidden) { el.hidden = false; el.textContent = '实时中文（草稿）· …'; }
    clearTimeout(this.timer);
    if (text === this.lastText) return;  // 识别局部结果没变化：不重复翻译
    this.lastText = text;
    this.timer = setTimeout(async () => {
      if (!State.running || !S.preview) return;
      if (this.ctrl) { try { this.ctrl.abort(); } catch {} }
      const ctrl = new AbortController();
      this.ctrl = ctrl;
      const showDraft = (t) => {
        if (!State.running || this.ctrl !== ctrl || ctrl.signal.aborted) return;
        const e = $('#livePreview');
        if (e && t && t.trim()) { e.hidden = false; e.textContent = '实时中文（草稿）· ' + t; }
      };
      try {
        const out = await translateStream(text, this.sourceLang(), tgt, State.epoch, showDraft, ctrl.signal, undefined, S.liveModel);
        showDraft(out);                  // 结论也逐字流入同一草稿行
      } catch (e) {
        if (!/abort/i.test(e.message || '')) console.warn('[草稿]', e.message);
      } finally {
        if (this.ctrl === ctrl) this.ctrl = null;
      }
    }, this.debounceMs);
  },
  clearText() {                          // 定稿/停止时收起草稿
    clearTimeout(this.timer);
    clearTimeout(this._clearT);
    this._clearT = null;
    if (this.ctrl) { try { this.ctrl.abort(); } catch {} this.ctrl = null; }
    this.lastText = '';
    const el = $('#livePreview');
    if (el) { el.hidden = true; el.textContent = ''; }
  },
};

/* ================= 5. 控制器：串起整条链路 ================= */
const Controller = {
  capture: new Capture(),
  speaker: new Speaker(),
  stt: null,          // 权威识别引擎（SttCloud 或 SttNative）
  previewRec: null,   // 预览专用识别（仅云端权威时启用）
  engine: 'cloud',
  fallbackDone: false,
  _lastInterimAt: 0,

  idleGuard() {   // 空闲保护：长时间没有有效语音 → 自动停止并提示
    if (!State.running) return;
    const now = Date.now();
    if (!this._lastSpeechAt) { this._lastSpeechAt = now; return; }
    const idleMin = (now - this._lastSpeechAt) / 60000;
    if (idleMin >= 10) {
      toast('已连续 10 分钟没有识别到有效语音，为免浪费额度已自动停止。要继续请重新点「开始」', 12000);
      this.stop();
      return;
    }
    if (idleMin >= 5 && !this._idleWarned) {
      this._idleWarned = true;
      toast('已经 5 分钟没听到有效语音了，若不再使用请点「停止」（10 分钟后会自动停止）', 9000);
    }
    if (idleMin < 5) this._idleWarned = false;
  },
  wireCapture() {   // 采集接线：音量表 + 权威分段 + 定时快照（恢复麦克风后必须重新调用）
    this.capture.enableMonitor(S.monitor);
    this.capture.onLevel = (r) => { $('#meterFill').style.width = Math.min(100, Math.round(r * 2200)) + '%'; };
    this.capture.onSegment = (blob) => {
      if (!State.running || this.engine !== 'cloud' || !this.stt) return;
      const mark = Date.now();
      setLive('识别中…（停顿后自动成句）', true);
      this.stt.segment(blob);
      setTimeout(() => {   // 若预览字幕早已静默，这里补一句状态提示
        if (State.running && this.engine === 'cloud' && mark - this._lastInterimAt > 800) {
          setLive('识别中…（停顿后自动成句）', true);
        }
      }, 1400);
    };
    this.capture.onSnapshot = (blob) => this.draftSnap(blob);
  },
  async start() {
    if (State.running || this._starting) return;
    this._starting = true;
    setMicBusy(true, '启动中…');
    setLive('正在请求麦克风…若浏览器弹出提示，请点「允许」', false);
    const fail = (msg) => { this._starting = false; setMicBusy(false); setLive(msg || '启动失败，请重试。', true); };
    // 权限预检：仅在“尚未授权”时检查，已授权则直接跳过（更快启动，也不会重复打扰）
    if (!State.micGranted) {
      try {
        if (navigator.permissions && navigator.permissions.query) {
          const st = await navigator.permissions.query({ name: 'microphone' });
          if (st.state === 'denied') {
            toast('麦克风被禁止了：点地址栏左侧的 🔒/🎤 图标 → 改为「允许」→ 再点开始', 9000);
            return fail('麦克风权限被禁止（见浏览器地址栏设置）');
          }
        }
      } catch {}
    }
    this.engine = pickAuthorEngine();
    if (this.engine === 'native' && !nativeSupported()) {
      toast('浏览器流式识别不可用（需 Chrome/Edge），或在「设置」配置云端识别 API Key');
      $('#btnSettings').click();
      return;
    }
    if (this.engine === 'cloud' && !needCloudConfigured()) {
      toast('云端识别未配置：请在「设置」①选择管理员预设代号（如 snow），或手动填写 API Key');
      $('#btnSettings').click();
      return;
    }
    if (S.mode === 'duo' && this.engine === 'native' && S.who === 'auto') {
      S.who = 'A';
      saveS();
      syncWhoUI();
      toast('双人模式下浏览器流式识别无法自动辨向，已切为手动 A/B 切换');
    }
    try { await this.capture.start(); }
    catch (e) { toast('麦克风启动失败：' + e.message, 9000); return fail('麦克风启动失败：' + e.message); }
    this.capture.needRec = (this.engine === 'cloud' || this.engine === 'realtime');
    this._starting = false; setMicBusy(false);

    State.epoch = ++State.epoch;
    State.running = true;
    State.segSeq = 0; State.segCount = 0; State.latSamples = []; State.lastSentence = null;
    CtxMem.clear();
    Guard.reset();
    Para.reset();
    this.fallbackDone = false;
    this._snapFail = 0;
    this._lastInterimAt = 0;
    this._lastSpeechAt = Date.now(); this._idleStreak = 0; this._idleWarned = false;
    if (!this._idleTimer) this._idleTimer = setInterval(() => this.idleGuard(), 30000);
    $('#statSegs').textContent = '0';
    $('#statLat').textContent = '–';
    $('#statSpk').textContent = '–';
    this.speaker.prime();
    Preview.clearText();
    this.wireCapture();   // 采集回调统一接线（start 与自动恢复共用）
    const sentCb = (sent) => this.onSentence(sent);
    if (this.engine === 'realtime') {
      console.log('[RT] 引擎=realtime, ws支持=', 'WebSocket' in window, 'profile=', S.profile, 'needCloud=', needCloudConfigured());
      const realtimeFail = () => {
        if (!State.running || this.engine !== 'realtime') return;
        try { if (this.stt) this.stt.stop(); } catch (e) {}
        this.stt = new SttCloud(sentCb);
        this.capture.realtimeMode = false;
        this.capture.onPcm = null;
        this.engine = 'cloud';
        this.capture.needRec = true;
        toast('实时流式未连通，已自动切换为整段识别', 4000);
      };
      this.stt = new SttRealtime((msg) => {
        if (!State.running) return;
        if (msg.type === 'error') { realtimeFail(); return; }
        if (msg.type === 'interim') this.onInterim(msg.text);
        else if (msg.type === 'final') this.onSentence({ text: msg.text, lang: msg.lang, t0: performance.now() });
      });
      this.stt.start(S.src);
      this.capture.realtimeMode = true;
      this.capture.onPcm = (pcm16) => { if (this.stt) this.stt.send(pcm16); };
    } else if (this.engine === 'cloud') {
      this.stt = new SttCloud(sentCb);
      // 英文快车道：浏览器流式识别逐词出字（云端快照仍负责权威成句）
      if (nativeSupported() && (S.preview || Para.canUse())) {
        this.previewRec = new SttNative(null, { commit: false });
        this.previewRec.start();
      }
    } else {
      this.stt = new SttNative(sentCb);   // 浏览器流式：局部字幕天然实时
      this.stt.start();
    }
    this.syncRecognizers();
    $('.live-bar').classList.add('recording');
    setUiRunning(true);
    const engName = this.engine === 'cloud' ? '云端识别' : '浏览器流式识别';
    const demo = (serverCfg.mock && this.engine === 'cloud') ? ' · 离线演示' : '';
    setLive(S.preview
      ? '正在聆听…（' + engName + ' · 实时字幕开，说的时候顶部滚动原文+译文）'
      : '正在聆听…（' + engName + ' · 自动识别，译文直接出卡片）', true);
    if (serverCfg.mock && this.engine === 'cloud' && !window.__lbDemoTip) {
      window.__lbDemoTip = 1;
      toast('当前为离线演示模式：卡片带“演示数据”标记、译文为模拟句。真实效果请在「设置」填入 API Key 后重新开始', 8000);
    }
  },
  async stop() {
    if (!State.running) return;
    State.running = false;
    await Para.commit();   // 把在译的一段定稿保留
    if (State.running) return;
    State.epoch = ++State.epoch;
    this.speaker.stop();
    if (this.previewRec) { try { this.previewRec.stop(); } catch {} this.previewRec = null; }
    if (this.stt) { try { this.stt.stop(); } catch {} this.stt = null; }
    Preview.clearText();
    this.capture.needRec = false;
    await this.capture.stop();
    $('.live-bar').classList.remove('recording');
    setUiRunning(false);
    setLive('已停止。点击麦克风重新开始。', true);
  },
  // 麦克风自动修复：切后台回来、锁屏、设备被占用导致断流时，自动重新接管（用户无需刷新）
  async healMic(reason) {
    if (!State.running || this._healing) return;
    const cap = this.capture;
    const tracks = (cap && cap.stream && cap.stream.getAudioTracks) ? cap.stream.getAudioTracks() : [];
    const dead = !cap || !cap.stream || !tracks.length || tracks.every((t) => t.readyState !== 'live');
    const susp = !!(cap && cap.ctx && cap.ctx.state !== 'running');
    if (!dead && !susp) return;
    if (!dead && susp) { try { await cap.ctx.resume(); setLive('已恢复，请继续说。', false); return; } catch {} }
    this._healing = true;
    setLive('麦克风连接中断，正在自动恢复…', false);
    try {
      await sleep(300);
      await this.capture.start();               // 内部先释放再重新取流（带重试）
      this.wireCapture();                       // 关键：重新接上回调，否则“连上却不出字”
      this.capture.needRec = (this.engine === 'cloud' || this.engine === 'realtime');
      if (this.engine === 'cloud' && nativeSupported() && (S.preview || Para.canUse())) {
        if (this.previewRec) { try { this.previewRec.stop(); } catch {} }
        this.previewRec = new SttNative(null, { commit: false });
        this.previewRec.start();
      }
      this._healFails = 0;
      $('.live-bar').classList.add('recording');
      setLive('麦克风已自动恢复，请继续说。', false);
      toast('麦克风已自动恢复 ✅', 3000);
    } catch (e) {
      this._healFails = (this._healFails || 0) + 1;
      setLive('麦克风不可用：' + e.message, true);
      toast(this._healFails >= 2
        ? '麦克风仍不可用：请点「停止」→「开始」重试，或刷新页面'
        : '麦克风恢复失败，稍后自动重试…', 7000);
    } finally {
      this._healing = false;
    }
  },
  toggle() { return State.running ? this.stop() : this.start(); },

  /* 方向/语言变化后刷新“边说边出”配置；浏览器流式引擎用新语言重启 */
  syncRecognizers() {
    if (!State.running) return;
    const duoAuto = S.mode === 'duo' && S.who === 'auto';
    // 云端权威识别：草稿 = 录音快照增量识别（任何浏览器可用，需真实语音端点）
    this.capture.snapMode = !!(this.engine === 'cloud' && (S.preview || Para.canUse()) && !duoAuto);
    if (this.previewRec) { try { this.previewRec.start(); } catch {} }   // 重启快车道（语言可能变化）
    if (this.engine === 'native' && this.stt) this.stt.start();
  },
  /* 云端识别不可用(如 DeepSeek 等无语音端点)时：本会话自动回退浏览器流式 */
  async fallbackToNative(reason) {
    if (this.fallbackDone || this.engine !== 'cloud' || !State.running) return;
    this.fallbackDone = true;
    toast((reason || '') + ' — 已自动切换为浏览器流式识别（实时字幕，无自动辨向）', 5000);
    if (this.previewRec) { try { this.previewRec.stop(); } catch {} this.previewRec = null; }
    if (this.stt) { try { this.stt.stop(); } catch {} this.stt = null; }
    this.engine = 'native';
    this.capture.needRec = false;
    this.capture.snapMode = false;
    try { await this.capture.finishRec(); } catch {}
    if (S.mode === 'duo' && S.who === 'auto') { S.who = 'A'; saveS(); syncWhoUI(); }
    this.stt = new SttNative((sent) => this.onSentence(sent));
    this.stt.start();
    setLive('已切换浏览器流式识别：继续说话即可（自然停顿成句）', false);
  },

  markSttSrc(txt) {   // 顶部小标签：显示英文来自“浏览器直连”还是“云识别”
    const el = $('#sttSrc');
    if (el) el.textContent = txt || '';
  },
  onInterim(t) {   // 浏览器流式引擎路径的局部字幕
    if (!State.running) return;
    const s = String(t || '').trim();
    if (!s) return;
    if (S.mode !== 'duo' && langMismatch(s, S.src)) return;   // 背景杂音不显示
    if (Para.canUse()) {   // 段落模式：原文实时进面板
      this._lastInterimAt = Date.now();
      this.markSttSrc('⚡ 浏览器直连识别');
      if (!Para.active) Para.begin(S.src);
      Para.setOrigLive(s);
      return;
    }
    if (!S.preview) return;
    this._lastInterimAt = Date.now();
    setLive(s, false);
    Preview.show(s);
  },
  // 云端路径：录音快照 → 原文草稿 + 中文草稿（“边说边出”，不依赖浏览器局部识别）
  async draftSnap(blob) {
    if (!State.running || this.engine !== 'cloud') return;
    if (!S.preview && !Para.canUse()) return;            // 段落模式自带实时双语
    if (Guard.degraded('stt')) return;                   // 降级中：暂停增量草稿，减少请求
    if (S.mode === 'duo' && S.who === 'auto') return;   // 双向自动辨向：方向未定，由成段定稿
    const hint = S.mode === 'duo' ? (S.who === 'A' ? S.A : S.B) : (S.src || null);
    try {
      const r = await sttRequest(blob, hint);
      if (!State.running || !S.preview || r.mock || !r.text || r.text.length < 2) return;
      if (this.capture) this.capture.snapEvery = 450;    // 恢复标准节奏
      if (Date.now() - (this._lastInterimAt || 0) < 1200) return;   // ⚡ 直连识别在线时，云快照不抢显示
      this.onDraft(r.text);
    } catch (e) {
      this._snapFail = (this._snapFail || 0) + 1;
      if (this.capture) this.capture.snapEvery = 7000;   // 失败：快照节奏放慢到 7s
      if (this._snapFail === 2) {
        errToast('云端增量识别暂时不可用（' + e.message + '）：草稿已降速，停顿后仍会正常出译文卡片');
      }
    }
  },
  onDraft(text) {
    if (!State.running) return;
    if (S.mode !== 'duo' && langMismatch(text, S.src)) return;   // 背景杂音不显示
    if (Para.canUse()) {   // 段落模式：原文实时进面板
      this._lastInterimAt = Date.now();
      this.markSttSrc('☁ 云识别快照');
      if (!Para.active) Para.begin(S.src);
      Para.setOrigLive(text);
      return;
    }
    if (!S.preview) return;
    this._lastInterimAt = Date.now();
    setLive(text, false);
    Preview.show(text);
  },
  // 一句原文识别完成 → 收起预览，建卡并派发各目标语言翻译
  async onSentence(sent) {
    if (!State.running) return;
    // 空闲/噪音保护：统计“有效语音”时间，长时间只有碎词 → 自动停止，避免忘关麦克风烧额度
    try {
      const txt = String((sent && sent.text) || '');
      const words = (txt.match(/[A-Za-z一-龥']+/g) || []).length;
      if (words >= 3) { this._lastSpeechAt = Date.now(); this._idleStreak = 0; }
      else {
        this._idleStreak = (this._idleStreak || 0) + 1;
        if (this._idleStreak >= 6) {   // 连续 6 段都是碎词 → 判定为环境噪音，降低上传频率
          if (this.capture && this.capture.snapEvery < 2000) {
            this.capture.snapEvery = Math.min(2000, Math.round(this.capture.snapEvery * 2));
            console.warn('[idle] 疑似噪音，快照间隔放宽到', this.capture.snapEvery, 'ms');
          }
        }
      }
      if (words >= 3 && this.capture && this.capture.snapEvery > 450) {
        this.capture.snapEvery = 450;   // 恢复正常语音 → 恢复高频
      }
    } catch {}
    const text = String(sent.text || '').trim();
    if (!text) return;
    if (S.mode !== 'duo' && langMismatch(text, S.src)) {   // 语音来源与所选源语言不符 → 判定为背景杂音，丢弃
      console.log('[跳过背景语音]', text);
      return;
    }
    Preview.clearText();
    const t0 = sent.t0 || performance.now();
    const duo = S.mode === 'duo';
    let origLang, speakerName, color;
    if (duo) {
      const lang = (S.who !== 'auto') ? (S.who === 'A' ? S.A : S.B) : (sent.lang || null);
      if (lang === S.A) { origLang = S.A; speakerName = 'A · ' + L(S.A)[1]; color = 'a'; }
      else if (lang === S.B) { origLang = S.B; speakerName = 'B · ' + L(S.B)[1]; color = 'b'; }
      else {
        origLang = lang || S.A;
        speakerName = lang ? ('说话人 · ' + L(lang)[1]) : ('A · ' + L(S.A)[1]);
        color = 'x';
      }
    } else {
      origLang = S.src;
      speakerName = '讲者 · ' + L(origLang)[1];
    }
    const targetLangs = duo
      ? (origLang === S.A ? [S.B] : origLang === S.B ? [S.A] : [S.A, S.B])
      : S.targets.filter((lg) => lg !== origLang);
    if (Para.canUse()) {   // 段落流：进入/续接当前段落；停顿约 1.8 秒或满 6 句则先定稿
      if (Para.active && ((t0 - Para.lastSegAt > 1800) || Para.segments.length >= 6)) await Para.commit();
      if (!Para.active) Para.begin(origLang);
      Para.appendSeg(text);
      return;
    }
    const seq = ++State.segSeq;
    State.segCount++;
    $('#statSegs').textContent = State.segCount;
    const card = addCard({ speakerName, color, origLang, origText: text, seq, mock: !!sent.mock });
    if (S.preview) setLive(text, false);
    if (!targetLangs.length) { finishCard(card, t0); return; }
    // ① 口语清洗：同一句只洗一次，多目标语言共用；失败自动退回原文
    let cleanP = Promise.resolve(text);
    if (S.clean) {
      cleanP = callClean(text, origLang).then((c) => c || text).catch(() => text);
    }
    for (const lg of targetLangs) this.translateRow(card, text, origLang, lg, seq, t0, cleanP);
  },
  async translateRow(card, origRaw, origLang, lg, seq, t0, cleanP) {
    const row = addTargetRow(card, lg, origLang);
    if (origLang === lg) { rowDone(row, origRaw, lg, seq); finishCard(card, t0); return; }
    try {
      let src = origRaw;
      if (cleanP) src = await cleanP;                 // ① 清洗后的文本
      if (!State.running) return;
      const key = CtxMem.key(origLang, lg);
      const hist = S.ctx ? CtxMem.get(key) : [];      // ③ 带上文
      let text = '';
      try {
        text = await translateStream(src, origLang, lg, State.epoch, (partial) => {
          row.textEl.textContent = partial + '▍';
        }, undefined, hist);
      } catch (err) {
        // 上游繁忙(429/503)时自动重试一次，别让限流直接杀死这局翻译
        if (State.running && /429|503|too busy|busy|rate limit|rate limiting|fetch failed|failed to fetch|network|ECONN|timeout/i.test(err.message || '')) {
          row.textEl.textContent = '…（上游繁忙，重试中）';
          await sleep(1200);
          if (!State.running) return;
          text = await translateStream(src, origLang, lg, State.epoch, (partial) => {
            row.textEl.textContent = partial + '▍';
          }, undefined, hist);
        } else throw err;
      }
      if (!State.running) return;
      row.textEl.textContent = text;
      if (S.ctx && src && text) CtxMem.push(key, src, text);
      rowDone(row, text, lg, seq);
    } catch (e) {
      if (/会话已结束/.test(e.message)) return;
      row.textEl.textContent = '⚠ ' + e.message;
      row.textEl.style.color = 'var(--red)';
      errToast('翻译失败：' + e.message);
    } finally {
      finishCard(card, t0);
    }
  },
};

/* 一行译文就绪：需要播报的目标语言才进语音队列 */
function rowDone(row, text, lg, seq) {
  if (row.done) return;
  row.done = true;
  row.replay.hidden = false;
  const isSpeakingLang = speakingLangOf(row) === lg;
  if (isSpeakingLang) {
    State.lastSentence = { text, lang: lg };
    $('#statSpk').textContent = L(lg)[1];
    if (S.voiceOn) {
      Controller.speaker.push(text, lg, { seq,
        rowEl: row.rowEl,
        onStart: () => { row.rowEl.classList.add('speaking'); const c = row.rowEl.closest('.fcard'); if (c) c.classList.add('speaking'); },
        onEnd: () => { row.rowEl.classList.remove('speaking'); const c = row.rowEl.closest('.fcard'); if (c) c.classList.remove('speaking'); },
      });
    }
  }
}
function speakingLangOf(row) {
  // 卡片的说话方向：双向→对方语言；单向→用户在界面点选的播报语言
  const card = row.rowEl.closest('.fcard');
  if (S.mode === 'duo' && card) {
    const o = card.dataset.orig;
    if (o === S.A) return S.B;
    if (o === S.B) return S.A;
    return S.speakLang || S.B;
  }
  return S.speakLang;
}
function finishCard(card, t0) {
  if (--card.pending > 0) return;
  const ms = Math.round(performance.now() - t0);
  State.latSamples.push(ms);
  if (State.latSamples.length > 30) State.latSamples.shift();
  $('#statLat').textContent = Math.round(State.latSamples.reduce((a, b) => a + b, 0) / State.latSamples.length) + '';
  if (card.latEl) card.latEl.textContent = '端到端 ' + ms + ' ms';
}

/* ================= 6. 卡片渲染 ================= */
function renderDisplay() {
  const style = S.displayStyle || 'text';
  document.body.classList.toggle('style-text', style === 'text');
  document.body.classList.toggle('style-bubble', style === 'bubble');
  document.body.classList.toggle('style-dual', style === 'dual');
  $$('#displaySeg button').forEach((b) => b.classList.toggle('on', b.dataset.style === style));
  const dual = style === 'dual';
  const d = $('#dual');
  if (d) d.hidden = !dual;
  const pp = $('#paraPanel');
  if (pp) pp.hidden = dual;                       // 分屏不再显示顶部实时框
  const f = $('#feed');
  if (f) f.style.display = dual ? 'none' : '';
  const fe = $('#feedEmpty');
  if (fe) fe.style.display = (dual || State.segCount > 0) ? 'none' : '';
}
function renderFeedBar() {
  $$('#feedOrderSeg button').forEach((b) => b.classList.toggle('on', b.dataset.order === (S.topFeed ? 'top' : 'bottom')));
  const st = $('#capState');
  if (st) st.textContent = S.preview ? '实时识别字幕：开（顶部滚动）' : '实时识别字幕：隐藏（译文直接出卡片）';
}
function setFeedOrder(top) {
  if (S.topFeed === top) return;
  S.topFeed = top;
  saveS();
  const f = $('#feed');
  const kids = [...f.children];
  f.innerHTML = '';
  kids.reverse().forEach((k) => f.appendChild(k));
  f.scrollTop = S.topFeed ? 0 : f.scrollHeight;
  renderFeedBar();
}
function clearFeed() {
  $('#feed').innerHTML = '';
  $('#feedEmpty').style.display = '';
  const de = $('#dualEn'), dz = $('#dualZh');
  if (de) de.innerHTML = '';
  if (dz) dz.innerHTML = '';
  if (typeof Para !== 'undefined') Para.clearAll();
}
function isNearBottom() {
  const f = $('#feed');
  return f.scrollHeight - f.scrollTop - f.clientHeight < 220;
}
function scrollBottom() {
  const f = $('#feed');
  if (isNearBottom()) f.scrollTop = f.scrollHeight;
}
function appendParagraph(orig, tr, origLang, trLang, seq) {
  if (S.displayStyle === 'dual') {
    const en = $('#dualEn'), zh = $('#dualZh');
    if (en && orig) { const el = document.createElement('p'); el.className = 'dual-line'; el.textContent = orig; en.appendChild(el); en.parentElement.scrollTop = en.parentElement.scrollHeight; }
    if (zh && tr) { const el = document.createElement('p'); el.className = 'dual-line zh'; el.textContent = tr; zh.appendChild(el); zh.parentElement.scrollTop = zh.parentElement.scrollHeight; }
    return;
  }
  addParagraphCard(orig, tr, origLang, trLang, seq);
}
function addParagraphCard(orig, tr, origLang, trLang, seq) {
  $('#feedEmpty').style.display = 'none';
  const el = document.createElement('div');
  el.className = 'fcard para-card';
  el.dataset.orig = origLang;
  el.dataset.seq = seq;
  const time = new Date().toTimeString().slice(0, 8);
  el.innerHTML =
    '<div class="fhead"><span class="spk" style="color:var(--spa)">讲者</span>' +
    '<span class="tlang">' + esc(L(origLang)[1]) + '</span>' +
    (tr ? '<span class="mk tr-lang">' + esc(L(trLang)[1]) + '</span>' : '') +
    '<span class="time">' + time + '</span><span class="lat">段落</span></div>' +
    '<div class="fbody">' +
    '<div class="row-orig">' + esc(orig) + '</div>' +
    (tr ? '<div class="row-tr"><span class="tchip">➜ ' + esc(L(trLang)[1]) + '</span><span class="trtext">' + esc(tr) + '</span>' +
      '<span class="actions"><button class="mini" data-replay="1">🔊</button></span></div>' : '') +
    '</div>';
  const f = $('#feed');
  if (S.topFeed) f.insertBefore(el, f.firstChild); else f.appendChild(el);
  while (f.children.length > 160) f.removeChild(S.topFeed ? f.lastChild : f.firstChild);
  if (S.topFeed) f.scrollTop = 0; else scrollBottom();
  const rp = el.querySelector('[data-replay]');
  if (rp) on(rp, 'click', () => { if (tr && trLang) Controller.speaker.interrupt(tr, trLang, null); });
  return el;
}
function addCard({ speakerName, color, origLang, origText, seq, mock }) {
  $('#feedEmpty').style.display = 'none';
  const el = document.createElement('div');
  el.className = 'fcard';
  el.dataset.seq = seq;
  el.dataset.orig = origLang;
  const headColor = color === 'b' ? 'var(--spb)' : color === 'x' ? 'var(--gold)' : 'var(--spa)';
  el.innerHTML =
    '<div class="fhead"><span class="spk" style="color:' + headColor + '">' + esc(speakerName) + '</span>' +
    '<span class="tlang">' + esc(L(origLang)[1]) + '</span>' +
    (mock ? '<span class="mk">演示数据</span>' : '') +
    '<span class="time">' + new Date().toTimeString().slice(0, 8) + '</span>' +
    '<span class="lat"></span></div>' +
    '<div class="fbody"><div class="row-orig">' + esc(origText) + '</div><div class="rows"></div></div>';
  const feedEl = $('#feed');
  if (S.topFeed) feedEl.insertBefore(el, feedEl.firstChild);
  else feedEl.appendChild(el);
  while (feedEl.children.length > 160) feedEl.removeChild(S.topFeed ? feedEl.lastChild : feedEl.firstChild);
  if (S.topFeed) feedEl.scrollTop = 0; else scrollBottom();
  const card = {
    el,
    latEl: el.querySelector('.lat'),
    rowsEl: el.querySelector('.rows'),
    pending: 0,
  };
  return card;
}
function addTargetRow(card, lg, origLang) {
  const el = document.createElement('div');
  el.className = 'row-tr';
  const duo = S.mode === 'duo';
  if (duo && lg === S.B) el.classList.add('sp-b');
  const chip = document.createElement('span');
  chip.className = 'tchip';
  chip.textContent = '➜ ' + L(lg)[1];
  const textEl = document.createElement('span');
  textEl.className = 'trtext thinking';
  textEl.textContent = '…';
  const acts = document.createElement('span');
  acts.className = 'actions';
  const replay = document.createElement('button');
  replay.className = 'mini';
  replay.textContent = '🔊';
  replay.hidden = true;
  replay.title = '立即播报此句';
  on(replay, 'click', () => {
    const t = textEl.textContent.replace(/▍$/, '');
    if (t && t !== '…' && t.indexOf('⚠') !== 0) Controller.speaker.interrupt(t, lg, el);
  });
  acts.appendChild(replay);
  el.append(chip, textEl, acts);
  card.rowsEl.appendChild(el);
  card.pending++;
  return { rowEl: el, textEl, replay, done: false };
}
function setLive(text, idle) {
  const p = $('#liveText');
  p.textContent = text;
  p.classList.toggle('idle', !!idle);
}
function setMicBusy(on, label) {   // 启动过程中的可见反馈（避免“点了没反应”）
  const b = $('#btnMic');
  if (!b) return;
  b.disabled = !!on;
  const l = $('#micLabel');
  if (l) l.textContent = on ? (label || '启动中…') : (State.running ? '停止' : '开始');
}
function setUiRunning(on) {
  const b = $('#btnMic');
  b.classList.toggle('live', on);
  $('#micLabel').textContent = on ? '停止' : '开始';
  b.title = on ? '停止同传' : '开始同传';
}

/* ================= 7. 设置与界面绑定 ================= */
function langOptions() {
  return LANGS.map((l) => '<option value="' + l[0] + '">' + l[3] + ' ' + l[1] + '</option>').join('');
}
function fillLangs() {
  for (const id of ['srcLang', 'speakerA', 'speakerB']) {
    const sel = $('#' + id);
    if (!sel.options.length) sel.innerHTML = langOptions();
  }
  $('#srcLang').value = S.src;
  $('#speakerA').value = S.A;
  $('#speakerB').value = S.B;
}
function renderModeUI() {
  const duo = S.mode === 'duo';
  $('#onewayRow').hidden = duo;
  $('#duoRow').hidden = !duo;
  $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
  renderTargets();
}
function renderTargets() {
  const bar = $('#targetChips');
  bar.innerHTML = '';
  const mk = (lg) => {
    const b = document.createElement('button');
    b.className = 'chip' + (S.speakLang === lg ? ' on' : '');
    b.title = '点击设为播报语言';
    b.textContent = L(lg)[3] + ' ' + L(lg)[1] + (S.speakLang === lg ? ' ♪' : '');
    const x = document.createElement('span');
    x.className = 'del';
    x.textContent = '×';
    x.title = '移除';
    on(x, 'click', (e) => {
      e.stopPropagation();
      if (S.targets.length <= 1) { toast('至少保留一个目标语言'); return; }
      S.targets = S.targets.filter((t) => t !== lg);
      if (S.speakLang === lg) S.speakLang = S.targets[0];
      saveS(); renderTargets();
    });
    on(b, 'click', () => { S.speakLang = lg; saveS(); renderTargets(); });
    b.appendChild(x);
    bar.appendChild(b);
  };
  S.targets.forEach(mk);
  const plus = document.createElement('select');
  plus.innerHTML = '<option value="">＋ 添加目标语言</option>' +
    LANGS.filter((l) => !S.targets.includes(l[0]) && l[0] !== S.src)
      .map((l) => '<option value="' + l[0] + '">' + l[1] + '</option>').join('');
  on(plus, 'change', () => {
    if (plus.value) { S.targets.push(plus.value); saveS(); renderTargets(); }
  });
  bar.appendChild(plus);
}
function syncWhoUI() {
  $$('#whoSeg button').forEach((b) => b.classList.toggle('on', b.dataset.who === S.who));
}
function applyProfileChoice() {
  const code = $('#setProfile').value || '';
  if (code !== S.profile) {
    S.profile = code;
    if (code) {   // 用预设时清空手动项，避免旧配置覆盖预设
      S.provider = ''; S.base = ''; S.key = '';
      S.chatModel = ''; S.sttModel = ''; S.ttsModel = ''; S.ttsVoice = 'nova';
    }
  }
  saveS();
  fillSettingsUI();
  const pl = (serverCfg.profiles || []).find((x) => x.code === code);
  toast(code ? '已启用预设「' + (pl ? pl.name : code) + '」：API 配置由服务端提供，可直接测试/使用'
             : '未使用预设：可手动填写下方 API 配置', 3200);
}
function fillSettingsUI() {
  const set = (id, val) => { const el = $('#' + id); if (el) el.value = val; };
  // 预设代号下拉
  const sel = $('#setProfile');
  if (sel) {
    const key = JSON.stringify((serverCfg.profiles || []).map((x) => x.code + x.name));
    if (key !== _profilesKey) {
      _profilesKey = key;
      sel.innerHTML = '<option value="">未使用（手动配置）</option>' +
        (serverCfg.profiles || []).map((x) => '<option value="' + esc(x.code) + '">' + esc(x.name + '（' + x.code + '）') + '</option>').join('');
    }
    sel.value = S.profile || '';
    const note = $('#profileNote');
    if (note) {
      const cur = (serverCfg.profiles || []).find((x) => x.code === S.profile);
      if (cur && (S.base || S.key)) {
        note.style.color = 'var(--red)';
        note.textContent = '⚠ 手动填写的 Base/Key 仍有效并优先于预设：若想用预设「' + cur.name + '」，请清空下方手动项，或重新选一次代号（会自动清空）。';
      } else {
        note.style.color = '';
        note.textContent = cur
          ? '当前：' + cur.name + ' → ' + (cur.host || '未知服务') + ' · 翻译 ' + (cur.chatModel || '默认') + ' · 识别 ' + (cur.sttModel || '默认') + (cur.hasKey ? '' : ' · ⚠ 该代号未配置密钥，请找管理员')
          : '请在右侧选择或手动配置；密钥不会被发送到浏览器。';
      }
    }
  }
  set('setProvider', S.provider);
  set('setBase', S.base);
  set('setKey', S.key);
  set('setChatModel', S.chatModel || serverCfg.chatModel || '');
  set('setSttModel', S.sttModel || serverCfg.sttModel || '');
  set('setTtsModel', S.ttsModel || serverCfg.ttsModel || '');
  set('setTtsVoice', S.ttsVoice);
  set('setSttEngine', S.sttEngine);
  set('setTtsEngine', S.ttsEngine);
  $('#setVoiceOn').checked = S.voiceOn;
  $('#setMonitor').checked = S.monitor;
  $('#setPreview').checked = S.preview;
  const gl = $('#setGlossary'); if (gl) gl.value = S.glossary || '';
  const dm = $('#setDomain'); if (dm) dm.value = S.domain || 'auto';
  const nt = $('#setNotes'); if (nt) nt.value = S.notes || '';
  const cr = $('#setCtxRounds'); if (cr) cr.value = String(S.ctxRounds || 5);
  const rg = $('#setRefineGpt'); if (rg) rg.checked = S.refineGpt !== false;
  const vb = $('#setVoiceBoost'); if (vb) vb.checked = S.voiceBoost !== false;
  const gi = $('#glossaryInfo');
  if (gi) gi.textContent = '术语表：固定 ' + (serverCfg.glossaryFixed || 96) + ' 条 / 自动 ' + (serverCfg.glossaryMined || 0) + ' 条｜口语库：固定 ' + (serverCfg.oralFixed || 0) + ' 条 / 自动 ' + (serverCfg.oralMined || 0) + ' 条（程序自己学）';
  $('#setClean').checked = S.clean;
  $('#setCtx').checked = S.ctx;
  $('#setParaMode').checked = S.paraMode;
  const lm = $('#setLiveModel');
  if (lm) lm.value = S.liveModel || '';
  $('#setRate').value = S.rate; $('#rateVal').textContent = S.rate.toFixed(2);
  $('#setTail').value = S.tailMs; $('#tailVal').textContent = S.tailMs + ' ms';
  $('#setMaxSeg').value = S.maxSegMs; $('#maxSegVal').textContent = Math.round(S.maxSegMs / 1000) + ' s';
  $('#setSense').value = S.sense; $('#senseVal').textContent = S.sense;
  const badge = $('#envBadge');
  if (serverCfg.mock) { badge.hidden = false; badge.textContent = '离线演示 MOCK'; badge.className = 'badge mock'; }
  else if (serverCfg.envConfigured) { badge.hidden = false; badge.textContent = '服务端已配置 API'; badge.className = 'badge ok'; }
}
function bindEvents() {
  on($('#btnSettings'), 'click', () => { $('#settings').hidden = false; });
  on($('#btnCloseSettings'), 'click', () => { $('#settings').hidden = true; });
  on($('#settings'), 'click', (e) => { if (e.target === $('#settings')) $('#settings').hidden = true; });
  on($('#btnMic'), 'click', () => Controller.toggle());

  $$('#modeSeg button').forEach((b) => on(b, 'click', () => {
    S.mode = b.dataset.mode;
    saveS(); renderModeUI();
    if (State.running) {
      if (S.mode === 'duo' && Controller.engine === 'native' && S.who === 'auto') {
        S.who = 'A'; saveS(); syncWhoUI();
        toast('双人对话 + 浏览器流式识别：请用 A/B 手动切换说话人');
      }
      Controller.syncRecognizers();
    }
  }));
  const bindVal = (id, key, parse, after) => {
    const el = $('#' + id);
    on(el, 'input', () => { S[key] = parse ? parse(el.value) : el.value; saveS(); after && after(); });
    on(el, 'change', () => { S[key] = parse ? parse(el.value) : el.value; saveS(); after && after(); });
  };
  bindVal('srcLang', 'src', null, () => {
    renderTargets();
    if (State.running) Controller.syncRecognizers();
  });
  bindVal('speakerA', 'A', null, () => { ensureDuoDistinct(); if (State.running) Controller.syncRecognizers(); });
  bindVal('speakerB', 'B', null, () => { ensureDuoDistinct(); if (State.running) Controller.syncRecognizers(); });
  $$('#whoSeg button').forEach((b) => on(b, 'click', () => {
    S.who = b.dataset.who;
    saveS(); syncWhoUI();
    if (State.running) {
      Controller.syncRecognizers();
      setLive('正在说话：' + (b.dataset.who === 'A' ? 'A · ' + L(S.A)[1] : b.dataset.who === 'B' ? 'B · ' + L(S.B)[1] : '自动识别'), false);
    }
  }));
  bindVal('setBase', 'base');
  bindVal('setKey', 'key');
  bindVal('setChatModel', 'chatModel');
  bindVal('setSttModel', 'sttModel');
  bindVal('setTtsModel', 'ttsModel');
  bindVal('setTtsVoice', 'ttsVoice');
  bindVal('setSttEngine', 'sttEngine');
  on($('#setSttEngine'), 'change', async () => {
    if (State.running) { toast('识别引擎已切换，会话自动重启'); await Controller.stop(); Controller.start(); }
  });
  bindVal('setTtsEngine', 'ttsEngine');
  bindVal('setVoiceOn', 'voiceOn', (v) => !!v);
  bindVal('setPreview', 'preview', (v) => !!v);
  bindVal('setClean', 'clean', (v) => !!v);
  bindVal('setCtx', 'ctx', (v) => !!v);
  bindVal('setGlossary', 'glossary');
  bindVal('setDomain', 'domain');
  bindVal('setNotes', 'notes');
  bindVal('setCtxRounds', 'ctxRounds', (v) => Number(v) || 5);
  bindVal('setRefineGpt', 'refineGpt', (v) => !!v);
  bindVal('setVoiceBoost', 'voiceBoost', (v) => !!v);
  bindVal('setLiveModel', 'liveModel');
  bindVal('setParaMode', 'paraMode', (v) => !!v);
  on($('#setParaMode'), 'change', () => {
    S.paraMode = $('#setParaMode').checked; saveS();
    if (State.running) {
      if (!S.paraMode) { Para.commit().then(() => { Para.reset(); toast('已切换到逐句卡片模式'); }); }
      else { Para.begin(S.src); toast('已切换到段落模式：停顿约 1.8 秒定稿成一段'); }
    }
  });
  on($('#setPreview'), 'change', () => {
    S.preview = $('#setPreview').checked;
    saveS();
    renderFeedBar();
    if (!S.preview) {
      Preview.clearText();
      if (State.running) setLive('正在聆听…（自动识别中，译文直接出卡片）', true);
      toast('实时中文草稿已关闭：译文将在停顿成段后直接出卡片');
    } else {
      if (State.running) { Controller.syncRecognizers(); setLive('实时中文草稿已开：说话时中文实时出现并修正', false); }
      toast('实时中文草稿已开启（云端录音快照驱动，任意浏览器可用）');
    }
  });
  bindVal('setRate', 'rate', parseFloat, () => { $('#rateVal').textContent = S.rate.toFixed(2); });
  bindVal('setTail', 'tailMs', parseInt);
  bindVal('setMaxSeg', 'maxSegMs', parseInt);
  bindVal('setSense', 'sense', parseInt);
  on($('#setRate'), 'input', () => { $('#rateVal').textContent = parseFloat($('#setRate').value).toFixed(2); });
  on($('#setTail'), 'input', () => { $('#tailVal').textContent = $('#setTail').value + ' ms'; });
  on($('#setMaxSeg'), 'input', () => { $('#maxSegVal').textContent = Math.round($('#setMaxSeg').value / 1000) + ' s'; });
  on($('#setSense'), 'input', () => { $('#senseVal').textContent = $('#setSense').value; });
  on($('#setTail'), 'change', () => { if (State.running) toast('成段时长已改：静音 ' + (S.tailMs / 1000).toFixed(1) + 's 后成段'); });
  on($('#setMonitor'), 'change', () => {
    S.monitor = $('#setMonitor').checked; saveS();
    if (Controller.capture) Controller.capture.enableMonitor(S.monitor);
    if (S.monitor) toast('原声回环监听已开启 —— 请务必佩戴耳机防止啸叫');
  });
  on($('#setVoiceOn'), 'change', () => {
    S.voiceOn = $('#setVoiceOn').checked; saveS();
    if (!S.voiceOn && Controller.speaker) Controller.speaker.stop();
  });
  on($('#setProvider'), 'change', () => {
    S.provider = $('#setProvider').value; saveS();
    const p = PROVIDERS[S.provider];
    if (p) {
      S.profile = '';          // 手动预设与管理员代号互斥，选其一
      S.base = p.base; S.chatModel = p.chat; S.sttModel = p.stt; S.ttsModel = p.tts;
      fillSettingsUI();
      if (p.note) toast(p.note, 3400);
    }
  });
  on($('#setProfile'), 'change', applyProfileChoice);
  on($('#btnTestStt'), 'click', async () => {
    const out = $('#testResult');
    out.textContent = '识别通道测试中…';
    out.style.color = 'var(--tx2)';
    try {
      const res = await fetch('/api/sttprobe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: apiSettings() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
      out.textContent = '✓ 识别通道可用：' + (j.note || 'ok');
      out.style.color = 'var(--acc2)';
    } catch (e) {
      out.textContent = '✗ ' + e.message;
      out.style.color = 'var(--red)';
    }
  });
  on($('#btnTestApi'), 'click', async () => {
    const out = $('#testResult');
    out.textContent = '测试中…';
    out.style.color = 'var(--tx2)';
    try {
      const res = await fetch('/api/translate?final=1', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '你好，这是一次连接测试。', sourceName: '中文', targetName: 'English', settings: apiSettings() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
      out.textContent = '✓ 翻译通道正常：' + j.text.slice(0, 90);
      out.style.color = 'var(--acc2)';
    } catch (e) {
      out.textContent = '✗ ' + e.message;
      out.style.color = 'var(--red)';
    }
  });
  on($('#btnClear'), 'click', () => {
    clearFeed();
    State.latSamples = []; State.segCount = 0;
    $('#statSegs').textContent = '0'; $('#statLat').textContent = '–';
  });
  on($('#btnExport'), 'click', exportLog);
  const openAdmin = () => window.open('/admin.html', '_blank', 'noopener');
  on($('#btnAdmin'), 'click', openAdmin);
  // 快捷键：Cmd/Ctrl + Shift + A 打开管理员面板（对普通用户不可见）
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
      e.preventDefault(); openAdmin();
    }
  });

  // ✏️ 纠错：把“听错的词”改成正确写法 → 存到服务器纠错表，之后所有识别自动纠正（改一次永久生效）
  on($('#btnFix'), 'click', async () => {
    const last = (Para._enParts && Para._enParts.length) ? Para._enParts[Para._enParts.length - 1] : (Para._lastPartial || '');
    const shown = String(last || '').trim();
    const wrong = window.prompt('把「听错的部分」贴在这里（可以只写错的那几个词）：', shown.slice(0, 120));
    if (!wrong || !wrong.trim()) return;
    const right = window.prompt('正确的写法是：', '');
    if (!right || !right.trim()) return;
    try {
      const res = await fetch('/api/correct', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wrong: wrong.trim(), right: right.trim() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
      // 立即修正当前屏幕上的显示
      const w = wrong.trim(), r = right.trim();
      Para._enParts = (Para._enParts || []).map((x) => x.split(w).join(r));
      Para._enFinal = Para._enParts.join(' ');
      Para._lastPartial = String(Para._lastPartial || '').split(w).join(r);
      Para._renderDualEn();
      toast('已记住：以后听到「' + w + '」会自动纠正为「' + r + '」（共 ' + (j.count || 0) + ' 条纠错）', 6000);
    } catch (e) {
      toast('纠错保存失败：' + e.message, 6000);
    }
  });

  $$('#feedOrderSeg button').forEach((b) => on(b, 'click', () => setFeedOrder(b.dataset.order === 'top')));
  $$('#displaySeg button').forEach((b) => on(b, 'click', async () => {
    S.displayStyle = b.dataset.style;
    if (S.displayStyle === 'dual' && !S.paraMode) {
      S.paraMode = true;
      const c = $('#setParaMode'); if (c) c.checked = true;
      toast('双语分屏需要段落模式，已自动开启');
    }
    saveS();
    if (State.running && Para.active) {
      await Para.commit();
      if (!Para.active) Para.begin(S.src);
    }
    renderDisplay();
  }));
  on($('#btnReplayLast'), 'click', () => {
    const s = State.lastSentence;
    if (!s) { toast('还没有可重播的句子'); return; }
    Controller.speaker.interrupt(s.text, s.lang, null);
  });
  on(document, 'keydown', (e) => {
    if (e.code === 'Space' && !e.repeat && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
      e.preventDefault();
      Controller.toggle();
    }
  });
}
function ensureDuoDistinct() {
  if (S.mode === 'duo' && S.A === S.B) {
    S.B = S.A === 'zh' ? 'en' : 'zh';
    $('#speakerB').value = S.B;
    toast('双人对话的两种语言不能相同，已自动调整');
  }
  saveS();
}
/* 导出 Markdown 记录 */
function exportLog() {
  const lines = [];
  const cards = [...$$('#feed .fcard')];
  if (S.topFeed) cards.reverse();   // 导出始终按时间正序（旧→新）
  cards.forEach((c) => {
    const spk = c.querySelector('.spk').textContent;
    const time = c.querySelector('.time').textContent;
    const orig = c.querySelector('.row-orig').textContent;
    lines.push('[' + time + '] ' + spk);
    lines.push('原文：' + orig);
    c.querySelectorAll('.row-tr').forEach((r) => {
      const lg = r.querySelector('.tchip').textContent.replace('➜ ', '');
      const tx = r.querySelector('.trtext').textContent.replace(/▍$/, '');
      lines.push(lg + '：' + tx);
    });
    lines.push('');
  });
  const md = '# LiveBridge 同传记录 ' + new Date().toLocaleString() + NL + NL + lines.join(NL);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
  a.download = '同传记录-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ================= 8. 启动 ================= */
async function init() {
  try {
    const j = await fetch('/api/config').then((r) => r.json());
    Object.assign(serverCfg, j);
  } catch {}
  // 首次打开（或未选预设）时，自动选好可用预设：优先 snow
  if (!S.profile && Array.isArray(serverCfg.profiles) && serverCfg.profiles.length) {
    const snow = serverCfg.profiles.find((x) => x.code === 'snow' && x.hasKey);
    const anyOk = serverCfg.profiles.find((x) => x.hasKey);
    const pickP = snow || anyOk || serverCfg.profiles[0];
    if (pickP) { S.profile = pickP.code; saveS(); }
  }
  const isMobile = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent);
  if (isMobile && !S._mobileTip) {
    S._mobileTip = 1; saveS();
    setTimeout(() => toast('手机使用：请保持页面在前台、关闭自动锁屏，麦克风尽量靠近讲者', 9000), 1200);
  }
  // 麦克风权限：记住已授权状态 + 给出“如何不用每次同意”的提示
  try { if (localStorage.getItem('lb_mic_granted') === '1') State.micGranted = true; } catch {}
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'microphone' }).then((st) => {
      const sync = () => { State.micGranted = st.state === 'granted'; };
      sync(); st.onchange = sync;
    }).catch(() => {});
  }
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const standalone = window.navigator.standalone === true || /standalone/i.test(navigator.userAgent);
  if (isIOS && !standalone && !S._iosTip) {
    S._iosTip = 1; saveS();
    setTimeout(() => toast('iPhone 提示：点「分享 → 添加到主屏幕」后从桌面图标打开，麦克风授权会被记住，不必每次同意', 10000), 2600);
  }
  // 切后台 / 锁屏 / 从缓存恢复回到页面：自动检查并修复麦克风（无需刷新页面）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (State.running) Controller.healMic('visibility');
    else if (Controller.capture && Controller.capture.ctx && Controller.capture.ctx.state === 'suspended') {
      Controller.capture.ctx.resume().catch(() => {});
    }
  });
  window.addEventListener('pageshow', () => { if (State.running) setTimeout(() => Controller.healMic('pageshow'), 500); });
  window.addEventListener('focus', () => { if (State.running) Controller.healMic('focus'); });
  fillLangs();
  fillSettingsUI();
  bindEvents();
  renderModeUI();
  syncWhoUI();
  renderFeedBar();
  renderDisplay();
  Para.init();
  // 看门狗：翻译流水线若卡死超过 40 秒，强制解锁（防止“英文在滚、中文不动”）
  setInterval(() => {
    if (Para._busy && Para._busySince && performance.now() - Para._busySince > 40000) {
      console.warn('[watchdog] 翻译停滞超 40s，强制恢复');
      Para._busy = false; Para._busySince = 0;
      toast('翻译卡住已自动恢复，请继续说', 4000);
    }
  }, 5000);
  setUiRunning(false);
  setLive('准备就绪。', true);
}
/* 页面级错误可见化：任何 JS 错误都提示出来，避免“点了没反应”无从排查 */
window.addEventListener('error', (e) => {
  try { toast('页面出错：' + (e.message || 'unknown'), 8000); } catch {}
  console.error('[LiveBridge error]', e.message, e.filename, e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  const m = (e.reason && (e.reason.message || e.reason)) || 'unknown';
  try { toast('异步出错：' + m, 8000); } catch {}
  console.error('[LiveBridge rejection]', m);
});
function boot() {
  try { init(); } catch (e) { toast('页面初始化失败：' + e.message, 10000); console.error(e); }
}
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
