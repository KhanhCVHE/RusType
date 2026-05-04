const assert = require("node:assert/strict");
const { analyzeText } = require("../src/content/russian-grammar-rules.js");

function firstIssue(text, ruleId) {
  return analyzeText(text).find((issue) => issue.ruleId === ruleId);
}

function assertSuggestion(text, ruleId, expectedOriginal, expectedSuggestion) {
  const issue = firstIssue(text, ruleId);

  assert.ok(issue, `Expected ${ruleId} for: ${text}`);
  assert.equal(issue.original, expectedOriginal);
  assert.equal(issue.suggestions[0], expectedSuggestion);
}

assertSuggestion("это это хорошо", "sentence-start-capitalization", "э", "Э");
assertSuggestion("это это хорошо", "duplicate-word", "это это", "это");
assertSuggestion("привет  как дела", "multiple-spaces-between-words", "т  к", "т к");
assertSuggestion("привет , как дела", "space-before-punctuation", " ,", ",");
assertSuggestion("привет,как дела", "missing-space-after-punctuation", ",", ", ");
assertSuggestion("я есть студент", "unneeded-est-present-tense", "я есть студент", "я студент");
assertSuggestion("пoнимаю", "mixed-cyrillic-latin", "пoнимаю", "понимаю");
assertSuggestion("привет. как дела", "sentence-start-capitalization", "п", "П");

const capitalizationIssues = analyzeText("Привет. как дела")
  .filter((issue) => issue.ruleId === "sentence-start-capitalization");
assert.equal(capitalizationIssues.length, 1);
assert.equal(capitalizationIssues[0].original, "к");
assert.equal(capitalizationIssues[0].suggestions[0], "К");

assert.equal(analyzeText("hello world").length, 0);

console.log("grammar rules ok");
