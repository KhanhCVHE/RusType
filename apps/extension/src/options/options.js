const enabledToggle = document.querySelector("#enabledToggle");
const autocompleteToggle = document.querySelector("#autocompleteToggle");
const autocompleteSuggestionCountSelect = document.querySelector("#autocompleteSuggestionCountSelect");
const spellcheckToggle = document.querySelector("#spellcheckToggle");
const checkLanguageSelect = document.querySelector("#checkLanguageSelect");
const selectionTranslateSelect = document.querySelector("#selectionTranslateSelect");
const aiEnabledToggle = document.querySelector("#aiEnabledToggle");
const aiProviderSelect = document.querySelector("#aiProviderSelect");
const aiModelSelect = document.querySelector("#aiModelSelect");
const aiApiKeyInput = document.querySelector("#aiApiKeyInput");
const testAiButton = document.querySelector("#testAiButton");
const aiTestStatus = document.querySelector("#aiTestStatus");
const themeSelect = document.querySelector("#themeSelect");
const allowedHostsInput = document.querySelector("#allowedHostsInput");
const blockedHostsInput = document.querySelector("#blockedHostsInput");
const showTextPreviewToggle = document.querySelector("#showTextPreviewToggle");
const selectionActionsToggle = document.querySelector("#selectionActionsToggle");
const dictionaryInput = document.querySelector("#dictionaryInput");
const dictionaryWordInput = document.querySelector("#dictionaryWordInput");
const addDictionaryButton = document.querySelector("#addDictionaryButton");
const dictionaryList = document.querySelector("#dictionaryList");
const dictionaryCount = document.querySelector("#dictionaryCount");
const favoriteWordInput = document.querySelector("#favoriteWordInput");
const addFavoriteButton = document.querySelector("#addFavoriteButton");
const favoriteList = document.querySelector("#favoriteList");
const favoriteCount = document.querySelector("#favoriteCount");
const saveButton = document.querySelector("#saveButton");
const saveStatus = document.querySelector("#saveStatus");

const DEFAULT_SETTINGS = {
  enabled: true,
  autocompleteEnabled: true,
  spellcheckEnabled: true,
  checkLanguage: "ru",
  selectionTranslateProvider: "google-ru-vi",
  aiEnabled: false,
  aiProvider: "gemini",
  aiModel: "gemini-2.5-flash-lite",
  aiApiKey: "",
  theme: "electric-light",
  allowedHosts: [],
  blockedHosts: [],
  showTextPreviewInPopup: true,
  selectionActionsEnabled: true,
  personalDictionary: [],
  autocompleteSuggestionCount: 1,
  autocompleteFavoriteWords: []
};
const AI_MODEL_OPTIONS = {
  gemini: [
    {
      value: "gemini-2.5-flash-lite",
      label: "Gemini 2.5 Flash-Lite"
    },
    {
      value: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash"
    },
    {
      value: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro"
    }
  ],
  openai: [
    {
      value: "gpt-5.4-nano",
      label: "GPT-5.4 Nano"
    },
    {
      value: "gpt-5-mini",
      label: "GPT-5 Mini"
    },
    {
      value: "gpt-4.1-mini",
      label: "GPT-4.1 Mini"
    },
    {
      value: "gpt-5.4-mini",
      label: "GPT-5.4 Mini"
    },
    {
      value: "gpt-5",
      label: "GPT-5"
    },
    {
      value: "gpt-4.1",
      label: "GPT-4.1"
    },
    {
      value: "gpt-5.4",
      label: "GPT-5.4"
    },
    {
      value: "gpt-5.5",
      label: "GPT-5.5"
    }
  ]
};
const DEFAULT_AI_MODEL_BY_PROVIDER = {
  gemini: "gemini-2.5-flash-lite",
  openai: "gpt-5.4-nano"
};
const EXAMPLE_WORDS = ["самозанятый", "общежитие", "регистрация"];

let dictionaryWords = [];
let favoriteWords = [];

init().catch((error) => {
  saveStatus.textContent = error instanceof Error ? error.message : String(error);
});

