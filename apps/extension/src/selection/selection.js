const DEFAULT_SETTINGS = {
  selectionTranslateProvider: "google-ru-vi",
  aiOutputLanguage: "vi",
  aiTask: "explain"
};
const CYRILLIC_RE = /[\u0400-\u04ff]/;
const TRANSLATABLE_TEXT_RE = /[A-Za-zÀ-ỹ\u0400-\u04ff]/;
const VIETNAMESE_RE = /[À-ỹ]/;
const TRANSLATION_PROVIDER_CONFIG = {
  "google-ru-vi": {
    languages: ["ru", "vi"],
    pairLabel: "Nga ↔ Việt"
  },
  "google-ru-en": {
    languages: ["ru", "en"],
    pairLabel: "Nga ↔ Anh"
  },
  "google-en-vi": {
    languages: ["en", "vi"],
    pairLabel: "Anh ↔ Việt"
  }
};
const LANGUAGE_LABELS = {
  en: "Anh",
  ru: "Nga",
  vi: "Việt"
};
const STORAGE_PREFIX = "rustype-selection-window:";

const shell = document.querySelector(".selection-shell");
const actionTitle = document.querySelector("#actionTitle");
const closeButton = document.querySelector("#closeButton");
const pairSelect = document.querySelector("#pairSelect");
const sourceText = document.querySelector("#sourceText");
const resultLabel = document.querySelector("#resultLabel");
const resultText = document.querySelector("#resultText");
const retryButton = document.querySelector("#retryButton");
const sourceNote = document.querySelector("#sourceNote");
const aiControls = document.querySelector("#aiControls");
const aiOutputLanguageSelect = document.querySelector("#aiOutputLanguageSelect");

const AI_OUTPUT_LANGUAGES = ["vi", "ru", "en"];
const AI_TASKS = ["explain", "summarize", "rewrite"];

let payload = null;
let settings = { ...DEFAULT_SETTINGS };

init().catch((error) => {
  renderError(error instanceof Error ? error.message : String(error));
});

async function init() {
  for (const [providerId, provider] of Object.entries(TRANSLATION_PROVIDER_CONFIG)) {
    const option = document.createElement("option");
    option.value = providerId;
    option.textContent = provider.pairLabel;
    pairSelect.append(option);
  }

  const requestId = new URLSearchParams(window.location.search).get("id");

  if (!requestId) {
    throw new Error("Thiếu dữ liệu đoạn đã chọn.");
  }

  payload = await readSelectionPayload(requestId);

  if (!payload?.text) {
    throw new Error("Không tìm thấy đoạn đã chọn.");
  }

  const settingsResponse = await sendRuntimeMessage({ type: "RUSTYPE_GET_SETTINGS" });
  settings = {
    ...DEFAULT_SETTINGS,
    ...(settingsResponse?.settings ?? {})
  };

  const action = payload.action === "explain" ? "explain" : "translate";

  actionTitle.textContent = action === "explain" ? "Sử dụng AI với đoạn đã chọn" : "Dịch đoạn đã chọn";
  retryButton.textContent = action === "explain" ? "Chạy AI lại" : "Dịch lại";
  pairSelect.closest(".field").hidden = action === "explain";
  aiControls.hidden = action !== "explain";
  aiOutputLanguageSelect.value = DEFAULT_SETTINGS.aiOutputLanguage;
  setSelectedAiTask(DEFAULT_SETTINGS.aiTask);
  sourceText.textContent = payload.text;
  sourceNote.textContent = createSourceNote(payload);
  pairSelect.value = TRANSLATION_PROVIDER_CONFIG[settings.selectionTranslateProvider]
    ? settings.selectionTranslateProvider
    : DEFAULT_SETTINGS.selectionTranslateProvider;

  pairSelect.addEventListener("change", handlePairChange);
  aiOutputLanguageSelect.addEventListener("change", runCurrentAction);
  document.querySelectorAll("input[name='aiTask']").forEach((input) => {
    input.addEventListener("change", runCurrentAction);
  });
  retryButton.addEventListener("click", runCurrentAction);
  closeButton.addEventListener("click", () => window.close());

  runCurrentAction();
}

async function readSelectionPayload(requestId) {
  const key = `${STORAGE_PREFIX}${requestId}`;
  const sessionPayload = await readStorageArea(chrome.storage.session, key, { removeAfterRead: true });

  if (sessionPayload) {
    return sessionPayload;
  }

  return readStorageArea(chrome.storage.local, key, { removeAfterRead: true });
}

