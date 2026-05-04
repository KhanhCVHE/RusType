const DEFAULT_SETTINGS = {
  enabled: true,
  autocompleteEnabled: true,
  spellcheckEnabled: true,
  suggestionLevel: "medium",
  checkLanguage: "ru",
  selectionTranslateProvider: "google-ru-vi",
  aiEnabled: false,
  aiProvider: "gemini",
  aiModel: "gemini-2.5-flash-lite",
  aiApiKey: "",
  aiOutputLanguage: "vi",
  aiTask: "explain",
  theme: "electric-light",
  blockedHosts: [],
  allowedHosts: [],
  showTextPreviewInPopup: true,
  selectionActionsEnabled: true,
  personalDictionary: [],
  autocompleteSuggestionCount: 1,
  autocompleteFavoriteWords: []
};
const YANDEX_CHECK_TEXT_URL = "https://speller.yandex.net/services/spellservice.json/checkText";
const MAX_SPELLCHECK_TEXT_LENGTH = 10_000;
const YANDEX_ERROR_CODES = {
  UNKNOWN_WORD: 1,
  REPEATED_WORD: 2,
  CAPITALIZATION: 3,
  TOO_MANY_ERRORS: 4
};
const DEFAULT_OPENAI_MODEL = "gpt-5.4-nano";
const SUPPORTED_OPENAI_MODELS = new Set([
  "gpt-5.4-nano",
  "gpt-5-mini",
  "gpt-4.1-mini",
  "gpt-5.4-mini",
  "gpt-5",
  "gpt-4.1",
  "gpt-5.4",
  "gpt-5.5"
]);
const CONTEXT_MENU_TRANSLATE_ID = "rustype-translate-selection";
const CONTEXT_MENU_EXPLAIN_ID = "rustype-explain-selection";
const SELECTION_WINDOW_STORAGE_PREFIX = "rustype-selection-window:";

const tabEditorState = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const missingDefaults = {};

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (stored[key] === undefined) {
      missingDefaults[key] = value;
    }
  }

  if (Object.keys(missingDefaults).length > 0) {
    await chrome.storage.local.set(missingDefaults);
  }

  createContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
});

if (chrome.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    handleContextMenuClick(info, tab);
  });
}

createContextMenus();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "RUSTYPE_EDITOR_STATE_UPDATED") {
    const tabId = sender.tab?.id;

    if (typeof tabId === "number") {
      tabEditorState.set(tabId, {
        ...message.payload,
        updatedAt: Date.now()
      });

      updateBadge(tabId, message.payload);
    }

    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "RUSTYPE_GET_EDITOR_STATE") {
    respondAsync(sendResponse, async () => {
      const tab = await getActiveTab();
      const state = typeof tab?.id === "number" ? tabEditorState.get(tab.id) : null;

      return {
        ok: true,
        state: state ?? createTabFallbackState(tab)
      };
    });
    return true;
  }

  if (message.type === "RUSTYPE_REFRESH_ACTIVE_EDITOR_STATE") {
    respondAsync(sendResponse, async () => {
      const state = await refreshActiveEditorState();
      return { ok: true, state };
    });
    return true;
  }

  if (message.type === "RUSTYPE_GET_SETTINGS") {
    respondAsync(sendResponse, async () => {
      const settings = await getSettings();
      return {
        ok: true,
        settings: canReadSensitiveSettings(sender) ? settings : redactSensitiveSettings(settings)
      };
    });
    return true;
  }

  if (message.type === "RUSTYPE_SPELLCHECK_TEXT") {
    respondAsync(sendResponse, async () => {
      const result = await spellcheckText(message.payload ?? {});
      return { ok: true, result };
    });
    return true;
  }

  if (message.type === "RUSTYPE_TRANSLATE_SELECTION") {
    respondAsync(sendResponse, async () => {
      const result = await translateSelectionWithGoogle(message.payload ?? {});
      return { ok: true, result };
    });
    return true;
  }

  if (message.type === "RUSTYPE_EXPLAIN_SELECTION") {
    respondAsync(sendResponse, async () => {
      const result = await explainSelectionWithAi(message.payload ?? {});
      return { ok: true, result };
    });
    return true;
  }

  if (message.type === "RUSTYPE_TEST_AI_PROVIDER") {
    respondAsync(sendResponse, async () => {
      const result = await testAiProvider(message.payload ?? {});
      return { ok: true, result };
    });
    return true;
  }

  if (message.type === "RUSTYPE_SAVE_SETTINGS") {
    respondAsync(sendResponse, async () => {
      await chrome.storage.local.set(message.payload ?? {});
      return { ok: true };
    });
    return true;
  }

  return false;
});

