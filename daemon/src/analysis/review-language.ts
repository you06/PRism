export type ReviewLanguageCode = "en" | "cn" | "jp";

const REVIEW_LANGUAGE_NAMES: Record<ReviewLanguageCode, string> = {
  en: "English",
  cn: "Simplified Chinese",
  jp: "Japanese",
};

export function isReviewLanguageCode(value: string): value is ReviewLanguageCode {
  return value === "en" || value === "cn" || value === "jp";
}

export function resolveReviewLanguageName(code: ReviewLanguageCode): string {
  return REVIEW_LANGUAGE_NAMES[code];
}
