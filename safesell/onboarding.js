// SafeSell — onboarding page logic.

const statusEl = document.getElementById("status");
const signInBtn = document.getElementById("sign-in-btn");
const skipLink = document.getElementById("skip-link");

function setStatus(msg, type = "") {
  statusEl.textContent = msg;
  statusEl.className = "status " + type;
}

signInBtn.addEventListener("click", async () => {
  signInBtn.disabled = true;
  setStatus("Opening Google sign-in…");

  try {
    const response = await chrome.runtime.sendMessage({ type: "SIGN_IN_GOOGLE" });
    if (response?.ok) {
      setStatus("Signed in! Taking you to Carousell…", "success");
      setTimeout(() => {
        chrome.tabs.create({ url: "https://www.carousell.sg" });
        window.close();
      }, 1200);
    } else {
      setStatus(response?.error || "Sign-in failed. Please try again.", "error");
      signInBtn.disabled = false;
    }
  } catch (err) {
    setStatus("Something went wrong. Please try again.", "error");
    signInBtn.disabled = false;
  }
});

skipLink.addEventListener("click", () => {
  chrome.storage.local.set({ safesell_skipped_auth: true });
  window.close();
});