function createContextMenus() {
  if (!chrome.contextMenus?.create || !chrome.contextMenus?.update) {
    return;
  }

  upsertContextMenu({
    id: CONTEXT_MENU_TRANSLATE_ID,
    title: "RusType: Dịch đoạn đã chọn",
    contexts: ["selection"]
  });

  upsertContextMenu({
    id: CONTEXT_MENU_EXPLAIN_ID,
    title: "RusType: Sử dụng AI với đoạn đã chọn",
    contexts: ["selection"]
  });
}

function upsertContextMenu(properties) {
  const { id, ...updateProperties } = properties;

  chrome.contextMenus.update(id, updateProperties, () => {
    if (!chrome.runtime.lastError) {
      return;
    }

    chrome.contextMenus.create(properties, () => {
      void chrome.runtime.lastError;
    });
  });
}

async function handleContextMenuClick(info, tab) {
  const tabId = tab?.id;
  const selectedText = String(info.selectionText ?? "").trim().slice(0, 5000);

  if (typeof tabId !== "number" || !selectedText) {
    return;
  }

  if (![CONTEXT_MENU_TRANSLATE_ID, CONTEXT_MENU_EXPLAIN_ID].includes(info.menuItemId)) {
    return;
  }

  const settings = await getSettings();

  if (
    !settings.enabled ||
    !settings.selectionActionsEnabled ||
    !isExtensionActiveForUrl(tab.url ?? "", settings)
  ) {
    return;
  }

  const action = info.menuItemId === CONTEXT_MENU_TRANSLATE_ID ? "translate" : "explain";
  const message = {
    type: "RUSTYPE_SHOW_SELECTION_ACTION",
    payload: {
      action,
      text: selectedText
    }
  };
  const options = typeof info.frameId === "number" ? { frameId: info.frameId } : undefined;
  const delivered = await sendSelectionActionToContentScript(tabId, message, options);

  if (delivered) {
    return;
  }

  await openSelectionResultWindow({
    action,
    text: selectedText,
    sourceUrl: tab.url ?? "",
    sourceTitle: tab.title ?? ""
  });
}

function sendSelectionActionToContentScript(tabId, message, options) {
  return new Promise((resolve) => {
    const handleResponse = (response) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }

      resolve(Boolean(response?.ok));
    };

    try {
      if (options) {
        chrome.tabs.sendMessage(tabId, message, options, handleResponse);
        return;
      }

      chrome.tabs.sendMessage(tabId, message, handleResponse);
    } catch {
      resolve(false);
    }
  });
}

async function openSelectionResultWindow(payload) {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const storageKey = `${SELECTION_WINDOW_STORAGE_PREFIX}${requestId}`;
  const storageArea = chrome.storage.session ?? chrome.storage.local;

  await storageArea.set({
    [storageKey]: {
      ...payload,
      createdAt: Date.now()
    }
  });

  await chrome.windows.create({
    url: chrome.runtime.getURL(`src/selection/selection.html?id=${encodeURIComponent(requestId)}`),
    type: "popup",
    width: 420,
    height: 560,
    focused: true
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

function respondAsync(sendResponse, handler) {
  handler()
    .then((response) => {
      sendResponse(response);
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        code: error?.code ?? "BACKGROUND_ERROR",
        error: error instanceof Error ? error.message : String(error),
        state: null
      });
    });
}

function redactSensitiveSettings(settings) {
  const { aiApiKey: _aiApiKey, ...safeSettings } = settings;
  return safeSettings;
}

function canReadSensitiveSettings(sender) {
  try {
    const url = new URL(sender?.url ?? "");
    return url.protocol === "chrome-extension:" && url.pathname.endsWith("/src/options/options.html");
  } catch {
    return false;
  }
}

async function refreshActiveEditorState() {
  const tab = await getActiveTab();

  if (typeof tab?.id !== "number") {
    return null;
  }

  const response = await collectStateFromFrames(tab.id);

  if (response?.state) {
    const state = {
      ...response.state,
      updatedAt: Date.now()
    };

    tabEditorState.set(tab.id, state);
    updateBadge(tab.id, state);

    return state;
  }

  return createTabFallbackState(tab);
}

async function collectStateFromFrames(tabId) {
  const frames = await getTabFrames(tabId);

  if (frames.length === 0) {
    return sendTabMessage(tabId, {
      type: "RUSTYPE_COLLECT_EDITOR_STATE"
    });
  }

  const responses = await Promise.all(
    frames.map((frame) => {
      return sendTabMessage(
        tabId,
        { type: "RUSTYPE_COLLECT_EDITOR_STATE" },
        frame.frameId
      );
    })
  );

  return responses
    .filter(Boolean)
    .sort((left, right) => scoreFrameState(right.state) - scoreFrameState(left.state))[0] ?? null;
}

function getTabFrames(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
        if (chrome.runtime.lastError) {
          resolve([]);
          return;
        }

        resolve(frames ?? []);
      });
    } catch {
      resolve([]);
    }
  });
}