async function init() {
  const response = await sendMessage({ type: "RUSTYPE_GET_SETTINGS" });
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(response?.settings ?? {})
  };

  enabledToggle.checked = Boolean(settings.enabled);
  autocompleteToggle.checked = Boolean(settings.autocompleteEnabled);
  autocompleteSuggestionCountSelect.value = String(normalizeAutocompleteSuggestionCount(settings.autocompleteSuggestionCount));
  spellcheckToggle.checked = Boolean(settings.spellcheckEnabled);
  checkLanguageSelect.value = settings.checkLanguage;
  selectionTranslateSelect.value = settings.selectionTranslateProvider;
  aiEnabledToggle.checked = Boolean(settings.aiEnabled);
  aiProviderSelect.value = settings.aiProvider;
  renderAiModelOptions(settings.aiProvider, settings.aiModel);
  aiApiKeyInput.value = settings.aiApiKey;
  themeSelect.value = settings.theme;
  allowedHostsInput.value = normalizeStoredHostList(settings.allowedHosts).join("\n");
  blockedHostsInput.value = normalizeStoredHostList(settings.blockedHosts).join("\n");
  showTextPreviewToggle.checked = Boolean(settings.showTextPreviewInPopup);
  selectionActionsToggle.checked = Boolean(settings.selectionActionsEnabled);
  dictionaryWords = normalizeWordList(settings.personalDictionary);
  favoriteWords = normalizeWordList(settings.autocompleteFavoriteWords);

  renderDictionary();
  renderFavorites();
  bindEvents();
  syncAutocompleteOptionsState();
}

function bindEvents() {
  saveButton.addEventListener("click", saveSettings);
  testAiButton.addEventListener("click", testAiProvider);
  aiProviderSelect.addEventListener("change", () => {
    renderAiModelOptions(aiProviderSelect.value);
    aiApiKeyInput.placeholder = aiProviderSelect.value === "openai" ? "sk-..." : "AIza...";
  });
  autocompleteToggle.addEventListener("change", syncAutocompleteOptionsState);
  addDictionaryButton.addEventListener("click", addDictionaryWord);
  addFavoriteButton.addEventListener("click", addFavoriteWord);
  dictionaryWordInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addDictionaryWord();
    }
  });
  favoriteWordInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addFavoriteWord();
    }
  });

  document.querySelectorAll(".settings-nav a").forEach((link) => {
    link.addEventListener("click", () => {
      document.querySelectorAll(".settings-nav a").forEach((item) => {
        item.classList.toggle("active", item === link);
      });
    });
  });
}

async function saveSettings() {
  await sendMessage({
    type: "RUSTYPE_SAVE_SETTINGS",
    payload: {
      enabled: enabledToggle.checked,
      autocompleteEnabled: autocompleteToggle.checked,
      autocompleteSuggestionCount: normalizeAutocompleteSuggestionCount(autocompleteSuggestionCountSelect.value),
      spellcheckEnabled: spellcheckToggle.checked,
      checkLanguage: checkLanguageSelect.value,
      selectionTranslateProvider: selectionTranslateSelect.value,
      aiEnabled: aiEnabledToggle.checked,
      aiProvider: aiProviderSelect.value,
      aiModel: aiModelSelect.value,
      aiApiKey: aiApiKeyInput.value.trim(),
      theme: themeSelect.value,
      allowedHosts: toHostRuleList(allowedHostsInput.value),
      blockedHosts: toHostRuleList(blockedHostsInput.value),
      showTextPreviewInPopup: showTextPreviewToggle.checked,
      selectionActionsEnabled: selectionActionsToggle.checked,
      personalDictionary: dictionaryWords,
      autocompleteFavoriteWords: favoriteWords
    }
  });

  saveStatus.textContent = "Đã lưu";
  setTimeout(() => {
    saveStatus.textContent = "";
  }, 1800);
}

async function testAiProvider() {
  aiTestStatus.textContent = aiProviderSelect.value === "openai"
    ? "Đang test OpenAI..."
    : "Đang test Gemini...";
  testAiButton.disabled = true;

  const response = await sendMessage({
    type: "RUSTYPE_TEST_AI_PROVIDER",
    payload: {
      aiProvider: aiProviderSelect.value,
      aiModel: aiModelSelect.value,
      aiApiKey: aiApiKeyInput.value.trim()
    }
  });

  testAiButton.disabled = false;

  if (!response?.ok) {
    aiTestStatus.textContent = response?.error ?? "Không kết nối được AI provider.";
    return;
  }

  aiTestStatus.textContent = `Kết nối OK: ${response.result?.model ?? aiModelSelect.value}`;
}

function renderAiModelOptions(provider, selectedModel) {
  const options = AI_MODEL_OPTIONS[provider] ?? AI_MODEL_OPTIONS.gemini;
  const fallbackModel = DEFAULT_AI_MODEL_BY_PROVIDER[provider] ?? DEFAULT_SETTINGS.aiModel;
  const selected = options.some((option) => option.value === selectedModel)
    ? selectedModel
    : fallbackModel;

  aiModelSelect.textContent = "";

  for (const option of options) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    aiModelSelect.append(element);
  }

  aiModelSelect.value = selected;
  aiApiKeyInput.placeholder = provider === "openai" ? "sk-..." : "AIza...";
}

