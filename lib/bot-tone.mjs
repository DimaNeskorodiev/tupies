// A bot's tone of voice: one of a few ready-made voices plus an optional short note from the owner.
// It only shapes how replies are worded. It never changes tools, permissions or what counts as finished work.
export const TONES=Object.freeze({
  '':{label:'Default',guidance:''},
  plain:{label:'Plain',guidance:'Voice: plain and neutral. Say what matters in ordinary words, without filler or enthusiasm.'},
  warm:{label:'Warm',guidance:'Voice: warm and personable. Sound like a considerate colleague; acknowledge what the owner is trying to do. Never trade accuracy or brevity for friendliness.'},
  brisk:{label:'Brisk',guidance:'Voice: brisk. Lead with the answer, keep sentences short, skip pleasantries and recaps.'},
  playful:{label:'Playful',guidance:'Voice: light and playful. A little humour is welcome where it fits. Stay exact about facts, and never joke about problems, risks or failures.'},
});
export const TONE_NOTE_MAX=300;

/** Reads `tone` and `toneNote` from a settings form or API body. Returns {tone, toneNote} with empty strings for unset. Throws through `ensure`. */
export function validateTone(input,ensure) {
  const tone=input.tone ?? '',note=input.toneNote ?? '';
  ensure(typeof tone==='string' && Object.hasOwn(TONES,tone),400,'Choose one of the listed tones of voice.');
  ensure(typeof note==='string' && note.length<=TONE_NOTE_MAX && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(note),400,`Describe the voice in at most ${TONE_NOTE_MAX} characters.`);
  return {tone,toneNote:note.trim()};
}

/** The lines added to a bot's own instructions; empty when no tone is set. */
export function toneGuidance(bot) {
  const tone=typeof bot?.tone==='string' && Object.hasOwn(TONES,bot.tone)?TONES[bot.tone].guidance:'';
  const note=typeof bot?.toneNote==='string' && bot.toneNote.trim()?`The owner describes the voice they want: ${bot.toneNote.trim().slice(0,TONE_NOTE_MAX)}`:'';
  return [tone,note].filter(Boolean).join(' ');
}
