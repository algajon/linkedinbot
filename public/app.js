// Live character count + post preview for the editor screens.
(function () {
  const form = document.querySelector(".post-form");
  if (!form) return;

  const textarea = form.querySelector('textarea[name="body"]');
  const counter = document.getElementById("char-current");
  const counterWrap = counter ? counter.closest(".char-count") : null;
  const preview = document.getElementById("preview-body");
  const max = parseInt(form.dataset.max || "3000", 10);

  function update() {
    const value = textarea.value;
    if (counter) counter.textContent = String(value.length);
    if (counterWrap) counterWrap.classList.toggle("over", value.length > max);
    if (preview) preview.textContent = value || "Your post preview will appear here.";
  }

  textarea.addEventListener("input", update);
  update();

  // ---- AI generation -----------------------------------------------------
  const generateBtn = document.getElementById("ai-generate");
  if (!generateBtn) return;

  const topicEl = document.getElementById("ai-topic");
  const toneEl = document.getElementById("ai-tone");
  const customWrap = document.getElementById("ai-custom-wrap");
  const customToneEl = document.getElementById("ai-custom-tone");
  const audienceEl = document.getElementById("ai-audience");
  const statusEl = document.getElementById("ai-status");

  // Reveal the custom-tone input only when "Custom…" is selected.
  toneEl.addEventListener("change", function () {
    customWrap.hidden = toneEl.value !== "__custom__";
  });

  generateBtn.addEventListener("click", async function () {
    const topic = (topicEl.value || "").trim();
    if (!topic) {
      statusEl.textContent = "Enter a topic first.";
      topicEl.focus();
      return;
    }

    const tone = toneEl.value === "__custom__" ? (customToneEl.value || "").trim() : toneEl.value;

    generateBtn.disabled = true;
    statusEl.textContent = "Generating…";

    try {
      const res = await fetch("/api/ai/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, tone, audience: (audienceEl.value || "").trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Generation failed.");
      }
      textarea.value = data.text;
      update();
      statusEl.textContent = "Draft generated — edit freely before scheduling.";
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      generateBtn.disabled = false;
    }
  });
})();

// ---- Image upload (edit page) --------------------------------------------
(function () {
  const card = document.getElementById("images-card");
  if (!card) return;

  const postId = card.dataset.postId;
  const input = document.getElementById("image-input");
  const uploadBtn = document.getElementById("image-upload-btn");
  const list = document.getElementById("image-list");
  const status = document.getElementById("upload-status");

  function wireRemove(item) {
    const btn = item.querySelector(".remove-image");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      const fileId = item.dataset.fileId;
      btn.disabled = true;
      try {
        const res = await fetch(`/api/posts/${postId}/files/${fileId}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not remove image.");
        item.remove();
      } catch (err) {
        status.textContent = err.message;
        btn.disabled = false;
      }
    });
  }

  // Wire up any images already rendered on the page.
  list.querySelectorAll(".image-item").forEach(wireRemove);

  uploadBtn.addEventListener("click", async function () {
    const file = input.files && input.files[0];
    if (!file) {
      status.textContent = "Choose an image first.";
      return;
    }

    const form = new FormData();
    form.append("file", file);
    uploadBtn.disabled = true;
    status.textContent = "Uploading…";

    try {
      const res = await fetch(`/api/posts/${postId}/upload`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed.");

      const item = document.createElement("li");
      item.className = "image-item";
      item.dataset.fileId = data.file.id;
      item.innerHTML =
        `<img src="${data.file.url}" alt="${data.file.filename}" />` +
        `<button type="button" class="btn small danger remove-image">Remove</button>`;
      list.appendChild(item);
      wireRemove(item);

      input.value = "";
      status.textContent = "Uploaded.";
    } catch (err) {
      status.textContent = err.message;
    } finally {
      uploadBtn.disabled = false;
    }
  });
})();