function addDictionaryWord() {
  const word = dictionaryWordInput.value.trim();

  if (!word) {
    return;
  }

  const normalized = normalizeWord(word);

  if (!dictionaryWords.includes(normalized)) {
    dictionaryWords = [...dictionaryWords, normalized].sort((left, right) => left.localeCompare(right, "ru"));
    renderDictionary();
    saveStatus.textContent = "Chưa lưu thay đổi";
  }

  dictionaryWordInput.value = "";
  dictionaryWordInput.focus();
}

function removeDictionaryWord(word) {
  dictionaryWords = dictionaryWords.filter((item) => item !== word);
  renderDictionary();
  saveStatus.textContent = "Chưa lưu thay đổi";
}

function syncAutocompleteOptionsState() {
  autocompleteSuggestionCountSelect.disabled = !autocompleteToggle.checked;
}

function addFavoriteWord() {
  const word = favoriteWordInput.value.trim();

  if (!word) {
    return;
  }

  const normalized = normalizeWord(word);

  if (!favoriteWords.includes(normalized)) {
    favoriteWords = [...favoriteWords, normalized].sort((left, right) => left.localeCompare(right, "ru"));
    renderFavorites();
    saveStatus.textContent = "Chưa lưu thay đổi";
  }

  favoriteWordInput.value = "";
  favoriteWordInput.focus();
}

function removeFavoriteWord(word) {
  favoriteWords = favoriteWords.filter((item) => item !== word);
  renderFavorites();
  saveStatus.textContent = "Chưa lưu thay đổi";
}

function renderDictionary() {
  dictionaryInput.value = dictionaryWords.join("\n");
  dictionaryCount.textContent = `Tổng: ${dictionaryWords.length} từ`;
  dictionaryList.textContent = "";

  const wordsToRender = dictionaryWords.length > 0 ? dictionaryWords : EXAMPLE_WORDS;

  for (const word of wordsToRender) {
    const item = document.createElement("li");
    const isExample = dictionaryWords.length === 0;

    if (isExample) {
      item.classList.add("example");
    }

    const text = document.createElement("span");
    text.textContent = word;

    const deleteButton = document.createElement("button");
    deleteButton.className = "delete-word";
    deleteButton.type = "button";
    deleteButton.textContent = "⌫";
    deleteButton.title = isExample ? "Từ mẫu" : `Xóa ${word}`;
    deleteButton.disabled = isExample;
    deleteButton.addEventListener("click", () => removeDictionaryWord(word));

    item.append(text, deleteButton);
    dictionaryList.append(item);
  }
}

function renderFavorites() {
  favoriteCount.textContent = `Ưu tiên: ${favoriteWords.length} từ`;
  favoriteList.textContent = "";

  const wordsToRender = favoriteWords.length > 0 ? favoriteWords : ["привет", "спасибо", "пожалуйста"];

  for (const word of wordsToRender) {
    const item = document.createElement("li");
    const isExample = favoriteWords.length === 0;

    if (isExample) {
      item.classList.add("example");
    }

    const text = document.createElement("span");
    text.textContent = word;

    const deleteButton = document.createElement("button");
    deleteButton.className = "delete-word";
    deleteButton.type = "button";
    deleteButton.textContent = "⌫";
    deleteButton.title = isExample ? "Từ mẫu" : `Xóa ${word}`;
    deleteButton.disabled = isExample;
    deleteButton.addEventListener("click", () => removeFavoriteWord(word));

    item.append(text, deleteButton);
    favoriteList.append(item);
  }
}

function toLineList(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function toHostRuleList(value) {
  return Array.from(new Set(toLineList(value).map(normalizeHostRule).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeStoredHostList(value) {
  const values = Array.isArray(value) ? value : [];
  return Array.from(new Set(values.map(normalizeHostRule).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeHostRule(value) {
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

function normalizeWordList(words) {
  return Array.from(new Set((words ?? []).map(normalizeWord).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, "ru"));
}

function normalizeWord(word) {
  return String(word ?? "").trim().toLocaleLowerCase("ru-RU");
}

function normalizeAutocompleteSuggestionCount(value) {
  const count = Number(value);

  if (!Number.isInteger(count)) {
    return DEFAULT_SETTINGS.autocompleteSuggestionCount;
  }

  return Math.min(Math.max(count, 1), 3);
}

function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: chrome.runtime.lastError.message
          });
          return;
        }

        resolve(response ?? { ok: false });
      });
    } catch (error) {
      resolve({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
