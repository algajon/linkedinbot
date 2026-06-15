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
    if (preview) preview.textContent = value || preview.dataset.empty || "Your post preview will appear here.";
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

    // Resolve the tone to send: a saved preset passes its full distilled
    // instruction; "Custom…" passes the free-text box; built-ins pass their key.
    let tone;
    if (toneEl.value === "__custom__") {
      tone = (customToneEl.value || "").trim();
    } else if (toneEl.value.indexOf("saved:") === 0) {
      tone = toneEl.selectedOptions[0].dataset.instruction || "";
    } else {
      tone = toneEl.value;
    }

    generateBtn.disabled = true;
    statusEl.textContent = "Generating…";

    try {
      const langEl = document.getElementById("post-language");
      const res = await fetch("/api/ai/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          tone,
          audience: (audienceEl.value || "").trim(),
          language: langEl ? langEl.value : "en",
          length: (document.getElementById("ai-length") || {}).value || "medium",
        }),
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

  // ---- Learn a tone from examples ----------------------------------------
  const analyzeBtn = document.getElementById("learn-analyze");
  if (analyzeBtn) {
    const samplesEl = document.getElementById("learn-samples");
    const learnStatus = document.getElementById("learn-status");
    const resultWrap = document.getElementById("learn-result");
    const instructionEl = document.getElementById("learn-instruction");
    const nameEl = document.getElementById("learn-name");
    const saveBtn = document.getElementById("learn-save");

    analyzeBtn.addEventListener("click", async function () {
      const samples = (samplesEl.value || "").trim();
      if (samples.length < 80) {
        learnStatus.textContent = "Paste a bit more example text first.";
        return;
      }
      analyzeBtn.disabled = true;
      learnStatus.textContent = "Analyzing voice…";
      try {
        const res = await fetch("/api/tones/learn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ samples }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Analysis failed.");
        instructionEl.value = data.instruction;
        resultWrap.hidden = false;
        learnStatus.textContent = "Review the captured voice, name it, and save.";
      } catch (err) {
        learnStatus.textContent = err.message;
      } finally {
        analyzeBtn.disabled = false;
      }
    });

    saveBtn.addEventListener("click", async function () {
      const name = (nameEl.value || "").trim();
      const instruction = (instructionEl.value || "").trim();
      if (!name || !instruction) {
        learnStatus.textContent = "Give the voice a name first.";
        return;
      }
      saveBtn.disabled = true;
      learnStatus.textContent = "Saving…";
      try {
        const res = await fetch("/api/tones", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, instruction, sampleText: (samplesEl.value || "").trim() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not save preset.");

        // Add it to the dropdown (under a "saved voices" group) and select it.
        let group = toneEl.querySelector('optgroup[label="Your saved voices"]');
        if (!group) {
          group = document.createElement("optgroup");
          group.label = "Your saved voices";
          toneEl.insertBefore(group, toneEl.firstChild);
        }
        const opt = document.createElement("option");
        opt.value = "saved:" + data.preset.id;
        opt.dataset.instruction = data.preset.instruction;
        opt.textContent = data.preset.name;
        group.appendChild(opt);
        toneEl.value = opt.value;

        learnStatus.textContent = `Saved "${data.preset.name}" — it's now selected above.`;
        resultWrap.hidden = true;
        nameEl.value = "";
      } catch (err) {
        learnStatus.textContent = err.message;
      } finally {
        saveBtn.disabled = false;
      }
    });
  }
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

// ---- Content sources: upload, delete, generate drafts --------------------
(function () {
  const uploadBtn = document.getElementById("source-upload-btn");
  const genPanel = document.getElementById("generate-panel");
  if (!uploadBtn && !genPanel) return;

  const input = document.getElementById("source-input");
  const sourceStatus = document.getElementById("source-status");
  const list = document.getElementById("source-list");

  function wireDelete(item) {
    const btn = item.querySelector(".delete-source");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      const id = btn.dataset.sourceId;
      btn.disabled = true;
      try {
        const res = await fetch("/api/sources/" + id, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not delete.");
        item.remove();
      } catch (err) {
        sourceStatus.textContent = err.message;
        btn.disabled = false;
      }
    });
  }

  // Generate-panel state: which source is selected.
  let activeSourceId = null;
  const genStatus = document.getElementById("gen-status");
  const genTone = document.getElementById("gen-tone");
  const genCount = document.getElementById("gen-count");
  const genAudience = document.getElementById("gen-audience");
  const genRun = document.getElementById("gen-run");

  function wireGenerate(item) {
    const btn = item.querySelector(".generate-from");
    if (!btn) return;
    btn.addEventListener("click", function () {
      activeSourceId = btn.dataset.sourceId;
      if (genPanel) {
        genPanel.hidden = false;
        genPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
        genStatus.textContent = "Generating from: " + (item.querySelector("strong")?.textContent || "source");
      }
    });
  }

  if (list) list.querySelectorAll(".source-item").forEach((el) => { wireDelete(el); wireGenerate(el); });

  if (uploadBtn) {
    uploadBtn.addEventListener("click", async function () {
      const file = input.files && input.files[0];
      if (!file) { sourceStatus.textContent = "Choose a PDF first."; return; }
      const form = new FormData();
      form.append("file", file);
      uploadBtn.disabled = true;
      sourceStatus.textContent = "Parsing PDF…";
      try {
        const res = await fetch("/api/sources", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed.");
        const item = document.createElement("li");
        item.className = "source-item";
        item.dataset.sourceId = data.source.id;
        item.innerHTML =
          '<strong>' + data.source.name + '</strong> <span class="muted">· ' + data.source.charCount + ' chars</span>' +
          '<span class="row-actions">' +
          '<button type="button" class="btn small generate-from" data-source-id="' + data.source.id + '">Generate drafts</button> ' +
          '<button type="button" class="btn small ghost delete-source" data-source-id="' + data.source.id + '">Delete</button>' +
          '</span>';
        const empty = document.getElementById("no-sources");
        if (empty) empty.remove();
        list.appendChild(item);
        wireDelete(item); wireGenerate(item);
        input.value = "";
        sourceStatus.textContent = "Parsed " + data.source.charCount + " characters.";
      } catch (err) {
        sourceStatus.textContent = err.message;
      } finally {
        uploadBtn.disabled = false;
      }
    });
  }

  if (genRun) {
    genRun.addEventListener("click", async function () {
      if (!activeSourceId) { genStatus.textContent = "Pick a source first."; return; }
      let tone = genTone.value;
      if (tone.indexOf("saved:") === 0) tone = genTone.selectedOptions[0].dataset.instruction || "";
      genRun.disabled = true;
      genStatus.textContent = "Generating drafts…";
      try {
        const res = await fetch("/api/sources/" + activeSourceId + "/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tone,
            count: genCount.value,
            audience: (genAudience.value || "").trim(),
            language: (document.getElementById("gen-language") || {}).value || "en",
            length: (document.getElementById("gen-length") || {}).value || "medium",
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Generation failed.");
        genStatus.innerHTML = "Created " + data.created + ' drafts. <a href="/queue">Review in the queue →</a>';
      } catch (err) {
        genStatus.textContent = err.message;
      } finally {
        genRun.disabled = false;
      }
    });
  }
})();

// ---- Routines: toggle cadence-specific fields ----------------------------
(function () {
  const form = document.getElementById("routine-form");
  if (!form) return;
  const anchor = document.getElementById("anchor-block");
  const weekly = document.getElementById("weekly-block");
  function sync() {
    const cadence = form.querySelector('input[name="cadence"]:checked').value;
    const isWeekly = cadence === "WEEKLY";
    anchor.hidden = isWeekly;
    weekly.hidden = !isWeekly;
  }
  form.querySelectorAll('input[name="cadence"]').forEach((r) => r.addEventListener("change", sync));
  sync();
})();