function scoreFrameState(state) {
  if (!state || state.editorType === "none") {
    return 0;
  }

  let score = 1;

  if (state.host) {
    score += 1;
  }

  if (state.isRussianLike) {
    score += 10;
  }

  if (state.textPreview) {
    score += 5;
  }

  if (state.editorType === "selection") {
    score += 4;
  }

  if (state.editorType === "google-docs-dev") {
    score += 2;
  }

  if (state.textPreview && ["input", "textarea", "contenteditable"].includes(state.editorType)) {
    score += 3;
  }

  return score;
}

function sendTabMessage(tabId, message, frameId) {
  return new Promise((resolve) => {
    try {
      const handleResponse = (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }

        resolve(response ?? null);
      };

      if (typeof frameId === "number") {
        chrome.tabs.sendMessage(tabId, message, { frameId }, handleResponse);
        return;
      }

      chrome.tabs.sendMessage(tabId, message, handleResponse);
    } catch {
      resolve(null);
    }
  });
}

async function spellcheckText(payload) {
  const text = String(payload.text ?? "");

  if (!text.trim()) {
    return {
      issues: [],
      meta: createSpellcheckMeta()
    };
  }

  if (text.length > MAX_SPELLCHECK_TEXT_LENGTH) {
    throw createBackgroundError(
      "TEXT_TOO_LONG",
      `Text must be ${MAX_SPELLCHECK_TEXT_LENGTH} characters or fewer`
    );
  }

  const form = new URLSearchParams();
  form.set("text", text);
  form.set("lang", "ru");
  form.set("format", "plain");
  form.set("options", String(normalizeYandexOptions(payload.options)));

  let response;

  try {
    response = await fetch(YANDEX_CHECK_TEXT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form
    });
  } catch (error) {
    throw createBackgroundError(
      "PROVIDER_UNAVAILABLE",
      `Yandex Speller request failed: ${error.message}`
    );
  }

  if (!response.ok) {
    throw createBackgroundError(
      "PROVIDER_UNAVAILABLE",
      `Yandex Speller returned HTTP ${response.status}`
    );
  }

  const body = await response.json();
  const providerIssues = Array.isArray(body) ? body : [];

  return {
    issues: providerIssues.map((issue, index) => normalizeYandexIssue(issue, index)),
    meta: createSpellcheckMeta()
  };
}

function normalizeYandexOptions(options = {}) {
  let value = 0;

  if (options.ignoreWordsWithNumbers !== false) {
    value += 2;
  }

  if (options.ignoreUrls !== false) {
    value += 4;
  }

  if (options.findRepeatedWords !== false) {
    value += 8;
  }

  return value;
}

function normalizeYandexIssue(issue, index) {
  return {
    id: `yandex-${index}-${issue.pos}-${issue.len}`,
    type: "spelling",
    source: "yandex-speller",
    start: issue.pos,
    length: issue.len,
    original: issue.word,
    suggestions: Array.isArray(issue.s) ? issue.s.slice(0, 5) : [],
    code: issue.code,
    explanationCode: getYandexExplanationCode(issue),
    confidence: issue.s?.length ? 0.92 : 0.72
  };
}

