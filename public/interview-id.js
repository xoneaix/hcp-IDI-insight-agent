function normalizedType(type) {
  const value = String(type || "").trim().toLowerCase();
  return value === "patient" || value === "患者" ? "Patient" : "HCP";
}

export function respondentPrefix(type) {
  return normalizedType(type) === "Patient" ? "Patient" : "HCP";
}

function parsedInterviewId(value) {
  const match = String(value || "").trim().match(/^(HCP|Patient)-(\d+)$/i);
  if (!match) return null;
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  return {
    prefix: match[1].toLowerCase() === "patient" ? "Patient" : "HCP",
    sequence
  };
}

function formattedInterviewId(prefix, sequence) {
  return `${prefix}-${String(sequence).padStart(3, "0")}`;
}

function occupiedIds(items, excludedItem = null) {
  return new Set(items
    .filter((item) => item && item !== excludedItem)
    .map((item) => String(item.id || "").trim().toLowerCase())
    .filter(Boolean));
}

export function nextInterviewId(items, type, excludedItem = null) {
  const prefix = respondentPrefix(type);
  const occupied = occupiedIds(items, excludedItem);
  let sequence = items.reduce((maximum, item) => {
    if (!item || item === excludedItem) return maximum;
    const parsed = parsedInterviewId(item.id);
    return parsed?.prefix === prefix ? Math.max(maximum, parsed.sequence) : maximum;
  }, 0) + 1;
  while (occupied.has(formattedInterviewId(prefix, sequence).toLowerCase())) sequence += 1;
  return formattedInterviewId(prefix, sequence);
}

export function interviewIdForType(items, item, type) {
  const prefix = respondentPrefix(type);
  const occupied = occupiedIds(items, item);
  const current = parsedInterviewId(item?.id);
  if (current) {
    const preferred = formattedInterviewId(prefix, current.sequence);
    if (!occupied.has(preferred.toLowerCase())) return preferred;
  }
  return nextInterviewId(items, type, item);
}

export function repairInterviewIds(items) {
  const repairs = [];
  const projectGroups = new Map();
  for (const item of items) {
    if (!item) continue;
    const projectId = String(item.projectId || "default");
    if (!projectGroups.has(projectId)) projectGroups.set(projectId, []);
    projectGroups.get(projectId).push(item);
  }

  for (const projectItems of projectGroups.values()) {
    const maxima = { HCP: 0, Patient: 0 };
    for (const item of projectItems) {
      const prefix = respondentPrefix(item.type);
      const parsed = parsedInterviewId(item.id);
      if (parsed) maxima[prefix] = Math.max(maxima[prefix], parsed.sequence);
    }

    const occupied = new Set();
    for (const item of projectItems) {
      const prefix = respondentPrefix(item.type);
      const parsed = parsedInterviewId(item.id);
      let nextId = parsed ? formattedInterviewId(prefix, parsed.sequence) : "";
      if (!nextId || occupied.has(nextId.toLowerCase())) {
        do {
          maxima[prefix] += 1;
          nextId = formattedInterviewId(prefix, maxima[prefix]);
        } while (occupied.has(nextId.toLowerCase()));
      }
      occupied.add(nextId.toLowerCase());
      if (item.id !== nextId) {
        const previousId = item.id;
        item.id = nextId;
        repairs.push({ item, previousId, nextId });
      }
    }
  }
  return repairs;
}
