window.RusTypeAutocomplete = (() => {
  const MIN_PREFIX_LENGTH = 2;
  const DEFAULT_LIMIT = 3;
  const PREFIX_BUCKET_LENGTH = 2;
  const FAVORITE_WORD_FREQUENCY = 20000;
  const PERSONAL_DICTIONARY_FREQUENCY = 10000;
  const FALLBACK_WORDS = [
    ["привет", 1000],
    ["пожалуйста", 980],
    ["спасибо", 1000],
    ["здравствуйте", 1000],
    ["хорошо", 960],
    ["можно", 940],
    ["сегодня", 900],
    ["сейчас", 880],
    ["понимаю", 800],
    ["извините", 870]
  ];

  const words = loadDictionary();
  const prefixIndex = buildPrefixIndex(words);

  function suggest(prefix, options = {}) {
    const normalizedPrefix = normalizePrefix(prefix);
    const limit = options.limit ?? DEFAULT_LIMIT;
    const minPrefixLength = options.minPrefixLength ?? MIN_PREFIX_LENGTH;

    if (normalizedPrefix.length < minPrefixLength) {
      return [];
    }

    const candidates = [
      ...normalizeExtraWords(options.favoriteWords, FAVORITE_WORD_FREQUENCY, "favorite-word"),
      ...normalizeExtraWords(options.extraWords),
      ...getIndexedCandidates(normalizedPrefix)
    ];
    const seen = new Set();

    return candidates
      .filter((entry) => {
        if (
          seen.has(entry.word) ||
          entry.word === normalizedPrefix ||
          !entry.word.startsWith(normalizedPrefix)
        ) {
          return false;
        }

        seen.add(entry.word);
        return true;
      })
      .sort(compareEntries)
      .slice(0, limit)
      .map((entry) => {
        const fullWord = preservePrefixCase(prefix, entry.word);

        return {
          fullWord,
          completion: fullWord.slice(prefix.length),
          confidence: Math.min(0.98, 0.55 + entry.frequency / 2200),
          reason: entry.source ?? "prefix"
        };
      });
  }

  function loadDictionary() {
    const source = Array.isArray(window.RusTypeAutocompleteDictionary)
      ? window.RusTypeAutocompleteDictionary
      : FALLBACK_WORDS;

    return source
      .map(normalizeEntry)
      .filter(Boolean)
      .sort(compareEntries);
  }

  function buildPrefixIndex(entries) {
    const index = new Map();

    for (const entry of entries) {
      const key = entry.word.slice(0, PREFIX_BUCKET_LENGTH);
      const bucket = index.get(key) ?? [];

      bucket.push(entry);
      index.set(key, bucket);
    }

    return index;
  }

  function getIndexedCandidates(normalizedPrefix) {
    const key = normalizedPrefix.slice(0, PREFIX_BUCKET_LENGTH);
    return prefixIndex.get(key) ?? [];
  }

  function normalizeExtraWords(extraWords, frequency = PERSONAL_DICTIONARY_FREQUENCY, source = "personal-dictionary") {
    if (!Array.isArray(extraWords) || !extraWords.length) {
      return [];
    }

    return extraWords
      .map((word) => normalizeEntry([word, frequency, source]))
      .filter(Boolean);
  }

  function normalizeEntry(entry) {
    const word = Array.isArray(entry) ? entry[0] : entry?.word;
    const frequency = Array.isArray(entry) ? entry[1] : entry?.frequency;
    const source = Array.isArray(entry) ? entry[2] : entry?.source;
    const normalizedWord = normalizePrefix(word);

    if (!normalizedWord || normalizedWord.length < MIN_PREFIX_LENGTH) {
      return null;
    }

    return {
      word: normalizedWord,
      frequency: normalizeFrequency(frequency),
      source
    };
  }

  function compareEntries(left, right) {
    const frequencyDelta = right.frequency - left.frequency;
    return frequencyDelta !== 0 ? frequencyDelta : left.word.length - right.word.length;
  }

  function normalizeFrequency(frequency) {
    const value = Number(frequency);
    return Number.isFinite(value) ? value : 1;
  }

  function normalizePrefix(prefix) {
    return String(prefix ?? "").toLocaleLowerCase("ru-RU");
  }

  function preservePrefixCase(prefix, word) {
    if (!prefix || prefix[0] !== prefix[0].toLocaleUpperCase("ru-RU")) {
      return word;
    }

    return word[0].toLocaleUpperCase("ru-RU") + word.slice(1);
  }

  return {
    suggest
  };
})();
