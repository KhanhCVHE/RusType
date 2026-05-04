const enabledToggle = document.querySelector("#enabledToggle");
const autocompleteToggle = document.querySelector("#autocompleteToggle");
const spellcheckToggle = document.querySelector("#spellcheckToggle");
const statusDot = document.querySelector("#statusDot");
const hostValue = document.querySelector("#hostValue");
const editorValue = document.querySelector("#editorValue");
const wordValue = document.querySelector("#wordValue");
const textValue = document.querySelector("#textValue");
const russianValue = document.querySelector("#russianValue");
const noteValue = document.querySelector("#noteValue");
const refreshButton = document.querySelector("#refreshButton");
const optionsButton = document.querySelector("#optionsButton");
const dictionaryButton = document.querySelector("#dictionaryButton");
const suggestionValue = document.querySelector("#suggestionValue");
const dictionaryCountValue = document.querySelector("#dictionaryCountValue");

const DEFAULT_SETTINGS = {
  enabled: true,
  autocompleteEnabled: true,
  spellcheckEnabled: true,
  personalDictionary: []
};

let currentSettings = { ...DEFAULT_SETTINGS };

window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  renderPopupError(event.reason);
});

init().catch((error) => {
  renderPopupError(error);
  applySettings(DEFAULT_SETTINGS);
  renderState(null);
});

async function init() {
  const settingsResponse = await sendMessage({ type: "RUSTYPE_GET_SETTINGS" });
  const stateResponse = await sendMessage({ type: "RUSTYPE_REFRESH_ACTIVE_EDITOR_STATE" });

  const settings = {
    ...DEFAULT_SETTINGS,
    ...(settingsResponse?.settings ?? {})
  };
  const state = stateResponse?.state ?? null;

  applySettings(settings);
  renderState(state);

  enabledToggle.addEventListener("change", () => {
    saveSetting({ enabled: enabledToggle.checked });
  });

  autocompleteToggle.addEventListener("change", () => {
    saveSetting({ autocompleteEnabled: autocompleteToggle.checked });
  });

  spellcheckToggle.addEventListener("change", () => {
    saveSetting({ spellcheckEnabled: spellcheckToggle.checked });
  });

  refreshButton.addEventListener("click", refreshState);

  optionsButton.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  dictionaryButton.addEventListener("click", () => {
    if (chrome.tabs?.create) {
      chrome.tabs.create({
        url: chrome.runtime.getURL("src/options/options.html#dictionary")
      });
      return;
    }

    chrome.runtime.openOptionsPage();
  });
}

function applySettings(settings) {
  currentSettings = {
    ...DEFAULT_SETTINGS,
    ...settings
  };

  enabledToggle.checked = Boolean(settings.enabled);
  autocompleteToggle.checked = Boolean(settings.autocompleteEnabled);
  spellcheckToggle.checked = Boolean(settings.spellcheckEnabled);
  renderStats();
}

function renderState(state) {
  const isEnabled = Boolean(currentSettings.enabled);
  const hasRussian = Boolean(state?.isRussianLike);

  statusDot.classList.toggle("active", isEnabled);
  hostValue.textContent = state?.host ?? "-";
  editorValue.textContent = formatEditorType(state?.editorType);
  wordValue.textContent = state?.currentWord?.prefix || "-";
  textValue.textContent = state?.textPreview || "-";
  russianValue.textContent = hasRussian ? "Đã phát hiện" : "Chưa phát hiện";
  russianValue.classList.toggle("detected", hasRussian);
  noteValue.textContent = state?.note || "-";
}

function renderStats() {
  const dictionaryCount = Array.isArray(currentSettings.personalDictionary)
    ? currentSettings.personalDictionary.length
    : 0;

  suggestionValue.textContent = currentSettings.autocompleteEnabled ? "Bật" : "Tắt";
  dictionaryCountValue.textContent = String(dictionaryCount);
}

async function refreshState() {
  const response = await sendMessage({
    type: "RUSTYPE_REFRESH_ACTIVE_EDITOR_STATE"
  });

  renderState(response?.state ?? null);
  renderPopupError(response?.error ?? "");
}

function formatEditorType(editorType) {
  if (!editorType || editorType === "none") {
    return "-";
  }

  if (editorType === "selection") {
    return "selection";
  }

  if (editorType === "google-docs-dev") {
    return "google-docs";
  }

  return editorType;
}

async function saveSetting(payload) {
  await sendMessage({
    type: "RUSTYPE_SAVE_SETTINGS",
    payload
  });

  applySettings({
    ...currentSettings,
    ...payload
  });
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

        resolve(response ?? { ok: false, error: "EMPTY_RESPONSE" });
      });
    } catch (error) {
      resolve({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

function renderPopupError(error) {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "";

  document.body.dataset.error = message ? "true" : "false";
  document.body.title = message;
}
