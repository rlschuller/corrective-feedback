/** Cheap exclusions before sending anything to a provider; not a secret scrubber. */
export function prepareText(text: string, maxChars: number): string | undefined {
  if (!text.trim() || text.length > maxChars || /^[!/]/.test(text.trim())) return;
  const prose = text
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*(?:\n|$)/gm, "\n")
    .replace(/^\s*>.*$/gm, "")
    .replace(/https?:\/\/\S+/g, " ")
    .trim();
  // Inline code supplies grammatical context (e.g. "push to `dev`").
  // Ignore it only when deciding whether there is any prose to review.
  const outsideInlineCode = prose.replace(/(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, " ");
  if (!/[a-zA-Z]{2}/.test(outsideInlineCode)) return;
  if (/^(?:yes|no|ok(?:ay)?|thanks|thank you|sure|got it|hold on)[.!\s]*$/i.test(prose)) return;
  return prose;
}
