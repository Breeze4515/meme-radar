export const CANDIDATE_PHRASE = '亲爱的老板～我找到一枚不错的币，快来看看';

// Use voices installed on the listener's device; never redistribute a system recording.
export function selectChineseVoice(voices = []) {
  const female = /Meijia|Ting.?Ting|Xiaoxiao|Xiaoyi|Huihui|Yaoyao|Hanhan|Yating|Lili|Sinji|美佳|婷婷|晓晓|晓伊|慧慧|瑶瑶/i;
  const score = v => (female.test(v.name) ? 10 : 0) + (/^zh[-_](CN|Hans)/i.test(v.lang) ? 2 : 0) + (v.default ? 1 : 0);
  return voices.filter(v => v.localService === true && /^zh(?:[-_]|$)/i.test(v.lang))
    .sort((a, b) => score(b) - score(a))[0] || null;
}

export function createVoicePlayer({ synthesis = globalThis.speechSynthesis,
  makeUtterance = text => new globalThis.SpeechSynthesisUtterance(text),
  schedule = setTimeout, cancelTimer = clearTimeout } = {}) {
  let voice, unlocked = false, active = null;
  try { synthesis?.getVoices(); } catch {} // Start asynchronous browser voice discovery before the click.
  return {
    get ready() { return unlocked && !!voice && !synthesis?.paused; },
    get playing() { return active !== null; },
    async unlock() {
      unlocked = false;
      if (!synthesis?.speak || !synthesis?.getVoices) throw new Error('speech_unsupported');
      synthesis.resume(); // Remains synchronous in the user's click handler.
      voice = selectChineseVoice(synthesis.getVoices());
      if (!voice) throw new Error('chinese_voice_missing');
      unlocked = true;
    },
    stop() { active?.stop(); },
    play(volume = .5) {
      if (!this.ready) return Promise.reject(new Error('audio_suspended'));
      if (active || !Number.isFinite(volume) || volume <= 0) return Promise.resolve(false);
      return new Promise((resolve, reject) => {
        const utterance = makeUtterance(CANDIDATE_PHRASE);
        utterance.voice = voice; utterance.lang = voice.lang;
        utterance.volume = Math.min(1, volume); utterance.rate = .9; utterance.pitch = 1.05;
        let timer;
        const finish = (ok, error) => {
          if (active?.utterance !== utterance) return;
          active = null; cancelTimer(timer);
          utterance.onend = null; utterance.onerror = null;
          if (error) { unlocked = false; reject(error); } else resolve(ok);
        };
        active = { utterance, stop() { finish(false); synthesis.cancel(); } };
        utterance.onend = () => finish(true);
        utterance.onerror = event => finish(false, new Error(event.error || 'speech_failed'));
        timer = schedule(() => { finish(false, new Error('speech_timeout')); synthesis.cancel(); }, 20_000);
        try { synthesis.speak(utterance); } catch (error) { finish(false, error); }
      });
    }
  };
}