function getYandexExplanationCode(issue) {
  if (issue.code === YANDEX_ERROR_CODES.REPEATED_WORD) {
    return "SPELLING_REPEATED_WORD";
  }

  if (issue.code === YANDEX_ERROR_CODES.CAPITALIZATION) {
    return "SPELLING_CAPITALIZATION";
  }

  if (issue.code === YANDEX_ERROR_CODES.TOO_MANY_ERRORS) {
    return "SPELLING_TOO_MANY_ERRORS";
  }

  if (issue.code === YANDEX_ERROR_CODES.UNKNOWN_WORD) {
    return "SPELLING_UNKNOWN_WORD";
  }

  return "SPELLING_ERROR";
}

function createSpellcheckMeta() {
  return {
    provider: "yandex-speller",
    cached: false,
    requestId: crypto.randomUUID()
  };
}

function createBackgroundError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function translateSelectionWithGoogle(payload) {
  const text = String(payload?.text ?? "").trim();
  const sourceLanguage = payload?.sourceLanguage ?? "ru";
  const targetLanguage = payload?.targetLanguage ?? "vi";

  if (!text) {
    throw createBackgroundError("EMPTY_SELECTION", "No selected text to translate");
  }

  const response = await fetch(createGoogleTranslateApiUrl({
    text,
    sourceLanguage,
    targetLanguage
  }));
  const body = await response.json();

  if (!response.ok) {
    throw createBackgroundError(
      "GOOGLE_TRANSLATE_FAILED",
      `Google Translate failed with HTTP ${response.status}`
    );
  }

  return {
    translatedText: parseGoogleTranslateResponse(body),
    provider: "google-translate",
    sourceLanguage,
    targetLanguage
  };
}

function createGoogleTranslateApiUrl({ text, sourceLanguage, targetLanguage }) {
  const value = String(text ?? "").trim();

  if (!value) {
    throw createBackgroundError("EMPTY_SELECTION", "No selected text to translate");
  }

  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", sourceLanguage);
  url.searchParams.set("tl", targetLanguage);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", value.slice(0, 5000));
  return url.toString();
}

function parseGoogleTranslateResponse(body) {
  const translated = body?.[0]
    ?.map((segment) => Array.isArray(segment) ? segment[0] : "")
    .join("")
    .trim();

  if (!translated) {
    throw createBackgroundError("EMPTY_TRANSLATION", "Google Translate returned an empty translation");
  }

  return translated;
}

async function explainSelectionWithAi(payload) {
  const settings = await getSettings();
  return explainSelectionWithProvider(payload, settings);
}

async function testAiProvider(payload) {
  const settings = {
    ...(await getSettings()),
    aiEnabled: true,
    aiProvider: payload.aiProvider ?? "gemini",
    aiModel: payload.aiModel ?? "gemini-2.5-flash-lite",
    aiApiKey: payload.aiApiKey ?? "",
    aiOutputLanguage: payload.aiOutputLanguage ?? "vi",
    aiTask: payload.aiTask ?? "explain"
  };

  const result = await explainSelectionWithProvider({
    text: "Привет, как дела?",
    sourceLanguage: "ru",
    targetLanguage: "vi"
  }, settings);

  return {
    provider: settings.aiProvider,
    model: settings.aiModel,
    task: normalizeAiTask(settings.aiTask),
    targetLanguage: normalizeAiOutputLanguage(settings.aiOutputLanguage),
    preview: result.explanationText.slice(0, 180)
  };
}

async function explainSelectionWithProvider(payload, settings) {
  if (!settings.aiEnabled) {
    throw createBackgroundError("AI_NOT_CONFIGURED", "AI is not enabled");
  }

  if (settings.aiProvider === "openai") {
    return explainSelectionWithOpenAi(payload, settings);
  }

  if (settings.aiProvider === "gemini") {
    return explainSelectionWithGemini(payload, settings);
  }

  throw createBackgroundError("AI_PROVIDER_UNSUPPORTED", "Unsupported AI provider");
}

