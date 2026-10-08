/** Cheap exclusions before sending anything to a provider; not a secret scrubber. */
export function prepareText(text: string, maxChars: number): string | undefined {
  if (!text.trim() || text.length > maxChars || /^[!/]/.test(text.trim())) return;
  const prose = text
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*(?:\n|$)/gm, "\n")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^\s*>.*$/gm, "")
    .replace(/https?:\/\/\S+/g, " ")
    .trim();
  if (!/[a-zA-Z]{2}/.test(prose)) return;
  if (/^(?:yes|no|ok(?:ay)?|thanks|thank you|sure|got it|hold on)[.!\s]*$/i.test(prose)) return;
  return prose;
}
