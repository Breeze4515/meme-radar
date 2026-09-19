import { VoiceAlerts, VOICE_TTL, voiceKey } from './voice-alerts.mjs';
import { createVoicePlayer } from './voice-player.mjs';

const $ = id => document.getElementById(id);
const locales = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'ar'];
const copy = {
  title: ['候选语音提醒','候選語音提醒','Candidate voice alerts','候補の音声通知','후보 음성 알림','تنبيهات المرشحين الصوتية'],
  enable: ['试听并开启','試聽並開啟','Preview & enable','試聴して有効化','미리 듣기 및 켜기','استماع وتفعيل'],
  preview: ['试听','試聽','Preview','試聴','미리 듣기','استماع'],
  stop: ['关闭','關閉','Turn off','オフ','끄기','إيقاف'],
  volume: ['音量','音量','Volume','音量','음량','مستوى الصوت'],
  help: ['扫描链共用提醒 · 本机中文语音，优先女声 · 需保持页面打开；仍需人工复核。','掃描鏈共用提醒 · 本機中文語音，優先女聲 · 頁面需保持開啟；仍需人工複核。','Alerts across scanning chains · Local Chinese voice, female preferred · Keep page open; manual review required.','監視チェーン共通・端末の中国語音声（女性優先）・ページを開いたままに。手動確認が必要。','스캔 체인 공통 · 기기 중국어 음성, 여성 우선 · 페이지를 열어두세요. 수동 검토 필요.','تنبيهات لسلاسل المسح بصوت صيني محلي، مع تفضيل الصوت النسائي. أبقِ الصفحة مفتوحة؛ يلزم فحص يدوي.'],
  off: ['未开启','未開啟','Off','オフ','꺼짐','متوقف'],
  click: ['点击启用声音','點擊啟用聲音','Click to allow audio','クリックして音声を許可','클릭하여 소리 허용','انقر للسماح بالصوت'],
  ready: ['已开启 · 仅提醒新候选','已開啟 · 僅提醒新候選','On · new candidates only','オン・新しい候補のみ','켜짐 · 새 후보만','مفعّل · المرشحون الجدد فقط'],
  loading: ['正在准备语音…','正在準備語音…','Preparing audio…','音声を準備中…','음성 준비 중…','جارٍ تجهيز الصوت…'],
  error: ['声音未就绪，点击重试','聲音未就緒，點擊重試','Audio not ready; click to retry','音声未準備・クリックして再試行','소리 준비 안 됨; 클릭하여 재시도','الصوت غير جاهز؛ انقر لإعادة المحاولة'],
  noVoice: ['中文语音未就绪；请重试，或在系统中安装中文语音','中文語音未就緒；請重試，或在系統中安裝中文語音','Chinese voice unavailable; retry or install a local Chinese voice','中国語音声が未準備。再試行するか端末に中国語音声を追加してください','중국어 음성 없음; 다시 시도하거나 기기에 중국어 음성을 설치하세요','الصوت الصيني غير متاح؛ أعد المحاولة أو ثبّت صوتًا صينيًا محليًا'],
  offline: ['连接中断，提醒暂停','連線中斷，提醒暫停','Offline · alerts paused','接続切断・通知停止','연결 끊김 · 알림 일시 중지','الاتصال منقطع · التنبيهات متوقفة'],
  muted: ['音量为0，提醒暂停','音量為0，提醒暫停','Muted · alerts paused','音量0・通知停止','음량 0 · 알림 일시 중지','الصوت مكتوم · التنبيهات متوقفة'],
  unsupported: ['请使用新版浏览器并允许本地存储','請使用新版瀏覽器並允許本機儲存','Use a modern browser with local storage enabled','最新ブラウザーでローカル保存を許可してください','최신 브라우저에서 로컬 저장소를 허용하세요','استخدم متصفحًا حديثًا مع السماح بالتخزين المحلي']
};
const prefsKey = 'memeCommunityVoiceV1', historyKey = 'memeCommunityVoiceHistoryV1';
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { localStorage.setItem(key, JSON.stringify(value)); };
let locale = read('memeRadarLanguageV1', 'zh-CN');
let prefs = read(prefsKey, {}), enabled = false, online = false, snapshot = null, epoch = 0, busy = false;
let state = prefs.enabled ? 'click' : 'off';
const tracker = new VoiceAlerts(), player = createVoicePlayer();
const volume = Number(prefs.volume);
$('voiceVolume').value = Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 50;
const t = key => copy[key][Math.max(0, locales.indexOf(locale))];
const ignored = row => {
  const marks = read('robinhoodRadarManualMarksV1', {});
  const key = voiceKey(row), address = key.slice(key.indexOf(':') + 1);
  return (marks[key] || (row.chain === 'robinhood' ? marks[address] : null))?.decision === 'ignored';
};
function paint() {
  $('voiceTitle').textContent = t('title'); $('voiceHelp').textContent = t('help');
  $('voiceEnable').textContent = t(enabled ? 'preview' : 'enable');
  $('voiceStop').textContent = t('stop'); $('voiceStop').hidden = !enabled && state !== 'loading';
  $('voiceVolumeLabel').textContent = t('volume'); $('voiceVolume').setAttribute('aria-label', t('volume'));
  $('voiceStatus').textContent = t(state);
}
function savePrefs() { prefs = { enabled, volume: Number($('voiceVolume').value) }; write(prefsKey, prefs); }
async function notify() {
  if (!enabled || !online || busy) return;
  if (!player.ready) { state = 'click'; paint(); return; }
  if (Number($('voiceVolume').value) === 0) { state = 'muted'; paint(); return; }
  busy = true;
  const started = epoch;
  try {
    await navigator.locks.request('meme-community-voice', { ifAvailable: true }, async lock => {
      if (!lock || started !== epoch || !enabled || !online || Number($('voiceVolume').value) === 0) return;
      const now = Date.now(), saved = read(historyKey, {});
      const notified = Object.fromEntries(Object.entries(saved.notified || {}).filter(([, at]) => Number.isFinite(at) && now - at < VOICE_TTL));
      const batch = tracker.batch(notified, now, ignored);
      if (!batch.length || now - (saved.lastAt || 0) < 60_000) return;
      const played = await player.play(Number($('voiceVolume').value) / 100);
      if (played && enabled && started === epoch) {
        for (const row of batch) notified[voiceKey(row)] = now;
        write(historyKey, { notified, lastAt: Date.now() });
        tracker.acknowledge(batch);
      }
    });
    if (enabled && started === epoch) { state = Number($('voiceVolume').value) === 0 ? 'muted' : online ? 'ready' : 'offline'; paint(); }
  } catch {
    if (started === epoch) {
      ++epoch; enabled = false; player.stop(); tracker.reset(); state = 'error'; paint();
    }
  }
  finally { busy = false; }
}
$('voiceEnable').addEventListener('click', async () => {
  if (player.playing || state === 'loading') return;
  const started = ++epoch;
  if (!enabled) { tracker.reset(); if (snapshot) tracker.ingest(snapshot, Date.now(), ignored); }
  state = 'loading'; paint();
  try {
    // Unlock device speech while still in the user's click handler.
    const unlock = player.unlock();
    await unlock;
    if (started !== epoch) return;
    if (!navigator.locks?.request) throw new Error('browser_unsupported');
    enabled = true; savePrefs(); state = online ? 'ready' : 'offline'; paint();
    await player.play(Number($('voiceVolume').value) / 100); // Preview does not consume candidates.
  } catch (error) { if (started === epoch) { enabled = false; state = error.message === 'chinese_voice_missing' ? 'noVoice' : navigator.locks?.request ? 'error' : 'unsupported'; paint(); } }
});
$('voiceStop').addEventListener('click', () => {
  ++epoch; enabled = false; tracker.reset(); player.stop(); state = 'off';
  try { savePrefs(); } catch {} paint();
});
$('voiceVolume').addEventListener('input', () => {
  ++epoch; tracker.reset(); if (snapshot) tracker.ingest(snapshot, Date.now(), ignored);
  player.stop(); state = enabled ? (Number($('voiceVolume').value) ? (online ? 'ready' : 'offline') : 'muted') : 'off';
  try { savePrefs(); } catch {} paint();
});
window.addEventListener('radar-snapshot', event => {
  if (!event.detail?.chains) return;
  snapshot = event.detail; online = true;
  if (enabled) {
    if (Number($('voiceVolume').value) === 0) tracker.reset();
    tracker.ingest(snapshot, Date.now(), ignored); void notify();
  }
});
window.addEventListener('storage', event => {
  if (event.key !== prefsKey) return;
  const incoming = read(prefsKey, {});
  ++epoch; player.stop(); tracker.reset(); if (snapshot) tracker.ingest(snapshot, Date.now(), ignored);
  if (Number.isFinite(incoming.volume)) $('voiceVolume').value = Math.max(0, Math.min(100, incoming.volume));
  if (!incoming.enabled) { enabled = false; state = 'off'; }
  else state = enabled ? (Number($('voiceVolume').value) === 0 ? 'muted' : online ? 'ready' : 'offline') : 'click';
  paint(); // Another tab can silence this one, but cannot unlock its browser audio.
});
window.addEventListener('radar-offline', () => {
  online = false; snapshot = null; ++epoch; tracker.reset(); player.stop();
  if (enabled) state = 'offline'; paint();
});
window.addEventListener('radar-locale', event => { locale = event.detail; paint(); });
window.addEventListener('pagehide', () => { ++epoch; enabled = false; tracker.reset(); player.stop(); state = 'click'; paint(); });
window.addEventListener('pageshow', event => { if (event.persisted) { snapshot = null; online = false; state = 'click'; paint(); } });
paint();