async function explainSelectionWithGemini(payload, settings) {
  const text = String(payload?.text ?? "").trim().slice(0, 5000);
  const apiKey = String(settings.aiApiKey ?? "").trim();
  const model = String(settings.aiModel ?? "gemini-2.5-flash-lite").trim();
  const targetLanguage = normalizeAiOutputLanguage(
    payload?.aiOutputLanguage ?? payload?.targetLanguage ?? settings.aiOutputLanguage
  );
  const aiTask = normalizeAiTask(payload?.aiTask ?? settings.aiTask);

  if (settings.aiProvider !== "gemini") {
    throw createBackgroundError("AI_PROVIDER_UNSUPPORTED", "Gemini provider is not selected");
  }

  if (!apiKey) {
    throw createBackgroundError("AI_API_KEY_MISSING", "Gemini API key is missing");
  }

  if (!text) {
    throw createBackgroundError("EMPTY_SELECTION", "No selected text to explain");
  }

  const response = await fetch(createGeminiGenerateContentUrl(model), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(createGeminiExplanationPayload({
      text,
      sourceLanguage: payload?.sourceLanguage ?? "auto",
      targetLanguage,
      aiTask
    }))
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw createBackgroundError(
      "GEMINI_EXPLAIN_FAILED",
      body?.error?.message ?? `Gemini failed with HTTP ${response.status}`
    );
  }

  return {
    explanationText: parseGeminiTextResponse(body),
    provider: "gemini",
    model,
    task: aiTask,
    targetLanguage
  };
}

async function explainSelectionWithOpenAi(payload, settings) {
  const text = String(payload?.text ?? "").trim().slice(0, 5000);
  const apiKey = String(settings.aiApiKey ?? "").trim();
  const model = normalizeOpenAiModel(settings.aiModel);
  const targetLanguage = normalizeAiOutputLanguage(
    payload?.aiOutputLanguage ?? payload?.targetLanguage ?? settings.aiOutputLanguage
  );
  const aiTask = normalizeAiTask(payload?.aiTask ?? settings.aiTask);

  if (!apiKey) {
    throw createBackgroundError("AI_API_KEY_MISSING", "OpenAI API key is missing");
  }

  if (!text) {
    throw createBackgroundError("EMPTY_SELECTION", "No selected text to explain");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(createOpenAiExplanationPayload({
      model,
      text,
      sourceLanguage: payload?.sourceLanguage ?? "auto",
      targetLanguage,
      aiTask
    }))
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw createBackgroundError(
      "OPENAI_EXPLAIN_FAILED",
      body?.error?.message ?? `OpenAI failed with HTTP ${response.status}`
    );
  }

  return {
    explanationText: parseOpenAiTextResponse(body),
    provider: "openai",
    model,
    task: aiTask,
    targetLanguage
  };
}

function normalizeOpenAiModel(model) {
  const normalized = String(model ?? "").trim();
  return SUPPORTED_OPENAI_MODELS.has(normalized) ? normalized : DEFAULT_OPENAI_MODEL;
}

function createOpenAiExplanationPayload({ model, text, sourceLanguage, targetLanguage, aiTask }) {
  return {
    model,
    instructions: createAiInstruction({ aiTask, targetLanguage }),
    input: [
      `Ngôn ngữ nguồn: ${sourceLanguage}.`,
      `Ngôn ngữ trả lời: ${getAiLanguageLabel(targetLanguage)}.`,
      `Tác vụ AI: ${getAiTaskLabel(aiTask)}.`,
      "Đoạn cần xử lý:",
      text
    ].join("\n"),
    max_output_tokens: 600,
    store: false
  };
}

function createAiInstruction({ aiTask, targetLanguage }) {
  const task = normalizeAiTask(aiTask);
  const languageLabel = getAiLanguageLabel(targetLanguage);
  const base = [
    "Bạn là trợ lý RusType cho người Việt học tiếng Nga và ngoại ngữ.",
    `Luôn trả lời bằng ${languageLabel}.`,
    "Không bịa ngữ cảnh. Nếu thiếu ngữ cảnh, hãy nói rõ giới hạn.",
    "Chỉ trả plain text. Không dùng Markdown, không dùng **, ###, bảng Markdown, HTML hoặc code fence."
  ];

  if (task === "summarize") {
    return [
      ...base,
      "Nhiệm vụ: tóm tắt đoạn được chọn ngắn gọn, giữ ý chính, không thêm thông tin ngoài văn bản.",
      "Ưu tiên 2-4 gạch đầu dòng nếu đoạn đủ dài; nếu đoạn ngắn, trả lời một câu súc tích."
    ].join(" ");
  }

  if (task === "rewrite") {
    return [
      ...base,
      "Nhiệm vụ: viết lại đoạn được chọn cho tự nhiên, rõ ràng và đúng hơn nhưng vẫn giữ nghĩa chính.",
      "Chỉ đưa phiên bản viết lại và thêm một ghi chú rất ngắn nếu có thay đổi quan trọng."
    ].join(" ");
  }

  return [
    ...base,
    "Nhiệm vụ: giải thích đoạn được chọn ngắn gọn, thực dụng.",
    "Trả lời theo cấu trúc: Nghĩa chính, Điểm cần chú ý, Cách nói tự nhiên."
  ].join(" ");
}

