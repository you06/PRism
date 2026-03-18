// ---------------------------------------------------------------------------
// PRism — Review Language Tests
//
// Run with: npx tsx daemon/src/review-language.test.ts
// ---------------------------------------------------------------------------

import { buildPRReviewPrompt } from "./analysis/prompt.js";
import {
  isReviewLanguageCode,
  resolveReviewLanguageName,
} from "./analysis/review-language.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  [pass] ${message}`);
  } else {
    failed++;
    console.error(`  [fail] ${message}`);
  }
}

console.log("\n--- Review language mapping ---");
assert(isReviewLanguageCode("en"), "accepts en");
assert(isReviewLanguageCode("cn"), "accepts cn");
assert(isReviewLanguageCode("jp"), "accepts jp");
assert(!isReviewLanguageCode("foo"), "rejects unsupported language");
assert(resolveReviewLanguageName("en") === "English", "maps en to English");
assert(
  resolveReviewLanguageName("cn") === "Simplified Chinese",
  "maps cn to Simplified Chinese",
);
assert(resolveReviewLanguageName("jp") === "Japanese", "maps jp to Japanese");

console.log("\n--- Review prompt language injection ---");
const input = {
  prTitle: "Add language-aware review output",
  prDescription: "Prompt should drive summary language.",
  fragments: [
    {
      index: "1",
      filePath: "src/cli.ts",
      hunkHeader: "@@ -1,1 +1,2 @@",
      patch: "-old\n+new",
    },
  ],
};

const englishPrompt = buildPRReviewPrompt(input, resolveReviewLanguageName("en"));
const chinesePrompt = buildPRReviewPrompt(input, resolveReviewLanguageName("cn"));
const japanesePrompt = buildPRReviewPrompt(input, resolveReviewLanguageName("jp"));

assert(
  englishPrompt.system.includes("one concise sentence in English"),
  "injects English into system prompt",
);
assert(
  chinesePrompt.system.includes("one concise sentence in Simplified Chinese"),
  "injects Simplified Chinese into system prompt",
);
assert(
  japanesePrompt.system.includes("one concise sentence in Japanese"),
  "injects Japanese into system prompt",
);
assert(
  chinesePrompt.user.includes("PR title: Add language-aware review output"),
  "leaves user prompt content intact",
);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed.`);
  process.exit(1);
}

console.log(`\nAll ${passed} tests passed.`);
