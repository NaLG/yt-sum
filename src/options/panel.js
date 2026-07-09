// Browser-action popup. On Android this is the primary way to trigger a
// summary (the popup opens as a full overlay). Sends a message to the active
// YouTube tab's content script, which runs the same flow as the in-page button.

document.getElementById("settings").addEventListener("click", (e) => {
  // options_ui opens in a tab; also works via runtime.openOptionsPage on desktop.
  if (browser.runtime.openOptionsPage) {
    e.preventDefault();
    browser.runtime.openOptionsPage();
    window.close();
  }
});

document.getElementById("summarize").addEventListener("click", async () => {
  const msg = document.getElementById("msg");
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/youtube\.com\/watch|youtube\.com\/(shorts|live)\//.test(tab.url || "")) {
    msg.textContent = "Open a YouTube video first.";
    return;
  }
  try {
    await browser.tabs.sendMessage(tab.id, { type: "yapsum-summarize" });
    window.close(); // the panel renders in the page
  } catch (e) {
    msg.textContent = "Couldn't reach the page. Reload the video tab and retry.";
  }
});