async function readStorageArea(area, key, options = {}) {
  if (!area) {
    return null;
  }

  const data = await area.get(key);
  const value = data?.[key] ?? null;

  if (value && options.removeAfterRead && typeof area.remove === "function") {
    await area.remove(key);
  }

  return value;
}

async function handlePairChange() {
  settings.selectionTranslateProvider = pairSelect.value;
  await sendRuntimeMessage({
    type: "RUSTYPE_SAVE_SETTINGS",
    payload: {
      selectionTranslateProvider: pairSelect.value
    }
  });
  runCurrentAction();
}

async function runCurrentAction() {
  const action = payload?.action === "explain" ? "explain" : "translate";

  if (action === "explain") {
    runAiAction();
    return;
  }

  const translationPair = resolveTranslationPair(payload?.text, pairSelect.value);

  if (!translationPair) {
    renderUnsupportedPair();
    return;
  }

  shell.dataset.state = "loading";
  resultLabel.textContent = translationPair.targetLabel;
  resultText.textContent = "Đang dịch...";

  const response = await sendRuntimeMessage({
    type: "RUSTYPE_TRANSLATE_SELECTION",
    payload: {
      text: payload.text,
      sourceLanguage: translationPair.sourceLanguage,
      targetLanguage: translationPair.targetLanguage
    }
  });

  if (!response?.ok || !response.result?.translatedText) {
    renderError("Không dịch được lúc này. Hãy thử lại.");
    return;
  }

  shell.dataset.state = "ready";
  resultText.textContent = response.result.translatedText;
}

async function runAiAction() {
  const text = String(payload?.text ?? "").trim();
  const aiOutputLanguage = getSelectedAiOutputLanguage();
  const aiTask = getSelectedAiTask();
  const sourceLanguage = resolveSourceLanguageForText(text);

  if (!text || sourceLanguage === "auto") {
    renderError("Không tìm thấy đoạn có thể xử lý bằng AI.");
    return;
  }

  shell.dataset.state = "loading";
  actionTitle.textContent = `Sử dụng AI · ${getAiTaskDisplayName(aiTask)}`;
  resultLabel.textContent = getAiTaskDisplayName(aiTask);
  resultText.textContent = "Đang chạy AI...";

  const aiResponse = await sendRuntimeMessage({
    type: "RUSTYPE_EXPLAIN_SELECTION",
    payload: {
      text,
      sourceLanguage,
      targetLanguage: aiOutputLanguage,
      aiOutputLanguage,
      aiTask
    }
  });

  if (aiResponse?.ok && aiResponse.result?.explanationText) {
    const taskLabel = getAiTaskDisplayName(aiResponse.result.task);
    shell.dataset.state = "ready";
    actionTitle.textContent = `Sử dụng AI · ${taskLabel}`;
    resultLabel.textContent = taskLabel;
    resultText.textContent = formatAiResultText(aiResponse.result.explanationText);
    return;
  }

  if (aiTask !== "explain") {
    renderError("Chưa thể chạy AI lúc này. Hãy kiểm tra API key hoặc provider.");
    return;
  }

  const fallbackPair = resolveFallbackTranslationPair(text, sourceLanguage, aiOutputLanguage);

  if (!fallbackPair) {
    renderError("Chưa thể chạy AI lúc này. Hãy kiểm tra API key hoặc provider.");
    return;
  }

  const translation = await sendRuntimeMessage({
    type: "RUSTYPE_TRANSLATE_SELECTION",
    payload: {
      text,
      sourceLanguage: fallbackPair.sourceLanguage,
      targetLanguage: fallbackPair.targetLanguage
    }
  });

  if (!translation?.ok || !translation.result?.translatedText) {
    renderError("Chưa thể chạy AI lúc này. Hãy kiểm tra API key hoặc provider.");
    return;
  }

  shell.dataset.state = "ready";
  resultLabel.textContent = "Nghĩa chính";
  resultText.textContent =
    `Nghĩa chính (${fallbackPair.targetLabel}): ${translation.result.translatedText}\n\nMuốn giải thích sâu hơn, hãy bật AI và thêm API key trong Settings.`;
}

function getAiTaskDisplayName(task) {
  return {
    explain: "Giải thích",
    rewrite: "Viết lại",
    summarize: "Tóm tắt"
  }[task] ?? "AI";
}

