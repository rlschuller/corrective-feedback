/** Cheap exclusions before sending anything to a provider; not a secret scrubber.
 * Keep the Node-free plotting equivalent in scripts/review_character_counts.py in sync.
 */
export function prepareText(text: string, maxChars: number): string | undefined {
  if (!text.trim() || text.length > maxChars || /^[!/]/.test(text.trim())) return;
  const prose = text
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*(?:\n|$)/gm, "\n")
    .replace(/^\s*>.*$/gm, "")
    .trim();
  // Inline code and URLs supply grammatical context (e.g. "push to `dev`").
  // Keep them and adjacent punctuation verbatim in the review input; ignore them
  // only when deciding whether there is any prose to review.
  const outsideContext = prose
    .replace(/(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  if (!/[a-zA-Z]{2}/.test(outsideContext)) return;
  if (/^(?:yes|no|ok(?:ay)?|thanks|thank you|sure|got it|hold on)[.!\s]*$/i.test(prose)) return;
  return prose;
}
