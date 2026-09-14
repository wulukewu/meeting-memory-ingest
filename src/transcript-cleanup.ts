const EXACT_HALLUCINATION_PATTERNS: RegExp[] = [
  /^謝謝大家[。.!！]?$/u,
  /^谢谢大家[。.!！]?$/u,
  /^請訂閱[。.!！]?$/u,
  /^请订阅[。.!！]?$/u,
  /^請按讚[、,， ]*訂閱[、,， ]*分享[。.!！]?$/u,
  /^请按赞[、,， ]*订阅[、,， ]*分享[。.!！]?$/u,
  /^请不吝点赞\s*订阅\s*转发\s*打赏支持明镜与点点栏目[。.!！]?$/u,
  /^the following is (?:a )?(?:video|summary|work of fiction)\b.*$/iu,
  /^if you have any questions, please feel free to ask[.!]?$/iu,
];

export function isKnownTranscriptHallucination(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ");
  return EXACT_HALLUCINATION_PATTERNS.some((pattern) => pattern.test(normalized));
}
