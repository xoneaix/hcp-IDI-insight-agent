export function trialUserIdentity(email = "") {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const atIndex = normalizedEmail.lastIndexOf("@");
  if (atIndex <= 0) return null;

  const localPart = normalizedEmail.slice(0, atIndex).split("+")[0];
  const spacedName = localPart
    .replace(/[._-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  if (!spacedName) return null;

  const words = spacedName.split(/\s+/u).filter(Boolean);
  const characters = Array.from(words[0] || "");
  const initials = (words.length > 1
    ? `${Array.from(words[0])[0] || ""}${Array.from(words.at(-1))[0] || ""}`
    : characters.slice(0, 2).join(""))
    .toLocaleUpperCase("en-US");
  const displayName = words
    .map((word) => `${word.charAt(0).toLocaleUpperCase("en-US")}${word.slice(1)}`)
    .join(" ");

  return { email: normalizedEmail, displayName, initials: initials || "MV" };
}
