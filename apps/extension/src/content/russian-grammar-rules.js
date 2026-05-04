(function initRusTypeGrammarRules(root) {
  const CYRILLIC_RE = /[\u0400-\u04ff]/;
  const LATIN_RE = /[A-Za-z]/;
  const WORD_RE = /[\u0400-\u04ffA-Za-zЁё]+/g;
  const SENTENCE_START_LOWERCASE_RE = /^(\s*)([а-яё])/u;
  const AFTER_SENTENCE_PUNCTUATION_LOWERCASE_RE = /([.!?]\s+)([а-яё])/gu;
  const DUPLICATE_WORD_RE = /(^|[^\u0400-\u04ffЁё])([\u0400-\u04ffЁё]{2,})(\s+)\2(?=$|[^\u0400-\u04ffЁё])/giu;
  const MULTIPLE_SPACES_BETWEEN_WORDS_RE = /([\u0400-\u04ffЁё]) {2,}([\u0400-\u04ffЁё])/g;
  const SPACE_BEFORE_PUNCTUATION_RE = /\s+([,.;:!?])/g;
  const MISSING_SPACE_AFTER_PUNCTUATION_RE = /([,.;:!?])(?=[\u0400-\u04ffA-Za-zЁё])/g;
  const UNNEEDED_EST_RE = /(^|[^\u0400-\u04ffЁё])(я|ты|он|она|мы|вы|они)\s+есть\s+([\u0400-\u04ffЁё]{2,})(?=$|[^\u0400-\u04ffЁё])/giu;
  const LATIN_TO_CYRILLIC_LOOKALIKE = new Map([
    ["A", "А"],
    ["a", "а"],
    ["B", "В"],
    ["C", "С"],
    ["c", "с"],
    ["E", "Е"],
    ["e", "е"],
    ["H", "Н"],
    ["K", "К"],
    ["k", "к"],
    ["M", "М"],
    ["O", "О"],
    ["o", "о"],
    ["P", "Р"],
    ["p", "р"],
    ["T", "Т"],
    ["X", "Х"],
    ["x", "х"],
    ["y", "у"]
  ]);

  function analyzeText(text) {
    const value = String(text ?? "");

    if (!value.trim() || !CYRILLIC_RE.test(value)) {
      return [];
    }

    return [
      ...findSentenceCapitalizationIssues(value),
      ...findDuplicateWords(value),
      ...findMultipleSpacesBetweenWords(value),
      ...findPunctuationSpacingIssues(value),
      ...findMixedAlphabetWords(value),
      ...findUnneededEst(value)
    ].sort((left, right) => left.start - right.start);
  }

  function findSentenceCapitalizationIssues(text) {
    const issues = [];
    const sentenceStartMatch = SENTENCE_START_LOWERCASE_RE.exec(text);

    if (sentenceStartMatch) {
      const prefix = sentenceStartMatch[1] ?? "";
      const original = sentenceStartMatch[2];

      issues.push(createIssue({
        ruleId: "sentence-start-capitalization",
        start: prefix.length,
        length: original.length,
        original,
        suggestion: original.toLocaleUpperCase("ru"),
        message: "Đầu câu tiếng Nga nên viết hoa chữ cái đầu."
      }));
    }

    issues.push(...collectMatches(text, AFTER_SENTENCE_PUNCTUATION_LOWERCASE_RE, (match) => {
      const prefix = match[1] ?? "";
      const original = match[2];

      return createIssue({
        ruleId: "sentence-start-capitalization",
        start: match.index + prefix.length,
        length: original.length,
        original,
        suggestion: original.toLocaleUpperCase("ru"),
        message: "Sau dấu kết thúc câu, chữ cái đầu câu mới nên viết hoa."
      });
    }));

    return issues;
  }

  function findDuplicateWords(text) {
    return collectMatches(text, DUPLICATE_WORD_RE, (match) => {
      const prefix = match[1] ?? "";
      const original = `${match[2]}${match[3]}${match[2]}`;
      const suggestion = match[2];

      return createIssue({
        ruleId: "duplicate-word",
        start: match.index + prefix.length,
        length: original.length,
        original,
        suggestion,
        message: "Từ bị lặp liên tiếp. Thường chỉ cần giữ một lần."
      });
    });
  }

  function findMultipleSpacesBetweenWords(text) {
    return collectMatches(text, MULTIPLE_SPACES_BETWEEN_WORDS_RE, (match) => createIssue({
      ruleId: "multiple-spaces-between-words",
      start: match.index,
      length: match[0].length,
      original: match[0],
      suggestion: `${match[1]} ${match[2]}`,
      message: "Giữa hai từ chỉ nên có một khoảng trắng."
    }));
  }

  function findPunctuationSpacingIssues(text) {
    return [
      ...collectMatches(text, SPACE_BEFORE_PUNCTUATION_RE, (match) => createIssue({
        ruleId: "space-before-punctuation",
        start: match.index,
        length: match[0].length,
        original: match[0],
        suggestion: match[1],
        message: "Trong tiếng Nga không đặt khoảng trắng trước dấu câu."
      })),
      ...collectMatches(text, MISSING_SPACE_AFTER_PUNCTUATION_RE, (match) => createIssue({
        ruleId: "missing-space-after-punctuation",
        start: match.index,
        length: 1,
        original: match[1],
        suggestion: `${match[1]} `,
        message: "Sau dấu câu nên có một khoảng trắng."
      }))
    ];
  }

  function findMixedAlphabetWords(text) {
    const issues = [];
    let match = WORD_RE.exec(text);

    while (match) {
      const original = match[0];

      if (CYRILLIC_RE.test(original) && LATIN_RE.test(original)) {
        const suggestion = replaceLookalikes(original);

        if (suggestion !== original && !LATIN_RE.test(suggestion)) {
          issues.push(createIssue({
            ruleId: "mixed-cyrillic-latin",
            start: match.index,
            length: original.length,
            original,
            suggestion,
            message: "Từ này đang lẫn chữ Latin giống chữ Cyrillic, dễ gây lỗi tìm kiếm và kiểm tra chính tả."
          }));
        }
      }

      match = WORD_RE.exec(text);
    }

    return issues;
  }

  function findUnneededEst(text) {
    return collectMatches(text, UNNEEDED_EST_RE, (match) => {
      const prefix = match[1] ?? "";
      const original = `${match[2]} есть ${match[3]}`;
      const suggestion = `${match[2]} ${match[3]}`;

      return createIssue({
        ruleId: "unneeded-est-present-tense",
        start: match.index + prefix.length,
        length: original.length,
        original,
        suggestion,
        message: "Trong câu kiểu “я студент”, tiếng Nga hiện tại thường bỏ “есть”."
      });
    });
  }

  function collectMatches(text, regex, create) {
    const issues = [];
    regex.lastIndex = 0;
    let match = regex.exec(text);

    while (match) {
      issues.push(create(match));
      match = regex.exec(text);
    }

    return issues;
  }

  function createIssue({ ruleId, start, length, original, suggestion, message }) {
    return {
      type: "grammar",
      code: ruleId,
      ruleId,
      start,
      length,
      original,
      suggestions: [suggestion],
      message
    };
  }

  function replaceLookalikes(word) {
    return Array.from(word)
      .map((char) => LATIN_TO_CYRILLIC_LOOKALIKE.get(char) ?? char)
      .join("");
  }

  const api = { analyzeText };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  root.RusTypeGrammarRules = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
