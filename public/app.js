// Resolve a length selector's value: a preset key, or the custom char count
// when "Custom…" is chosen.
function pickLength(selectId, customId) {
  const sel = document.getElementById(selectId);
  if (!sel) return "medium";
  if (sel.value === "__custom__") {
    const custom = document.getElementById(customId);
    return custom && custom.value ? custom.value : "medium";
  }
  return sel.value;
}

// Show/hide a custom numeric input when its select is set to "Custom…".
function wireLengthToggle(selectId, customId) {
  const sel = document.getElementById(selectId);
  const custom = document.getElementById(customId);
  if (!sel || !custom) return;
  const sync = () => {
    custom.hidden = sel.value !== "__custom__";
  };
  sel.addEventListener("change", sync);
  sync();
}

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
  wireLengthToggle("ai-length", "ai-length-custom");

  generateBtn.addEventListener("click", async function () {
    const topic = (topicEl.value || "").trim();
    if (!topic) {
      statusEl.textContent = "Enter a topic first.";
      topicEl.focus();
      return;
    }

    // Resolve the tone to send: a saved preset sends its id (server injects its
    // instruction + real example posts for few-shot); "Custom…" sends free text;
    // built-ins send their key.
    let tone = "";
    let tonePresetId = "";
    if (toneEl.value === "__custom__") {
      tone = (customToneEl.value || "").trim();
    } else if (toneEl.value.indexOf("saved:") === 0) {
      tonePresetId = toneEl.value.slice("saved:".length);
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
          tonePresetId,
          audience: (audienceEl.value || "").trim(),
          language: langEl ? langEl.value : "en",
          length: pickLength("ai-length", "ai-length-custom"),
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
  wireLengthToggle("gen-length", "gen-length-custom");

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

  // Reveal the generate panel and point it at a given source.
  function openGeneratePanelFor(sourceId, label) {
    activeSourceId = sourceId;
    if (!genPanel) return;
    genPanel.hidden = false;
    genPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    genStatus.textContent = "Editing: " + (label || "source") + " — choose options, then Generate drafts.";
  }

  function wireGenerate(item) {
    const btn = item.querySelector(".generate-from");
    if (!btn) return;
    btn.addEventListener("click", function () {
      openGeneratePanelFor(btn.dataset.sourceId, item.querySelector("strong")?.textContent);
    });
  }

  if (list) list.querySelectorAll(".source-item").forEach((el) => { wireDelete(el); wireGenerate(el); });

  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; }
  }

  // Render the clickable "Sources (verify)" links for a news/URL source. Built
  // via DOM nodes (not innerHTML) so article titles can't inject markup.
  function renderRefs(item, urls) {
    if (!Array.isArray(urls) || !urls.length) return;
    const wrap = document.createElement("div");
    wrap.className = "source-refs";
    const label = document.createElement("span");
    label.className = "muted";
    label.textContent = "Sources (verify):";
    wrap.appendChild(label);
    const ul = document.createElement("ul");
    urls.forEach(function (r) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = r.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.textContent = r.title || r.url; a.title = r.title || r.url;
      const host = document.createElement("span");
      host.className = "muted"; host.textContent = " (" + hostOf(r.url) + ")";
      li.appendChild(a); li.appendChild(host); ul.appendChild(li);
    });
    wrap.appendChild(ul);
    item.appendChild(wrap);
  }

  function addSourceItem(source) {
    const item = document.createElement("li");
    item.className = "source-item";
    item.dataset.sourceId = source.id;
    item.innerHTML =
      "<strong></strong> <span class=\"muted\">· " + source.charCount + " chars</span>" +
      '<span class="row-actions">' +
      '<button type="button" class="btn small generate-from" data-source-id="' + source.id + '">Edit drafts</button> ' +
      '<button type="button" class="btn small ghost delete-source" data-source-id="' + source.id + '">Delete</button>' +
      "</span>";
    item.querySelector("strong").textContent = source.name; // safe against HTML in titles
    renderRefs(item, source.sourceUrls); // show article links immediately, no refresh
    const empty = document.getElementById("no-sources");
    if (empty) empty.remove();
    list.appendChild(item);
    wireDelete(item);
    wireGenerate(item);
  }

  // Add a source from a news/article URL.
  const urlBtn = document.getElementById("source-url-btn");
  if (urlBtn) {
    const urlInput = document.getElementById("source-url");
    const urlStatus = document.getElementById("source-url-status");
    urlBtn.addEventListener("click", async function () {
      const url = (urlInput.value || "").trim();
      if (!url) { urlStatus.textContent = "Paste a link first."; return; }
      urlBtn.disabled = true;
      urlStatus.textContent = "Fetching article…";
      try {
        const res = await fetch("/api/sources/url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not add URL.");
        addSourceItem(data.source);
        urlInput.value = "";
        urlStatus.textContent = "Added: " + data.source.name;
      } catch (err) {
        urlStatus.textContent = err.message;
      } finally {
        urlBtn.disabled = false;
      }
    });
  }

  // Add a source from a live news search on a topic.
  // Recent searched topics — clickable chips at the bottom of the page.
  const recentBox = document.getElementById("recent-topics");
  const noTopics = document.getElementById("no-topics");
  const newsInput = document.getElementById("source-news");
  const newsBtn = document.getElementById("source-news-btn");

  function wireTopicChip(chip) {
    const searchBtn = chip.querySelector(".topic-search");
    const removeBtn = chip.querySelector(".topic-remove");
    if (searchBtn) searchBtn.addEventListener("click", function () {
      if (newsInput) newsInput.value = searchBtn.dataset.query || "";
      window.scrollTo({ top: 0, behavior: "smooth" });
      if (newsBtn) newsBtn.click();
    });
    if (removeBtn) removeBtn.addEventListener("click", async function () {
      removeBtn.disabled = true;
      try {
        const res = await fetch("/api/sources/topics/" + chip.dataset.topicId, { method: "DELETE" });
        if (!res.ok) throw new Error();
        chip.remove();
        if (recentBox && !recentBox.querySelector(".topic-chip") && noTopics) noTopics.hidden = false;
      } catch (e) { removeBtn.disabled = false; }
    });
  }

  function addRecentTopic(topic) {
    if (!topic || !recentBox) return;
    const dup = Array.prototype.slice.call(recentBox.querySelectorAll(".topic-search"))
      .find(function (b) { return b.dataset.query === topic.query; });
    if (dup) { recentBox.prepend(dup.closest(".topic-chip")); return; } // bump to front
    const chip = document.createElement("span");
    chip.className = "topic-chip";
    chip.dataset.topicId = topic.id;
    const sb = document.createElement("button");
    sb.type = "button"; sb.className = "topic-search"; sb.dataset.query = topic.query; sb.textContent = topic.query;
    const rb = document.createElement("button");
    rb.type = "button"; rb.className = "topic-remove"; rb.title = "Delete"; rb.setAttribute("aria-label", "Delete"); rb.textContent = "×";
    chip.appendChild(sb); chip.appendChild(rb);
    recentBox.prepend(chip);
    wireTopicChip(chip);
    if (noTopics) noTopics.hidden = true;
  }

  if (recentBox) recentBox.querySelectorAll(".topic-chip").forEach(wireTopicChip);

  if (newsBtn) {
    const newsStatus = document.getElementById("source-news-status");
    newsBtn.addEventListener("click", async function () {
      const query = (newsInput.value || "").trim();
      if (!query) { newsStatus.textContent = "Enter a topic first."; return; }
      newsBtn.disabled = true;
      newsStatus.textContent = "Searching recent news…";
      try {
        const res = await fetch("/api/sources/news", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "News search failed.");
        // News topics are transient: they don't join "Your sources", they show as
        // a Recent-topics chip and open the generate panel so you can draft now.
        addRecentTopic(data.topic);
        newsInput.value = "";
        newsStatus.textContent = "Found: " + data.source.name;
        openGeneratePanelFor(data.source.id, data.source.name);
      } catch (err) {
        newsStatus.textContent = err.message;
      } finally {
        newsBtn.disabled = false;
      }
    });
  }

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
        addSourceItem(data.source);
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
      let tonePresetId = "";
      if (tone.indexOf("saved:") === 0) {
        tonePresetId = tone.slice("saved:".length);
        tone = "";
      }
      genRun.disabled = true;
      genStatus.textContent = "Generating drafts…";
      try {
        const res = await fetch("/api/sources/" + activeSourceId + "/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tone,
            tonePresetId,
            count: genCount.value,
            audience: (genAudience.value || "").trim(),
            language: (document.getElementById("gen-language") || {}).value || "en",
            length: pickLength("gen-length", "gen-length-custom"),
            stance: (document.getElementById("gen-stance") || {}).value || "",
            archetype: (document.getElementById("gen-archetype") || {}).value || "",
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Generation failed.");
        if (data.skipped) {
          genStatus.textContent = "Skipped — not a fit for this author: " + (data.reason || "");
        } else {
          genStatus.innerHTML = "Created " + data.created + ' drafts. <a href="/queue">Review in the queue →</a>';
        }
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

// ---- New-post compose: preview selected images before scheduling ----------
(function () {
  const input = document.getElementById("new-images");
  const preview = document.getElementById("new-image-preview");
  if (!input || !preview) return;
  input.addEventListener("change", function () {
    preview.innerHTML = "";
    Array.from(input.files || []).forEach((file) => {
      if (!file.type.startsWith("image/")) return;
      const li = document.createElement("li");
      li.className = "image-item";
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      img.alt = file.name;
      img.onload = () => URL.revokeObjectURL(img.src);
      li.appendChild(img);
      preview.appendChild(li);
    });
  });
})();

// ---- Dashboard: daily topic ideas (news-driven, one-click draft) ----------
(function () {
  const runBtn = document.getElementById("ideas-run");
  if (!runBtn) return;
  const card = document.querySelector(".ideas-card");
  const focusInput = document.getElementById("ideas-focus");
  const toneSelect = document.getElementById("ideas-tone");
  const statusEl = document.getElementById("ideas-status");
  const list = document.getElementById("ideas-list");
  const linkedinReady = card && card.dataset.linkedinReady === "1";

  function ideaCard(idea) {
    const li = document.createElement("li");
    li.className = "idea-item";

    const badge = document.createElement("span");
    badge.className = "idea-archetype";
    badge.textContent = idea.archetypeLabel || "Idea";
    li.appendChild(badge);

    const angle = document.createElement("p");
    angle.className = "idea-angle";
    angle.textContent = idea.angle || idea.title;
    li.appendChild(angle);

    const src = document.createElement("a");
    src.className = "idea-source muted";
    src.href = idea.url; src.target = "_blank"; src.rel = "noopener noreferrer";
    src.textContent = idea.title;
    li.appendChild(src);

    const actions = document.createElement("div");
    actions.className = "idea-actions";
    const draftBtn = document.createElement("button");
    draftBtn.type = "button";
    draftBtn.className = "btn small primary";
    draftBtn.textContent = "Draft it";
    draftBtn.disabled = !linkedinReady;
    if (!linkedinReady) draftBtn.title = "Connect LinkedIn first";
    const note = document.createElement("span");
    note.className = "idea-note muted";
    actions.appendChild(draftBtn);
    actions.appendChild(note);
    li.appendChild(actions);

    draftBtn.addEventListener("click", async function () {
      draftBtn.disabled = true;
      note.textContent = "Drafting…";
      try {
        const res = await fetch("/api/suggestions/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: idea.url,
            title: idea.title,
            archetype: idea.archetype,
            angle: idea.angle,
            tonePresetId: toneSelect ? toneSelect.value : "",
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not draft.");
        note.innerHTML = 'Drafted. <a href="/queue">Review in queue →</a>';
      } catch (err) {
        note.textContent = err.message;
        draftBtn.disabled = false;
      }
    });
    return li;
  }

  runBtn.addEventListener("click", async function () {
    runBtn.disabled = true;
    statusEl.textContent = "Finding fresh ideas…";
    list.innerHTML = "";
    try {
      const res = await fetch("/api/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ focus: focusInput ? focusInput.value.trim() : "" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not get ideas.");
      if (!data.ideas || !data.ideas.length) {
        statusEl.textContent = "No ideas found, try a different focus.";
      } else {
        statusEl.textContent = "Ideas from news on: " + data.focus;
        data.ideas.forEach((idea) => list.appendChild(ideaCard(idea)));
      }
    } catch (err) {
      statusEl.textContent = err.message;
    } finally {
      runBtn.disabled = false;
    }
  });
})();