function formatAiResultText(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```[a-z]*\n?/gi, "").replace(/```/g, ""))
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "- ")
    .replace(/^\s{0,3}(\d+)\.\s+/gm, "$1. ")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getSelectedAiOutputLanguage() {
  return AI_OUTPUT_LANGUAGES.includes(aiOutputLanguageSelect.value)
    ? aiOutputLanguageSelect.value
    : DEFAULT_SETTINGS.aiOutputLanguage;
}

function getSelectedAiTask() {
  const task = document.querySelector("input[name='aiTask']:checked")?.value;
  return AI_TASKS.includes(task) ? task : DEFAULT_SETTINGS.aiTask;
}

function setSelectedAiTask(task) {
  const taskValue = AI_TASKS.includes(task) ? task : DEFAULT_SETTINGS.aiTask;
  const input = document.querySelector(`input[name='aiTask'][value='${taskValue}']`);

  if (input) {
    input.checked = true;
  }
}

function resolveSourceLanguageForText(text) {
  if (CYRILLIC_RE.test(text)) {
    return "ru";
  }

  if (VIETNAMESE_RE.test(text)) {
    return "vi";
  }

  if (/[A-Za-z]/.test(text)) {
    return "en";
  }

  return "auto";
}

function resolveFallbackTranslationPair(text, sourceLanguage, targetLanguage) {
  if (!sourceLanguage || !targetLanguage || sourceLanguage === targetLanguage) {
    return null;
  }

  const providerEntry = Object.entries(TRANSLATION_PROVIDER_CONFIG)
    .find(([, provider]) => provider.languages.includes(sourceLanguage) && provider.languages.includes(targetLanguage));
  const providerId = providerEntry?.[0];

  return providerId ? resolveTranslationPair(text, providerId) : null;
}

function resolveTranslationPair(text, providerIdOverride) {
  const value = String(text ?? "").trim();

  if (!value || !TRANSLATABLE_TEXT_RE.test(value)) {
    return null;
  }

  const providerId = TRANSLATION_PROVIDER_CONFIG[providerIdOverride]
    ? providerIdOverride
    : DEFAULT_SETTINGS.selectionTranslateProvider;
  const provider = TRANSLATION_PROVIDER_CONFIG[providerId];

  if (!provider.languages.includes("ru") && CYRILLIC_RE.test(value)) {
    return null;
  }

  const [firstLanguage, secondLanguage] = provider.languages;
  const sourceLanguage = resolveSourceLanguageForPair(value, firstLanguage, secondLanguage);
  const targetLanguage = sourceLanguage === firstLanguage ? secondLanguage : firstLanguage;

  return {
    providerId,
    sourceLanguage,
    targetLanguage,
    sourceLabel: LANGUAGE_LABELS[sourceLanguage] ?? sourceLanguage,
    targetLabel: LANGUAGE_LABELS[targetLanguage] ?? targetLanguage,
    pairLabel: provider.pairLabel
  };
}

function resolveSourceLanguageForPair(text, firstLanguage, secondLanguage) {
  if (firstLanguage === "ru" || secondLanguage === "ru") {
    return CYRILLIC_RE.test(text)
      ? "ru"
      : (firstLanguage === "ru" ? secondLanguage : firstLanguage);
  }

  return VIETNAMESE_RE.test(text) ? "vi" : "en";
}

function renderUnsupportedPair() {
  const provider = TRANSLATION_PROVIDER_CONFIG[pairSelect.value];

  shell.dataset.state = "error";
  resultLabel.textContent = "Không hỗ trợ";
  resultText.textContent =
    `Cặp ${provider?.pairLabel ?? "đã chọn"} không phù hợp với đoạn đang chọn. Hãy chọn cặp có ngôn ngữ của đoạn này.`;
}

function renderError(message) {
  shell.dataset.state = "error";
  resultLabel.textContent = "Lỗi";
  resultText.textContent = message;
}

function createSourceNote(data) {
  const sourceTitle = String(data.sourceTitle ?? "").trim();
  const sourceUrl = String(data.sourceUrl ?? "").trim();

  if (sourceTitle) {
    return `Nguồn: ${sourceTitle}`;
  }

  if (sourceUrl.startsWith("file:")) {
    return "Nguồn: file PDF local";
  }

  if (sourceUrl) {
    return "Nguồn: PDF hoặc trang web";
  }

  return "";
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message
        });
        return;
      }

      resolve(response ?? { ok: false, error: "EMPTY_RESPONSE" });
    });
  });
}
