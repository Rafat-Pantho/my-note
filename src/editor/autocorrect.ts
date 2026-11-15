/** Autocorrect rules: a small built-in list of common typos. Pure: no DOM, no IPC (tested in autocorrect.test.ts).
 *
 *  `correctionAt` looks at the word just before the caret (the caller applies it on space or Enter) and returns
 *  the replacement, or null. It never fires inside a URL, e-mail address, file path or identifier, and in
 *  Markdown never inside code spans, fenced blocks or indented code. */

/** Typo (lower case) -> correction. Only entries that are never a real word, so a correction cannot be wrong. */
export const TYPOS: Readonly<Record<string, string>> = {
  teh: "the", hte: "the", thier: "their", theyre: "they're", thsi: "this", tihs: "this", taht: "that",
  adn: "and", anf: "and", wiht: "with", wtih: "with", wich: "which", whcih: "which",
  waht: "what", whta: "what", hwo: "how", jsut: "just", ahve: "have", hvae: "have", haev: "have",
  becuase: "because", becasue: "because", beacuse: "because", bcause: "because", beause: "because",
  recieve: "receive", recieved: "received", reciever: "receiver", recieving: "receiving",
  beleive: "believe", belive: "believe", beleived: "believed", wierd: "weird", freind: "friend", freinds: "friends",
  occured: "occurred", occuring: "occurring", occurence: "occurrence", occurance: "occurrence",
  seperate: "separate", seperated: "separated", seperately: "separately", definately: "definitely",
  definitly: "definitely", defintely: "definitely", definatly: "definitely", untill: "until", unitl: "until",
  alot: "a lot", noticable: "noticeable", sucess: "success", succesful: "successful", successfull: "successful",
  succesfully: "successfully", accomodate: "accommodate", acommodate: "accommodate", adress: "address",
  agressive: "aggressive", apparant: "apparent", apparantly: "apparently", arguement: "argument",
  begining: "beginning", buisness: "business", bussiness: "business", calender: "calendar", catagory: "category",
  collegue: "colleague", comming: "coming", commited: "committed", comitted: "committed", completly: "completely",
  concious: "conscious", curiousity: "curiosity", decison: "decision", dissapear: "disappear",
  dissapoint: "disappoint", dissappear: "disappear", embarass: "embarrass", enviroment: "environment",
  existance: "existence", experiance: "experience", familar: "familiar", finaly: "finally", foriegn: "foreign",
  goverment: "government", gaurd: "guard", happend: "happened", harrass: "harass", immediatly: "immediately",
  independant: "independent", intresting: "interesting", knowlege: "knowledge", liason: "liaison",
  libary: "library", maintainance: "maintenance", millenium: "millennium", mispell: "misspell",
  neccessary: "necessary", necesary: "necessary", neccesary: "necessary", occassion: "occasion",
  occassionally: "occasionally", persistant: "persistent", posession: "possession", prefered: "preferred",
  privelege: "privilege", probly: "probably", probaly: "probably", professer: "professor", publically: "publicly",
  realy: "really", reccomend: "recommend", recomend: "recommend", refered: "referred", relevent: "relevant",
  religous: "religious", remeber: "remember", rember: "remember", resistence: "resistance", responsability: "responsibility",
  rythm: "rhythm", scedule: "schedule", sieze: "seize", similiar: "similar", sincerly: "sincerely",
  speach: "speech", strenght: "strength", suprise: "surprise", surprize: "surprise", tommorow: "tomorrow",
  tommorrow: "tomorrow", tounge: "tongue", truely: "truly", unforseen: "unforeseen",
  usally: "usually", vaccum: "vacuum", vegtable: "vegetable", wheather: "weather",
  writting: "writing", yeild: "yield", youre: "you're", dont: "don't", doesnt: "doesn't", didnt: "didn't",
  isnt: "isn't", arent: "aren't", wasnt: "wasn't", werent: "weren't", wouldnt: "wouldn't", couldnt: "couldn't",
  shouldnt: "shouldn't", havent: "haven't", hasnt: "hasn't", wont: "won't", thats: "that's", whats: "what's",
  ive: "I've", cant: "can't",
};
// "wont", "cant" and "ive" can be real words (a name, "cant" = hypocritical talk), so they are corrected only
// when typed in lower case; "Ive" or "CANT" is left alone.
const LOWER_ONLY = new Set(["wont", "cant", "ive"]);

export interface Correction {
  /** Offsets inside the line. */
  from: number;
  to: number;
  insert: string;
}

export interface CorrectionContext {
  markdown?: boolean;
  /** The line is inside a fenced code block (Markdown). */
  inFence?: boolean;
  /** Words the user has declared fine (their dictionary or "Ignore"): never changed. */
  keep?: (word: string) => boolean;
}

/** What may stand right before the word: nothing, a space, or an opening bracket, quote or emphasis mark. */
const OPENERS = new Set(["(", "[", "{", '"', "“", "‘", "'", "*", "—", "–"]);
/** Things that make the whole space-delimited token a URL, address or path. */
const NOT_PROSE = /:\/\/|www\.|[/\\@#]|[\p{L}\p{N}]\.[\p{L}\p{N}]/u;
const WORD_END = /[\p{L}\p{M}'’]+$/u;

/** Matches the typo's capitalization: "teh" -> "the", "Teh" -> "The", "TEH" -> "THE". Mixed case: null. */
export function matchCase(word: string, fix: string): string | null {
  if (word === word.toLowerCase()) return fix;
  if (word === word.toUpperCase() && [...word].length > 1) return fix.toUpperCase();
  if (word[0] === word[0].toUpperCase() && word.slice(1) === word.slice(1).toLowerCase()) {
    return fix[0].toUpperCase() + fix.slice(1);
  }
  return null;
}

/** The correction for the word that ends at `col` in `line`, or null. */
export function correctionAt(line: string, col: number, ctx: CorrectionContext = {}): Correction | null {
  const head = line.slice(0, col);
  const m = WORD_END.exec(head);
  if (!m) return null;
  let start = m.index;
  while (start < col && (line[start] === "'" || line[start] === "’")) start++; // a quote, not part of the word
  const word = line.slice(start, col);
  if (word.length < 3) return null;

  const key = word.toLowerCase().replace(/’/g, "'");
  const fix = Object.prototype.hasOwnProperty.call(TYPOS, key) ? TYPOS[key] : undefined;
  if (!fix) return null;
  if (LOWER_ONLY.has(key) && word !== key) return null;
  if (ctx.keep?.(word)) return null;

  // Where the word sits: after nothing, a space or an opener, and not inside a URL / address / path.
  const before = line[start - 1];
  if (before !== undefined && !/\s/u.test(before) && !OPENERS.has(before)) return null;
  const tokenStart = head.search(/\S*$/u);
  if (NOT_PROSE.test(head.slice(tokenStart))) return null;

  if (ctx.markdown) {
    if (ctx.inFence) return null;
    if (/^( {4}|\t)/u.test(line)) return null; // indented code block
    if (((head.slice(0, start).match(/`/g) ?? []).length & 1) === 1) return null; // inside a code span
  }

  const insert = matchCase(word, fix);
  if (insert === null) return null;
  return { from: start, to: col, insert };
}