function normalizeAiTask(task) {
  return ["explain", "summarize", "rewrite"].includes(task) ? task : "explain";
}

function normalizeAiOutputLanguage(language) {
  return ["vi", "ru", "en"].includes(language) ? language : "vi";
}

function getAiLanguageLabel(language) {
  return {
    en: "tiếng Anh",
    ru: "tiếng Nga",
    vi: "tiếng Việt"
  }[normalizeAiOutputLanguage(language)];
}

function getAiTaskLabel(task) {
  return {
    explain: "Giải thích",
    rewrite: "Viết lại",
    summarize: "Tóm tắt"
  }[normalizeAiTask(task)];
}

function parseOpenAiTextResponse(body) {
  const directText = String(body?.output_text ?? "").trim();

  if (directText) {
    return directText;
  }

  const text = body?.output
    ?.flatMap((item) => item?.content ?? [])
    ?.map((content) => content?.text ?? "")
    ?.join("")
    ?.trim();

  if (!text) {
    throw createBackgroundError("EMPTY_AI_EXPLANATION", "OpenAI returned an empty explanation");
  }

  return text;
}

function createGeminiGenerateContentUrl(model) {
  const normalizedModel = (String(model ?? "").trim() || "gemini-2.5-flash-lite").replace(/^models\//, "");
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(normalizedModel)}:generateContent`;
}

function createGeminiExplanationPayload({ text, sourceLanguage, targetLanguage, aiTask }) {
  return {
    system_instruction: {
      parts: [{
        text: createAiInstruction({ aiTask, targetLanguage })
      }]
    },
    contents: [{
      role: "user",
      parts: [{
        text: [
          `Ngôn ngữ nguồn: ${sourceLanguage}.`,
          `Ngôn ngữ trả lời: ${getAiLanguageLabel(targetLanguage)}.`,
          `Tác vụ AI: ${getAiTaskLabel(aiTask)}.`,
          "Đoạn cần xử lý:",
          text
        ].join("\n")
      }]
    }],
    generationConfig: {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 600,
      responseMimeType: "text/plain"
    }
  };
}

function parseGeminiTextResponse(body) {
  const text = body?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw createBackgroundError("EMPTY_AI_EXPLANATION", "Gemini returned an empty explanation");
  }

  return text;
}

function createTabFallbackState(tab) {
  if (!tab?.url) {
    return null;
  }

  try {
    const url = new URL(tab.url);

    return {
      enabled: true,
      host: url.hostname,
      editorType: "none",
      isRussianLike: false,
      textLength: 0,
      selectionStart: 0,
      selectionEnd: 0,
      textPreview: "",
      currentWord: null,
      activeSentence: null,
      note: "",
      updatedAt: Date.now()
    };
  } catch {
    return null;
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return {
    ...DEFAULT_SETTINGS,
    ...stored
  };
}

function isExtensionActiveForUrl(url, settings) {
  const hostname = getHostnameFromUrl(url);
  const allowedHosts = normalizeHostList(settings.allowedHosts);
  const blockedHosts = normalizeHostList(settings.blockedHosts);

  if (!hostname) {
    return allowedHosts.length === 0;
  }

  if (matchesHostList(hostname, blockedHosts)) {
    return false;
  }

  if (allowedHosts.length > 0 && !matchesHostList(hostname, allowedHosts)) {
    return false;
  }

  return true;
}

function matchesHostList(hostname, rules) {
  const host = normalizeHostname(hostname);
  return normalizeHostList(rules).some((rule) => host === rule || host.endsWith(`.${rule}`));
}

function normalizeHostList(rules) {
  const values = Array.isArray(rules) ? rules : [];
  return Array.from(new Set(values.map(normalizeHostname).filter(Boolean)));
}

function normalizeHostname(value) {
  const raw = String(value ?? "").trim().toLowerCase();

  if (!raw) {
    return "";
  }

  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
  } catch {
    return raw
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .split(":")[0]
      .trim();
  }
}

function getHostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function updateBadge(tabId, state) {
  if (!state?.enabled) {
    chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }

  chrome.action.setBadgeText({
    tabId,
    text: state.isRussianLike ? "RU" : ""
  });

  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: "#2f855a"
  });
}
