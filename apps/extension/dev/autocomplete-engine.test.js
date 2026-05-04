const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const context = {
  window: {}
};

vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(root, "src/content/autocomplete-dictionary.generated.js"), "utf8"),
  context
);
vm.runInContext(
  fs.readFileSync(path.join(root, "src/content/autocomplete-engine.js"), "utf8"),
  context
);

const autocomplete = context.window.RusTypeAutocomplete;

assert.ok(autocomplete, "autocomplete engine should be available");

const suggestions = autocomplete.suggest("при", { limit: 3 });
assert.ok(suggestions.length > 0, "prefix should return suggestions");
assert.equal(suggestions[0].fullWord, "привет");
assert.equal(suggestions[0].completion, "вет");

const uppercaseSuggestions = autocomplete.suggest("При", { limit: 1 });
assert.equal(uppercaseSuggestions[0].fullWord, "Привет");

const personalSuggestions = autocomplete.suggest("при", {
  limit: 1,
  extraWords: ["приморье"]
});
assert.equal(personalSuggestions[0].fullWord, "приморье");
assert.equal(personalSuggestions[0].reason, "personal-dictionary");

const favoriteSuggestions = autocomplete.suggest("при", {
  limit: 1,
  favoriteWords: ["приз"]
});
assert.equal(favoriteSuggestions[0].fullWord, "приз");
assert.equal(favoriteSuggestions[0].reason, "favorite-word");

console.log("autocomplete engine ok");
