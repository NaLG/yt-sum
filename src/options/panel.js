document.getElementById("settings").addEventListener("click", (e) => {
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
    window.close();
  } catch (e) {
    msg.textContent = "Couldn't reach the page. Reload the video tab and retry.";
  }
});
