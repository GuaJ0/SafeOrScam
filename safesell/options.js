// SafeSell — options page logic.

const fields = {
  openai: "OPENAI_API_KEY",
  exa: "EXA_API_KEY",
  serp: "SERP_API_KEY",
};

const statusEl = document.getElementById("status");

// Load existing values.
chrome.storage.local.get(Object.values(fields), (stored) => {
  for (const [inputId, storageKey] of Object.entries(fields)) {
    const input = document.getElementById(inputId);
    if (input && stored[storageKey]) input.value = stored[storageKey];
  }
});

document.getElementById("save").addEventListener("click", () => {
  const payload = {};
  for (const [inputId, storageKey] of Object.entries(fields)) {
    payload[storageKey] = document.getElementById(inputId).value.trim();
  }
  chrome.storage.local.set(payload, () => {
    statusEl.textContent = "Saved ✓";
    setTimeout(() => (statusEl.textContent = ""), 2500);
  });
});
