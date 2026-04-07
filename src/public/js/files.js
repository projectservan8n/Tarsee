/**
 * File Manager — browse, view, edit workspace files.
 */
const FileManager = {
  currentPath: ".",
  openFile: null,

  init() {
    document.getElementById("fileManagerBtn")?.addEventListener("click", () => this.toggle());
    document.getElementById("fmClose")?.addEventListener("click", () => this.close());
    document.getElementById("fmCloseEditor")?.addEventListener("click", () => this.closeEditor());
    document.getElementById("fmClosePreview")?.addEventListener("click", () => this.closePreview());
    document.getElementById("fmSaveBtn")?.addEventListener("click", () => this.saveFile());
    document.getElementById("fmNewFile")?.addEventListener("click", () => this.newFile());
  },

  toggle() {
    const panel = document.getElementById("fileManagerPanel");
    if (panel.style.display === "none") {
      panel.style.display = "flex";
      this.loadDir(".");
    } else {
      this.close();
    }
  },

  close() {
    document.getElementById("fileManagerPanel").style.display = "none";
  },

  async loadDir(dirPath) {
    this.currentPath = dirPath;
    const breadcrumb = document.getElementById("fmBreadcrumb");
    breadcrumb.textContent = dirPath === "." ? "workspace" : dirPath;
    breadcrumb.title = dirPath;

    const list = document.getElementById("fmFileList");
    try {
      const data = await API.json(`/api/files/ls?path=${encodeURIComponent(dirPath)}`);
      const items = data.items || [];

      // Sort: dirs first, then files alphabetically
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      let html = "";

      // Back button if not at root
      if (dirPath !== ".") {
        const parent = dirPath.includes("/") ? dirPath.split("/").slice(0, -1).join("/") || "." : ".";
        html += `<div class="fm-item fm-dir" data-path="${parent}" data-action="dir">
          <span class="fm-icon">📁</span>
          <span class="fm-name">..</span>
        </div>`;
      }

      for (const item of items) {
        const fullPath = dirPath === "." ? item.name : `${dirPath}/${item.name}`;
        if (item.name.startsWith(".") && item.name !== ".claude") continue; // Hide dotfiles except .claude

        if (item.isDirectory) {
          html += `<div class="fm-item fm-dir" data-path="${fullPath}" data-action="dir">
            <span class="fm-icon">📁</span>
            <span class="fm-name">${item.name}</span>
          </div>`;
        } else {
          const icon = this.getFileIcon(item.name);
          const size = item.size ? this.formatSize(item.size) : "";
          html += `<div class="fm-item fm-file" data-path="${fullPath}" data-action="file">
            <span class="fm-icon">${icon}</span>
            <span class="fm-name">${item.name}</span>
            <span class="fm-size">${size}</span>
          </div>`;
        }
      }

      list.innerHTML = html;

      // Event listeners
      list.querySelectorAll("[data-action='dir']").forEach(el => {
        el.addEventListener("click", () => this.loadDir(el.dataset.path));
      });
      list.querySelectorAll("[data-action='file']").forEach(el => {
        el.addEventListener("click", () => this.openFileView(el.dataset.path));
      });
    } catch (err) {
      list.innerHTML = `<div style="color:var(--danger);padding:12px">${err.message}</div>`;
    }
  },

  async openFileView(filePath) {
    this.openFile = filePath;
    const ext = filePath.split(".").pop().toLowerCase();
    const editable = ["md", "txt", "js", "json", "html", "css", "py", "sh", "yaml", "yml", "toml", "env", "sql", "ts", "jsx", "tsx", "conf", "cfg", "ini", "xml", "csv"].includes(ext);
    const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext);

    if (isImage) {
      // Preview image
      document.getElementById("fmEditor").style.display = "none";
      document.getElementById("fmPreview").style.display = "flex";
      document.getElementById("fmPreviewFilename").textContent = filePath.split("/").pop();
      document.getElementById("fmPreviewContent").innerHTML = `<img src="/api/files/download?path=${encodeURIComponent(filePath)}" style="max-width:100%;border-radius:8px">`;
      return;
    }

    try {
      const data = await API.json(`/api/files/read?path=${encodeURIComponent(filePath)}`);

      if (editable) {
        document.getElementById("fmPreview").style.display = "none";
        document.getElementById("fmEditor").style.display = "flex";
        document.getElementById("fmEditorFilename").textContent = filePath.split("/").pop();
        document.getElementById("fmEditorContent").value = data.content;
      } else {
        document.getElementById("fmEditor").style.display = "none";
        document.getElementById("fmPreview").style.display = "flex";
        document.getElementById("fmPreviewFilename").textContent = filePath.split("/").pop();
        document.getElementById("fmPreviewContent").innerHTML = `<pre style="white-space:pre-wrap;font-size:12px">${this.escapeHtml(data.content)}</pre>`;
      }
    } catch (err) {
      App.showToast("Can't open: " + err.message, "error");
    }
  },

  async saveFile() {
    if (!this.openFile) return;
    const content = document.getElementById("fmEditorContent").value;
    try {
      await API.json("/api/files/write", { method: "POST", body: { path: this.openFile, content } });
      App.showToast("Saved", "success");
    } catch (err) {
      App.showToast("Save failed: " + err.message, "error");
    }
  },

  async newFile() {
    const name = prompt("File name:");
    if (!name) return;
    const filePath = this.currentPath === "." ? name : `${this.currentPath}/${name}`;
    try {
      await API.json("/api/files/write", { method: "POST", body: { path: filePath, content: "" } });
      this.loadDir(this.currentPath);
      App.showToast("Created " + name, "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  closeEditor() {
    document.getElementById("fmEditor").style.display = "none";
    this.openFile = null;
  },

  closePreview() {
    document.getElementById("fmPreview").style.display = "none";
    this.openFile = null;
  },

  getFileIcon(name) {
    const ext = name.split(".").pop().toLowerCase();
    const icons = {
      md: "📝", txt: "📄", js: "🟨", json: "📋", html: "🌐", css: "🎨",
      py: "🐍", sh: "⚙️", yaml: "📐", yml: "📐", toml: "📐",
      png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", svg: "🖼️", webp: "🖼️",
      pdf: "📕", db: "🗃️", sql: "🗃️", wav: "🔊", mp3: "🎵",
    };
    return icons[ext] || "📄";
  },

  formatSize(bytes) {
    if (bytes < 1024) return bytes + "B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + "KB";
    return (bytes / 1024 / 1024).toFixed(1) + "MB";
  },

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  },
};
